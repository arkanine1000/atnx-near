import { payoutIf, type PositionLike, type RoundLike, type RoundSide } from "@/lib/bm/dpm";
import type { BmRoundRow } from "@/lib/supabase/database-bm";

// Chain-agnostic helpers over lib/bm/dpm.ts for the rounds UI, shared by
// the Solana ticket (through useRounds.ts) and the NEAR one. No chain code
// here, so the NEAR ticket does not pull in the Solana program.

// A presale round read as if it opened now at its current pots, so a
// commit can be valued before the open.
export function asOpened(r: { presaleUp: bigint; presaleDown: bigint }): RoundLike {
  const total = r.presaleUp + r.presaleDown;
  return { presaleUp: r.presaleUp, presaleDown: r.presaleDown, mUp: r.presaleUp, mDown: r.presaleDown, nUp: total, nDown: total };
}

export function safePayoutIf(pos: PositionLike, r: RoundLike, side: RoundSide): bigint | null {
  try {
    return payoutIf(pos, r, side);
  } catch {
    return null;
  }
}

export function holdsAnything(p: PositionLike | null): boolean {
  return !!p && p.presaleUp + p.presaleDown + p.stakeUp + p.stakeDown > 0n;
}

// The registry's round in flight (opening, live or settling) and its
// presale round.
const IN_FLIGHT = new Set(["opening", "live", "settling"]);

export function liveRoundRow(rows: BmRoundRow[]): BmRoundRow | null {
  return rows.find((r) => IN_FLIGHT.has(r.state)) ?? null;
}

export function presaleRoundRow(rows: BmRoundRow[]): BmRoundRow | null {
  return rows.find((r) => r.state === "presale") ?? null;
}
