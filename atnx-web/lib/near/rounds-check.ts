// Rounds-level checks before the relayer pays for a call. A delegate that
// panics on chain still costs the relayer its gas, so the relay route reads
// the contract first and refuses what would fail: the wrong round, a paused
// series, a balance that does not cover the amount, a buy whose quote is
// below its min_shares, a claim with no position. The refusal carries the
// contract's own error text, so the client words it the same either way.
//
// This is a courtesy, not a guarantee: the chain can move between the read
// and the send (a round opening, the price moving), and the contract
// checks everything again.
import { FAUCET_MAX_UNITS } from './config';
import { RelayRejected, type CheckedDelegate } from './relay';
import { nearDue, type RoundSide, type RoundsViewer } from './rounds';

// The faucet is free for the user but not for the relayer: an account
// already holding this much test USDG gets no more.
export const FAUCET_HOLD_CAP = 10_000n * 1_000_000n;

function wouldFail(message: string): never {
  throw new RelayRejected('would_fail', message);
}

function badArgs(detail: string): never {
  throw new RelayRejected('bad_args', detail);
}

function int(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 0xffff_ffff) badArgs(`${name} must be a u32`);
  return v;
}

function amount(v: unknown, name: string): bigint {
  if (typeof v !== 'string' || !/^\d{1,30}$/.test(v)) badArgs(`${name} must be a U128 string`);
  return BigInt(v);
}

function side(v: unknown): RoundSide {
  if (v === 'Up') return 'up';
  if (v === 'Down') return 'down';
  badArgs('side must be "Up" or "Down"');
}

// The panic text inside a failed view call, if that is what it was.
export function viewPanic(err: unknown): string | null {
  const text = String((err as Error)?.message ?? err);
  const m = /panicked:\s*([^"\n]+?)(?:"|\n|$)/i.exec(text) ?? /panicked at[^:]*:\s*([^"\n]+)/i.exec(text);
  return m ? m[1].trim() : null;
}

export function roundsAppCheck(view: RoundsViewer): (checked: CheckedDelegate) => Promise<void> {
  return async (checked) => {
    const a = checked.args;
    const who = checked.senderId;
    switch (checked.methodName) {
      case 'faucet': {
        const amt = amount(a.amount, 'amount');
        if (amt === 0n) wouldFail('amount is zero');
        if (amt > FAUCET_MAX_UNITS) wouldFail('mint above the per-call cap');
        if ((await view.balanceOf(who)) >= FAUCET_HOLD_CAP) throw new RelayRejected('faucet_full', 'already holding enough test USDG');
        return;
      }
      case 'withdraw': {
        const amt = amount(a.amount, 'amount');
        if (amt === 0n) wouldFail('amount is zero');
        if ((await view.balanceOf(who)) < amt) wouldFail('balance too low');
        return;
      }
      case 'commit': {
        const sid = int(a.series_id, 'series_id');
        const ri = int(a.round_index, 'round_index');
        side(a.side);
        const amt = amount(a.amount, 'amount');
        if (amt === 0n) wouldFail('amount is zero');
        const [s, bal] = await Promise.all([view.series(sid), view.balanceOf(who)]);
        if (!s) wouldFail('no such series');
        if (s.paused) wouldFail('series is paused');
        if (s.presaleRound !== ri) wouldFail("round is not the series' presale round");
        if (bal < amt) wouldFail('balance too low');
        return;
      }
      case 'buy': {
        const sid = int(a.series_id, 'series_id');
        const ri = int(a.round_index, 'round_index');
        const sd = side(a.side);
        const amt = amount(a.amount, 'amount');
        const min = amount(a.min_shares, 'min_shares');
        const bal = await view.balanceOf(who);
        let shares: bigint;
        try {
          // The same checks and arithmetic as buy: live round, trading
          // window, paused, the ratio cap.
          shares = (await view.quoteBuy(sid, ri, sd, amt)).shares;
        } catch (err) {
          const msg = viewPanic(err);
          if (msg) wouldFail(msg);
          throw err;
        }
        if (shares < min) wouldFail('fewer shares than the minimum you set');
        if (bal < amt) wouldFail('balance too low');
        return;
      }
      case 'claim':
      case 'claim_rollover': {
        const sid = int(a.series_id, 'series_id');
        const ri = int(a.round_index, 'round_index');
        const [s, r, p] = await Promise.all([view.series(sid), view.round(sid, ri), view.position(sid, ri, who)]);
        if (!s) wouldFail('no such series');
        if (!r) wouldFail('no such round');
        if (!p) wouldFail('no position in this round');
        if (checked.methodName === 'claim') {
          if (r.state !== 'settled' && r.state !== 'void') wouldFail('round is not settled');
          return;
        }
        if (r.state !== 'settled') wouldFail('round is not settled');
        if (s.paused) wouldFail('series is paused');
        if (nearDue(r, p) === 0n) wouldFail('nothing to claim');
        const next = s.presaleRound ? await view.round(sid, s.presaleRound) : null;
        if (!next || next.state !== 'presale') wouldFail("round is not the series' presale round");
        return;
      }
      default:
        throw new RelayRejected('method_not_allowed', checked.methodName);
    }
  };
}
