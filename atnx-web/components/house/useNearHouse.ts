"use client";

import { useEffect, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { newestQuote, quotePrices } from "@/lib/bm/house-math";
import type { HouseClosed, HouseConfig, HouseMarket, HousePosition, HouseVault } from "@/lib/bm/house-types";
import { isNearHouseDeployed } from "@/lib/near/config";
import { houseContractMissing, nearHouseViewer } from "@/lib/near/house";
import { rememberWaiting, storedAsClosing, storedPosition } from "./track-store";

// The house contract as the ticket, the portfolio and Settings read it,
// straight from its views (lib/near/house.ts): the config, the vault, a
// market (by its page's reference, or by id), and an account's balance,
// faucet allowance used, positions and history. Query keys start with
// ["near", "house"], so an action refreshes them all (useNearAccount.act).
//
// Polling: while one of the account's positions is waiting (an order not
// filled yet, or a close not settled yet) only what resolves it is read
// every 1.5 s: the account's positions and balance, so "Confirming…" turns
// into the fill within a second or two of it landing. Everything else
// keeps its slow pace: the positions and balance every 15 s, the history
// and the faucet allowance used every 30 s, a market every 10 s (prices
// come with each five-minute print and each fill), the vault every 30 s,
// the config every 5 minutes. When a waiting position resolves, the
// history, the markets and the vault are read once at once. A hidden tab
// reads nothing (react-query pauses its intervals) and reads once when it
// shows again.

export const FAST_MS = 1_500;
const SLOW_ACCOUNT_MS = 15_000;
const SLOW_HISTORY_MS = 30_000;
const SLOW_MARKET_MS = 10_000;

export type HouseStatus = "unconfigured" | "loading" | "missing" | "error" | "ready";

export interface HouseAccountData {
  balance: bigint;
  // Null when the contract has no faucet_claimed view.
  claimed: bigint | null;
  positions: HousePosition[];
  history: HouseClosed[];
}

const waiting = (ps: readonly HousePosition[] | undefined) => !!ps?.some((p) => p.state === "Pending" || p.state === "Closing");

// Every position as last read, by id, and the ids seen Closing: what an
// order looked like while it waited (its limit and placement, to say why a
// refund happened once it is gone) and whether a close was seen in flight.
// Filled in by the account reads, never during a render.
const seen = new Map<string, HousePosition>();
const seenClosing = new Set<string>();

// The waiting ones are also kept for the tab (./track-store.ts), so a
// reload still knows them.
function remember(ps: readonly HousePosition[]) {
  for (const p of ps) {
    const key = p.id.toString();
    seen.set(key, p);
    if (p.state === "Closing") seenClosing.add(key);
  }
  rememberWaiting(ps);
}

export function lastSeenPosition(id: bigint): HousePosition | null {
  return seen.get(id.toString()) ?? storedPosition(id);
}

export function seenAsClosing(id: bigint): boolean {
  return seenClosing.has(id.toString()) || storedAsClosing(id);
}

const waitingIds = (ps: readonly HousePosition[] | undefined) =>
  (ps ?? [])
    .filter((p) => p.state === "Pending" || p.state === "Closing")
    .map((p) => `${p.id}:${p.state}`)
    .sort()
    .join(",");

function errorText(err: unknown): string | null {
  if (!err) return null;
  return String((err as Error)?.message ?? err).split("\n")[0].slice(0, 160);
}

// The config and the vault, shared by every house view on the page.
export function useHouseBasics() {
  const configured = isNearHouseDeployed();
  const config = useQuery({
    queryKey: ["near", "house", "config"],
    enabled: configured,
    staleTime: 60_000,
    refetchInterval: 300_000,
    retry: (n, err) => !houseContractMissing(err) && n < 2,
    queryFn: (): Promise<HouseConfig> => nearHouseViewer().config(),
  });
  const vault = useQuery({
    queryKey: ["near", "house", "vault"],
    enabled: configured && !!config.data,
    refetchInterval: 30_000,
    queryFn: (): Promise<HouseVault> => nearHouseViewer().vault(),
  });
  const status: HouseStatus = !configured
    ? "unconfigured"
    : config.isLoading
      ? "loading"
      : config.error
        ? houseContractMissing(config.error)
          ? "missing"
          : "error"
        : config.data
          ? "ready"
          : "loading";
  return { status, config: config.data ?? null, vault: vault.data ?? null, error: errorText(config.error), refetch: () => void config.refetch() };
}

// One account's money and positions. The positions and the balance are
// read fast while any position waits, or while `fast` is set (an order just
// sent, not seen yet); the history and the faucet allowance used, slowly,
// and once more when a waiting position resolves, along with the markets
// and the vault.
export function useHouseAccount(accountId: string | null, opts: { enabled?: boolean; fast?: boolean } = {}) {
  const queryClient = useQueryClient();
  const enabled = !!accountId && (opts.enabled ?? true) && isNearHouseDeployed();
  const live = useQuery({
    queryKey: ["near", "house", "account", accountId],
    enabled,
    refetchInterval: (query) => (opts.fast || waiting((query.state.data as Pick<HouseAccountData, "positions"> | undefined)?.positions) ? FAST_MS : SLOW_ACCOUNT_MS),
    queryFn: async (): Promise<Pick<HouseAccountData, "balance" | "positions">> => {
      const v = nearHouseViewer();
      const [balance, positions] = await Promise.all([v.balanceOf(accountId!), v.positionsOf(accountId!)]);
      remember(positions);
      return { balance, positions };
    },
  });
  const slow = useQuery({
    queryKey: ["near", "house", "account-history", accountId],
    enabled,
    refetchInterval: SLOW_HISTORY_MS,
    queryFn: async (): Promise<Pick<HouseAccountData, "claimed" | "history">> => {
      const v = nearHouseViewer();
      const [claimed, history] = await Promise.all([v.faucetClaimed(accountId!), v.historyOf(accountId!)]);
      return { claimed, history };
    },
  });

  // A waiting position resolved (filled, refunded, closed): read the rest
  // once now.
  const waitingNow = waitingIds(live.data?.positions);
  const waitingBefore = useRef("");
  const refetchSlow = slow.refetch;
  useEffect(() => {
    const before = waitingBefore.current ? waitingBefore.current.split(",") : [];
    waitingBefore.current = waitingNow;
    const still = new Set(waitingNow ? waitingNow.split(",") : []);
    if (!before.some((k) => !still.has(k))) return;
    void refetchSlow();
    void queryClient.invalidateQueries({ queryKey: ["near", "house", "market"] });
    void queryClient.invalidateQueries({ queryKey: ["near", "house", "vault"] });
  }, [waitingNow, refetchSlow, queryClient]);

  const data: HouseAccountData | null = live.data && slow.data ? { ...live.data, ...slow.data } : null;
  return {
    data,
    loading: live.isLoading || slow.isLoading,
    error: errorText(live.error ?? slow.error),
    refetch: () => Promise.all([live.refetch(), slow.refetch()]),
  };
}

// The market a page is about, by its reference (null when it is not on
// chain).
export function useHouseMarket(reference: string | null, opts: { enabled?: boolean } = {}) {
  const q = useQuery({
    queryKey: ["near", "house", "market", "ref", reference],
    enabled: !!reference && (opts.enabled ?? true) && isNearHouseDeployed(),
    refetchInterval: SLOW_MARKET_MS,
    queryFn: (): Promise<HouseMarket | null> => nearHouseViewer().marketByReference(reference!),
  });
  return { market: q.data ?? null, loaded: q.isFetched && !q.isError, loading: q.isLoading, error: errorText(q.error), refetch: q.refetch };
}

// Several markets by id, for the portfolio: the markets of the account's
// running positions.
export function useHouseMarkets(ids: readonly number[], opts: { enabled?: boolean } = {}): Map<number, HouseMarket> {
  const sorted = Array.from(new Set(ids)).sort((a, b) => a - b);
  return useQueries({
    queries: sorted.map((id) => ({
      queryKey: ["near", "house", "market", "id", id],
      enabled: (opts.enabled ?? true) && isNearHouseDeployed(),
      refetchInterval: SLOW_MARKET_MS,
      queryFn: (): Promise<HouseMarket | null> => nearHouseViewer().market(id),
    })),
    combine: (results) => {
      const out = new Map<number, HouseMarket>();
      results.forEach((r, i) => {
        if (r.data) out.set(sorted[i], r.data);
      });
      return out;
    },
  });
}

// Everything the ticket reads for one market page and one account: the
// config and the vault, the market by its reference with its newest quote
// and two prices, and the account's balance, faucet use, positions and
// history. `fast` keeps the account's positions and balance on the quick
// poll (an order just sent and not seen yet).
export function useNearHouse(opts: { reference: string | null; accountId: string | null; fast?: boolean }) {
  const basics = useHouseBasics();
  const ready = basics.status === "ready";
  const account = useHouseAccount(opts.accountId, { enabled: ready, fast: opts.fast });
  const isWaiting = !!opts.fast || waiting(account.data?.positions);
  const market = useHouseMarket(opts.reference, { enabled: ready });
  const quote = market.market ? newestQuote(market.market) : null;
  const prices = quote && basics.config ? quotePrices(quote.scoreE2, quote.readingE2, basics.config) : null;
  return { ...basics, account, market, quote, prices, waiting: isWaiting };
}

export { waiting as anyWaiting };
