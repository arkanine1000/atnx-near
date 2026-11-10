// House-level checks before the relayer pays for a call, beside
// ./rounds-check.ts. A delegate that panics on chain still costs the
// relayer its gas, so the relay route reads the house contract first and
// refuses what would fail: a faucet claim past the account's lifetime cap,
// an order on a market that takes none (not listed, not open, paused, in
// its cool-off, no fresh price, the score under the minimum, the two prices
// too far apart), with the wrong leverage, a stake outside the limits, no
// limit, more than the balance covers or over the position limit; a close
// or cancel of a position that is not the signer's or not in that state; a
// crank of more than 20 ids. The refusal carries the contract's own error
// text, so the client words it the same either way.
//
// A courtesy, not a guarantee: the chain can move between the read and the
// send, and the contract checks everything again. A full market is not
// refused here: the contract takes the order and refunds it at the fill.
import { CRANK_MAX_IDS, readAmountArgs, readCancelArgs, readCloseArgs, readCrankArgs, readOpenArgs } from '@/lib/bm/house-types';
import { CONTRACT_MESSAGE, openBlock } from '@/lib/bm/house-ticket';
import type { HouseViewer } from './house';
import { RelayRejected, type CheckedDelegate } from './relay';

export type HouseCheckViewer = Pick<HouseViewer, 'config' | 'market' | 'position' | 'positionsOf' | 'balanceOf' | 'faucetClaimed' | 'nowSecs'>;

function wouldFail(message: string): never {
  throw new RelayRejected('would_fail', message);
}

function badArgs(detail: string): never {
  throw new RelayRejected('bad_args', detail);
}

function parse<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    badArgs((e as Error).message);
  }
}

export function houseAppCheck(view: HouseCheckViewer, opts: { now?: () => number } = {}): (checked: CheckedDelegate) => Promise<void> {
  // The chain's clock, which the contract compares against; a test passes
  // its own.
  const nowSecs = async () => (opts.now ? Math.floor(opts.now() / 1000) : view.nowSecs());
  return async (checked) => {
    const a = checked.args;
    const who = checked.senderId;
    switch (checked.methodName) {
      case 'faucet': {
        const { amount } = parse(() => readAmountArgs(a));
        if (amount === 0n) wouldFail('amount is zero');
        const [cfg, claimed] = await Promise.all([view.config(), view.faucetClaimed(who)]);
        const cap = cfg.faucetPerAccount;
        if (cap === null) return;
        if (claimed !== null && claimed >= cap) throw new RelayRejected('faucet_full', 'faucet limit reached for this account');
        if ((claimed ?? 0n) + amount > cap) wouldFail('faucet limit reached for this account');
        return;
      }
      case 'withdraw': {
        const { amount } = parse(() => readAmountArgs(a));
        if (amount === 0n) wouldFail('amount is zero');
        if ((await view.balanceOf(who)) < amount) wouldFail('balance too low');
        return;
      }
      case 'open': {
        const o = parse(() => readOpenArgs(a));
        if (o.limitE2 === 0n) wouldFail('a limit price is required');
        const [cfg, market, balance, positions, now] = await Promise.all([view.config(), view.market(o.market), view.balanceOf(who), view.positionsOf(who), nowSecs()]);
        const block = openBlock({
          cfg,
          market,
          vault: null,
          nowSecs: now,
          side: o.side,
          leverage: o.leverage,
          stake: o.stake,
          balance,
          openCount: positions.length,
        });
        if (block && block !== 'full') wouldFail(CONTRACT_MESSAGE[block]);
        return;
      }
      case 'close': {
        const c = parse(() => readCloseArgs(a));
        if (c.limitE2 === 0n) wouldFail('a limit price is required');
        const [p, now] = await Promise.all([view.position(c.positionId), nowSecs()]);
        if (!p) wouldFail('no such position');
        if (p.account !== who) wouldFail('not your position');
        if (p.state !== 'Open') wouldFail('position is not open');
        if (p.expiresAt !== null && p.expiresAt !== undefined && now >= p.expiresAt) wouldFail('position has reached its end and is closing');
        return;
      }
      case 'cancel': {
        const c = parse(() => readCancelArgs(a));
        const [p, cfg, now] = await Promise.all([view.position(c.positionId), view.config(), nowSecs()]);
        if (!p) wouldFail('no such position');
        if (p.account !== who) wouldFail('not your position');
        if (p.state !== 'Pending') wouldFail('order is not pending');
        if (now < p.placedAt + cfg.orderTtlSecs) wouldFail('an order can be cancelled only once its time to live has passed');
        return;
      }
      case 'crank': {
        const { ids } = parse(() => readCrankArgs(a));
        if (ids.length === 0) badArgs('position_ids is empty');
        if (ids.length > CRANK_MAX_IDS) badArgs(`at most ${CRANK_MAX_IDS} position ids`);
        return;
      }
      default:
        throw new RelayRejected('method_not_allowed', checked.methodName);
    }
  };
}

// The position a relayed house call leaves waiting for a quote: an open's
// return value (the new position id) or a close's argument. The relay
// route asks the keeper for a quote on demand for it after the answer has
// gone back; anything else needs none.
export function onDemandPositionId(methodName: string, args: Record<string, unknown>, value: unknown): bigint | null {
  const asId = (v: unknown): bigint | null => {
    if (typeof v === 'string' && /^\d{1,20}$/.test(v)) return BigInt(v);
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
    return null;
  };
  if (methodName === 'open') return asId(value);
  if (methodName === 'close') return asId(args.position_id);
  return null;
}
