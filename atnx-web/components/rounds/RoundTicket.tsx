"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { startSeriesAction } from "@/app/app/actions/rounds";
import { Card } from "@/components/ui";
import { fmtUsdg, parseUsdg, shortHash } from "@/components/bm/format";
import { USDG_UNIT, solTxUrl } from "@/lib/bm/chains";
import { USDG_MINT, type RoundSide } from "@/lib/bm/sol-shared";
import type { BmRoundRow, BmSeriesRow } from "@/lib/supabase/database-bm";
import { SolConnectButton } from "./SolConnectButton";
import { ClaimList, HowRounds, LivePane, NextRoundLine, PresalePane, Question, RegistryLine } from "./ticket-parts";
import {
  MOCK_HINT,
  friendlySolError,
  holdsAnything,
  liveRoundRow,
  presaleRoundRow,
  useClaimables,
  useNow,
  useRoundState,
  useSendRounds,
  useSolWallet,
  type RoundsBuilders,
} from "./useRounds";

// The panes, the claim list and the footer moved to ticket-parts.tsx, shared
// with the NEAR ticket; re-exported for anything that imported them here.
export { ClaimList, HowRounds };

// The rounds ticket. One question per round: will the index, averaged
// over the round's last minutes, end at or above where it opened? The
// ticket shows one round: the live one when the series has it, otherwise
// the presale round (round 1 before it opens, or the few minutes between
// a settle and the next open). Commits to the next round are not offered
// while one is live; a position already there shows as one line. Same
// mount contract as BoundedTicket.
//
// It reads like a trade ticket: numbers, one outcome line, a button. How
// rounds work sits behind the one "How rounds work" disclosure at the
// bottom of every state, and behind it the Show me modal.

const SLIPPAGE_BPS = 100n; // 1% below the quote
const MAX_VI_AGE_MIN = 30; // lib/bm/open.ts: a series starts only on a fresh VI
const FAUCET_USDG = 1_000n;
// lib/bm/rounds.ts: the averaging window a new series gets.
const WINDOW_SECS = 1_800;
const FAST_WINDOW_SECS = 900;

interface Props {
  atnxMarketId: string;
  name: string;
  score: number;
  scoring?: boolean;
  // When the market's VI was last written; a stale VI cannot start a series.
  viUpdatedAt?: string | null;
  series: BmSeriesRow | null;
  rounds: BmRoundRow[];
  initialSide?: RoundSide;
  onToast?: (message: string, detail: string | undefined, type: RoundSide) => void;
}

export function RoundTicket(props: Props) {
  if (!USDG_MINT) {
    return (
      <Card className="p-4">
        <p className="text-sm text-secondary">Rounds are not live on Solana devnet yet.</p>
      </Card>
    );
  }
  if (!props.series || !props.series.series_pubkey || props.series.state === "pending") return <StartSeries {...props} />;
  return <SeriesTicket {...props} series={props.series} />;
}

// ------------------------------------------------------------ no series

function StartSeries({ atnxMarketId, name, score, scoring = false, viUpdatedAt, series }: Props) {
  const router = useRouter();
  const wallet = useSolWallet();
  const now = useNow();
  const [fast, setFast] = useState(false);
  const [starting, startStarting] = useTransition();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = started || series?.state === "pending";

  // The action creates the series on chain before it returns; a refresh
  // then brings the registry row. Keep re-reading until it does (a row
  // left pending by a slow confirmation is picked up by the keeper).
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => router.refresh(), 8_000);
    return () => clearInterval(t);
  }, [pending, router]);

  const roundSecs = fast ? 3_600 : 86_400;
  const windowSecs = fast ? FAST_WINDOW_SECS : WINDOW_SECS;
  const stale = !!viUpdatedAt && now !== null && now - new Date(viUpdatedAt).getTime() > MAX_VI_AGE_MIN * 60_000;
  const blocked = scoring
    ? "The first score is still being computed."
    : score <= 0
      ? "This market has no score yet."
      : stale
        ? `The index is over ${MAX_VI_AGE_MIN} minutes old. Rounds start on a fresh reading.`
        : null;

  function start() {
    if (!wallet.publicKey) return;
    const finder = wallet.publicKey.toBase58();
    setError(null);
    startStarting(async () => {
      const r = await startSeriesAction(atnxMarketId, finder, fast);
      if (!r.ok) setError(r.code === "already_active" ? "Rounds are already running on this market. Reload the page." : r.error);
      else {
        setStarted(true);
        router.refresh();
      }
    });
  }

  if (pending) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series?.round_secs ?? roundSecs} />
        <p className="text-sm text-secondary animate-pulse">Starting rounds on chain…</p>
        <HowRounds roundSecs={series?.round_secs ?? roundSecs} windowSecs={series?.settle_window_secs ?? windowSecs} />
      </Card>
    );
  }

  return (
    <Card className="p-4 sm:p-5">
      <Question name={name} roundSecs={roundSecs} />
      {process.env.NODE_ENV !== "production" && (
        <label className="flex items-center gap-2 text-xs text-secondary mb-3 cursor-pointer">
          <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} className="accent-[var(--color-atnx-cyan)]" />
          Fast series (1 h rounds, 15-minute average, for demos)
        </label>
      )}
      {blocked ? (
        <p className="text-sm text-secondary">{blocked}</p>
      ) : (
        <>
          {!wallet.connected ? (
            <SolConnectButton label="Connect a Solana wallet to start" />
          ) : (
            <button
              type="button"
              onClick={start}
              disabled={starting || wallet.mock}
              className="btn-cyan w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
            >
              {starting ? "Starting…" : "Start rounds"}
            </button>
          )}
          <p className="text-[11px] text-tertiary mt-2">You earn a share of every fee in this series.</p>
          {wallet.mock && <p className="text-[11px] text-tertiary mt-1">{MOCK_HINT}</p>}
        </>
      )}
      {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
      <HowRounds roundSecs={roundSecs} windowSecs={windowSecs} />
    </Card>
  );
}

// ------------------------------------------------------------- the ticket

function SeriesTicket({ name, score, series, rounds, initialSide = "up", onToast }: Props & { series: BmSeriesRow }) {
  const router = useRouter();
  const wallet = useSolWallet();
  const now = useNow();
  const state = useRoundState(series, rounds);
  const claims = useClaimables(series, rounds);
  const { send } = useSendRounds();

  const liveRow = liveRoundRow(rounds);
  const presaleRow = presaleRoundRow(rounds);
  const [side, setSide] = useState<RoundSide>(initialSide);
  const [amount, setAmount] = useState("25");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const snap = state.data;
  const live = snap?.live ?? null;
  const presale = snap?.presale ?? null;
  const acct = snap?.series ?? null;

  // Waiting on the keeper: a live round past its close, a row it is
  // moving (opening, settling), or a presale whose opening time passed.
  // Re-read the page so the registry rows and the round indexes follow.
  const closeAtMs = live ? live.account.closeAt * 1000 : null;
  const opensAtMs = presaleRow ? new Date(presaleRow.opens_at).getTime() : null;
  const waiting =
    now !== null &&
    ((closeAtMs !== null && now >= closeAtMs) ||
      liveRow?.state === "opening" ||
      liveRow?.state === "settling" ||
      (!live && opensAtMs !== null && now >= opensAtMs));
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => router.refresh(), 8_000);
    return () => clearInterval(t);
  }, [waiting, router]);

  const units = useMemo(() => parseUsdg(amount), [amount]);

  async function run(label: string, build: (b: RoundsBuilders, holder: PublicKey) => Promise<TransactionInstruction[]>, toast: [string, string | undefined]) {
    setBusy(label);
    setError(null);
    try {
      const sig = await send(build);
      setLastTx(sig);
      void state.refetch();
      void claims.refetch();
      onToast?.(toast[0], toast[1], side);
      return true;
    } catch (err) {
      setError(friendlySolError(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function faucet() {
    await run(
      "Getting USDG…",
      async (b, holder) => {
        const ata = getAssociatedTokenAddressSync(USDG_MINT!, holder);
        return [createAssociatedTokenAccountIdempotentInstruction(holder, ata, holder, USDG_MINT!), await b.faucet({ to: ata, amount: FAUCET_USDG * USDG_UNIT })];
      },
      ["Got 1,000 USDG", "Devnet money, no value"],
    );
  }

  // ---------------------------------------------------------------- states

  if (!wallet.connected || !wallet.publicKey) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series.round_secs} />
        <RegistryLine liveRow={liveRow} presaleRow={presaleRow} now={now} />
        <SolConnectButton label={!liveRow && presaleRow ? "Connect Solana wallet to commit" : "Connect Solana wallet to trade"} />
        <HowRounds roundSecs={series.round_secs} windowSecs={series.settle_window_secs} />
      </Card>
    );
  }

  if (!snap || !acct) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series.round_secs} />
        <p className="text-sm text-secondary animate-pulse">{state.error ? "Could not read the round." : "Loading the round…"}</p>
        {state.error && <p className="text-[11px] text-atnx-magenta mt-2 break-words">{state.error.message.split("\n")[0]}</p>}
        <HowRounds roundSecs={series.round_secs} windowSecs={series.settle_window_secs} />
      </Card>
    );
  }

  const holdsSomething = holdsAnything(live?.position ?? null) || holdsAnything(presale?.position ?? null) || claims.data.length > 0;

  if (snap.usdg === 0n && !holdsSomething) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series.round_secs} />
        <p className="text-sm text-secondary mb-3">You need test USDG to take a side.</p>
        <button type="button" onClick={faucet} disabled={!!busy || wallet.mock} className="btn-cyan w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50">
          {busy ?? "Get 1,000 test USDG"}
        </button>
        {wallet.mock && <p className="text-[11px] text-tertiary mt-2">{MOCK_HINT}</p>}
        {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
        <HowRounds roundSecs={series.round_secs} windowSecs={series.settle_window_secs} />
      </Card>
    );
  }

  const feeBps = BigInt(acct.feeBps);
  const finderBps = BigInt(acct.finderBps);
  const ref = state.ref;
  // A position the wallet already holds in the next round (a rollover or
  // an earlier commit), shown under the live pane as one line.
  const nextPos = live && presale && holdsAnything(presale.position) ? presale.position : null;

  return (
    <Card className="p-4 sm:p-5">
      <Question name={name} roundSecs={acct.roundSecs} />
      {live ? (
        <div className="text-xs font-bold text-secondary mb-3">Round {live.account.index} · Live</div>
      ) : presale ? (
        <div className="text-xs font-bold text-secondary mb-3">Round {presale.account.index} · Opens soon</div>
      ) : (
        <p className="text-sm text-secondary mb-3">No open round. The series may be paused or ended.</p>
      )}

      {live && ref ? (
        <LivePane
          view={live}
          series={acct}
          score={score}
          now={now}
          side={side}
          setSide={setSide}
          amount={amount}
          setAmount={setAmount}
          units={units}
          usdg={snap.usdg}
          feeBps={feeBps}
          finderBps={finderBps}
          busy={busy}
          mock={wallet.mock}
          onBuy={async (quote) => {
            if (!units) return;
            const minShares = (quote.shares * (10_000n - SLIPPAGE_BPS)) / 10_000n;
            const ok = await run(
              "Buying…",
              async (b, holder) => [await b.buy({ ref, roundIndex: live.account.index, side, amount: units, minShares, holder })],
              [`Bought ${side.toUpperCase()}`, `${fmtUsdg(quote.shares)} shares in round ${live.account.index} of ${name}`],
            );
            if (ok) setAmount("25");
          }}
        />
      ) : presale && ref ? (
        <PresalePane
          view={presale}
          series={acct}
          seriesRow={series}
          now={now}
          side={side}
          setSide={setSide}
          amount={amount}
          setAmount={setAmount}
          units={units}
          usdg={snap.usdg}
          feeBps={feeBps}
          finderBps={finderBps}
          busy={busy}
          mock={wallet.mock}
          onCommit={async () => {
            if (!units) return;
            const ok = await run(
              "Committing…",
              async (b, holder) => [await b.commit({ ref, roundIndex: presale.account.index, side, amount: units, holder })],
              [`Committed ${side.toUpperCase()}`, `${fmtUsdg(units, 0)} USDG on round ${presale.account.index} of ${name}`],
            );
            if (ok) setAmount("25");
          }}
        />
      ) : null}
      {nextPos && presale && <NextRoundLine pos={nextPos} index={presale.account.index} />}

      {units !== null && units > snap.usdg && (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs">
          <span className="text-atnx-magenta">Not enough USDG.</span>
          <button type="button" onClick={faucet} disabled={!!busy || wallet.mock} className="h-8 px-3 rounded-lg border border-surface text-secondary btn-quiet cursor-pointer disabled:opacity-50">
            {busy === "Getting USDG…" ? "Getting USDG…" : "Get 1,000 test USDG"}
          </button>
        </div>
      )}
      {wallet.mock && <p className="text-[11px] text-tertiary mt-2">{MOCK_HINT}</p>}
      {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
      {lastTx && (
        <a href={solTxUrl(lastTx)} target="_blank" rel="noreferrer" className="block mt-2 text-[11px] text-tertiary link-quiet">
          View last transaction {shortHash(lastTx)} ↗
        </a>
      )}

      {claims.data.length > 0 && ref && (
        <div className="mt-4 pt-3 border-t border-surface">
          <ClaimList
            claims={claims.data}
            series={acct}
            busy={busy}
            mock={wallet.mock}
            keyOf={(c) => c.key.toBase58()}
            onClaim={(c) =>
              run(
                c.amount > 0n ? "Claiming…" : "Closing…",
                async (b, holder) => {
                  const ata = getAssociatedTokenAddressSync(USDG_MINT!, holder);
                  return [createAssociatedTokenAccountIdempotentInstruction(holder, ata, holder, USDG_MINT!), await b.claim({ ref, roundIndex: c.account.index, holder })];
                },
                c.amount > 0n ? [`Claimed ${fmtUsdg(c.amount)} USDG`, `Round ${c.account.index} of ${name}`] : ["Position closed", "The account's rent is back in your wallet"],
              )
            }
            onRoll={(c) =>
              run(
                "Rolling over…",
                async (b, holder) => [await b.claimRollover({ ref, roundIndex: c.account.index, nextRoundIndex: acct.presaleRound, holder })],
                [`Rolled ${fmtUsdg(c.amount)} USDG`, `Into round ${acct.presaleRound} of ${name}, ${c.account.winner?.toUpperCase() ?? ""}`],
              )
            }
          />
        </div>
      )}
      <HowRounds roundSecs={acct.roundSecs} windowSecs={acct.settleWindowSecs} />
    </Card>
  );
}
