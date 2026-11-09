"use client";

import type { BmRoundRow, BmSeriesRow } from "@/lib/supabase/database-bm";
import { RoundChipView } from "./RoundChip";
import { useNearAccount } from "./useNearAccount";
import { useNearRoundState } from "./useNearRounds";

// The market header's round chip on NEAR testnet: the same chip, with the
// chance of UP from the contract. It reads the round with the ticket's own
// query (same key), so the page polls the chain once.
export function NearRoundChip({ series, rounds, vi }: { series: BmSeriesRow; rounds: BmRoundRow[]; vi: number }) {
  const near = useNearAccount();
  const { data } = useNearRoundState(series, rounds, near.status === "ready" ? near.accountId : null);
  return <RoundChipView rounds={rounds} vi={vi} live={data?.live?.account ?? null} />;
}
