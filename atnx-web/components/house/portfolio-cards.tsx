"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { fmtUsdg } from "@/components/bm/format";
import { Card } from "@/components/ui";
import { closeReasonLine, fmtDuration, fmtPriceE2, markPosition, secondsLeft } from "@/lib/bm/house-ticket";
import type { HouseClosed, HouseConfig, HouseMarket, HousePosition, HouseSide } from "@/lib/bm/house-types";
import { CloseControl, Help, MarketName, Parts, pctText, pnlTone, sideWord, signedUsdg } from "./parts";

// The house portfolio's position cards, in atnx.app's layout (its
// PositionCard and HistoryCard): the market's name as a link, a side and
// leverage chip with how long ago it opened or closed, the PnL large with a
// percent chip, a row of readouts, then what is particular to a house
// position and "View market ↗" with the close. atnx.app's 10 to 11 px
// labels are 13 px here, in the secondary ink, as on the rest of the page.

const YELLOW = "text-atnx-yellow light:text-atnx-yellow-light";

// UP 2× in the side's colour.
export function SideChip({ side, leverage }: { side: HouseSide; leverage: number }) {
  const tone =
    side === "Long"
      ? "bg-atnx-cyan/10 text-atnx-cyan light:text-atnx-cyan-light border-atnx-cyan/30"
      : "bg-atnx-magenta/10 text-atnx-magenta light:text-atnx-magenta-light border-atnx-magenta/30";
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[13px] font-bold uppercase leading-none tracking-wider whitespace-nowrap ${tone}`}>
      {sideWord(side)} {leverage}×
    </span>
  );
}

// A percentage in a chip, toned like the amount it goes with; plain when
// it rounds to 0.0 %.
export function PctChip({ units, pct }: { units: bigint; pct: number }) {
  const text = pctText(pct);
  const tone = text === "0.0 %" ? "text-primary" : pnlTone(units);
  const fill = tone === "text-primary" ? "bg-elevated border-surface" : units > 0n ? "bg-atnx-cyan/10 border-atnx-cyan/30" : "bg-atnx-magenta/10 border-atnx-magenta/30";
  return <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[13px] font-bold leading-none tabular-nums whitespace-nowrap ${fill} ${tone}`}>{text}</span>;
}

function Readout({ label, value, tone = "text-primary" }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[13px] text-secondary">{label}</div>
      <div className={`mt-0.5 text-base font-semibold tabular-nums truncate ${tone}`}>{value}</div>
    </div>
  );
}

function ViewMarket({ href }: { href: string | null }) {
  if (!href) return <span />;
  return (
    <Link href={href} className="text-sm text-secondary underline underline-offset-2 link-quiet">
      View market ↗
    </Link>
  );
}

const ago = (secs: number) => `${fmtDuration(secs)} ago`;
const when = (secs: number) => new Date(secs * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// An open position (or one closing): its PnL now at the price it would
// close at, Entry / Now / Stake / Value, the liquidation level and the time
// left of its 14 days, and the close.
export function OpenCard({
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
  name: string;
  href: string | null;
  nowMs: number;
  busy: boolean;
  onClose: (p: HousePosition, limitE2: bigint) => void;
}) {
  const mark = markPosition(p, market, cfg);
  const nowSecs = Math.floor(nowMs / 1000);
  const left = secondsLeft(p, cfg, nowSecs);
  return (
    <Card className="p-4 sm:p-5 min-w-0">
      <Help label="About At risk" note="Worth nothing at the price it would close at, but not liquidated: it recovers if the index does.">
        {(atRiskHelp) => (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <MarketName name={name} href={href} className="block text-lg font-bold text-primary leading-snug break-words" />
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <SideChip side={p.side} leverage={p.leverage} />
                  {p.openedAt !== null && <span className="text-[13px] text-secondary">opened {ago(nowSecs - p.openedAt)}</span>}
                </div>
              </div>
              <div className="text-right shrink-0">
                {mark ? (
                  <>
                    <div className={`font-display text-2xl font-bold leading-none tabular-nums whitespace-nowrap ${pnlTone(mark.pnl)}`}>
                      {signedUsdg(mark.pnl)} <span className="text-base">USDG</span>
                    </div>
                    <div className="mt-1.5">
                      <PctChip units={mark.pnl} pct={mark.pnlPct} />
                    </div>
                  </>
                ) : (
                  <span className="text-sm text-secondary">no price yet</span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4 pt-3 border-t border-surface">
              <Readout label="Entry" value={p.entryE2 !== null ? fmtPriceE2(p.entryE2) : "—"} tone={YELLOW} />
              <Readout label="Now" value={mark ? fmtPriceE2(mark.closeE2) : "—"} tone={YELLOW} />
              <Readout label="Stake" value={`${fmtUsdg(p.stake)} USDG`} />
              <Readout label="Value" value={mark ? `${fmtUsdg(mark.value)} USDG` : "—"} />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-secondary tabular-nums">
              <span>
                <Parts
                  items={[
                    mark ? (p.side === "Long" && p.leverage === 1 ? "No liquidation" : `Liquidation ${fmtPriceE2(mark.liquidationE2)}`) : null,
                    left !== null ? (left > 0 ? `${fmtDuration(left)} left` : "ending now") : null,
                  ].filter((d): d is string => d !== null)}
                />
              </span>
              {mark?.atRisk && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="rounded-md border border-atnx-magenta/50 px-1.5 py-0.5 text-[13px] font-bold leading-none text-atnx-magenta light:text-atnx-magenta-light">At risk</span>
                  {atRiskHelp}
                </span>
              )}
            </div>

            <div className="mt-3 pt-3 border-t border-surface flex items-center justify-between gap-3">
              <ViewMarket href={href} />
              <CloseControl
                p={p}
                market={market}
                cfg={cfg}
                nowSecs={nowSecs}
                busy={busy}
                onClose={onClose}
                label="Close position"
                className="h-9 px-4 rounded-full bg-atnx-magenta text-white text-sm font-bold shadow-[0_0_16px_rgba(255,0,229,0.25)] hover:brightness-110 transition cursor-pointer disabled:opacity-50"
              />
            </div>
          </>
        )}
      </Help>
    </Card>
  );
}

// A closed position as the contract keeps it: what it made, Entry / Exit /
// Stake / Paid back, how it ended and when.
export function ClosedCard({ c, name, href, nowMs }: { c: HouseClosed; name: string; href: string | null; nowMs: number }) {
  const pnl = c.payout - c.stake;
  const pct = c.stake > 0n ? (Number(pnl) / Number(c.stake)) * 100 : 0;
  const nowSecs = Math.floor(nowMs / 1000);
  return (
    <Card className="p-4 sm:p-5 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <MarketName name={name} href={href} className="block text-lg font-bold text-primary leading-snug break-words" />
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <SideChip side={c.side} leverage={c.leverage} />
            <span className="text-[13px] text-secondary">closed {ago(Math.max(0, nowSecs - c.closedAt))}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`font-display text-2xl font-bold leading-none tabular-nums whitespace-nowrap ${pnlTone(pnl)}`}>
            {signedUsdg(pnl)} <span className="text-base">USDG</span>
          </div>
          <div className="mt-1.5">
            <PctChip units={pnl} pct={pct} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4 pt-3 border-t border-surface">
        <Readout label="Entry" value={fmtPriceE2(c.entryE2)} tone={YELLOW} />
        <Readout label="Exit" value={fmtPriceE2(c.exitE2)} tone={YELLOW} />
        <Readout label="Stake" value={`${fmtUsdg(c.stake)} USDG`} />
        <Readout label="Paid back" value={`${fmtUsdg(c.payout)} USDG`} />
      </div>

      <div className="mt-3 pt-3 border-t border-surface flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-sm text-secondary tabular-nums">
          <Parts items={[closeReasonLine(c.reason), when(c.closedAt)]} />
        </span>
        <ViewMarket href={href} />
      </div>
    </Card>
  );
}
