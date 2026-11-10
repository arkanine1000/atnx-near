"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card, Segmented } from "@/components/ui";
import { fmtUsdg, parseUsdg, shortHash } from "@/components/bm/format";
import { FUND_HREF } from "@/components/rounds/FundFromAnyChain";
import { AccountGate, useAutoAccount } from "@/components/rounds/NearAccountGate";
import { NearGuestChoice } from "@/components/rounds/NearGuestChoice";
import { AmountInput, Row, SideButton } from "@/components/rounds/ticket-parts";
import { useNow } from "@/components/rounds/time";
import { useNearAccount } from "@/components/rounds/useNearAccount";
import { useAuth } from "@/context/AuthContext";
import {
  blockLine,
  fmtDuration,
  fmtPriceE2,
  fundingState,
  limitPastE2,
  marketBlock,
  maxStakeFor,
  notListedReason,
  openBlock,
  parsePriceE2,
  ticketNumbers,
  withinLimit,
} from "@/lib/bm/house-ticket";
import { faucetArgs, openArgs, uuidToReference, type HouseConfig, type HousePosition, type HouseSide } from "@/lib/bm/house-types";
import { HOUSE_FAUCET_UNITS, isNearHouseDeployed, nearTxUrl } from "@/lib/near/config";
import { friendlyNearError } from "@/lib/near/errors";
import { HouseFooter, PositionLine, TrackLines, pctText, sendClose, useTracks } from "./parts";
import { useNearHouse } from "./useNearHouse";

// The house ticket on a market page (NEXT_PUBLIC_BM_NEAR_PRODUCT=house):
// atnx.app's long/short ticket on NEAR testnet, against the house
// contract's vault. UP (a long) or DOWN (a short), an amount of 10 to 250
// USDG, 2× or 3×, and what the order would do: the two prices, the worst
// price accepted (filled in 1 % past the current price, editable), the
// fee, the liquidation level, the maximum win and what it would be worth
// the moment it filled. Every number is worked out here from the
// contract's config and the market's newest quote with the same functions
// the relay checks with (lib/bm/house-ticket.ts); the contract decides.
//
// States, one plain line each: sign in or try as a guest, setting up the
// account, "Get 10,000 test USDG", not on chain yet or not tradable yet,
// close only, the two prices too far apart, market full, new orders
// paused, the price feed late. After the tap, "Confirming…" until the
// order has filled (with its entry) or been refunded (with why, when the
// market's quotes say); the user's positions on this market follow, each
// with its value and a Close button.

const BUTTON = "btn-cyan w-full h-11 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50";
const USDG = 1_000_000n;

type DockSide = "up" | "down";

interface Props {
  atnxMarketId: string;
  name: string;
  score: number;
  scoring?: boolean;
  // When the market went live on atnx.app (its created_at), to say how
  // long a young market has left before it can trade.
  createdAt?: string | null;
  initialSide?: DockSide;
  onToast?: (message: string, detail: string | undefined, type: DockSide) => void;
}

function Shell({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-sm font-bold text-primary leading-snug mb-3">Trade {name}&apos;s index</p>
      {children}
      <HouseFooter />
    </Card>
  );
}

export function HouseTicket(props: Props) {
  if (!isNearHouseDeployed()) {
    return (
      <Shell name={props.name}>
        <p className="text-sm text-secondary">Trading is not live on NEAR testnet yet.</p>
      </Shell>
    );
  }
  return <Ticket {...props} />;
}

const usdgNumber = (u: bigint | null | undefined) => (u === null || u === undefined ? undefined : Number(u / USDG));

function Ticket({ atnxMarketId, name, score, scoring = false, createdAt, initialSide = "up", onToast }: Props) {
  const near = useNearAccount();
  const { openLoginModal } = useAuth();
  const ready = near.status === "ready";
  const accountId = ready ? near.accountId : null;
  const auto = useAutoAccount(near, true);
  const nowMs = useNow() ?? 0;
  const nowSecs = Math.floor(nowMs / 1000);
  const reference = useMemo(() => {
    try {
      return uuidToReference(atnxMarketId);
    } catch {
      return null;
    }
  }, [atnxMarketId]);
  // This account's orders and closes from this tab; the lines below show
  // this market's.
  const { tracks: allTracks, add, dismiss, settle } = useTracks(accountId);
  const sentRecently = allTracks.some((t) => nowMs - t.sentAtMs < 20_000);
  const house = useNearHouse({ reference, accountId, fast: sentRecently });
  const cfg = house.config;
  const market = house.market.market;
  const account = house.account.data;

  const [side, setSide] = useState<HouseSide>(initialSide === "down" ? "Short" : "Long");
  const [leverage, setLeverage] = useState<"2" | "3">("2");
  const [amount, setAmount] = useState("100");
  // The worst price, as typed; null follows the price.
  const [limitText, setLimitText] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  // ------------------------------------------------------- not trading yet

  if (house.status === "missing" || house.status === "unconfigured") {
    return (
      <Shell name={name}>
        <p className="text-sm text-secondary">Trading is not live on NEAR testnet yet.</p>
      </Shell>
    );
  }
  if (house.status === "error") {
    return (
      <Shell name={name}>
        <p className="text-sm text-secondary mb-3">Could not read the market just now.</p>
        <button type="button" onClick={house.refetch} className={BUTTON}>
          Try again
        </button>
      </Shell>
    );
  }
  if (house.status === "loading" || !cfg || (reference && house.market.loading)) {
    return (
      <Shell name={name}>
        <p className="text-sm text-secondary animate-pulse">Loading the market…</p>
      </Shell>
    );
  }

  const minStake = usdgNumber(cfg.minStake) ?? 10;
  const maxStake = usdgNumber(cfg.maxStake) ?? 250;
  const minScore = Number(cfg.minScoreE2) / 100;
  const cooloffHours = Math.round(cfg.cooloffSecs / 3600);

  if (!market) {
    const created = createdAt ? Math.floor(Date.parse(createdAt) / 1000) : null;
    const why = scoring ? "low_score" : notListedReason({ createdAtSecs: Number.isFinite(created) ? created : null, score, nowSecs, minScoreE2: cfg.minScoreE2, cooloffSecs: cfg.cooloffSecs });
    const opensIn = why === "cooloff" && created !== null ? fmtDuration(created + cfg.cooloffSecs - nowSecs) : null;
    return (
      <Shell name={name}>
        <p className="text-sm text-secondary">{blockLine(why, { minScore, cooloffHours, opensIn })}</p>
      </Shell>
    );
  }

  // --------------------------------------------------------------- prices

  const quote = house.quote;
  const prices = house.prices;
  const lev = Number(leverage);
  const stake = parseUsdg(amount);
  const nums = quote && stake !== null && stake > 0n ? ticketNumbers({ cfg, quote, side, leverage: lev, stake }) : null;
  const autoLimit = nums && nums.entryE2 > 0n ? limitPastE2(nums.entryE2, side, "open") : null;
  const limitE2 = limitText === null ? autoLimit : parsePriceE2(limitText);
  const mine = (account?.positions ?? []).filter((p) => p.market === market.id).sort((a, b) => (a.id < b.id ? 1 : -1));

  const priceLine = prices ? (
    <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
      <div className="rounded-lg border border-surface bg-elevated/60 px-3 py-2">
        <div className="text-tertiary">Buy price</div>
        <div className="font-display font-bold text-lg tabular-nums text-primary">{fmtPriceE2(prices.buy)}</div>
      </div>
      <div className="rounded-lg border border-surface bg-elevated/60 px-3 py-2">
        <div className="text-tertiary">Sell price</div>
        <div className="font-display font-bold text-lg tabular-nums text-primary">{fmtPriceE2(prices.sell)}</div>
      </div>
    </div>
  ) : null;

  const marketLine = (b: ReturnType<typeof openBlock>) =>
    b ? blockLine(b, { side, minScore, cooloffHours, minStake, maxStake, opensIn: b === "cooloff" ? fmtDuration(market.liveSince + cfg.cooloffSecs - nowSecs) : null }) : null;

  // ------------------------------------------------------------- the account

  if (!ready) {
    // Why the market takes no order now, said before the sign-in too.
    const mb = marketBlock({ cfg, market, nowSecs });
    // Signed out, and while a guest account is being set up: the sign-in
    // and the guest choice stay mounted from one to the other, so a failed
    // set-up's message stays on screen.
    const guestFlow = near.status === "signed-out" || (near.isGuest && near.status === "creating");
    return (
      <Shell name={name}>
        {priceLine}
        {mb && <p className="text-xs text-secondary mb-3">{marketLine(mb)}</p>}
        {guestFlow ? (
          <>
            <button type="button" onClick={openLoginModal} className={BUTTON}>
              Sign in to trade
            </button>
            <div className="mt-2.5">
              <NearGuestChoice />
            </div>
          </>
        ) : (
          <AccountGate near={near} label="Sign in to trade" autoError={auto.error} onRetry={auto.retry} guest />
        )}
      </Shell>
    );
  }
  if (!account) {
    return (
      <Shell name={name}>
        {priceLine}
        <p className="text-sm text-secondary animate-pulse">{house.account.error ? "Could not read your account just now." : "Loading your account…"}</p>
      </Shell>
    );
  }

  const act = near.act;
  const funding = fundingState({ balance: account.balance, claimed: account.claimed, cfg });
  const faucetLeft = cfg.faucetPerAccount !== null && account.claimed !== null ? cfg.faucetPerAccount - account.claimed : HOUSE_FAUCET_UNITS;
  const faucetAmount = faucetLeft > HOUSE_FAUCET_UNITS ? HOUSE_FAUCET_UNITS : faucetLeft;

  async function faucet() {
    if (faucetAmount <= 0n) return;
    setBusy("faucet");
    setError(null);
    try {
      const r = await act("faucet", faucetArgs(faucetAmount));
      setLastTx(r.txHash);
      onToast?.(`Got ${fmtUsdg(faucetAmount, 0)} test USDG`, "Testnet money, no value", "up");
    } catch (e) {
      setError(friendlyNearError(e));
    } finally {
      setBusy(null);
    }
  }

  const faucetButton = (
    <button type="button" onClick={faucet} disabled={!!busy || faucetAmount <= 0n} className="btn-cyan w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50">
      {busy === "faucet" ? "Getting test USDG…" : `Get ${fmtUsdg(faucetAmount, 0)} test USDG`}
    </button>
  );

  const positionsBlock = (
    <PositionsHere
      positions={mine}
      cfg={cfg}
      market={market}
      nowMs={nowMs}
      onClose={async (p, limit) => {
        setBusy(`close-${p.id}`);
        setError(null);
        const err = await sendClose(act, p, limit, add);
        if (err) setError(err);
        setBusy(null);
      }}
      busyId={busy?.startsWith("close-") ? busy.slice(6) : null}
    />
  );
  const trackBlock = (
    <TrackLines
      tracks={allTracks.filter((t) => t.market === undefined || t.market === market.id)}
      account={account}
      marketOf={() => market}
      cfg={cfg}
      nowMs={nowMs}
      act={act}
      onDismiss={dismiss}
      onSettled={settle}
    />
  );

  if (funding === "faucet" && mine.length === 0) {
    return (
      <Shell name={name}>
        {priceLine}
        <p className="text-sm text-secondary mb-3">You need test USDG to trade.</p>
        {faucetButton}
        <Link href={FUND_HREF} className="block mt-3 text-[11px] text-tertiary link-quiet">
          Have USDC on another chain? See what bringing it to NEAR would cost.
        </Link>
        {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
        {trackBlock}
      </Shell>
    );
  }

  // ---------------------------------------------------------------- the form

  const block = stake === null ? null : openBlock({ cfg, market, vault: house.vault, nowSecs, side, leverage: lev, stake, balance: account.balance, openCount: account.positions.length });
  const mBlock = marketLineFor(block);
  // The market takes no orders at all: say so instead of the form.
  if (mBlock) {
    return (
      <Shell name={name}>
        {priceLine}
        <p className="text-sm text-secondary">{marketLine(mBlock)}</p>
        {positionsBlock}
        {trackBlock}
        {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
      </Shell>
    );
  }

  const maxS = maxStakeFor(account.balance, cfg);
  const limitPast = limitE2 !== null && nums !== null && nums.entryE2 > 0n && !withinLimit(side, "open", nums.entryE2, limitE2);
  const formError =
    stake === null || stake <= 0n
      ? "Enter an amount."
      : limitE2 === null
        ? "Enter the worst price you accept, like 412.9."
        : limitPast
          ? `The ${side === "Long" ? "buy" : "sell"} price is past your worst price now, so the order would not fill.`
          : block
            ? marketLine(block)
            : null;
  const canSubmit = !formError && !busy && !!nums && limitE2 !== null;

  async function submit() {
    if (!canSubmit || !nums || limitE2 === null || stake === null) return;
    setBusy("open");
    setError(null);
    try {
      const r = await act("open", openArgs({ market: market!.id, side, leverage: lev, stake, limitE2 }));
      setLastTx(r.txHash);
      const id = typeof r.value === "string" && /^\d+$/.test(r.value) ? BigInt(r.value) : typeof r.value === "number" ? BigInt(r.value) : null;
      if (id !== null) add(id, "open", market!.id);
      setLimitText(null);
    } catch (e) {
      setError(friendlyNearError(e));
    } finally {
      setBusy(null);
    }
  }

  const up = side === "Long";
  return (
    <Shell name={name}>
      {priceLine}
      <div className="grid grid-cols-2 gap-2 mb-4" role="radiogroup" aria-label="Side">
        <SideButton side="up" caption={prices ? `in at ${fmtPriceE2(prices.buy)}` : "UP"} selected={up} onClick={() => (setSide("Long"), setLimitText(null))} />
        <SideButton side="down" caption={prices ? `in at ${fmtPriceE2(prices.sell)}` : "DOWN"} selected={!up} onClick={() => (setSide("Short"), setLimitText(null))} />
      </div>

      {/* Whole USDG, rounded down, so "You have" never reads more than the balance. */}
      <AmountInput amount={amount} setAmount={setAmount} usdg={account.balance - (account.balance % USDG)} maxBuy={maxS !== null ? fmtUsdg(maxS, 2).replace(/,/g, "") : String(minStake)} label="Amount" />

      <div className="flex items-center justify-between gap-3 mt-4">
        <span className="text-xs text-secondary">Leverage</span>
        <Segmented ariaLabel="Leverage" value={leverage} onChange={(v) => setLeverage(v)} options={[{ value: "2", label: "2×" }, { value: "3", label: "3×" }]} />
      </div>

      {nums && (
        <dl className="mt-4 rounded-xl bg-elevated/60 border border-surface px-3 py-2.5 space-y-1.5 text-[11px]">
          <Row k={up ? "You get in at the buy price" : "You get in at the sell price"} v={fmtPriceE2(nums.entryE2)} />
          <div className="flex items-center justify-between gap-3">
            <dt className="text-tertiary">
              Worst price you accept
              {limitText !== null && (
                <button type="button" onClick={() => setLimitText(null)} className="ml-1.5 link-quiet cursor-pointer">
                  reset
                </button>
              )}
            </dt>
            <dd>
              <input
                inputMode="decimal"
                aria-label="Worst price you accept"
                value={limitText ?? (autoLimit !== null ? (Number(autoLimit) / 100).toFixed(2) : "")}
                onChange={(e) => setLimitText(e.target.value)}
                className="w-24 rounded-md border border-surface bg-elevated px-2 py-1 text-right font-mono tabular-nums text-secondary outline-none focus:border-atnx-cyan/60"
              />
            </dd>
          </div>
          <Row k={`Fee (${(cfg.feeBps ?? 100) / 100} %), on top`} v={`${fmtUsdg(nums.fee)} USDG`} />
          <Row k="Liquidation at" v={fmtPriceE2(nums.liquidationE2)} />
          <Row k="Maximum win" v={`+${fmtUsdg(nums.maxProfit)} USDG`} />
          <div className="flex items-center justify-between gap-3">
            <dt className="text-tertiary" title="What closing at once would pay back">
              Worth on fill
            </dt>
            <dd className={`tabular-nums ${nums.valueOnFill >= stake! ? "text-secondary" : "text-atnx-magenta"}`}>
              {fmtUsdg(nums.valueOnFill)} USDG ({pctText(nums.valueOnFillPct)})
            </dd>
          </div>
          {nums.valueOnFillPct < -0.05 && (
            <p className="pt-1 text-tertiary">Closing at once pays at the {up ? "sell" : "buy"} price, so a new position usually starts a little down.</p>
          )}
        </dl>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className={`mt-4 w-full h-12 rounded-xl font-bold text-sm cursor-pointer disabled:opacity-40 ${up ? "btn-cyan" : "btn-magenta"}`}
      >
        {busy === "open" ? "Sending…" : `Open ${up ? "UP" : "DOWN"} ${lev}×${stake && stake > 0n ? ` · ${fmtUsdg(stake, stake % USDG === 0n ? 0 : 2)} USDG` : ""}`}
      </button>
      {formError && <p className="mt-2 text-xs text-secondary">{formError}</p>}
      {nums && !formError && (
        <p className="mt-2 text-[11px] text-tertiary">
          Costs {fmtUsdg(nums.cost)} USDG with the fee. It fills in a few seconds at a price read after you tap.
        </p>
      )}

      {funding !== "ok" && (
        <div className="mt-3 text-xs">
          {funding === "faucet" ? faucetButton : <p className="text-secondary">You have had all the test USDG this account can get. Close a position to free some up.</p>}
        </div>
      )}

      {trackBlock}
      {error && <p className="text-xs text-atnx-magenta mt-3 break-words">{error}</p>}
      {lastTx && (
        <a href={nearTxUrl(lastTx)} target="_blank" rel="noreferrer" className="block mt-2 text-[11px] text-tertiary link-quiet">
          View last transaction {shortHash(lastTx)} ↗
        </a>
      )}
      {positionsBlock}
    </Shell>
  );
}

// The refusals that last (the market's state, its age, its score, no price
// at all): the ticket shows the line instead of the form. Passing ones (the
// two prices too far apart, new orders paused, a late price feed, the cap)
// keep the form, with the button off and the line under it.
function marketLineFor(b: ReturnType<typeof openBlock>): ReturnType<typeof openBlock> {
  switch (b) {
    case "settled":
    case "close_only":
    case "cooloff":
    case "no_quote":
    case "low_score":
      return b;
    default:
      return null;
  }
}

function PositionsHere({
  positions,
  cfg,
  market,
  nowMs,
  onClose,
  busyId,
}: {
  positions: HousePosition[];
  cfg: HouseConfig;
  market: Parameters<typeof PositionLine>[0]["market"];
  nowMs: number;
  onClose: (p: HousePosition, limitE2: bigint) => void;
  busyId: string | null;
}) {
  if (positions.length === 0) return null;
  return (
    <div className="mt-4 pt-3 border-t border-surface">
      <div className="text-xs font-bold text-secondary mb-1">Your positions here</div>
      {positions.map((p) => (
        <PositionLine key={p.id.toString()} p={p} market={market} cfg={cfg} nowMs={nowMs} busy={busyId === p.id.toString()} onClose={onClose} />
      ))}
    </div>
  );
}
