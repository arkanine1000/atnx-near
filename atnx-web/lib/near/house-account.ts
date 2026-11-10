// The house account that belongs to a rounds account: the same name with
// "-h" before the parent, alice.atnx.testnet → alice-h.atnx.testnet. A
// rounds account's only key is scoped to the rounds contract, so trading
// on the house contract needs an account of its own; deriving its name
// keeps bm.near_accounts and bm.near_guests pointing at the rounds accounts
// and needs no new mapping. Only the parent can create sub-accounts of
// itself, so a derived name can only ever be created by the platform.
// Pure: whether the house account exists is checked on chain by the caller.
import { MAX_ACCOUNT_ID, isSubAccountOf } from './handle';

export const HOUSE_ACCOUNT_SUFFIX = '-h';
export const DEFAULT_HOUSE_PARENT = 'atnx.testnet';

// A handle no rounds account may take: one ending in "-h" is the label of
// another handle's house account (bob-h is bob's), so the two names would
// collide. Wherever handles are chosen, this is checked beside the other
// reserved names (handle.ts has its own isReservedHandle for those).
export function isReservedHandle(handle: string): boolean {
  return typeof handle === 'string' && handle.trim().toLowerCase().endsWith(HOUSE_ACCOUNT_SUFFIX);
}

// The house account id of `roundsAccountId`, a direct sub-account of
// `parent`, or null when the input is not one or the result would be
// longer than 64 characters. It is one-to-one only because no rounds
// handle ends in "-h" (isReservedHandle above): otherwise bob's house
// account and the rounds account of a user called bob-h would share a name.
export function houseAccountId(roundsAccountId: string, parent: string = DEFAULT_HOUSE_PARENT): string | null {
  if (typeof roundsAccountId !== 'string' || typeof parent !== 'string' || !parent) return null;
  if (!isSubAccountOf(roundsAccountId, parent)) return null;
  const label = roundsAccountId.slice(0, -parent.length - 1);
  const id = `${label}${HOUSE_ACCOUNT_SUFFIX}.${parent}`;
  return id.length <= MAX_ACCOUNT_ID ? id : null;
}
