// The house account that belongs to a rounds account: the same name with
// "-h" before the parent, alice.atnx.testnet → alice-h.atnx.testnet. A
// rounds account's only key is scoped to the rounds contract, so trading
// on the house contract needs an account of its own; deriving its name
// keeps bm.near_accounts and bm.near_guests pointing at the rounds accounts
// and needs no new mapping. Only the parent can create sub-accounts of
// itself, so a derived name can only ever be created by the platform.
// Pure: whether the house account exists is checked on chain by the caller
// (lib/near/routes.ts, ensureHouseAccount).
import { HOUSE_ACCOUNT_SUFFIX, MAX_ACCOUNT_ID, isSubAccountOf } from './handle';
import type { KeyPermission } from './relay';

export { HOUSE_ACCOUNT_SUFFIX };
export const DEFAULT_HOUSE_PARENT = 'atnx.testnet';

// The house account id of `roundsAccountId`, a direct sub-account of
// `parent`, or null when the input is not one or the result would be
// longer than 64 characters. It is one-to-one only because no rounds
// handle ends in "-h" (isReservedHandle in ./handle): otherwise bob's house
// account and the rounds account of a user called bob-h would share a name.
export function houseAccountId(roundsAccountId: string, parent: string = DEFAULT_HOUSE_PARENT): string | null {
  if (typeof roundsAccountId !== 'string' || typeof parent !== 'string' || !parent) return null;
  if (!isSubAccountOf(roundsAccountId, parent)) return null;
  const label = roundsAccountId.slice(0, -parent.length - 1);
  const id = `${label}${HOUSE_ACCOUNT_SUFFIX}.${parent}`;
  return id.length <= MAX_ACCOUNT_ID ? id : null;
}

// The other way: the rounds account a house account id belongs to, or null
// when the id is not a direct sub-account of `parent` whose label ends in
// "-h". The relay uses it to find a guest's row from a house delegate.
export function roundsAccountOf(houseId: string, parent: string = DEFAULT_HOUSE_PARENT): string | null {
  if (typeof houseId !== 'string' || typeof parent !== 'string' || !parent) return null;
  if (!isSubAccountOf(houseId, parent)) return null;
  const label = houseId.slice(0, -parent.length - 1);
  if (!label.endsWith(HOUSE_ACCOUNT_SUFFIX)) return null;
  const rounds = `${label.slice(0, -HOUSE_ACCOUNT_SUFFIX.length)}.${parent}`;
  return isSubAccountOf(rounds, parent) && houseAccountId(rounds, parent) === houseId ? rounds : null;
}

// One access key of an account, as the chain lists it.
export interface AccountKey {
  publicKey: string;
  permission: KeyPermission;
}

// What an existing house account's keys say about reusing it:
//   'match'  exactly one key, the browser's, a function-call key for the
//            house contract with an empty method list: the account is this
//            browser's house account and is used as it is;
//   'clash'  anything else (another key, a full-access key, another
//            receiver, a method list): the name is not ours to use.
// The allowance is not compared: the relayer pays all gas, so it never
// moves, and a different one grants nothing more.
export function houseKeyVerdict(keys: readonly AccountKey[], publicKey: string, houseContractId: string): 'match' | 'clash' {
  if (keys.length !== 1) return 'clash';
  const k = keys[0];
  if (k.publicKey !== publicKey || k.permission === 'FullAccess') return 'clash';
  return k.permission.receiverId === houseContractId && k.permission.methodNames.length === 0 ? 'match' : 'clash';
}
