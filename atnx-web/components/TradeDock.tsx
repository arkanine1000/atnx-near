"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isHouseProduct } from "@/lib/near/config";

// The market page's order ticket on phones, the way Polymarket does it:
// UP and DOWN anchored just above the tab bar (Markets, +, Portfolio
// stay where a thumb expects them), and the ticket itself (amount,
// quote, submit) in a sheet that slides up from the bottom edge when
// one of them is tapped. The page behind stays scrollable: chart, pulse
// and activity are all there, only the ticket waits behind the buttons.
// Desktop keeps the ticket in its column; this renders nothing there.
//
// The sheet's header row (the handle, and the close button at the right)
// can be dragged down: the sheet follows the finger and, let go far enough
// down or with enough speed downward, closes with its usual animation from
// where it was; otherwise it settles back. Only the header row takes the
// drag, so the ticket under it scrolls as it always did.

// How long the closing animation runs before the sheet unmounts.
const CLOSE_MS = 200;
// A drag closes the sheet past this share of its height (at most
// DRAG_CLOSE_MAX_PX), or when let go moving down faster than
// DRAG_CLOSE_SPEED px/ms; it starts following after DRAG_START_PX.
const DRAG_CLOSE_SHARE = 0.25;
const DRAG_CLOSE_MAX_PX = 140;
const DRAG_CLOSE_SPEED = 0.6;
const DRAG_START_PX = 4;
const SETTLE_MS = 180;

// The sheet's name: the house ticket opens a position ("Open UP 1× · …");
// rounds and bounded markets buy.
const OPEN_WORD = isHouseProduct() ? "Open" : "Buy";

export type Side = "up" | "down";

export function TradeDock({
  renderTicket,
}: {
  // The ticket for the side that was tapped; a fresh one each time so it
  // opens on that side.
  renderTicket: (side: Side) => ReactNode;
}) {
  const [side, setSide] = useState<Side | null>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  // The drag in progress: where it started, the latest moves (for the
  // speed at release), and whether it has started following.
  const drag = useRef<{ id: number; y0: number; dy: number; moves: { y: number; t: number }[]; live: boolean } | null>(null);

  // The sheet plays its way out, then unmounts.
  const close = () => {
    if (!side || closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      setSide(null);
      setClosing(false);
      closeTimer.current = null;
    }, CLOSE_MS);
  };
  const open = (next: Side) => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
    setSide(next);
  };

  // ------------------------------------------------- drag the header down

  const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const setOffset = (dy: number, settle: boolean) => {
    const el = sheetRef.current;
    if (!el) return;
    // The opening animation holds its last frame (fill-mode both), which
    // would win over the inline transform: it is done, so it goes.
    el.style.animation = "none";
    el.style.transition = settle && !reducedMotion() ? `transform ${SETTLE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)` : "none";
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
    // The close animation starts from here (sheet-down in globals.css).
    el.style.setProperty("--sheet-drag", `${dy}px`);
  };
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    // The close button keeps its own tap; a second finger is ignored.
    if (closing || drag.current || (e.target as Element).closest("button")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.current = { id: e.pointerId, y0: e.clientY, dy: 0, moves: [{ y: e.clientY, t: e.timeStamp }], live: false };
    // Every move of this pointer comes to the header row from here, even a
    // fast first one that has already left it.
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - d.y0);
    if (!d.live) {
      if (dy < DRAG_START_PX) return;
      d.live = true;
    }
    d.dy = dy;
    d.moves.push({ y: e.clientY, t: e.timeStamp });
    if (d.moves.length > 6) d.moves.shift();
    setOffset(dy, false);
  };
  const onDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.live) return;
    const first = d.moves[0];
    const last = d.moves[d.moves.length - 1];
    const speed = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
    const height = sheetRef.current?.offsetHeight ?? 0;
    const far = d.dy >= Math.min(DRAG_CLOSE_MAX_PX, height * DRAG_CLOSE_SHARE);
    if (e.type !== "pointercancel" && (far || (speed > DRAG_CLOSE_SPEED && d.dy > 16))) {
      // Hold the offset; the close animation (the class close() sets)
      // runs on from it.
      const el = sheetRef.current;
      if (el) {
        el.style.transition = "none";
        el.style.animation = "";
      }
      close();
    } else {
      setOffset(0, true);
    }
  };

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!side) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
    // close reads the latest state through its closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side]);

  return (
    <div className="lg:hidden" data-no-swipe>
      {side && (
        <div
          className={`fixed inset-0 z-50 flex items-end ${closing ? "animate-fade-out" : "animate-fade-in"}`}
          style={{
            backgroundColor: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
          }}
          onClick={close}
        >
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-label={`${OPEN_WORD} ${side === "up" ? "UP" : "DOWN"}`}
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-h-[88svh] overflow-y-auto rounded-t-2xl bg-surface border-t border-surface shadow-2xl pb-[env(safe-area-inset-bottom)] ${
              closing ? "animate-sheet-down" : "animate-sheet-up"
            }`}
          >
            {/* The header row: the handle centred, the close button at the
                right with a 44 px target. It stays at the top while the
                ticket scrolls, and it is where the sheet is dragged down. */}
            <div
              onPointerDown={onDragStart}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onPointerCancel={onDragEnd}
              className="sticky top-0 z-10 grid grid-cols-[44px_1fr_44px] items-center h-12 px-1.5 bg-surface touch-none select-none cursor-grab active:cursor-grabbing"
            >
              <span aria-hidden="true" />
              <span aria-hidden="true" className="justify-self-center h-1.5 w-12 rounded-full bg-[#3a3a3a] light:bg-[#cfcfcf]" />
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="h-11 w-11 rounded-full inline-flex items-center justify-center text-lg text-secondary link-quiet hover-lift cursor-pointer transition-colors"
              >
                {"✕"}
              </button>
            </div>
            <div className="px-3 pb-3">{renderTicket(side)}</div>
          </div>
        </div>
      )}

      {/* Above the phone tab bar (4rem plus the safe area); from sm up
          there is no bar, so it sits on the bottom edge itself. */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] sm:bottom-0 z-40 nav-blur border-t border-surface sm:pb-[env(safe-area-inset-bottom)]">
        <div className="h-14 px-4 flex items-center gap-3 max-w-6xl mx-auto">
          <button
            type="button"
            onClick={() => open("up")}
            className="btn-cyan flex-1 h-11 rounded-xl font-bold text-sm cursor-pointer inline-flex items-center justify-center gap-1.5"
          >
            <span aria-hidden="true">{"↗"}</span> UP
          </button>
          <button
            type="button"
            onClick={() => open("down")}
            className="btn-magenta flex-1 h-11 rounded-xl font-bold text-sm cursor-pointer inline-flex items-center justify-center gap-1.5"
          >
            <span aria-hidden="true">{"↘"}</span> DOWN
          </button>
        </div>
      </div>
    </div>
  );
}
