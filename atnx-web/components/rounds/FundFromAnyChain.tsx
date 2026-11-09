"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { fmtDuration, fmtFee, fmtUsdc, ORIGINS, originByChain, parseUsdcAmount, quoteErrorText, type OriginChain, type QuotePreview } from "@/lib/near/intents";

// "Fund from any chain", in the NEAR block of Settings: pick the chain your
// USDC is on and an amount, and see a live NEAR Intents price for bringing
// it to NEAR: what you send, what arrives, the fee and the time. A preview
// only: ATNX runs on NEAR testnet and NEAR Intents has no testnet, so the
// server asks for dry quotes, which move no money (lib/near/intents.ts,
// lib/near/README.md). The ticket's "no USDG" state links here.

export const FUND_ANCHOR = "fund-from-any-chain";
export const FUND_HREF = `/app/settings#${FUND_ANCHOR}`;

const PREVIEW_LINE = "Preview only: ATNX runs on NEAR testnet, so no money moves.";
const STAND_IN = "Priced for delivery to a stand-in NEAR account, because your ATNX account is on testnet.";
const RETRYABLE = new Set(["timeout", "busy", "upstream", "network"]);

class QuoteFailed extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

// 6-decimal units -> the amount string the route takes ("25.000000").
function amountText(units: bigint): string {
  return `${units / 1_000_000n}.${(units % 1_000_000n).toString().padStart(6, "0")}`;
}

async function fetchQuote(chain: OriginChain, units: bigint, signal: AbortSignal): Promise<QuotePreview> {
  let res: Response;
  try {
    res = await fetch("/api/near/intents/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chain, amount: amountText(units) }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new QuoteFailed("Could not reach ATNX. Check your connection and try again.", "network");
  }
  const body = (await res.json().catch(() => null)) as { quote?: QuotePreview; error?: string; message?: string } | null;
  if (!res.ok || !body?.quote) throw new QuoteFailed(body?.message ?? quoteErrorText("upstream"), body?.error ?? "upstream");
  return body.quote;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function FundFromAnyChain() {
  const ref = useRef<HTMLDivElement>(null);
  const [chain, setChain] = useState<OriginChain>("sol");
  const [amount, setAmount] = useState("25");
  const typed = useDebounced(amount.trim(), 400);
  const check = parseUsdcAmount(typed);
  const units = check.ok ? check.units : null;

  // Arriving from the ticket's link: this block renders after the page has
  // loaded, so the browser's own jump to the anchor misses it.
  useEffect(() => {
    if (window.location.hash === `#${FUND_ANCHOR}`) ref.current?.scrollIntoView({ block: "center" });
  }, []);

  const quote = useQuery({
    queryKey: ["near", "intents", "quote", chain, units?.toString() ?? null],
    enabled: units !== null,
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => fetchQuote(chain, units!, signal),
  });

  const typing = amount.trim() !== typed;
  const invalid = typed.length > 0 && !check.ok ? quoteErrorText(check.error) : null;
  const failure = quote.error instanceof QuoteFailed ? quote.error : quote.error ? new QuoteFailed(quoteErrorText("upstream"), "upstream") : null;
  const data = quote.data;
  const dataOrigin = data ? originByChain(data.chain) : null;
  const dim = typing || quote.isPlaceholderData;
  const row = "flex items-baseline justify-between gap-3 py-1";

  return (
    <div ref={ref} id={FUND_ANCHOR} className="py-3 border-b border-surface scroll-mt-24">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-xs text-primary">Fund from any chain</div>
        <div className="text-[10px] text-tertiary">Live price from NEAR Intents</div>
      </div>
      <p className="text-[11px] text-tertiary mt-0.5 mb-3">What it would cost to bring USDC to NEAR from another chain.</p>

      <div role="radiogroup" aria-label="The chain your USDC is on" className="flex flex-wrap gap-2 mb-2">
        {ORIGINS.map((o) => {
          const active = o.chain === chain;
          return (
            <button
              key={o.chain}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setChain(o.chain)}
              className={`h-8 px-3 rounded-full border text-xs font-bold cursor-pointer transition-colors ${active ? "border-atnx-cyan text-atnx-cyan" : "border-surface text-secondary btn-quiet"}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>

      <label className="flex items-center gap-2 rounded-xl border border-surface bg-elevated px-3 h-10 focus-within:border-atnx-cyan/60">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="flex-1 bg-transparent outline-none font-mono text-sm text-primary tabular-nums min-w-0"
          aria-label="Amount of USDC to send"
        />
        <span className="text-xs text-tertiary">USDC</span>
      </label>

      <div className="mt-2 min-h-[1.5rem]" aria-live="polite">
        {invalid ? (
          <p className="text-[11px] text-atnx-magenta">{invalid}</p>
        ) : failure && !typing ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-atnx-magenta break-words">{failure.message}</p>
            {RETRYABLE.has(failure.code) && (
              <button
                type="button"
                onClick={() => void quote.refetch()}
                disabled={quote.isFetching}
                className="h-7 px-3 rounded-lg border border-surface text-[11px] text-secondary btn-quiet cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                Try again
              </button>
            )}
          </div>
        ) : data && dataOrigin && units !== null ? (
          <dl className={`text-xs transition-opacity ${dim ? "opacity-50" : ""}`}>
            <div className={row}>
              <dt className="text-tertiary">You send</dt>
              <dd className="text-primary tabular-nums text-right">
                {fmtUsdc(data.sendUnits)} USDC on {dataOrigin.label}
              </dd>
            </div>
            <div className={row}>
              <dt className="text-tertiary">Arrives on NEAR</dt>
              <dd className="text-primary tabular-nums text-right font-bold">{fmtUsdc(data.receiveUnits)} USDC</dd>
            </div>
            <div className={row}>
              <dt className="text-tertiary">Fee</dt>
              <dd className="text-secondary tabular-nums text-right">{fmtFee(data.feeUnits)}</dd>
            </div>
            <div className={row}>
              <dt className="text-tertiary">Time</dt>
              <dd className="text-secondary text-right">
                {fmtDuration(data.timeSecs)}, once {dataOrigin.label} confirms the transfer
              </dd>
            </div>
          </dl>
        ) : quote.isFetching || typing ? (
          <p className="text-[11px] text-secondary animate-pulse">Getting a live price…</p>
        ) : null}
      </div>

      <p className="text-[11px] text-tertiary mt-2" title={STAND_IN}>
        {PREVIEW_LINE}
      </p>
    </div>
  );
}
