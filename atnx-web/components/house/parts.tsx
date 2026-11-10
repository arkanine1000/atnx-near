"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { fmtUsdg } from "@/components/bm/format";
import { closePrice, quotePrices, newestQuote } from "@/lib/bm/house-math";
import {
  closeReasonLine,
  fmtDuration,
  fmtPriceE2,
  limitPastE2,
  markPosition,
  refundLine,
  secondsLeft,
  trackOutcome,
  type Tracked,
  type TrackedOutcome,
} from "@/lib/bm/house-ticket";
import type { HouseClosed, HouseConfig, HouseMarket, HousePosition } from "@/lib/bm/house-types";
import { cancelArgs, closeArgs } from "@/lib/bm/house-types";
import type { ActResult, NearMethod } from "@/lib/near/client";
import { friendlyNearError } from "@/lib/near/errors";
import type { HouseAccountData } from "./useNearHouse";
import { lastSeenPosition, seenAsClosing } from "./useNearHouse";
import { addTrack, dropTrack, emptyTracks, settleTrack, subscribeTracks, tracksOf, type StoredTrack } from "./track-store";

// The parts the house ticket and the house portfolio share: a position's
// line with its value and its Close button, the lines that follow an order
// or a close after the tap, and the "How it works" footer.

export const TESTNET = "Testnet · test USDG, no value.";

type Act = (method: NearMethod, args: Record<string, unknown>) => Promise<ActResult>;

export const sideWord = (s: HousePosition["side"]) => (s === "Long" ? "UP" : "DOWN");
export const sideTone = (s: HousePosition["side"]) => (s === "Long" ? "text-atnx-cyan" : "text-atnx-magenta");

export function pctText(pct: number): string {
  const r = Math.round(pct * 10) / 10;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(1)} %`;
}

export function signedUsdg(units: bigint): string {
  return `${units > 0n ? "+" : units < 0n ? "−" : ""}${fmtUsdg(units < 0n ? -units : units)}`;
}

// ---------------------------------------------------------------- tracks

// The orders and closes this account sent from this tab, followed until
// they resolve. Kept for the tab (./track-store.ts), so a reload, or the
// portfolio after the market page, still says what became of them. With
// `market`, only that market's.
export function useTracks(accountId: string | null, market?: number | null) {
  const all = useSyncExternalStore(subscribeTracks, () => tracksOf(accountId), emptyTracks);
  const tracks: StoredTrack[] = market === undefined || market === null ? all : all.filter((t) => t.market === undefined || t.market === market);
  const add = useCallback(
    (id: bigint, kind: Tracked["kind"], onMarket?: number) => {
      if (accountId) addTrack(accountId, { id, kind, sentAtMs: Date.now(), last: null, market: onMarket });
    },
    [accountId],
  );
  const dismiss = useCallback((id: bigint) => accountId && dropTrack(accountId, id), [accountId]);
  const settle = useCallback((id: bigint) => accountId && settleTrack(accountId, id), [accountId]);
  return { tracks, add, dismiss, settle };
}

// A track's outcome now, from the account's positions and history and its
// market; the position as last read while it waited fills in what a gone
// order looked like.
// Null while there is nothing to say yet: the account, the config or (when
// `market` is undefined) the market not read yet.
export function outcomeOf(t: Tracked, account: HouseAccountData | null, market: HouseMarket | null | undefined, cfg: HouseConfig | null, nowMs: number): TrackedOutcome | null {
  if (!account || !cfg || market === undefined) return null;
  const position = account.positions.find((p) => p.id === t.id) ?? null;
  const full: Tracked = { ...t, last: t.last ?? lastSeenPosition(t.id), sawClosing: t.sawClosing || seenAsClosing(t.id) };
  return trackOutcome(full, { position, history: account.history, market }, cfg, nowMs);
}

export function trackLine(t: Tracked, o: TrackedOutcome): string {
  if (o.phase === "waiting") {
    if (t.kind === "close") return "Closing… This usually takes about 10 seconds.";
    if (o.cancellable) return "Your order has not filled. You can cancel it now and get your stake and fee back.";
    if (o.slow) return "This is taking longer than usual. If it has not filled after 15 minutes, you can cancel it and get your stake and fee back.";
    return "Confirming your order… This usually takes about 10 seconds.";
  }
  if (o.phase === "filled") return o.entryE2 > 0n ? `Filled at ${fmtPriceE2(o.entryE2)}.` : "Filled.";
  if (o.phase === "refunded") return refundLine(o.reason);
  if (o.phase === "close_missed") return "Not closed: the price moved past your limit in those seconds. Tap Close to try again.";
  // closed
  if (t.kind === "open") return o.closed ? `Filled, then closed: ${closeReasonLine(o.closed.reason).toLowerCase()}.` : "Filled, then closed.";
  return o.closed ? `Closed. ${fmtUsdg(o.closed.payout)} USDG is back in your balance.` : "Closed. The payout is in your balance.";
}

export function TrackLines({
  tracks,
  account,
  marketOf,
  cfg,
  nowMs,
  act,
  onDismiss,
  onSettled,
}: {
  tracks: Tracked[];
  account: HouseAccountData | null;
  // Undefined while the market is still being read.
  marketOf: (id: bigint) => HouseMarket | null | undefined;
  cfg: HouseConfig | null;
  nowMs: number;
  act: Act;
  onDismiss: (id: bigint) => void;
  // A line now shows how its order or close ended.
  onSettled?: (id: bigint) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const outcomes = tracks.map((t) => [t, outcomeOf(t, account, marketOf(t.id), cfg, nowMs)] as const);
  const settled = outcomes
    .filter(([, o]) => o && o.phase !== "waiting")
    .map(([t]) => t.id.toString())
    .join(",");
  useEffect(() => {
    if (!onSettled || !settled) return;
    for (const id of settled.split(",")) onSettled(BigInt(id));
  }, [settled, onSettled]);
  if (tracks.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {outcomes.map(([t, o]) => {
        if (!o) return null;
        const done = o.phase !== "waiting";
        const bad = o.phase === "refunded" || o.phase === "close_missed";
        return (
          <div key={t.id.toString()} className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-xs ${bad ? "border-atnx-magenta/40" : "border-surface"}`}>
            <p className={`min-w-0 ${done ? "text-secondary" : "text-secondary animate-pulse"}`} role="status">
              {trackLine(t, o)}
            </p>
            {o.phase === "waiting" && o.cancellable ? (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => {
                  setBusy(t.id.toString());
                  setError(null);
                  act("cancel", cancelArgs(t.id))
                    .catch((e) => setError(friendlyNearError(e)))
                    .finally(() => setBusy(null));
                }}
                className="shrink-0 h-7 px-2.5 rounded-lg border border-surface text-secondary btn-quiet font-bold cursor-pointer disabled:opacity-50"
              >
                {busy === t.id.toString() ? "Cancelling…" : "Cancel"}
              </button>
            ) : done ? (
              <button type="button" onClick={() => onDismiss(t.id)} aria-label="Dismiss" className="shrink-0 text-tertiary link-quiet cursor-pointer">
                ×
              </button>
            ) : null}
          </div>
        );
      })}
      {error && <p className="text-xs text-atnx-magenta break-words">{error}</p>}
    </div>
  );
}

// -------------------------------------------------------------- positions

// One position: side and leverage, stake, entry, what it is worth now at
// the price it would close at and its PnL, the liquidation level, "at
// risk", the time left of its 14 days, and Close. A pending order says it
// is confirming; a closing one, that it is closing.
export function PositionLine({
  p,
  market,
  cfg,
  name,
  nowMs,
  busy,
  onClose,
}: {
  p: HousePosition;
  market: HouseMarket | null;
  cfg: HouseConfig;
  // The market's name, in the portfolio.
  name?: string | null;
  nowMs: number;
  busy: boolean;
  onClose: (p: HousePosition, limitE2: bigint) => void;
}) {
  const mark = markPosition(p, market, cfg);
  const nowSecs = Math.floor(nowMs / 1000);
  const left = secondsLeft(p, cfg, nowSecs);
  const q = market ? newestQuote(market) : null;
  const closeAt = q ? closePrice(quotePrices(q.scoreE2, q.readingE2, cfg), p.side) : null;
  const canClose = p.state === "Open" && market?.status !== "Settled" && closeAt !== null && closeAt > 0n && (left === null || left > 0);
  return (
    <div className="py-2.5 border-b border-surface last:border-b-0 text-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {name && <div className="text-primary font-bold truncate">{name}</div>}
          <div className="text-secondary">
            <span className={`font-bold ${sideTone(p.side)}`}>{sideWord(p.side)}</span> {p.leverage}× · <span className="tabular-nums">{fmtUsdg(p.stake)}</span> USDG
            {p.entryE2 !== null && <span className="text-tertiary tabular-nums"> · entry {fmtPriceE2(p.entryE2)}</span>}
          </div>
          {mark && (
            <div className="text-tertiary tabular-nums mt-0.5">
              Liquidation {fmtPriceE2(mark.liquidationE2)}
              {left !== null && <> · {left > 0 ? `${fmtDuration(left)} left` : "ending now"}</>}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          {p.state === "Pending" ? (
            <span className="text-secondary animate-pulse">Confirming…</span>
          ) : mark ? (
            <>
              <div className="tabular-nums font-bold text-primary">{fmtUsdg(mark.value)} USDG</div>
              <div className={`tabular-nums ${mark.pnl >= 0n ? "text-atnx-cyan" : "text-atnx-magenta"}`}>
                {signedUsdg(mark.pnl)} ({pctText(mark.pnlPct)})
              </div>
              {mark.atRisk && (
                <span
                  className="inline-block mt-0.5 rounded-md border border-atnx-magenta/50 px-1.5 text-[10px] font-bold text-atnx-magenta"
                  title="Worth nothing at the price it would close at, but not liquidated: it recovers if the index does."
                >
                  At risk
                </span>
              )}
            </>
          ) : (
            <span className="text-tertiary">no price yet</span>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex justify-end">
        {p.state === "Closing" ? (
          <span className="text-secondary animate-pulse">Closing…</span>
        ) : canClose ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onClose(p, limitPastE2(closeAt!, p.side, "close"))}
            title={`Closes at the ${p.side === "Long" ? "sell" : "buy"} price, no worse than ${fmtPriceE2(limitPastE2(closeAt!, p.side, "close"))}`}
            className="h-7 px-3 rounded-lg border border-surface text-secondary btn-quiet font-bold cursor-pointer disabled:opacity-50"
          >
            {busy ? "Closing…" : "Close"}
          </button>
        ) : p.state === "Open" && market?.status === "Settled" ? (
          <span className="text-tertiary">Closing at the last score</span>
        ) : null}
      </div>
    </div>
  );
}

// A position that has ended, for the history list.
export function ClosedLine({ c, name }: { c: HouseClosed; name?: string | null }) {
  const pnl = c.payout - c.stake;
  const pct = c.stake > 0n ? (Number(pnl) / Number(c.stake)) * 100 : 0;
  return (
    <div className="py-2.5 border-b border-surface last:border-b-0 text-xs flex items-start justify-between gap-3">
      <div className="min-w-0">
        {name && <div className="text-primary font-bold truncate">{name}</div>}
        <div className="text-secondary">
          <span className={`font-bold ${sideTone(c.side)}`}>{sideWord(c.side)}</span> {c.leverage}× · <span className="tabular-nums">{fmtUsdg(c.stake)}</span> USDG
        </div>
        <div className="text-tertiary tabular-nums mt-0.5">
          {fmtPriceE2(c.entryE2)} → {fmtPriceE2(c.exitE2)} · {closeReasonLine(c.reason)} · {new Date(c.closedAt * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="tabular-nums font-bold text-primary">{fmtUsdg(c.payout)} USDG</div>
        <div className={`tabular-nums ${pnl >= 0n ? "text-atnx-cyan" : "text-atnx-magenta"}`}>
          {signedUsdg(pnl)} ({pctText(pct)})
        </div>
      </div>
    </div>
  );
}

// Sends a close at `limitE2` and starts following it; a refusal comes back
// as words.
export async function sendClose(act: Act, p: HousePosition, limitE2: bigint, add: (id: bigint, kind: Tracked["kind"], market?: number) => void): Promise<string | null> {
  try {
    await act("close", closeArgs(p.id, limitE2));
    add(p.id, "close", p.market);
    return null;
  } catch (e) {
    return friendlyNearError(e);
  }
}

// ------------------------------------------------------------------ footer

// The one place the ticket explains itself, collapsed, with the testnet
// note beside it.
export function HouseFooter() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 pt-3 border-t border-surface text-[11px] text-tertiary">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="link-quiet cursor-pointer">
          {open ? "▾" : "▸"} How it works
        </button>
        <span>{TESTNET}</span>
      </div>
      {open && (
        <ul className="mt-2 list-disc pl-4 space-y-1 text-secondary">
          <li>UP gains when the index rises, DOWN when it falls, at 2× or 3× leverage.</li>
          <li>There are two prices. You get in at the buy price on UP and out at the sell price; DOWN the other way round. When the index is still catching up with a new reading they differ, so a new position usually starts a little down.</li>
          <li>Your order fills a few seconds after you tap, at a price read after the tap, and never worse than the worst price you accept.</li>
          <li>You can lose at most what you put in. A win is capped: an UP position pays back at most ten times its amount.</li>
          <li>If both prices reach the liquidation level, the position closes and its amount is lost.</li>
          <li>The fee is 1 % of the amount, paid when the order fills. A position ends by itself after 14 days.</li>
          <li>When you close, the payout goes straight to your balance.</li>
        </ul>
      )}
    </div>
  );
}
