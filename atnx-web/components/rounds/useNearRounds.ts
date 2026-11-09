"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { isNearRoundsDeployed } from "@/lib/near/config";
import { nearDue, roundsViewer, type NearPosition, type NearRound, type NearSeries, type RoundsViewer } from "@/lib/near/rounds";
import type { BmRoundRow, BmSeriesRow } from "@/lib/supabase/database-bm";

// The NEAR rounds as the ticket reads them, straight from the contract's
// views (no wallet, no signing): the series by its registry reference, its
// live and presale rounds, the account's positions in both and its USDG,
// polled every 5 s; and the settled or void rounds the account can still
// claim, every 15 s. Query keys start with ["near", "rounds"] so an action
// refreshes them all (useNearAccount.act).

let viewer: RoundsViewer | null = null;
export function nearViewer(): RoundsViewer {
  if (!viewer) viewer = roundsViewer();
  return viewer;
}

export interface NearRoundView {
  account: NearRound;
  row: BmRoundRow | null;
  position: NearPosition | null;
}

export interface NearClaimable extends NearRoundView {
  position: NearPosition;
  amount: bigint;
}

export interface NearSnapshot {
  series: NearSeries | null;
  live: NearRoundView | null;
  presale: NearRoundView | null;
  usdg: bigint;
}

export function useNearRoundState(series: BmSeriesRow | null, rounds: BmRoundRow[], accountId: string | null) {
  const reference = series?.reference ?? null;
  const q = useQuery({
    queryKey: ["near", "rounds", "state", reference, accountId],
    enabled: !!reference && isNearRoundsDeployed(),
    refetchInterval: 5_000,
    queryFn: async (): Promise<NearSnapshot> => {
      const v = nearViewer();
      const [s, usdg] = await Promise.all([v.seriesByReference(reference!), accountId ? v.balanceOf(accountId) : Promise.resolve(0n)]);
      if (!s) return { series: null, live: null, presale: null, usdg };
      const read = async (index: number): Promise<NearRoundView | null> => {
        if (!index) return null;
        const [account, position] = await Promise.all([v.round(s.id, index), accountId ? v.position(s.id, index, accountId) : Promise.resolve(null)]);
        return account ? { account, row: null, position } : null;
      };
      const [live, presale] = await Promise.all([read(s.liveRound), read(s.presaleRound)]);
      return { series: s, live, presale, usdg };
    },
  });

  // Registry rows are joined here rather than in the query, so a page
  // refresh (new rows) does not refetch the chain.
  const data = useMemo(() => {
    if (!q.data) return null;
    const rowFor = (v: NearRoundView | null) => (v ? { ...v, row: rounds.find((r) => r.idx === v.account.index) ?? null } : null);
    return { ...q.data, live: rowFor(q.data.live), presale: rowFor(q.data.presale) };
  }, [q.data, rounds]);

  return { data, loading: q.isLoading, error: q.error as Error | null, refetch: q.refetch };
}

export function useNearClaimables(seriesId: number | null, rounds: BmRoundRow[], accountId: string | null) {
  const q = useQuery({
    queryKey: ["near", "rounds", "claims", seriesId, accountId],
    enabled: !!seriesId && !!accountId && isNearRoundsDeployed(),
    refetchInterval: 15_000,
    queryFn: async () => {
      const v = nearViewer();
      const mine = (await v.positionsOf(accountId!)).filter((p) => p.seriesId === seriesId);
      const out: Array<{ account: NearRound; position: NearPosition }> = [];
      const accounts = await Promise.all(mine.map((p) => v.round(p.seriesId, p.roundIndex)));
      mine.forEach((position, i) => {
        const account = accounts[i];
        if (account && (account.state === "settled" || account.state === "void")) out.push({ account, position });
      });
      return out.sort((a, b) => b.account.index - a.account.index);
    },
  });

  const data = useMemo<NearClaimable[]>(
    () =>
      (q.data ?? []).map((c) => ({
        ...c,
        row: rounds.find((r) => r.idx === c.account.index) ?? null,
        amount: nearDue(c.account, c.position),
      })),
    [q.data, rounds],
  );

  return { data, loading: q.isLoading, refetch: q.refetch };
}
