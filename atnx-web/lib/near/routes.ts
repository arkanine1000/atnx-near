// The logic of /api/near/account, /api/near/guest and /api/near/relay,
// without Next or Supabase: each handler takes its dependencies and the
// signed-in user (or, for a guest, the client's IP) and returns a status and
// a JSON body. The route files wire in the real store,
// chain and relayer (lib/near/server.ts); the tests and the e2e script wire
// in fakes or the in-memory store.
import { PublicKey } from 'near-api-js';
import { GUEST_CAPS, GUEST_LOCK, GUEST_METHODS, guestAccountId, isGuestAccountId, type GuestCaps } from './guest';
import { handleCandidates, pickAccountId, type HandleSource } from './handle';
import { RelayFailed, RelayRejected, delegateSenderId, type CheckedDelegate, type Relayer } from './relay';
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

export interface AccountDeps {
  store: NearAccountStore;
  chain: AccountChain;
  parentId: string;
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
    if (row.publicKey === publicKey) return json(200, { ...publicView(row), created: false });
    if (!fresh) return json(409, { error: 'other_key', accountId: row.accountId });
    if (row.previousAccountIds.length + 1 >= maxAccounts) return json(429, { error: 'account_limit' });
  } else if (row?.state === 'creating' && !stale(row)) {
    return json(409, { error: 'in_progress' });
  }

  const own = row?.accountId ?? null;
  const isTaken = async (id: string) => (id !== own && (await store.accountIdTaken(id))) || (await chain.accountExists(id));
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
  return json(201, { ...(done ? publicView(done) : { accountId, publicKey, state: 'active', previousAccountIds: [] }), created: true, txHash });
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
  if (row?.state === 'active') return json(200, { ...guestView(row), created: false });
  if (row?.state === 'failed') return json(409, { error: 'key_used' });
  if (row?.state === 'creating') {
    if (now() - new Date(row.updatedAt).getTime() <= staleMs) return json(409, { error: 'in_progress' });
    // Abandoned mid-creation: finish it if it landed, else send it again. The
    // row already counted against the caps.
    if (await chain.hasKey(row.accountId, publicKey)) {
      await store.markActive(row.accountId, row.createTx);
      return json(200, { ...guestView({ ...row, state: 'active' }), created: false });
    }
  } else {
    if (deps.hasFunds && !(await deps.hasFunds())) return json(503, { error: 'relayer_empty' });
    const ipHash = await deps.hashIp(client.ip);
    for (let attempt = 0; attempt < 3 && !row; attempt++) {
      const accountId = guestAccountId(deps.parentId, deps.rand);
      if (await chain.accountExists(accountId)) continue;
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
  return json(201, { ...guestView({ ...row, state: 'active' }), created: true, txHash: made.txHash });
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
  // Rounds-level checks before paying: the round is the right one, the
  // balance covers it, the quote meets min_shares (lib/near/rounds-check.ts).
  appCheck?: (checked: CheckedDelegate) => Promise<void>;
  lock?: Partial<RelayLockOptions> & { waitMs?: number; pollMs?: number };
  sleep?: (ms: number) => Promise<void>;
  newToken?: () => string;
  now?: () => number;
}

export const DEFAULT_LOCK: RelayLockOptions = { ttlSecs: 60, windowSecs: 3600, maxPerWindow: 200 };

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

  let checked: CheckedDelegate;
  try {
    checked = await deps.relayer.check(signedDelegate, { expectedSenderId: row.accountId, expectedPublicKey: row.publicKey });
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
  const sender = delegateSenderId(signedDelegate);
  if (!sender) return json(400, { error: 'malformed', detail: 'expected a base64 SignedDelegate' });
  if (!isGuestAccountId(sender, deps.guests.parentId)) return json(403, { error: 'not_a_guest' });
  const row = await deps.guests.store.getByAccount(sender);
  if (!row || row.state !== 'active') return json(409, { error: 'no_account' });

  let checked: CheckedDelegate;
  try {
    checked = await deps.relayer.check(signedDelegate, { expectedSenderId: row.accountId, expectedPublicKey: row.publicKey });
  } catch (err) {
    if (err instanceof RelayRejected) return json(400, { error: err.reason, detail: err.detail ?? null });
    throw err;
  }
  const methods = deps.guests.methods ?? GUEST_METHODS;
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
    return json(200, { txHash: r.txHash, value: r.value ?? null, events: r.events, method: checked.methodName });
  } catch (err) {
    if (err instanceof RelayRejected) return json(400, { error: err.reason, detail: err.detail ?? null });
    if (err instanceof RelayFailed) return json(422, { error: 'failed_on_chain', txHash: err.txHash, message: err.contractMessage });
    return json(502, { error: 'relay_error', detail: String((err as Error)?.message ?? err).slice(0, 200) });
  } finally {
    await lockFns.release(token).catch(() => {});
  }
}
