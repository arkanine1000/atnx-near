"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
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
import type { HouseConfig, HouseMarket, HousePosition } from "@/lib/bm/house-types";
import { cancelArgs, closeArgs } from "@/lib/bm/house-types";
import type { ActResult, NearMethod } from "@/lib/near/client";
import { nearTxUrl } from "@/lib/near/config";
import { friendlyNearError } from "@/lib/near/errors";
import type { HouseAccountData } from "./useNearHouse";
import { lastSeenPosition, seenAsClosing } from "./useNearHouse";
import { addTrack, dropTrack, emptyTracks, settleTrack, subscribeTracks, tracksOf, type StoredTrack } from "./track-store";

// The parts the house ticket and the house portfolio share: a position's
// line with its value and its Close button (the close itself, CloseControl,
// is the portfolio cards' too), the lines that follow an order
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

// A small visible "?" that opens a short note in a floating window, for
// what does not need to be on screen all the time. Not a hover tooltip: a
// tooltip shows neither in a screen recording nor on a touch screen.
// `children` gets the button to put where it belongs (beside a label, in a
// header). `label` is the button's accessible name and its title: "About
// <what>", or "How it works".
//
// The window is portalled to the body with fixed positioning worked out
// from the button's rectangle (placeHelp below), so no card, fold or sheet
// with overflow hidden or its own scroll can clip it, and it sits above the
// phone order sheet. It opens below the "?" when it fits, else above, else
// on the roomier side with its own scroll; it is moved sideways to stay
// HELP_MARGIN px inside the viewport and is never wider than it. It follows
// the button when anything scrolls or the viewport resizes, and closes when
// the button leaves the screen, on Escape, on a tap outside, on the "?"
// again, or when another one opens. Focus stays where it is (nothing is
// trapped); the button names the window with aria-controls and is
// described by it while it is open, so a screen reader reads the note.
export function Help({ label, note, children }: { label: string; note: ReactNode; children: (button: ReactNode) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  // One window at a time: opening this one closes the one before.
  useEffect(() => {
    if (!open) return;
    if (openHelp && openHelp !== close) openHelp();
    openHelp = close;
    return () => {
      if (openHelp === close) openHelp = null;
    };
  }, [open, close]);

  const button = (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      aria-describedby={open ? id : undefined}
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
        <HelpWindow id={id} anchor={buttonRef} onClose={close}>
          {note}
        </HelpWindow>
      )}
    </>
  );
}

// The open Help's close, so the next one to open can shut it.
let openHelp: (() => void) | null = null;

// Gap between the "?" and its window, and the window's least distance from
// the viewport's edges; the widest it gets (a 390 px phone leaves 366).
export const HELP_GAP = 8;
export const HELP_MARGIN = 12;
const HELP_MAX_WIDTH = 360;

export interface HelpPlacement {
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
  side: "below" | "above";
  // Where the little pointer sits along the window's edge, from its left.
  caret: number;
}

// Where the window goes, from the button's rectangle, the window's natural
// size and the viewport's: below when it fits, else above, else on the
// roomier side with its height capped there (it scrolls); centred on the
// button, then moved sideways to keep HELP_MARGIN from both edges.
export function placeHelp(
  anchor: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): HelpPlacement {
  const maxWidth = Math.max(0, Math.min(HELP_MAX_WIDTH, viewport.width - 2 * HELP_MARGIN));
  const width = Math.min(size.width, maxWidth);
  const below = viewport.height - (anchor.top + anchor.height) - HELP_GAP - HELP_MARGIN;
  const above = anchor.top - HELP_GAP - HELP_MARGIN;
  const side: "below" | "above" = size.height <= below || below >= above ? "below" : "above";
  const room = Math.max(0, side === "below" ? below : above);
  const height = Math.min(size.height, room);
  const top = side === "below" ? anchor.top + anchor.height + HELP_GAP : anchor.top - HELP_GAP - height;
  const centred = anchor.left + anchor.width / 2 - width / 2;
  const left = Math.min(Math.max(centred, HELP_MARGIN), viewport.width - HELP_MARGIN - width);
  const caret = Math.min(Math.max(anchor.left + anchor.width / 2 - left, 14), Math.max(14, width - 14));
  return { left: Math.round(left), top: Math.round(top), maxWidth, maxHeight: Math.floor(room), side, caret: Math.round(caret) };
}

function HelpWindow({ id, anchor, onClose, children }: { id: string; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void; children: ReactNode }) {
  // The window (placed, with its pointer) and the note inside it (which
  // scrolls when the window is capped).
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<HelpPlacement | null>(null);

  // Measured and placed before the browser paints, then again on every
  // scroll (any scroller: the page, a card, the phone sheet) and resize.
  useLayoutEffect(() => {
    const box = ref.current;
    const el = body.current;
    const btn = anchor.current;
    if (!box || !el || !btn) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const r = btn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      // The "?" has left the screen (or its sheet closed): so does the note.
      if (r.width === 0 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {
        onClose();
        return;
      }
      // The natural size, unconstrained by the last placement; the
      // window's border (1 px a side) comes on top of the note's.
      const edge = box.offsetWidth - box.clientWidth;
      el.style.maxHeight = "none";
      el.style.maxWidth = `${Math.min(HELP_MAX_WIDTH, vw - 2 * HELP_MARGIN) - edge}px`;
      const size = { width: el.offsetWidth + edge, height: el.scrollHeight + edge };
      const next = placeHelp({ left: r.left, top: r.top, width: r.width, height: r.height }, size, { width: vw, height: vh });
      el.style.maxWidth = `${next.maxWidth - edge}px`;
      el.style.maxHeight = `${next.maxHeight - edge}px`;
      setPlace((p) => (p && p.left === next.left && p.top === next.top && p.maxWidth === next.maxWidth && p.maxHeight === next.maxHeight && p.side === next.side && p.caret === next.caret ? p : next));
    };
    update();
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [anchor, onClose]);

  // Escape closes it before anything else hears the key (the phone sheet
  // and the Show Me modal close on Escape too); a press outside the window
  // and its "?" closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [anchor, onClose]);

  const below = place?.side !== "above";
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="note"
      data-help-window=""
      data-no-swipe=""
      data-side={place?.side}
      style={{ position: "fixed", left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? "visible" : "hidden" }}
      className="z-[60] rounded-xl border border-surface bg-elevated shadow-[0_12px_32px_rgba(0,0,0,0.45)] light:shadow-[0_12px_32px_rgba(0,0,0,0.14)]"
    >
      {/* The pointer to the "?": a square turned 45°, its two outer edges
          bordered, half outside the window. */}
      <span
        aria-hidden="true"
        style={{ left: (place?.caret ?? 14) - 6 }}
        className={`absolute h-3 w-3 rotate-45 bg-elevated border-surface ${below ? "-top-1.5 border-l border-t" : "-bottom-1.5 border-r border-b"}`}
      />
      <div ref={body} className="relative w-max overflow-y-auto overscroll-contain rounded-xl px-3.5 py-3 text-sm leading-snug text-primary">
        {children}
      </div>
    </div>,
    document.body,
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
              <CloseControl
                p={p}
                market={market}
                cfg={cfg}
                nowSecs={nowSecs}
                busy={busy}
                onClose={onClose}
                label="Close"
                className="h-9 px-4 rounded-lg border border-surface text-sm text-primary btn-quiet font-bold cursor-pointer disabled:opacity-50"
              />
            </div>
          </>
        )}
      </Help>
    </div>
  );
}

// The worst price a close sends now (1 % past the price it would close at),
// or null when the position cannot be closed from here: not open yet or
// already closing, its market ended, no price, or its 14 days are up.
export function closeLimitOf(p: HousePosition, market: HouseMarket | null, cfg: HouseConfig, nowSecs: number): bigint | null {
  const left = secondsLeft(p, cfg, nowSecs);
  const q = market ? newestQuote(market) : null;
  const closeAt = q ? closePrice(quotePrices(q.scoreE2, q.readingE2, cfg), p.side) : null;
  const canClose = p.state === "Open" && market?.status !== "Settled" && closeAt !== null && closeAt > 0n && (left === null || left > 0);
  return canClose ? limitPastE2(closeAt!, p.side, "close") : null;
}

// A position's close: "Closing…" while one is in flight, the button
// (named "Close position") while it can be closed, or the line for a market
// that has ended.
export function CloseControl({
  p,
  market,
  cfg,
  nowSecs,
  busy,
  onClose,
  label,
  className,
}: {
  p: HousePosition;
  market: HouseMarket | null;
  cfg: HouseConfig;
  nowSecs: number;
  busy: boolean;
  onClose: (p: HousePosition, limitE2: bigint) => void;
  label: string;
  className: string;
}) {
  const closeLimit = closeLimitOf(p, market, cfg, nowSecs);
  if (p.state === "Closing") return <span className="text-sm text-secondary animate-pulse">Closing…</span>;
  if (closeLimit !== null) {
    return (
      <button
        type="button"
        disabled={busy}
        aria-label="Close position"
        onClick={() => onClose(p, closeLimit)}
        title={`Closes at the ${p.side === "Long" ? "sell" : "buy"} price, no worse than ${fmtPriceE2(closeLimit)}`}
        className={className}
      >
        {busy ? "Closing…" : label}
      </button>
    );
  }
  if (p.state === "Open" && market?.status === "Settled") return <span className="text-sm text-secondary">Closing at the last score</span>;
  return null;
}

// A row's market name, linking to its market page when there is one. The
// ink stays primary (.text-primary is unlayered, so a hover colour would
// not apply); the underline says it is a link.
export function MarketName({ name, href, className = "block text-base font-bold text-primary truncate" }: { name: string; href?: string | null; className?: string }) {
  const cls = className;
  if (!href) return <div className={cls}>{name}</div>;
  return (
    <Link href={href} className={`${cls} underline-offset-2 hover:underline focus-visible:underline`}>
      {name}
    </Link>
  );
}

// A second line's parts, " · " between them, each kept whole when the line
// wraps on a phone ("13 d 23 h left", not "13 d" and "23 h left").
export function Parts({ items }: { items: string[] }) {
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
