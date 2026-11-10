"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card, EmptyState, StatTile } from "@/components/ui";
import { fmtUsdg, shortHash } from "@/components/bm/format";
import { useNow } from "@/components/rounds/time";
import { useNearAccount } from "@/components/rounds/useNearAccount";
import { useAuth } from "@/context/AuthContext";
import { fundingState, markPosition } from "@/lib/bm/house-ticket";
import { faucetArgs, type HousePosition } from "@/lib/bm/house-types";
import { HOUSE_FAUCET_UNITS, isNearHouseDeployed, nearTxUrl } from "@/lib/near/config";
import { friendlyNearError } from "@/lib/near/errors";
import { ClosedLine, PositionLine, TESTNET, TrackLines, sendClose, signedUsdg, useTracks } from "./parts";
import { useHouseAccount, useHouseBasics, useHouseMarkets } from "./useNearHouse";

// The house portfolio (NEXT_PUBLIC_BM_NEAR_PRODUCT=house), read from the
// contract: the balance; orders still confirming; open positions with the
// market, UP or DOWN and leverage, stake, entry, what each is worth now at
// the price it would close at and its PnL, the liquidation level, "at
// risk", the time left of its 14 days, and Close (1 % past the current
// close price; "Closing…" until it settles; a close that missed its limit
// says so and can be tapped again); then the last 20 closed positions with
// entry, exit, payout, PnL and why they ended. No claim step: the contract
// pays every close into the balance.

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
          <button type="button" onClick={openLoginModal} disabled={near.status === "loading"} className="h-8 px-3.5 inline-flex items-center rounded-full btn-magenta text-xs font-bold cursor-pointer whitespace-nowrap disabled:opacity-60">
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
          <Link href="/app" className="inline-block text-xs px-5 py-2.5 rounded-full btn-magenta font-bold">
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
        <StatTile label="Balance" value={`${fmtUsdg(data.balance)} USDG`} hero sub={<span>test USDG on NEAR testnet</span>} className="col-span-2 md:col-span-1" />
        <StatTile label="Open positions" value={`${fmtUsdg(openValue)} USDG`} sub={<span>{open.length} {open.length === 1 ? "position" : "positions"}, worth now</span>} />
        <StatTile
          label="Open PnL"
          value={<span className={openValue >= openStake ? "text-atnx-cyan light:text-atnx-cyan-light" : "text-atnx-magenta light:text-atnx-magenta-light"}>{signedUsdg(openValue - openStake)} USDG</span>}
          sub={<span>at the prices they would close at</span>}
        />
      </div>

      {near.status === "other-browser" && (
        <p className="text-[11px] text-tertiary mb-3">This account was set up in another browser, so it can be viewed here but not used. Settings can start a new one for this browser.</p>
      )}
      {funding !== "ok" && canAct && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs">
          {funding === "faucet" ? (
            <>
              <span className="text-secondary">You need test USDG to trade.</span>
              <button type="button" onClick={faucet} disabled={!!busy || faucetAmount <= 0n} className="h-8 px-3 rounded-full btn-cyan font-bold cursor-pointer disabled:opacity-50">
                {busy === "faucet" ? "Getting test USDG…" : `Get ${fmtUsdg(faucetAmount, 0)} test USDG`}
              </button>
            </>
          ) : (
            <span className="text-secondary">You have had all the test USDG this account can get.</span>
          )}
        </div>
      )}
      {error && <p className="text-xs text-atnx-magenta mb-3 break-words">{error}</p>}
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
          <h3 className="text-sm font-bold text-primary mb-1">Orders confirming</h3>
          {pending.map((p) => (
            <PositionLine key={p.id.toString()} p={p} market={chainMarkets.get(p.market) ?? null} cfg={cfg} name={nameOf(p.market)} nowMs={nowMs} busy={false} onClose={close} />
          ))}
        </Card>
      )}

      <Card className="p-4 mt-4">
        <h3 className="text-sm font-bold text-primary mb-1">Open positions</h3>
        {open.length === 0 ? (
          <p className="text-xs text-secondary py-2">
            No open positions.{" "}
            <Link href="/app" className="link-quiet underline">
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
        <h3 className="text-sm font-bold text-primary mb-1">Closed</h3>
        {data.history.length === 0 ? (
          <p className="text-xs text-secondary py-2">Nothing closed yet.</p>
        ) : (
          data.history.slice(0, 20).map((c) => <ClosedLine key={c.id.toString()} c={c} name={nameOf(c.market)} />)
        )}
        <p className="text-[11px] text-tertiary pt-2">The last 20, kept by the contract. Every close is paid straight into your balance.</p>
      </Card>

      {lastTx && (
        <a href={nearTxUrl(lastTx)} target="_blank" rel="noreferrer" className="block mt-3 text-[11px] text-tertiary link-quiet">
          View last transaction {shortHash(lastTx)} ↗
        </a>
      )}
      <p className="mt-4 text-[11px] text-tertiary">{TESTNET}</p>
    </div>
  );
}
