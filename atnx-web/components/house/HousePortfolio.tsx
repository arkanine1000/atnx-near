"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Card, EmptyState } from "@/components/ui";
import { fmtUsdg } from "@/components/bm/format";
import { useNow } from "@/components/rounds/time";
import { useNearAccount } from "@/components/rounds/useNearAccount";
import { useAuth } from "@/context/AuthContext";
import { fundingState, markPosition } from "@/lib/bm/house-ticket";
import { faucetArgs, type HousePosition } from "@/lib/bm/house-types";
import { HOUSE_FAUCET_UNITS, isNearHouseDeployed } from "@/lib/near/config";
import { friendlyNearError } from "@/lib/near/errors";
import { ClosedLine, Help, LastTxLink, PositionLine, TESTNET, TrackLines, sendClose, pnlTone, signedUsdg, useTracks } from "./parts";
import { useHouseAccount, useHouseBasics, useHouseMarkets } from "./useNearHouse";

// The house portfolio (NEXT_PUBLIC_BM_NEAR_PRODUCT=house), read from the
// contract: the balance; orders still confirming; open positions with the
// market, UP or DOWN and leverage, stake, entry, what each is worth now at
// the price it would close at and its PnL, the liquidation level, "at
// risk", the time left of its 14 days, and Close (1 % past the current
// close price; "Closing…" until it settles; a close that missed its limit
// says so and can be tapped again); then the last 20 closed positions with
// entry, exit, payout, PnL and why they ended. No claim step: the contract
// pays every close into the balance. The TESTNET chip is beside the page's
// title (app/app/portfolio/page.tsx); what the numbers are worked out from
// is behind the "?"s.

// A stat card: the label (with an optional "?") over the number. The
// shared StatTile's label is 10 to 11 px; this one is 13 px in the
// secondary ink, so it survives a compressed recording.
function Stat({ label, value, help, hero = false, className = "" }: { label: string; value: ReactNode; help?: { label: string; note: string }; hero?: boolean; className?: string }) {
  const body = (button: ReactNode) => (
    <>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="text-[13px] font-mono uppercase tracking-[0.12em] text-secondary">{label}</div>
        {button}
      </div>
      <div className={`font-display font-bold tabular-nums text-primary truncate ${hero ? "text-2xl sm:text-3xl" : "text-xl sm:text-2xl"}`}>{value}</div>
    </>
  );
  return (
    <Card className={`p-4 sm:p-5 min-w-0 ${className}`}>
      {help ? (
        <Help label={help.label} note={help.note}>
          {body}
        </Help>
      ) : (
        body(null)
      )}
    </Card>
  );
}

// The on-chain markets with their atnx.app name and picture (the server
// reads the list once per page load).
export interface HousePortfolioMarket {
  id: number;
  atnxMarketId: string;
  name: string;
  thumb: string | null;
}

export function HousePortfolio({ markets }: { markets: HousePortfolioMarket[] }) {
  const near = useNearAccount();
  const { user, openLoginModal } = useAuth();
  const nowMs = useNow() ?? 0;
  const accountId = near.status === "ready" || near.status === "other-browser" || near.status === "none" ? near.accountId : null;
  const basics = useHouseBasics();
  const { tracks, add, dismiss, settle } = useTracks(accountId);
  const sentRecently = tracks.some((t) => nowMs - t.sentAtMs < 20_000);
  const account = useHouseAccount(accountId, { enabled: basics.status === "ready", fast: sentRecently });
  const data = account.data;
  // The markets of the positions still running (their prices value them)
  // and of the orders and closes being followed (to say why an order was
  // refunded). Closed ones need no market read: their names come from
  // `markets`.
  const ids = useMemo(
    () => [...(data?.positions ?? []).map((p) => p.market), ...tracks.flatMap((t) => (t.market === undefined ? [] : [t.market]))],
    [data, tracks],
  );
  const chainMarkets = useHouseMarkets(ids, { enabled: basics.status === "ready" });
  const meta = useMemo(() => new Map(markets.map((m) => [m.id, m])), [markets]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  if (!isNearHouseDeployed() || basics.status === "unconfigured" || basics.status === "missing") {
    return <EmptyState title="Trading is not live on NEAR testnet yet" body={TESTNET} />;
  }
  if (basics.status === "error") return <EmptyState title="Could not read the market just now" body={basics.error ?? undefined} />;

  if (near.status === "loading" && user) return <EmptyState title="Reading your account…" />;
  if (near.status === "signed-out" || near.status === "loading") {
    return (
      <EmptyState
        title="Sign in to see your positions"
        body="Or try it as a guest from any market's ticket."
        action={
          <button type="button" onClick={openLoginModal} disabled={near.status === "loading"} className="h-9 px-4 inline-flex items-center rounded-full btn-magenta text-sm font-bold cursor-pointer whitespace-nowrap disabled:opacity-60">
            Sign in
          </button>
        }
      />
    );
  }
  if (!accountId) {
    return (
      <EmptyState
        title={near.status === "creating" ? "Setting up your account…" : near.status === "error" ? "Could not read your account" : "No positions yet"}
        body={near.status === "error" ? (near.error ?? undefined) : "Go UP or DOWN on any market."}
        action={
          <Link href="/app" className="inline-block text-sm px-5 py-2.5 rounded-full btn-magenta font-bold">
            Browse markets
          </Link>
        }
      />
    );
  }

  const cfg = basics.config;
  if (!cfg || !data) return <EmptyState title={account.error ? "Could not read your positions just now" : "Reading your positions…"} body={account.error ?? undefined} />;

  const canAct = near.status === "ready";
  const nameOf = (id: number) => meta.get(id)?.name ?? `Market ${id}`;
  const pending = data.positions.filter((p) => p.state === "Pending");
  const open = data.positions.filter((p) => p.state !== "Pending").sort((a, b) => (a.id < b.id ? 1 : -1));
  const marks = open.map((p) => markPosition(p, chainMarkets.get(p.market) ?? null, cfg));
  const openValue = marks.reduce((a, m) => a + (m?.value ?? 0n), 0n);
  const openStake = open.reduce((a, p) => a + p.stake, 0n);
  const funding = fundingState({ balance: data.balance, claimed: data.claimed, cfg });
  const faucetLeft = cfg.faucetPerAccount !== null && data.claimed !== null ? cfg.faucetPerAccount - data.claimed : HOUSE_FAUCET_UNITS;
  const faucetAmount = faucetLeft > HOUSE_FAUCET_UNITS ? HOUSE_FAUCET_UNITS : faucetLeft;

  async function faucet() {
    setBusy("faucet");
    setError(null);
    try {
      setLastTx((await near.act("faucet", faucetArgs(faucetAmount))).txHash);
    } catch (e) {
      setError(friendlyNearError(e));
    } finally {
      setBusy(null);
    }
  }

  async function close(p: HousePosition, limitE2: bigint) {
    setBusy(`close-${p.id}`);
    setError(null);
    const err = await sendClose(near.act, p, limitE2, add);
    if (err) setError(err);
    setBusy(null);
  }

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4 mb-6">
        <Stat label="Balance" value={`${fmtUsdg(data.balance)} USDG`} hero className="col-span-2 md:col-span-1" />
        <Stat label={`Open positions\u00a0·\u00a0${open.length}`} value={`${fmtUsdg(openValue)} USDG`} />
        <Stat
          label="Open PnL"
          value={<span className={pnlTone(openValue - openStake)}>{signedUsdg(openValue - openStake)} USDG</span>}
          help={{ label: "About Open PnL", note: "At the prices your positions would close at now." }}
        />
      </div>

      {near.status === "other-browser" && (
        <p className="text-sm text-secondary mb-3">This account was set up in another browser, so it can be viewed here but not used. Settings can start a new one for this browser.</p>
      )}
      {funding !== "ok" && canAct && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          {funding === "faucet" ? (
            <>
              <span className="text-secondary">You need test USDG to trade.</span>
              <button type="button" onClick={faucet} disabled={!!busy || faucetAmount <= 0n} className="h-9 px-4 rounded-full btn-cyan font-bold cursor-pointer disabled:opacity-50">
                {busy === "faucet" ? "Getting test USDG…" : `Get ${fmtUsdg(faucetAmount, 0)} test USDG`}
              </button>
            </>
          ) : (
            <span className="text-secondary">You have had all the test USDG this account can get.</span>
          )}
        </div>
      )}
      {error && <p className="text-sm text-atnx-magenta light:text-atnx-magenta-light mb-3 break-words">{error}</p>}
      <TrackLines
        tracks={tracks}
        account={data}
        marketOf={(id) => {
          const m = tracks.find((t) => t.id === id)?.market ?? (data.positions.find((x) => x.id === id) ?? data.history.find((x) => x.id === id))?.market;
          // Undefined while that market is still being read: the line waits.
          return m === undefined ? null : chainMarkets.get(m);
        }}
        cfg={cfg}
        nowMs={nowMs}
        act={near.act}
        onDismiss={dismiss}
        onSettled={settle}
      />

      {pending.length > 0 && (
        <Card className="p-4 mt-4">
          <h3 className="text-base font-bold text-primary">Orders confirming</h3>
          {pending.map((p) => (
            <PositionLine key={p.id.toString()} p={p} market={chainMarkets.get(p.market) ?? null} cfg={cfg} name={nameOf(p.market)} nowMs={nowMs} busy={false} onClose={close} />
          ))}
        </Card>
      )}

      <Card className="p-4 mt-4">
        <h3 className="text-base font-bold text-primary">Open positions</h3>
        {open.length === 0 ? (
          <p className="text-sm text-secondary py-2">
            No open positions.{" "}
            <Link href="/app" className="link-quiet underline underline-offset-2">
              Browse markets
            </Link>
          </p>
        ) : (
          open.map((p) => (
            <PositionLine
              key={p.id.toString()}
              p={p}
              market={chainMarkets.get(p.market) ?? null}
              cfg={cfg}
              name={nameOf(p.market)}
              nowMs={nowMs}
              busy={busy === `close-${p.id}` || !canAct}
              onClose={close}
            />
          ))
        )}
      </Card>

      <Card className="p-4 mt-4">
        <Help label="About Closed" note="The last 20, kept by the contract. Every close is paid straight into your balance." noteClassName="mb-1">
          {(help) => (
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-primary">Closed</h3>
              {help}
            </div>
          )}
        </Help>
        {data.history.length === 0 ? (
          <p className="text-sm text-secondary py-2">Nothing closed yet.</p>
        ) : (
          data.history.slice(0, 20).map((c) => <ClosedLine key={c.id.toString()} c={c} name={nameOf(c.market)} />)
        )}
      </Card>

      {lastTx && <LastTxLink txHash={lastTx} className="mt-3" />}
    </div>
  );
}
