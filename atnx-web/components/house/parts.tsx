"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { nearTxUrl } from "@/lib/near/config";
import { friendlyNearError } from "@/lib/near/errors";
import type { HouseAccountData } from "./useNearHouse";
import { lastSeenPosition, seenAsClosing } from "./useNearHouse";
import { addTrack, dropTrack, emptyTracks, settleTrack, subscribeTracks, tracksOf, type StoredTrack } from "./track-store";

// The parts the house ticket and the house portfolio share: a position's
// line with its value and its Close button, the lines that follow an order
// or a close after the tap, the "How it works" rules, the TESTNET chip and
// the "?" help control.
//
// Legibility: the ticket, the portfolio and Settings are filmed for a demo
// that gets compressed, so no visible text here is under 13 px, the numbers
// a viewer has to catch are 16 px and semi-bold, and anything to be read is
// in the primary or secondary ink; the tertiary ink is for decoration and
// disabled states. What does not need to be on screen sits behind a "?".

export const TESTNET = "Testnet · test USDG, no value.";

type Act = (method: NearMethod, args: Record<string, unknown>) => Promise<ActResult>;

export const sideWord = (s: HousePosition["side"]) => (s === "Long" ? "UP" : "DOWN");
export const sideTone = (s: HousePosition["side"]) => (s === "Long" ? "text-atnx-cyan light:text-atnx-cyan-light" : "text-atnx-magenta light:text-atnx-magenta-light");
const gainTone = (up: boolean) => (up ? "text-atnx-cyan light:text-atnx-cyan-light" : "text-atnx-magenta light:text-atnx-magenta-light");

// ------------------------------------------------------------------- help

// A small visible "?" that opens a short note in place, for what does not
// need to be on screen all the time. Not a hover tooltip: a tooltip shows
// neither in a screen recording nor on a touch screen. `children` gets the
// button to put where it belongs (beside a label, in a header); the note
// opens after whatever `children` renders. `label` is the button's
// accessible name and its title: "About <what>", or "How it works".
export function Help({ label, note, children, noteClassName = "" }: { label: string; note: ReactNode; children: (button: ReactNode) => ReactNode; noteClassName?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      aria-label={label}
      title={label}
      className={`relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[13px] font-bold leading-none align-middle cursor-pointer after:absolute after:-inset-2 after:content-[''] ${
        open ? "border-atnx-cyan text-atnx-cyan light:border-atnx-cyan-light light:text-atnx-cyan-light" : "border-surface text-secondary btn-quiet"
      }`}
    >
      ?
    </button>
  );
  return (
    <>
      {children(button)}
      {open && (
        <div id={id} className={`mt-2 rounded-lg border border-surface bg-elevated px-3 py-2 text-sm leading-snug text-secondary ${noteClassName}`}>
          {note}
        </div>
      )}
    </>
  );
}

// "TESTNET", beside a title: the money here is test USDG, with no value.
export function TestnetChip() {
  return (
    <span title={TESTNET} className="inline-flex shrink-0 items-center rounded-md border border-surface bg-elevated px-1.5 py-0.5 font-mono text-[13px] font-bold uppercase leading-none tracking-wider text-secondary">
      Testnet
    </span>
  );
}

export function pctText(pct: number): string {
  const r = Math.round(pct * 10) / 10;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(1)} %`;
}

// A profit or loss in USDG with its sign. One that rounds to 0.00 is
// written 0.00, with no sign.
export function signedUsdg(units: bigint): string {
  const abs = fmtUsdg(units < 0n ? -units : units);
  if (showsAsZero(units)) return abs;
  return `${units > 0n ? "+" : "−"}${abs}`;
}

function showsAsZero(units: bigint): boolean {
  return /^[0.,]+$/.test(fmtUsdg(units < 0n ? -units : units));
}

// The ink of a profit or loss: a gain, a loss, or plain when it rounds to 0.00.
export function pnlTone(units: bigint): string {
  return showsAsZero(units) ? "text-primary" : gainTone(units > 0n);
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
    (id: bigint, kind: Tracked["kind"], onMarket?: number, txHash?: string) => {
      if (accountId) addTrack(accountId, { id, kind, sentAtMs: Date.now(), last: null, market: onMarket, txHash });
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

// Each line is a notice: 15 px in the primary ink, tinted cyan when an
// order filled or a close paid, magenta when one was refunded or missed,
// with the transaction's link inside it.
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
  tracks: StoredTrack[];
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
        // A close that paid out, or an order that filled; an order that
        // filled and then ended (liquidated, expired) is said plainly.
        const good = o.phase === "filled" || (o.phase === "closed" && t.kind === "close");
        const tint = bad ? "border-atnx-magenta/50 bg-atnx-magenta/10" : good ? "border-atnx-cyan/50 bg-atnx-cyan/10" : "border-surface bg-elevated";
        return (
          <div key={t.id.toString()} className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 ${tint}`}>
            <p className={`min-w-0 text-[15px] leading-snug text-primary ${done ? "font-semibold" : ""}`} role="status">
              {!done && <span aria-hidden="true" className="mr-2 inline-block h-2 w-2 rounded-full bg-atnx-cyan align-middle animate-pulse" />}
              {trackLine(t, o)}
              {t.txHash && (
                <>
                  {" "}
                  <a href={nearTxUrl(t.txHash)} target="_blank" rel="noreferrer" title={t.txHash} className="whitespace-nowrap text-sm font-normal text-secondary underline underline-offset-2 link-quiet">
                    View transaction ↗
                  </a>
                </>
              )}
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
                className="shrink-0 h-8 px-3 rounded-lg border border-surface text-sm text-secondary btn-quiet font-bold cursor-pointer disabled:opacity-50"
              >
                {busy === t.id.toString() ? "Cancelling…" : "Cancel"}
              </button>
            ) : done ? (
              <button
                type="button"
                onClick={() => onDismiss(t.id)}
                aria-label="Dismiss"
                className="shrink-0 -mr-1 -mt-0.5 h-7 w-7 inline-flex items-center justify-center rounded-md text-lg leading-none text-secondary link-quiet cursor-pointer"
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
      {error && <p className="text-sm text-atnx-magenta light:text-atnx-magenta-light break-words">{error}</p>}
    </div>
  );
}

// -------------------------------------------------------------- positions

// One position: side, leverage and stake on the first line, with what it is
// worth now at the price it would close at and its PnL on the right; the
// entry, the liquidation level and the time left of its 14 days on the
// second; "at risk"; and Close. A pending order says it is confirming; a
// closing one, that it is closing.
export function PositionLine({
  p,
  market,
  cfg,
  name,
  href,
  nowMs,
  busy,
  onClose,
}: {
  p: HousePosition;
  market: HouseMarket | null;
  cfg: HouseConfig;
  // The market's name, in the portfolio, and its page.
  name?: string | null;
  href?: string | null;
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
  const closeLimit = canClose ? limitPastE2(closeAt!, p.side, "close") : null;
  // The second line: entry, liquidation level, time left.
  const details = [
    p.entryE2 !== null ? `Entry ${fmtPriceE2(p.entryE2)}` : null,
    mark ? (p.side === "Long" && p.leverage === 1 ? "No liquidation" : `Liquidation ${fmtPriceE2(mark.liquidationE2)}`) : null,
    mark && left !== null ? (left > 0 ? `${fmtDuration(left)} left` : "ending now") : null,
  ].filter((d): d is string => d !== null);
  return (
    <div className="py-3 border-b border-surface last:border-b-0">
      <Help label="About At risk" note="Worth nothing at the price it would close at, but not liquidated: it recovers if the index does.">
        {(atRiskHelp) => (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {name && <MarketName name={name} href={href} />}
                <div className="text-base text-primary">
                  <span className={`font-bold ${sideTone(p.side)}`}>{sideWord(p.side)}</span>{" "}
                  <span className="font-semibold tabular-nums">
                    {p.leverage}× · {fmtUsdg(p.stake)} USDG
                  </span>
                </div>
                {details.length > 0 && (
                  <div className="mt-0.5 text-[13px] text-secondary tabular-nums">
                    <Parts items={details} />
                  </div>
                )}
              </div>
              <div className="text-right shrink-0">
                {p.state === "Pending" ? (
                  <span className="text-sm text-secondary animate-pulse">Confirming…</span>
                ) : mark ? (
                  <>
                    <div className="text-base tabular-nums font-bold text-primary">{fmtUsdg(mark.value)} USDG</div>
                    <div className={`text-base font-semibold tabular-nums ${pnlTone(mark.pnl)}`}>
                      {signedUsdg(mark.pnl)} ({pctText(mark.pnlPct)})
                    </div>
                    {mark.atRisk && (
                      <span className="mt-1 inline-flex items-center gap-1.5">
                        <span className="rounded-md border border-atnx-magenta/50 px-1.5 py-0.5 text-[13px] font-bold leading-none text-atnx-magenta light:text-atnx-magenta-light">At risk</span>
                        {atRiskHelp}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-sm text-secondary">no price yet</span>
                )}
              </div>
            </div>
            <div className="mt-2 flex justify-end">
              {p.state === "Closing" ? (
                <span className="text-sm text-secondary animate-pulse">Closing…</span>
              ) : canClose ? (
                <button
                  type="button"
                  disabled={busy}
                  aria-label="Close position"
                  onClick={() => onClose(p, closeLimit!)}
                  title={`Closes at the ${p.side === "Long" ? "sell" : "buy"} price, no worse than ${fmtPriceE2(closeLimit!)}`}
                  className="h-9 px-4 rounded-lg border border-surface text-sm text-primary btn-quiet font-bold cursor-pointer disabled:opacity-50"
                >
                  {busy ? "Closing…" : "Close"}
                </button>
              ) : p.state === "Open" && market?.status === "Settled" ? (
                <span className="text-sm text-secondary">Closing at the last score</span>
              ) : null}
            </div>
          </>
        )}
      </Help>
    </div>
  );
}

// A row's market name, linking to its market page when there is one. The
// ink stays primary (.text-primary is unlayered, so a hover colour would
// not apply); the underline says it is a link.
function MarketName({ name, href }: { name: string; href?: string | null }) {
  const cls = "block text-base font-bold text-primary truncate";
  if (!href) return <div className={cls}>{name}</div>;
  return (
    <Link href={href} className={`${cls} underline-offset-2 hover:underline focus-visible:underline`}>
      {name}
    </Link>
  );
}

// A second line's parts, " · " between them, each kept whole when the line
// wraps on a phone ("13 d 23 h left", not "13 d" and "23 h left").
function Parts({ items }: { items: string[] }) {
  return (
    <>
      {items.map((s, i) => (
        <span key={i}>
          {i > 0 && " · "}
          <span className="whitespace-nowrap">{s}</span>
        </span>
      ))}
    </>
  );
}

// A position that has ended, for the history list: side, leverage and
// stake, with the payout and PnL on the right; entry → exit, how it ended
// and when on the second line.
export function ClosedLine({ c, name, href }: { c: HouseClosed; name?: string | null; href?: string | null }) {
  const pnl = c.payout - c.stake;
  const pct = c.stake > 0n ? (Number(pnl) / Number(c.stake)) * 100 : 0;
  return (
    <div className="py-3 border-b border-surface last:border-b-0 flex items-start justify-between gap-3">
      <div className="min-w-0">
        {name && <MarketName name={name} href={href} />}
        <div className="text-base text-primary">
          <span className={`font-bold ${sideTone(c.side)}`}>{sideWord(c.side)}</span>{" "}
          <span className="font-semibold tabular-nums">
            {c.leverage}× · {fmtUsdg(c.stake)} USDG
          </span>
        </div>
        <div className="mt-0.5 text-[13px] text-secondary tabular-nums">
          <Parts
            items={[
              `${fmtPriceE2(c.entryE2)} → ${fmtPriceE2(c.exitE2)}`,
              closeReasonLine(c.reason),
              new Date(c.closedAt * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
            ]}
          />
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-base tabular-nums font-bold text-primary">{fmtUsdg(c.payout)} USDG</div>
        <div className={`text-base font-semibold tabular-nums ${pnlTone(pnl)}`}>
          {signedUsdg(pnl)} ({pctText(pct)})
        </div>
      </div>
    </div>
  );
}

// Sends a close at `limitE2` and starts following it; a refusal comes back
// as words.
export async function sendClose(act: Act, p: HousePosition, limitE2: bigint, add: (id: bigint, kind: Tracked["kind"], market?: number, txHash?: string) => void): Promise<string | null> {
  try {
    const r = await act("close", closeArgs(p.id, limitE2));
    add(p.id, "close", p.market, r.txHash);
    return null;
  } catch (e) {
    return friendlyNearError(e);
  }
}

// ----------------------------------------------------------- how it works

// The one place the ticket explains itself, behind the "?" in its header.
export function HowItWorks() {
  return (
    <ul className="list-disc pl-4 space-y-1.5">
      <li>UP gains when the index rises, DOWN when it falls, at 1× (no leverage), 2× or 3×.</li>
      <li>There are two prices. You get in at the buy price on UP and out at the sell price; DOWN the other way round. When the index is still catching up with a new reading they differ, so a new position usually starts a little down.</li>
      <li>Your order fills a few seconds after you tap, at a price read after the tap, and never worse than the worst price you accept.</li>
      <li>You can lose at most what you put in. A win is capped: an UP position pays back at most ten times its amount.</li>
      <li>If both prices reach the liquidation level, the position closes and its amount is lost. A 1× UP position has no such level.</li>
      <li>The fee is 1 % of the amount, paid when the order fills. A position ends by itself after 14 days.</li>
      <li>When you close, the payout goes straight to your balance.</li>
    </ul>
  );
}

// A transaction with no notice of its own to carry its link (a test USDG
// claim): one legible line.
export function LastTxLink({ txHash, className = "" }: { txHash: string; className?: string }) {
  return (
    <a href={nearTxUrl(txHash)} target="_blank" rel="noreferrer" title={txHash} className={`block text-sm text-secondary underline underline-offset-2 link-quiet ${className}`}>
      View last transaction ↗
    </a>
  );
}
