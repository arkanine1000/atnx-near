"use client";

import { useId, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";
import { DOWN, UP, useChartTheme, useSize } from "@/components/charts/ViArea";
import { Card } from "@/components/ui";
import type { PnlSeries } from "@/lib/bm/house-pnl";
import { Help, pnlTone, signedUsdg } from "./parts";

// The house portfolio's chart card: the running PnL from lib/bm/house-pnl.ts
// (the last 20 closes the contract keeps, then the open positions now),
// drawn the way the market page draws the index (components/charts/ViArea:
// recharts, measured size, hairline grid, right-hand ticks, a wash under the
// line). It steps at each close, since realised PnL only moves when a
// position closes. The end value is printed in the header and beside the
// line's last point, so it reads without hovering; the ticks are 13 px.

const UNIT = 1_000_000;
const DAY_MS = 86_400_000;

interface Row {
  t: number;
  v: number;
  kind: "start" | "close" | "now";
}

function tickTime(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs <= DAY_MS) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (spanMs <= 3 * DAY_MS) return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const fullTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// "+1.23" / "−0.40" for the axis and the end label.
function signedNumber(v: number): string {
  const abs = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs === "0.00") return abs;
  return `${v > 0 ? "+" : "−"}${abs}`;
}

export function PnlChart({ series, className = "" }: { series: PnlSeries; className?: string }) {
  const t = useChartTheme();
  const { ref, w, h, ready } = useSize();
  const gradId = useId();
  const rows: Row[] = useMemo(() => series.points.map((p) => ({ t: p.t * 1000, v: Number(p.pnl) / UNIT, kind: p.kind })), [series]);
  const end = series.points.length ? series.points[series.points.length - 1].pnl : 0n;
  const plottable = rows.length >= 2 && rows[rows.length - 1].t > rows[0].t;
  const last = rows[rows.length - 1];
  const stroke = end < 0n ? DOWN : UP;
  const spanMs = plottable ? last.t - rows[0].t : 0;
  // The end label sits left of the last point, clear of the step that
  // climbs or drops into it; above it when the line arrives flat.
  const flatEnd = rows.length >= 2 && rows[rows.length - 2].v === last?.v;

  return (
    <Card className={`p-4 sm:p-5 min-w-0 flex flex-col ${className}`}>
      <Help
        label="About PnL"
        note="Your running PnL over the last 20 closed positions, the most the contract keeps, ending with what your open positions would add if they closed now. A position's PnL is what it paid back less its stake; the 1 % fee is not in it."
      >
        {(help) => (
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-mono uppercase tracking-[0.12em] text-secondary">PnL</span>
              {help}
            </div>
            {series.points.length > 0 && (
              <span className={`font-display text-xl sm:text-2xl font-bold tabular-nums leading-none ${pnlTone(end)}`}>{signedUsdg(end)} USDG</span>
            )}
          </div>
        )}
      </Help>

      <div ref={ref} className="relative mt-3 flex-1 min-h-[180px]">
        {!plottable ? (
          <div className="absolute inset-0 flex items-center justify-center text-center text-sm text-secondary px-4">Nothing to plot yet. Close a position and its PnL shows here.</div>
        ) : (
          ready && (
            <AreaChart width={w} height={h} data={rows} accessibilityLayer={false} style={{ cursor: "inherit" }} margin={{ top: 28, right: 12, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={stroke} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={stroke} stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke={t.grid} strokeWidth={1} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(v: number) => tickTime(v, spanMs)}
                tick={{ fill: t.inkMuted, fontSize: 13, fontFamily: "inherit" }}
                tickLine={false}
                axisLine={false}
                minTickGap={56}
                height={30}
              />
              {/* Zero is always in view: the line is read against it. */}
              <YAxis
                orientation="right"
                domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]}
                tick={{ fill: t.inkMuted, fontSize: 13, fontFamily: "inherit" }}
                tickLine={false}
                axisLine={false}
                width={60}
                tickFormatter={(v: number) => signedNumber(v)}
              />
              <ReferenceLine y={0} stroke={t.inkMuted} strokeWidth={1} strokeDasharray="4 3" strokeOpacity={0.6} />
              <Tooltip
                cursor={{ stroke: t.tick, strokeWidth: 1 }}
                isAnimationActive={false}
                content={({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: Row }> }) => {
                  const p = payload?.[0]?.payload;
                  if (!active || !p) return null;
                  return (
                    <div className="rounded-lg px-3 py-2 shadow-lg" style={{ background: t.tooltipBg, border: `1px solid ${t.tooltipBorder}` }}>
                      <div className="text-base font-bold tabular-nums" style={{ color: t.ink }}>
                        {signedNumber(p.v)} USDG
                      </div>
                      <div className="text-[13px] mt-0.5" style={{ color: t.inkMuted }}>
                        {p.kind === "now" ? "Now, with open positions" : p.kind === "start" ? "Before these trades" : `A close, ${fullTime(p.t)}`}
                      </div>
                    </div>
                  );
                }}
              />
              <Area
                type="stepAfter"
                dataKey="v"
                baseValue={0}
                stroke={stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                fill={`url(#${gradId})`}
                dot={(props: { cx?: number; cy?: number; index?: number }) => {
                  const r = rows[props.index ?? -1];
                  const key = `dot-${props.index}`;
                  if (!r || r.kind !== "close" || props.cx === undefined || props.cy === undefined) return <g key={key} />;
                  return <circle key={key} cx={props.cx} cy={props.cy} r={3} fill={t.surface} stroke={stroke} strokeWidth={2} />;
                }}
                activeDot={{ r: 4, fill: stroke, stroke: t.surface, strokeWidth: 2 }}
                isAnimationActive={false}
              />
              {/* The end value, beside the line's last point. */}
              <ReferenceDot
                x={last.t}
                y={last.v}
                r={4.5}
                fill={stroke}
                stroke={t.surface}
                strokeWidth={2}
                ifOverflow="visible"
                label={{ value: signedNumber(last.v), position: flatEnd ? "top" : "left", offset: 10, fill: t.ink, fontSize: 13, fontWeight: 700 }}
              />
            </AreaChart>
          )
        )}
      </div>
    </Card>
  );
}
