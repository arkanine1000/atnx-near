// The logic of /api/near/account, /api/near/guest and /api/near/relay,
// without Next or Supabase: each handler takes its dependencies and the
// signed-in user (or, for a guest, the client's IP) and returns a status and
// a JSON body. The route files wire in the real store,
// chain and relayer (lib/near/server.ts); the tests and the e2e script wire
// in fakes or the in-memory store.
import { PublicKey } from 'near-api-js';
import { HOUSE_GUEST_METHODS } from './config';
import { GUEST_CAPS, GUEST_LOCK, GUEST_METHODS, guestAccountId, isGuestAccountId, type GuestCaps } from './guest';
import { handleCandidates, pickAccountId, type HandleSource } from './handle';
import { houseAccountId, houseKeyVerdict, roundsAccountOf, type AccountKey } from './house-account';
import { RelayFailed, RelayRejected, delegateTarget, type CheckedDelegate, type RelayResult, type Relayer } from './relay';
import type { LockResult, NearAccountRow, NearAccountStore, NearGuestRow, NearGuestStore, RelayLockOptions } from './store';

export interface RouteUser extends HandleSource {
  id: string;
}

export interface RouteResult {
  status: number;
  body: Record<string, unknown>;
}

const json = (status: number, body: Record<string, unknown>): RouteResult => ({ status, body });

// --------------------------------------------------------------- account

export interface AccountChain {
  accountExists(accountId: string): Promise<boolean>;
  // Whether the account exists and holds this key.
  hasKey(accountId: string, publicKey: string): Promise<boolean>;
  // <accountId> with zero NEAR and `publicKey` as its only key, a
  // function-call key for the rounds contract.
  createAccount(args: { accountId: string; publicKey: string }): Promise<{ txHash: string }>;
}

// The house side of account creation (NEXT_PUBLIC_BM_NEAR_PRODUCT=house):
// every rounds account, user or guest, also gets its derived house account
// (lib/near/house-account.ts), made by the same parent with the same
// browser key.
export interface HouseAccountChain {
  // The account's access keys, or null when the account does not exist.
  accessKeys(accountId: string): Promise<AccountKey[] | null>;
  // <accountId> with zero NEAR and `publicKey` as its only key, a
  // function-call key for the house contract with an empty method list.
  createHouseAccount(args: { accountId: string; publicKey: string }): Promise<{ txHash: string }>;
}

export interface HouseAccountDeps {
  contractId: string;
  chain: HouseAccountChain;
}

export type HouseSetup =
  | { ok: true; accountId: string; created: boolean; txHash: string | null }
  | { ok: false; status: number; error: 'house_name' | 'house_account_clash' | 'house_create_failed'; accountId: string | null; detail?: string };

// The house account of `roundsAccountId` for this browser key. The name is
// looked up on chain first:
//   - not there: created (a send that failed but landed counts);
//   - there with exactly this key, scoped to the house contract with an
//     empty method list: used as it is;
//   - there with anything else: refused (house_account_clash), and nothing
//     is sent.
export async function ensureHouseAccount(house: HouseAccountDeps, roundsAccountId: string, publicKey: string, parentId: string): Promise<HouseSetup> {
  const accountId = houseAccountId(roundsAccountId, parentId);
  if (!accountId) return { ok: false, status: 409, error: 'house_name', accountId: null };
  const keys = await house.chain.accessKeys(accountId);
  if (keys) {
    return houseKeyVerdict(keys, publicKey, house.contractId) === 'match'
      ? { ok: true, accountId, created: false, txHash: null }
      : { ok: false, status: 409, error: 'house_account_clash', accountId };
  }
  try {
    const { txHash } = await house.chain.createHouseAccount({ accountId, publicKey });
    return { ok: true, accountId, created: true, txHash };
  } catch (err) {
    const landed = await house.chain.accessKeys(accountId).catch(() => null);
    if (landed && houseKeyVerdict(landed, publicKey, house.contractId) === 'match') return { ok: true, accountId, created: true, txHash: null };
    return { ok: false, status: 502, error: 'house_create_failed', accountId, detail: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

// A successful account or guest answer, with its house account made sure
// of when the house is on; without it, the answer as it was.
async function withHouse(house: HouseAccountDeps | undefined, parentId: string, r: RouteResult, roundsAccountId: string, publicKey: string): Promise<RouteResult> {
  if (!house) return r;
  const h = await ensureHouseAccount(house, roundsAccountId, publicKey, parentId);
  if (!h.ok) return json(h.status, { error: h.error, accountId: roundsAccountId, houseAccountId: h.accountId, detail: h.detail ?? null });
  return json(r.status, { ...r.body, houseAccountId: h.accountId, houseCreated: h.created, houseTxHash: h.txHash });
}

// A new rounds name is free only when its house name is free too (or the
// house is off), so a new account never meets a clash.
async function houseNameTaken(house: HouseAccountDeps | undefined, chain: AccountChain, roundsAccountId: string, parentId: string): Promise<boolean> {
  if (!house) return false;
  const h = houseAccountId(roundsAccountId, parentId);
  return !h || (await chain.accountExists(h));
}

export interface AccountDeps {
  store: NearAccountStore;
  chain: AccountChain;
  parentId: string;
  // The house is on: each account also gets its house account.
  house?: HouseAccountDeps;
  // A user may start over with a fresh account (lost browser key) this many
  // times in all; each account costs the parent about 0.007 NEAR.
  maxAccountsPerUser?: number;
  // A row left 'creating' this long is treated as abandoned.
  staleCreatingMs?: number;
  now?: () => number;
  rand?: (n: number) => Uint8Array;
}

function publicView(row: NearAccountRow) {
  return { accountId: row.accountId, publicKey: row.publicKey, state: row.state, previousAccountIds: row.previousAccountIds };
}

// GET: the user's account, if any.
export async function handleAccountGet(deps: Pick<AccountDeps, 'store'>, user: RouteUser | null): Promise<RouteResult> {
  if (!user) return json(401, { error: 'signed_out' });
  const row = await deps.store.getByUser(user.id);
  return json(200, row ? publicView(row) : { accountId: null });
}

export function parseEd25519(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('ed25519:') || v.length > 100) return null;
  try {
    const pk = PublicKey.from(v);
    return pk.data.length === 32 ? pk.toString() : null;
  } catch {
    return null;
  }
}

// POST { publicKey, fresh? }: the user's account for this browser key.
//   - the same key as on record: the account as it is (idempotent);
//   - another key on record: 409 other_key, unless fresh is true, which
//     creates a new account and makes it the user's (the old one stays on
//     chain with whatever it holds);
//   - none: a new <handle>.<parent>.
export async function handleAccountCreate(deps: AccountDeps, user: RouteUser | null, body: unknown): Promise<RouteResult> {
  if (!user) return json(401, { error: 'signed_out' });
  const b = (body ?? {}) as { publicKey?: unknown; fresh?: unknown };
  const publicKey = parseEd25519(b.publicKey);
  if (!publicKey) return json(400, { error: 'bad_public_key' });
  const fresh = b.fresh === true;
  const now = deps.now ?? Date.now;
  const maxAccounts = deps.maxAccountsPerUser ?? 5;
  const staleMs = deps.staleCreatingMs ?? 120_000;
  const { store, chain } = deps;

  let row = await store.getByUser(user.id);
  const stale = (r: NearAccountRow) => now() - new Date(r.updatedAt).getTime() > staleMs;

  // A creation that never finished: if the chain has the account with the
  // key on record, it did land; finish the row.
  if (row?.state === 'creating' && stale(row) && (await chain.hasKey(row.accountId, row.publicKey))) {
    await store.markActive(row.userId, row.accountId, row.createTx);
    row = await store.getByUser(user.id);
  }

  if (row?.state === 'active') {
    if (row.publicKey === publicKey) return withHouse(deps.house, deps.parentId, json(200, { ...publicView(row), created: false }), row.accountId, publicKey);
    if (!fresh) return json(409, { error: 'other_key', accountId: row.accountId });
    if (row.previousAccountIds.length + 1 >= maxAccounts) return json(429, { error: 'account_limit' });
  } else if (row?.state === 'creating' && !stale(row)) {
    return json(409, { error: 'in_progress' });
  }

  const own = row?.accountId ?? null;
  const isTaken = async (id: string) =>
    (id !== own && (await store.accountIdTaken(id))) || (await chain.accountExists(id)) || (await houseNameTaken(deps.house, chain, id, deps.parentId));
  const candidates = handleCandidates(user, deps.parentId);

  let accountId: string | null = null;
  for (let attempt = 0; attempt < 3 && !accountId; attempt++) {
    const id = await pickAccountId(candidates, deps.parentId, isTaken, deps.rand);
    const r = row ? await store.replaceIfUnchanged(row, { accountId: id, publicKey }) : await store.insertCreating({ userId: user.id, accountId: id, publicKey });
    if (r === 'ok') accountId = id;
    else if (r === 'user_exists' || r === 'changed') return json(409, { error: 'in_progress' });
    // 'account_taken': someone else reserved that name meanwhile; pick again.
  }
  if (!accountId) return json(409, { error: 'in_progress' });

  const made = await createOnChain(chain, accountId, publicKey);
  if (!made.ok) {
    await store.abortCreating(user.id, accountId, row);
    return json(502, { error: 'create_failed', detail: made.detail });
  }
  const txHash = made.txHash;
  await store.markActive(user.id, accountId, txHash);
  const done = await store.getByUser(user.id);
  return withHouse(deps.house, deps.parentId, json(201, { ...(done ? publicView(done) : { accountId, publicKey, state: 'active', previousAccountIds: [] }), created: true, txHash }), accountId, publicKey);
}

// The parent's CreateAccount for a user or a guest. A send that failed may
// still have landed (a timeout after the transaction went out): if the
// chain has the account with the key, it counts, with no hash.
async function createOnChain(chain: AccountChain, accountId: string, publicKey: string): Promise<{ ok: true; txHash: string | null } | { ok: false; detail: string }> {
  try {
    return { ok: true, txHash: (await chain.createAccount({ accountId, publicKey })).txHash };
  } catch (err) {
    const landed = await chain.hasKey(accountId, publicKey).catch(() => false);
    if (landed) return { ok: true, txHash: null };
    return { ok: false, detail: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

// ----------------------------------------------------------------- guest

export interface GuestDeps {
  store: NearGuestStore;
  chain: AccountChain;
  parentId: string;
  // The house is on: each guest also gets its house account.
  house?: HouseAccountDeps;
  // The salted hash of the client's IP (lib/near/guest.ts hashIp with the
  // server's salt). Null when the request carried no address.
  hashIp: (ip: string | null) => Promise<string>;
  // Whether the relayer and the parent still hold enough NEAR. A guest that
  // cannot be relayed for is no use, so none is made below the floor.
  hasFunds?: () => Promise<boolean>;
  caps?: Partial<GuestCaps>;
  // A row left 'creating' this long is treated as abandoned.
  staleCreatingMs?: number;
  now?: () => number;
  rand?: (n: number) => Uint8Array;
}

function guestView(row: NearGuestRow) {
  return { accountId: row.accountId, publicKey: row.publicKey, state: row.state, guest: true };
}

// POST { publicKey } with no session: a guest account for this browser key.
//   - a key already on record: that account as it is (idempotent), or 409
//     in_progress while its creation is in flight, or 409 key_used when it
//     failed (the browser makes a new key);
//   - none: a new guest-<8>.<parent>, if the caps allow it: 429
//     guest_limit_ip (this IP made its guests for the hour) or
//     guest_limit_day (the day's guests are made), 503 relayer_empty below
//     the floor.
// The account is created exactly as a user's: zero NEAR, the key as a
// function-call key for the rounds contract and the user methods.
export async function handleGuestCreate(deps: GuestDeps, client: { ip: string | null }, body: unknown): Promise<RouteResult> {
  const publicKey = parseEd25519((body as { publicKey?: unknown } | null)?.publicKey);
  if (!publicKey) return json(400, { error: 'bad_public_key' });
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleCreatingMs ?? 120_000;
  const caps: GuestCaps = { ...GUEST_CAPS, ...deps.caps };
  const { store, chain } = deps;

  let row = await store.getByPublicKey(publicKey);
  if (row?.state === 'active') return withHouse(deps.house, deps.parentId, json(200, { ...guestView(row), created: false }), row.accountId, publicKey);
  if (row?.state === 'failed') return json(409, { error: 'key_used' });
  if (row?.state === 'creating') {
    if (now() - new Date(row.updatedAt).getTime() <= staleMs) return json(409, { error: 'in_progress' });
    // Abandoned mid-creation: finish it if it landed, else send it again. The
    // row already counted against the caps.
    if (await chain.hasKey(row.accountId, publicKey)) {
      await store.markActive(row.accountId, row.createTx);
      return withHouse(deps.house, deps.parentId, json(200, { ...guestView({ ...row, state: 'active' }), created: false }), row.accountId, publicKey);
    }
  } else {
    if (deps.hasFunds && !(await deps.hasFunds())) return json(503, { error: 'relayer_empty' });
    const ipHash = await deps.hashIp(client.ip);
    for (let attempt = 0; attempt < 3 && !row; attempt++) {
      const accountId = guestAccountId(deps.parentId, deps.rand);
      if ((await chain.accountExists(accountId)) || (await houseNameTaken(deps.house, chain, accountId, deps.parentId))) continue;
      const r = await store.reserve({ accountId, publicKey, ipHash }, caps);
      if (r === 'ip_limit') return json(429, { error: 'guest_limit_ip' });
      if (r === 'day_limit') return json(429, { error: 'guest_limit_day' });
      // The same key, reserved by a request running alongside this one.
      if (r === 'key_taken') return json(409, { error: 'in_progress' });
      if (r === 'ok') row = await store.getByAccount(accountId);
      // 'account_taken': that name was reserved meanwhile; pick again.
    }
    if (!row) return json(409, { error: 'in_progress' });
  }

  const made = await createOnChain(chain, row.accountId, publicKey);
  if (!made.ok) {
    await store.markFailed(row.accountId);
    return json(502, { error: 'create_failed', detail: made.detail });
  }
  await store.markActive(row.accountId, made.txHash);
  return withHouse(deps.house, deps.parentId, json(201, { ...guestView({ ...row, state: 'active' }), created: true, txHash: made.txHash }), row.accountId, publicKey);
}

// ----------------------------------------------------------------- relay

export interface RelayDeps {
  store: NearAccountStore;
  // Relays for guest accounts (bm.near_guests), which have no session.
  // Without it the guest branch answers guests_off.
  guests?: {
    store: NearGuestStore;
    parentId: string;
    // Overrides GUEST_LOCK (60 relays an hour) and GUEST_METHODS.
    lock?: Partial<RelayLockOptions>;
    methods?: readonly string[];
  };
  relayer: Pick<Relayer, 'check' | 'preflight' | 'send'>;
  // Contract-level checks before paying (lib/near/rounds-check.ts,
  // lib/near/house-check.ts; appCheckByReceiver picks one per contract).
  appCheck?: (checked: CheckedDelegate) => Promise<void>;
  // The house is on: a delegate to `contractId` is relayed for the house
  // account derived from the user's or guest's rounds account (same row,
  // same key, same lock and caps), a guest with `guestMethods` only
  // (default HOUSE_GUEST_METHODS).
  house?: { contractId: string; parentId: string; guestMethods?: readonly string[] };
  // Called after a successful send, before the answer goes back: schedules
  // follow-up work such as the house quote on demand. It must not wait for
  // that work; if it throws, the relay still succeeds.
  afterSend?: (checked: CheckedDelegate, result: RelayResult) => void;
  // Reads a delegate's sender and receiver before it is checked (default
  // delegateTarget).
  peek?: (signedDelegateBase64: string) => { senderId: string; receiverId: string } | null;
  lock?: Partial<RelayLockOptions> & { waitMs?: number; pollMs?: number };
  sleep?: (ms: number) => Promise<void>;
  newToken?: () => string;
  now?: () => number;
}

export const DEFAULT_LOCK: RelayLockOptions = { ttlSecs: 60, windowSecs: 3600, maxPerWindow: 200 };

// Whether a delegate is for the house contract (the house is on and its
// receiver is the house contract).
function toHouse(deps: RelayDeps, target: { receiverId: string } | null): boolean {
  return !!deps.house && !!target && target.receiverId === deps.house.contractId;
}

// One check per contract, chosen by the delegate's receiver; a receiver
// with no check is refused.
export function appCheckByReceiver(checks: Record<string, (checked: CheckedDelegate) => Promise<void>>): (checked: CheckedDelegate) => Promise<void> {
  return async (checked) => {
    const receiver = checked.da?.receiverId ?? checked.policy?.contractId ?? '';
    const fn = Object.prototype.hasOwnProperty.call(checks, receiver) ? checks[receiver] : undefined;
    if (!fn) throw new RelayRejected('receiver_not_allowed', receiver);
    return fn(checked);
  };
}

// POST { signedDelegate }: check it against the user's account, take the
// user's relay lock (one delegate in flight per user, so nonces land in
// order), check it against the chain, send it.
//
// POST { signedDelegate, guest: true }: the guest branch (handleGuestRelay),
// which never reads the session. The two never cross: the user branch only
// relays for the session user's own account (a guest's delegate there is
// sender_mismatch), and the guest branch only for an active guest row (a
// user's delegate there is not_a_guest).
export async function handleRelay(deps: RelayDeps, user: RouteUser | null, body: unknown): Promise<RouteResult> {
  if ((body as { guest?: unknown } | null)?.guest === true) return handleGuestRelay(deps, body);
  if (!user) return json(401, { error: 'signed_out' });
  const row = await deps.store.getByUser(user.id);
  if (!row || row.state !== 'active') return json(409, { error: 'no_account' });
  const signedDelegate = (body as { signedDelegate?: unknown } | null)?.signedDelegate;
  if (typeof signedDelegate !== 'string') return json(400, { error: 'bad_request', detail: 'expected signedDelegate' });

  // A house delegate comes from the user's house account; anything else
  // from the rounds account on record.
  const house = deps.house && toHouse(deps, (deps.peek ?? delegateTarget)(signedDelegate)) ? deps.house : null;
  const expectedSenderId = house ? houseAccountId(row.accountId, house.parentId) : row.accountId;
  if (!expectedSenderId) return json(409, { error: 'no_account' });

  let checked: CheckedDelegate;
  try {
    checked = await deps.relayer.check(signedDelegate, { expectedSenderId, expectedPublicKey: row.publicKey });
  } catch (err) {
    if (err instanceof RelayRejected) return json(400, { error: err.reason, detail: err.detail ?? null });
    throw err;
  }

  const opts: RelayLockOptions = { ...DEFAULT_LOCK, ...deps.lock };
  return relayLocked(deps, checked, {
    acquire: (token) => deps.store.acquireRelayLock(user.id, token, opts),
    release: (token) => deps.store.releaseRelayLock(user.id, token),
  });
}

// The guest branch: no session. The delegate's sender must be an active
// row in bm.near_guests, and the delegate is checked against that row's
// account and key exactly as a user's is against theirs, then gets the
// same lock, chain checks and rounds checks, with GUEST_LOCK's lower cap
// and GUEST_METHODS only.
async function handleGuestRelay(deps: RelayDeps, body: unknown): Promise<RouteResult> {
  if (!deps.guests) return json(404, { error: 'guests_off' });
  const signedDelegate = (body as { signedDelegate?: unknown } | null)?.signedDelegate;
  if (typeof signedDelegate !== 'string') return json(400, { error: 'bad_request', detail: 'expected signedDelegate' });
  const target = (deps.peek ?? delegateTarget)(signedDelegate);
  if (!target) return json(400, { error: 'malformed', detail: 'expected a base64 SignedDelegate' });
  // A house delegate comes from the guest's house account: its row is the
  // rounds guest account the name derives from.
  const house = deps.house && toHouse(deps, target) ? deps.house : null;
  const sender = house ? roundsAccountOf(target.senderId, house.parentId) : target.senderId;
  if (!sender || !isGuestAccountId(sender, deps.guests.parentId)) return json(403, { error: 'not_a_guest' });
  const row = await deps.guests.store.getByAccount(sender);
  if (!row || row.state !== 'active') return json(409, { error: 'no_account' });
  const expectedSenderId = house ? houseAccountId(row.accountId, house.parentId) : row.accountId;
  if (!expectedSenderId) return json(409, { error: 'no_account' });

  let checked: CheckedDelegate;
  try {
    checked = await deps.relayer.check(signedDelegate, { expectedSenderId, expectedPublicKey: row.publicKey });
  } catch (err) {
    if (err instanceof RelayRejected) return json(400, { error: err.reason, detail: err.detail ?? null });
    throw err;
  }
  const methods: readonly string[] = house ? (house.guestMethods ?? HOUSE_GUEST_METHODS) : (deps.guests.methods ?? GUEST_METHODS);
  if (!methods.includes(checked.methodName)) return json(400, { error: 'method_not_allowed', detail: checked.methodName });

  const opts: RelayLockOptions = { ...GUEST_LOCK, ...deps.guests.lock };
  const guests = deps.guests.store;
  return relayLocked(deps, checked, {
    acquire: (token) => guests.acquireRelayLock(row.accountId, token, opts),
    release: (token) => guests.releaseRelayLock(row.accountId, token),
  });
}

// Both branches from here: the account's relay lock (waiting a little for
// one in flight), then the chain and rounds checks, then the send.
async function relayLocked(
  deps: RelayDeps,
  checked: CheckedDelegate,
  lockFns: { acquire: (token: string) => Promise<LockResult>; release: (token: string) => Promise<void> },
): Promise<RouteResult> {
  const waitMs = deps.lock?.waitMs ?? 10_000;
  const pollMs = deps.lock?.pollMs ?? 400;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const token = deps.newToken?.() ?? crypto.randomUUID();
  const deadline = now() + waitMs;
  let lock = await lockFns.acquire(token);
  while (lock === 'busy' && now() < deadline) {
    await sleep(pollMs);
    lock = await lockFns.acquire(token);
  }
  if (lock === 'busy') return json(409, { error: 'busy' });
  if (lock === 'rate') return json(429, { error: 'rate_limited' });
  if (lock === 'no_account') return json(409, { error: 'no_account' });

  try {
    await deps.relayer.preflight(checked);
    if (deps.appCheck) await deps.appCheck(checked);
    const r = await deps.relayer.send(checked);
    if (deps.afterSend) {
      try {
        deps.afterSend(checked, r);
      } catch {
        // Follow-up work never fails a relay that went through.
      }
    }
    return json(200, { txHash: r.txHash, value: r.value ?? null, events: r.events, method: checked.methodName });
  } catch (err) {
    if (err instanceof RelayRejected) return json(400, { error: err.reason, detail: err.detail ?? null });
    if (err instanceof RelayFailed) return json(422, { error: 'failed_on_chain', txHash: err.txHash, message: err.contractMessage });
    return json(502, { error: 'relay_error', detail: String((err as Error)?.message ?? err).slice(0, 200) });
  } finally {
    await lockFns.release(token).catch(() => {});
  }
}
