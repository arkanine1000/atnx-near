// Where the app keeps which NEAR account belongs to which ATNX user, and
// the per-user relay lock (supabase/bm/004_near_accounts.sql). The routes
// talk to this interface only, so their logic runs against the in-memory
// store below in tests and in scripts/near-relay-e2e.ts, and against
// bm.near_accounts (lib/near/store-supabase.ts) in the app.

export type NearAccountState = 'creating' | 'active';

export interface NearAccountRow {
  userId: string;
  accountId: string;
  // "ed25519:..." — the browser key, the account's only key.
  publicKey: string;
  state: NearAccountState;
  createTx: string | null;
  // Accounts this user had before (a lost browser key means a fresh one).
  previousAccountIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type ReserveResult = 'ok' | 'user_exists' | 'account_taken';

// 'ok': the lock is held under the given token. 'busy': another relay for
// this user holds it. 'rate': the user hit the hourly cap. 'no_account':
// no active row.
export type LockResult = 'ok' | 'busy' | 'rate' | 'no_account';

export interface RelayLockOptions {
  ttlSecs: number;
  windowSecs: number;
  maxPerWindow: number;
}

export interface NearAccountStore {
  getByUser(userId: string): Promise<NearAccountRow | null>;
  // Any user's current account with this id.
  accountIdTaken(accountId: string): Promise<boolean>;
  // A new row in state 'creating'.
  insertCreating(row: { userId: string; accountId: string; publicKey: string }): Promise<ReserveResult>;
  // Moves a row to a new account in state 'creating', but only if it still
  // reads as `expected` (state, account and updated_at): a compare-and-set,
  // so two requests cannot both take it. When the row was active, its
  // account id is added to previousAccountIds.
  replaceIfUnchanged(expected: NearAccountRow, next: { accountId: string; publicKey: string }): Promise<'ok' | 'changed' | 'account_taken'>;
  markActive(userId: string, accountId: string, createTx: string | null): Promise<boolean>;
  // Undoes a reservation whose chain creation failed: back to `restore`
  // (the row as it was), or deleted when there was none.
  abortCreating(userId: string, accountId: string, restore: NearAccountRow | null): Promise<void>;
  acquireRelayLock(userId: string, token: string, opts: RelayLockOptions): Promise<LockResult>;
  releaseRelayLock(userId: string, token: string): Promise<void>;
}

// ------------------------------------------------------------ in memory

interface MemRow extends NearAccountRow {
  lockToken: string | null;
  lockedUntil: number | null;
  windowStartedAt: number | null;
  windowCount: number;
}

// Same semantics as the SQL, for tests and the e2e script. `now` is
// injectable so lock expiry can be tested.
export function memoryNearAccountStore(opts: { now?: () => number } = {}): NearAccountStore & { rows: Map<string, MemRow> } {
  const now = opts.now ?? (() => Date.now());
  const rows = new Map<string, MemRow>();
  // updated_at must move on every write, even within one millisecond, for
  // the compare-and-set to mean anything.
  let last = 0;
  const stamp = () => {
    last = Math.max(now(), last + 1);
    return new Date(last).toISOString();
  };
  const pub = (r: MemRow): NearAccountRow => ({
    userId: r.userId,
    accountId: r.accountId,
    publicKey: r.publicKey,
    state: r.state,
    createTx: r.createTx,
    previousAccountIds: [...r.previousAccountIds],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
  const takenBy = (accountId: string) => Array.from(rows.values()).find((r) => r.accountId === accountId);

  return {
    rows,
    async getByUser(userId) {
      const r = rows.get(userId);
      return r ? pub(r) : null;
    },
    async accountIdTaken(accountId) {
      return !!takenBy(accountId);
    },
    async insertCreating({ userId, accountId, publicKey }) {
      if (rows.has(userId)) return 'user_exists';
      if (takenBy(accountId)) return 'account_taken';
      const t = stamp();
      rows.set(userId, {
        userId,
        accountId,
        publicKey,
        state: 'creating',
        createTx: null,
        previousAccountIds: [],
        createdAt: t,
        updatedAt: t,
        lockToken: null,
        lockedUntil: null,
        windowStartedAt: null,
        windowCount: 0,
      });
      return 'ok';
    },
    async replaceIfUnchanged(expected, next) {
      const r = rows.get(expected.userId);
      if (!r || r.state !== expected.state || r.accountId !== expected.accountId || r.updatedAt !== expected.updatedAt) return 'changed';
      const other = takenBy(next.accountId);
      if (other && other.userId !== r.userId) return 'account_taken';
      if (r.state === 'active' && r.accountId !== next.accountId) r.previousAccountIds = [...r.previousAccountIds, r.accountId];
      r.accountId = next.accountId;
      r.publicKey = next.publicKey;
      r.state = 'creating';
      r.createTx = null;
      r.updatedAt = stamp();
      return 'ok';
    },
    async markActive(userId, accountId, createTx) {
      const r = rows.get(userId);
      if (!r || r.accountId !== accountId || r.state !== 'creating') return false;
      r.state = 'active';
      r.createTx = createTx;
      r.updatedAt = stamp();
      return true;
    },
    async abortCreating(userId, accountId, restore) {
      const r = rows.get(userId);
      if (!r || r.accountId !== accountId || r.state !== 'creating') return;
      if (!restore) {
        rows.delete(userId);
        return;
      }
      Object.assign(r, {
        accountId: restore.accountId,
        publicKey: restore.publicKey,
        state: restore.state,
        createTx: restore.createTx,
        previousAccountIds: [...restore.previousAccountIds],
        updatedAt: stamp(),
      });
    },
    async acquireRelayLock(userId, token, { ttlSecs, windowSecs, maxPerWindow }) {
      const r = rows.get(userId);
      if (!r || r.state !== 'active') return 'no_account';
      const t = now();
      if (r.lockedUntil !== null && r.lockedUntil > t) return 'busy';
      if (r.windowStartedAt === null || r.windowStartedAt <= t - windowSecs * 1000) {
        r.windowStartedAt = t;
        r.windowCount = 0;
      }
      if (r.windowCount >= maxPerWindow) return 'rate';
      r.windowCount += 1;
      r.lockToken = token;
      r.lockedUntil = t + ttlSecs * 1000;
      return 'ok';
    },
    async releaseRelayLock(userId, token) {
      const r = rows.get(userId);
      if (r && r.lockToken === token) {
        r.lockToken = null;
        r.lockedUntil = null;
      }
    },
  };
}
