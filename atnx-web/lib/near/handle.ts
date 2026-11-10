// Account names for new users: <handle>.<parent>, e.g. alice.atnx.testnet.
//
// NEAR account ids are lowercase letters and digits, with `-` or `_`
// between them (never two in a row, never at either end), dots between
// labels, 2 to 64 characters in all. The handle is the user's own name where
// there is one (the X username, else the ATNX profile handle), cleaned up to
// fit those rules; otherwise a short random one.

export const MAX_ACCOUNT_ID = 64;
const MIN_HANDLE = 2;

// Names the platform keeps for itself, or that would read as official.
const RESERVED = new Set([
  'admin',
  'api',
  'app',
  'atnx',
  'faucet',
  'keeper',
  'markets',
  'near',
  'official',
  'owner',
  'relayer',
  'root',
  'rounds',
  'support',
  'system',
  'team',
  'treasury',
  'usdg',
  'www',
]);

// The suffix of a house account's label (lib/near/house-account.ts):
// bob.atnx.testnet trades on the house contract as bob-h.atnx.testnet.
export const HOUSE_ACCOUNT_SUFFIX = '-h';

// Handles no user account may take:
//   - the platform's own names (RESERVED);
//   - `guest`, and `guest-…` or `guest_…`, which belong to the guest
//     accounts (lib/near/guest.ts), so a user's account never looks like one;
//   - anything ending in "-h": that is the label of another handle's house
//     account (bob-h is bob's), so the two names would collide.
// Every place a handle is chosen goes through here: sanitizeHandle for the
// user's own names, pickAccountId for every name it tries.
export function isReservedHandle(h: string): boolean {
  if (typeof h !== 'string') return false;
  const v = h.trim().toLowerCase();
  return RESERVED.has(v) || v === 'guest' || /^guest[-_]/.test(v) || v.endsWith(HOUSE_ACCOUNT_SUFFIX);
}

// The longest handle that still fits <handle>.<parent> in 64 characters.
export function maxHandleLength(parent: string): number {
  return MAX_ACCOUNT_ID - parent.length - 1;
}

// A raw name to a valid handle, or null when nothing usable is left.
// "Attn_seeker#1234" -> "attn_seeker-1234", "Zoë Smith" -> "zoe-smith",
// "__bob__" -> "bob", "a.b" -> "a-b".
export function sanitizeHandle(raw: string | null | undefined, maxLen = 32): string | null {
  if (!raw) return null;
  let h = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents off: é -> e
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-') // anything else, dots included, becomes a dash
    .replace(/[-_]{2,}/g, (run) => run[0]) // one separator at a time
    .replace(/^[-_]+|[-_]+$/g, '');
  if (h.length > maxLen) h = h.slice(0, maxLen).replace(/[-_]+$/, '');
  if (h.length < MIN_HANDLE) return null;
  if (isReservedHandle(h)) return null;
  return h;
}

// The full NEAR account id rule (near-account-id): 2–64 characters, labels
// of [a-z0-9] joined by single - or _, labels joined by dots.
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= MAX_ACCOUNT_ID && ACCOUNT_ID.test(id);
}

// A direct sub-account of `parent`: exactly one label in front of it.
export function isSubAccountOf(id: string, parent: string): boolean {
  if (!isValidAccountId(id) || !id.endsWith(`.${parent}`)) return false;
  const label = id.slice(0, -parent.length - 1);
  return label.length > 0 && !label.includes('.');
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

export function randomSuffix(n: number, rand: (n: number) => Uint8Array = randomBytes): string {
  return Array.from(rand(n), (b) => BASE36[b % 36]).join('');
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

// "u" and seven random characters: the handle when the user has no name
// that fits.
export function randomHandle(rand?: (n: number) => Uint8Array): string {
  return `u${randomSuffix(7, rand)}`;
}

export interface HandleSource {
  // The X username (user_metadata.user_name / preferred_username).
  username?: string | null;
  // The ATNX profile handle (user_profiles.handle).
  handle?: string | null;
}

// Handles to try, best first, without duplicates.
export function handleCandidates(src: HandleSource, parent: string): string[] {
  const max = Math.min(32, maxHandleLength(parent) - 5); // room for "-xxxx"
  const out: string[] = [];
  for (const raw of [src.username, src.handle]) {
    const h = sanitizeHandle(raw, max);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

// The first free account id: each candidate as it is, then with a short
// random suffix, then random handles. `isTaken` checks the registry and the
// chain.
export async function pickAccountId(
  candidates: string[],
  parent: string,
  isTaken: (accountId: string) => Promise<boolean>,
  rand?: (n: number) => Uint8Array,
): Promise<string> {
  const tries: string[] = [];
  for (const c of candidates) {
    tries.push(c, `${c}-${randomSuffix(4, rand)}`);
  }
  for (let i = 0; i < 4; i++) tries.push(randomHandle(rand));
  for (const h of tries) {
    if (isReservedHandle(h)) continue;
    const id = `${h}.${parent}`;
    if (!isValidAccountId(id)) continue;
    if (!(await isTaken(id))) return id;
  }
  throw new Error('no free account name found');
}
