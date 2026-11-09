"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Card } from "@/components/ui";
import { fmtUsdg, parseUsdg, shortHash } from "@/components/bm/format";
import { useAuth } from "@/context/AuthContext";
import type { RoundSide } from "@/lib/bm/dpm";
import type { ActResult } from "@/lib/near/client";
import { FAUCET_UNITS, isNearRoundsDeployed, nearTxUrl, type UserMethod } from "@/lib/near/config";
import { friendlyNearError } from "@/lib/near/errors";
import { callArgs, u128 } from "@/lib/near/rounds";
import type { BmRoundRow, BmSeriesRow } from "@/lib/supabase/database-bm";
import { FUND_HREF } from "./FundFromAnyChain";
import { NearGuestChoice } from "./NearGuestChoice";
import { holdsAnything, liveRoundRow, presaleRoundRow } from "./round-math";
import { ClaimList, HowRounds, LivePane, NextRoundLine, PresalePane, Question, RegistryLine } from "./ticket-parts";
import { useNow } from "./time";
import { useNearAccount, type NearAccount } from "./useNearAccount";
import { useNearClaimables, useNearRoundState, type NearClaimable } from "./useNearRounds";

// The rounds ticket on NEAR testnet: the same states, panes and copy as the
// Solana ticket (docs/rounds.md, "What the trader sees"), with the wallet
// replaced by the ATNX sign-in. A signed-in user gets a gasless account
// (useNearAccount) the first time the ticket needs one; every action is a
// call the browser signs and ATNX relays, so there is nothing to connect,
// approve or pay for. "Connect wallet" becomes "Sign in to trade", then
// "Setting up your account…". Under the sign-in button, "Try as a guest"
// makes a test account in this browser with no sign-in; a guest trades the
// same ticket but sees "Sign in to start rounds" where a series has none.
//
// The series is found by its registry reference (get_series_by_reference);
// commits and buys name the round they are for, so one sent as the keeper
// opens the next round fails rather than landing in it.

const SLIPPAGE_BPS = 100n; // 1% below the quote
const MAX_VI_AGE_MIN = 30; // lib/bm/open.ts: a series starts only on a fresh VI
const TESTNET = "Testnet · test USDG, no value.";
// lib/bm/rounds.ts: the averaging window a new series gets.
const WINDOW_SECS = 1_800;
const FAST_WINDOW_SECS = 900;

// Starts a NEAR series on the market (startNearSeriesAction in
// app/app/actions/rounds.ts). It takes no finder: the server makes the
// signed-in user's own active account the finder, from the session.
export type StartNearSeries = (atnxMarketId: string, fast: boolean) => Promise<{ ok: true } | { ok: false; error: string; code?: string }>;

interface Props {
  atnxMarketId: string;
  name: string;
  score: number;
  scoring?: boolean;
  viUpdatedAt?: string | null;
  // The NEAR series on this market (bm.series with chain 'near:testnet'),
  // pending ones included, and its rounds.
  series: BmSeriesRow | null;
  rounds: BmRoundRow[];
  initialSide?: RoundSide;
  onToast?: (message: string, detail: string | undefined, type: RoundSide) => void;
  // Starts a NEAR series with the signed-in user's account as finder; the
  // keeper creates it on chain. Without it, a market with no series says
  // so instead of offering a button.
  startSeries?: StartNearSeries;
}

function Footer({ roundSecs, windowSecs }: { roundSecs: number; windowSecs: number }) {
  return <HowRounds roundSecs={roundSecs} windowSecs={windowSecs} networkNote={TESTNET} costNote={null} />;
}

const BUTTON = "btn-cyan w-full h-11 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50";

export function NearRoundTicket(props: Props) {
  if (!isNearRoundsDeployed()) {
    return (
      <Card className="p-4">
        <p className="text-sm text-secondary">Rounds are not live on NEAR testnet yet.</p>
      </Card>
    );
  }
  if (!props.series || props.series.state === "pending") return <StartSeries {...props} />;
  return <SeriesTicket {...props} series={props.series} />;
}

// ------------------------------------------------------------ the account

// Sets the account up once, on its own, when a signed-in user without one
// opens a ticket that needs it.
function useAutoAccount(near: NearAccount, enabled: boolean) {
  const tried = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || near.status !== "none" || tried.current) return;
    tried.current = true;
    near.ensureAccount().catch((e) => setError(friendlyNearError(e)));
  }, [enabled, near]);
  const retry = () => {
    setError(null);
    near.ensureAccount().catch((e) => setError(friendlyNearError(e)));
  };
  return { error, retry };
}

// What stands between the user and the ticket: signing in (or, where
// `guest` is set, trying it as a guest), the account being set up, or an
// account whose key is in another browser.
function AccountGate({ near, label, autoError, onRetry, guest = false }: { near: NearAccount; label: string; autoError: string | null; onRetry: () => void; guest?: boolean }) {
  const { user, openLoginModal } = useAuth();
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  switch (near.status) {
    case "loading":
      // Signed in, reading the account; before the session is known, the
      // sign-in button (disabled) holds the place.
      if (user) return <p className="text-sm text-secondary animate-pulse">Loading your account…</p>;
      return (
        <button type="button" disabled className={BUTTON}>
          {label}
        </button>
      );
    case "signed-out":
      return (
        <>
          <button type="button" onClick={openLoginModal} className={BUTTON}>
            {label}
          </button>
          {guest && (
            <div className="mt-2.5">
              <NearGuestChoice />
            </div>
          )}
        </>
      );
    case "none":
    case "creating":
      if (near.isGuest) return <p className="text-sm text-secondary animate-pulse">Setting up your test account…</p>;
      if (autoError && near.status === "none") {
        return (
          <>
            <p className="text-xs text-atnx-magenta mb-3 break-words">{autoError}</p>
            <button type="button" onClick={onRetry} className={BUTTON}>
              Try again
            </button>
          </>
        );
      }
      return <p className="text-sm text-secondary animate-pulse">Setting up your account…</p>;
    case "other-browser":
      return (
        <>
          <p className="text-xs text-secondary mb-3">Your account was set up in another browser. Start a new one here to trade; the old one keeps what it holds.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setFresh(null);
              near
                .startFresh()
                .catch((e) => setFresh(friendlyNearError(e)))
                .finally(() => setBusy(false));
            }}
            className={BUTTON}
          >
            {busy ? "Setting up your account…" : "Start a new account here"}
          </button>
          {fresh && <p className="text-xs text-atnx-magenta mt-3 break-words">{fresh}</p>}
        </>
      );
    case "unsupported":
      return <p className="text-sm text-secondary">This browser can&apos;t hold your trading account. Try a recent Chrome, Firefox or Safari.</p>;
    case "error":
      return (
        <>
          <p className="text-xs text-atnx-magenta mb-3">{near.error ?? "Your account could not be read just now."}</p>
          <button type="button" onClick={near.refetch} className={BUTTON}>
            Try again
          </button>
        </>
      );
    default:
      return null;
  }
}

// ------------------------------------------------------------- no series

function StartSeries({ atnxMarketId, name, score, scoring = false, viUpdatedAt, series, startSeries }: Props) {
  const router = useRouter();
  const now = useNow();
  const near = useNearAccount();
  const { openLoginModal } = useAuth();
  const [fast, setFast] = useState(false);
  const [starting, startStarting] = useTransition();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = started || series?.state === "pending";

  // The keeper creates the series on chain; the registry row moves from
  // pending to active once it has. Keep re-reading until it does.
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

  // "Start rounds" needs a signed-in user with an active account, which
  // becomes the series' finder (the server reads it from the session). It
  // needs no key to earn, so an account whose key is in another browser is
  // fine too. Before that comes the sign-in and the account set-up. A guest
  // cannot start rounds (the finder earns fees): it is asked to sign in.
  const canStart = !near.isGuest && !!near.accountId && (near.status === "ready" || near.status === "other-browser" || near.status === "unsupported");
  const auto = useAutoAccount(near, !!startSeries && !blocked && !pending);

  if (pending) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series?.round_secs ?? roundSecs} />
        <p className="text-sm text-secondary animate-pulse">Starting rounds on chain…</p>
        <Footer roundSecs={series?.round_secs ?? roundSecs} windowSecs={series?.settle_window_secs ?? windowSecs} />
      </Card>
    );
  }

  function start() {
    if (!startSeries || !canStart) return;
    setError(null);
    startStarting(async () => {
      try {
        const r = await startSeries(atnxMarketId, fast);
        if (r.ok) {
          setStarted(true);
          router.refresh();
          return;
        }
        setError(r.code === "already_active" ? "Rounds are already running on this market. Reload the page." : r.error);
        // The session or the account changed under the page.
        if (r.code === "signed_out") openLoginModal();
        else if (r.code === "no_account" || r.code === "account_creating") near.refetch();
      } catch (e) {
        setError(friendlyNearError(e));
      }
    });
  }

  return (
    <Card className="p-4 sm:p-5">
      <Question name={name} roundSecs={roundSecs} />
      {!startSeries ? (
        <p className="text-sm text-secondary">Rounds have not started on this market yet.</p>
      ) : (
        <>
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
              {canStart ? (
                <button type="button" onClick={start} disabled={starting} className="btn-cyan w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50">
                  {starting ? "Starting…" : "Start rounds"}
                </button>
              ) : near.isGuest ? (
                <button type="button" onClick={openLoginModal} className={BUTTON}>
                  Sign in to start rounds
                </button>
              ) : (
                <AccountGate near={near} label="Sign in to start rounds" autoError={auto.error} onRetry={auto.retry} />
              )}
              <p className="text-[11px] text-tertiary mt-2">You earn a share of every fee in this series.</p>
            </>
          )}
          {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
        </>
      )}
      <Footer roundSecs={roundSecs} windowSecs={windowSecs} />
    </Card>
  );
}

// ------------------------------------------------------------- the ticket

function SeriesTicket({ name, score, series, rounds, initialSide = "up", onToast }: Props & { series: BmSeriesRow }) {
  const router = useRouter();
  const now = useNow();
  const near = useNearAccount();
  const ready = near.status === "ready";
  const accountId = ready ? near.accountId : null;
  const state = useNearRoundState(series, rounds, accountId);
  const snap = state.data;
  const acct = snap?.series ?? null;
  const claims = useNearClaimables(acct?.id ?? null, rounds, accountId);
  const auto = useAutoAccount(near, true);

  const liveRow = liveRoundRow(rounds);
  const presaleRow = presaleRoundRow(rounds);
  const [side, setSide] = useState<RoundSide>(initialSide);
  const [amount, setAmount] = useState("25");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const live = snap?.live ?? null;
  const presale = snap?.presale ?? null;

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

  async function run(label: string, method: UserMethod, args: Record<string, unknown>, toast: (r: ActResult) => [string, string | undefined]): Promise<boolean> {
    setBusy(label);
    setError(null);
    try {
      const r = await near.act(method, args);
      setLastTx(r.txHash);
      void state.refetch();
      void claims.refetch();
      const [title, detail] = toast(r);
      onToast?.(title, detail, side);
      return true;
    } catch (err) {
      setError(friendlyNearError(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const faucet = () => run("Getting USDG…", "faucet", callArgs.faucet(FAUCET_UNITS), () => ["Got 1,000 USDG", "Testnet money, no value"]);

  // ---------------------------------------------------------------- states

  if (!ready) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series.round_secs} />
        <RegistryLine liveRow={liveRow} presaleRow={presaleRow} now={now} />
        <AccountGate near={near} label={!liveRow && presaleRow ? "Sign in to commit" : "Sign in to trade"} autoError={auto.error} onRetry={auto.retry} guest />
        <Footer roundSecs={series.round_secs} windowSecs={series.settle_window_secs} />
      </Card>
    );
  }

  if (!snap || !acct) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series.round_secs} />
        <p className="text-sm text-secondary animate-pulse">{state.error ? "Could not read the round." : snap && !acct ? "Waiting for the series on chain…" : "Loading the round…"}</p>
        {state.error && <p className="text-[11px] text-atnx-magenta mt-2 break-words">{state.error.message.split("\n")[0]}</p>}
        <Footer roundSecs={series.round_secs} windowSecs={series.settle_window_secs} />
      </Card>
    );
  }

  const holdsSomething = holdsAnything(live?.position ?? null) || holdsAnything(presale?.position ?? null) || claims.data.length > 0;

  if (snap.usdg === 0n && !holdsSomething) {
    return (
      <Card className="p-4 sm:p-5">
        <Question name={name} roundSecs={series.round_secs} />
        <p className="text-sm text-secondary mb-3">You need test USDG to take a side.</p>
        <button type="button" onClick={faucet} disabled={!!busy} className="btn-cyan w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50">
          {busy ?? "Get 1,000 test USDG"}
        </button>
        <Link href={FUND_HREF} className="block mt-3 text-[11px] text-tertiary link-quiet">
          Have USDC on another chain? See what bringing it to NEAR would cost.
        </Link>
        {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
        <Footer roundSecs={series.round_secs} windowSecs={series.settle_window_secs} />
      </Card>
    );
  }

  const feeBps = BigInt(acct.feeBps);
  const finderBps = BigInt(acct.finderBps);
  // A position the account already holds in the next round (a rollover or
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

      {live ? (
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
          mock={false}
          onBuy={async (quote) => {
            if (!units) return;
            const minShares = (quote.shares * (10_000n - SLIPPAGE_BPS)) / 10_000n;
            const index = live.account.index;
            const ok = await run("Buying…", "buy", callArgs.buy(acct.id, index, side, units, minShares), () => [
              `Bought ${side.toUpperCase()}`,
              `${fmtUsdg(quote.shares)} shares in round ${index} of ${name}`,
            ]);
            if (ok) setAmount("25");
          }}
        />
      ) : presale ? (
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
          mock={false}
          onCommit={async () => {
            if (!units) return;
            const index = presale.account.index;
            const ok = await run("Committing…", "commit", callArgs.commit(acct.id, index, side, units), () => [
              `Committed ${side.toUpperCase()}`,
              `${fmtUsdg(units, 0)} USDG on round ${index} of ${name}`,
            ]);
            if (ok) setAmount("25");
          }}
        />
      ) : null}
      {nextPos && presale && <NextRoundLine pos={nextPos} index={presale.account.index} />}

      {units !== null && units > snap.usdg && (
        <div className="mt-3 flex items-center justify-between gap-3 text-xs">
          <span className="text-atnx-magenta">Not enough USDG.</span>
          <button type="button" onClick={faucet} disabled={!!busy} className="h-8 px-3 rounded-lg border border-surface text-secondary btn-quiet cursor-pointer disabled:opacity-50">
            {busy === "Getting USDG…" ? "Getting USDG…" : "Get 1,000 test USDG"}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
      {lastTx && (
        <a href={nearTxUrl(lastTx)} target="_blank" rel="noreferrer" className="block mt-2 text-[11px] text-tertiary link-quiet">
          View last transaction {shortHash(lastTx)} ↗
        </a>
      )}

      {claims.data.length > 0 && (
        <div className="mt-4 pt-3 border-t border-surface">
          <ClaimList<NearClaimable>
            claims={claims.data}
            series={acct}
            busy={busy}
            mock={false}
            keyOf={(c) => `${c.account.seriesId}-${c.account.index}`}
            closeLabel="Close position"
            onClaim={(c) =>
              run(c.amount > 0n ? "Claiming…" : "Closing…", "claim", callArgs.claim(acct.id, c.account.index), (r) =>
                c.amount > 0n ? [`Claimed ${fmtUsdg(u128(r.value))} USDG`, `Round ${c.account.index} of ${name}`] : ["Position closed", `Round ${c.account.index} of ${name}`],
              )
            }
            onRoll={(c) =>
              run("Rolling over…", "claim_rollover", callArgs.claimRollover(acct.id, c.account.index), (r) => [
                `Rolled ${fmtUsdg(u128(r.value))} USDG`,
                `Into round ${acct.presaleRound} of ${name}, ${c.account.winner?.toUpperCase() ?? ""}`,
              ])
            }
          />
        </div>
      )}
      <Footer roundSecs={acct.roundSecs} windowSecs={acct.settleWindowSecs} />
    </Card>
  );
}
