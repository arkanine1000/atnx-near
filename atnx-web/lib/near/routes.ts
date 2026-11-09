// The logic of /api/near/account and /api/near/relay, without Next or
// Supabase: each handler takes its dependencies and the signed-in user and
// returns a status and a JSON body. The route files wire in the real store,
// chain and relayer (lib/near/server.ts); the tests and the e2e script wire
// in fakes or the in-memory store.
import { PublicKey } from 'near-api-js';
import { handleCandidates, pickAccountId, type HandleSource } from './handle';
import { RelayFailed, RelayRejected, type CheckedDelegate, type Relayer } from './relay';
import type { NearAccountRow, NearAccountStore, RelayLockOptions } from './store';

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

  let txHash: string | null = null;
  try {
    txHash = (await chain.createAccount({ accountId, publicKey })).txHash;
  } catch (err) {
    // The send may have failed after the transaction landed (a timeout).
    const landed = await chain.hasKey(accountId, publicKey).catch(() => false);
    if (!landed) {
      await store.abortCreating(user.id, accountId, row);
      return json(502, { error: 'create_failed', detail: String((err as Error)?.message ?? err).slice(0, 200) });
    }
  }
  await store.markActive(user.id, accountId, txHash);
  const done = await store.getByUser(user.id);
  return json(201, { ...(done ? publicView(done) : { accountId, publicKey, state: 'active', previousAccountIds: [] }), created: true, txHash });
}

// ----------------------------------------------------------------- relay

export interface RelayDeps {
  store: NearAccountStore;
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
export async function handleRelay(deps: RelayDeps, user: RouteUser | null, body: unknown): Promise<RouteResult> {
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
  const waitMs = deps.lock?.waitMs ?? 10_000;
  const pollMs = deps.lock?.pollMs ?? 400;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const token = deps.newToken?.() ?? crypto.randomUUID();
  const deadline = now() + waitMs;
  let lock = await deps.store.acquireRelayLock(user.id, token, opts);
  while (lock === 'busy' && now() < deadline) {
    await sleep(pollMs);
    lock = await deps.store.acquireRelayLock(user.id, token, opts);
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
    await deps.store.releaseRelayLock(user.id, token).catch(() => {});
  }
}
