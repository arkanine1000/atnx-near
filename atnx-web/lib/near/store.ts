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

// ================================================================ guests
//
// Guest accounts (lib/near/guest.ts) live in bm.near_guests
// (supabase/bm/005_near_guests.sql), apart from bm.near_accounts: a guest
// has no ATNX user, only an account id and the browser's key. The caps on
// how many guests are made, per client IP and overall, are checked and the
// row inserted in one database call (bm.near_guest_reserve), so concurrent
// serverless instances cannot both slip under them. The in-memory store
// below has the same semantics, for tests and scripts/near-guest-e2e.ts.

// 'failed' rows stay: they still count against the caps, and their key is
// spent (the browser makes a new one).
export type NearGuestState = 'creating' | 'active' | 'failed';

export interface NearGuestRow {
  accountId: string;
  publicKey: string;
  state: NearGuestState;
  createTx: string | null;
  createdAt: string;
  updatedAt: string;
}

// 'ip_limit': this client IP made its guests for the hour; 'day_limit': the
// day's guests are made; 'key_taken' / 'account_taken': a row already has
// that key or that account id.
export type GuestReserveResult = 'ok' | 'ip_limit' | 'day_limit' | 'key_taken' | 'account_taken';

export interface GuestReserveCaps {
  perIp: number;
  ipWindowSecs: number;
  perDay: number;
  dayWindowSecs: number;
}

export interface NearGuestStore {
  getByAccount(accountId: string): Promise<NearGuestRow | null>;
  getByPublicKey(publicKey: string): Promise<NearGuestRow | null>;
  // A new row in state 'creating', if the caps allow it. `ipHash` is the
  // salted hash of the client's IP (lib/near/guest.ts hashIp).
  reserve(row: { accountId: string; publicKey: string; ipHash: string }, caps: GuestReserveCaps): Promise<GuestReserveResult>;
  markActive(accountId: string, createTx: string | null): Promise<boolean>;
  markFailed(accountId: string): Promise<void>;
  // The guest's relay lock and hourly count, as for a user.
  acquireRelayLock(accountId: string, token: string, opts: RelayLockOptions): Promise<LockResult>;
  releaseRelayLock(accountId: string, token: string): Promise<void>;
}

interface MemGuestRow extends NearGuestRow {
  ipHash: string | null;
  createdMs: number;
  lockToken: string | null;
  lockedUntil: number | null;
  windowStartedAt: number | null;
  windowCount: number;
}

export function memoryNearGuestStore(opts: { now?: () => number } = {}): NearGuestStore & { rows: Map<string, MemGuestRow> } {
  const now = opts.now ?? (() => Date.now());
  const rows = new Map<string, MemGuestRow>();
  let last = 0;
  const stamp = () => {
    last = Math.max(now(), last + 1);
    return new Date(last).toISOString();
  };
  const pub = (r: MemGuestRow): NearGuestRow => ({
    accountId: r.accountId,
    publicKey: r.publicKey,
    state: r.state,
    createTx: r.createTx,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

  return {
    rows,
    async getByAccount(accountId) {
      const r = rows.get(accountId);
      return r ? pub(r) : null;
    },
    async getByPublicKey(publicKey) {
      const r = Array.from(rows.values()).find((x) => x.publicKey === publicKey);
      return r ? pub(r) : null;
    },
    async reserve({ accountId, publicKey, ipHash }, { perIp, ipWindowSecs, perDay, dayWindowSecs }) {
      const t = now();
      // As the SQL: hashes are dropped once no cap needs them.
      const keepMs = Math.max(ipWindowSecs, dayWindowSecs) * 1000;
      for (const r of rows.values()) if (r.ipHash !== null && r.createdMs < t - keepMs) r.ipHash = null;
      const all = Array.from(rows.values());
      if (all.some((r) => r.publicKey === publicKey)) return 'key_taken';
      if (rows.has(accountId)) return 'account_taken';
      if (all.filter((r) => r.ipHash === ipHash && r.createdMs > t - ipWindowSecs * 1000).length >= perIp) return 'ip_limit';
      if (all.filter((r) => r.createdMs > t - dayWindowSecs * 1000).length >= perDay) return 'day_limit';
      const s = stamp();
      rows.set(accountId, {
        accountId,
        publicKey,
        state: 'creating',
        createTx: null,
        createdAt: s,
        updatedAt: s,
        ipHash,
        createdMs: t,
        lockToken: null,
        lockedUntil: null,
        windowStartedAt: null,
        windowCount: 0,
      });
      return 'ok';
    },
    async markActive(accountId, createTx) {
      const r = rows.get(accountId);
      if (!r || r.state !== 'creating') return false;
      r.state = 'active';
      r.createTx = createTx;
      r.updatedAt = stamp();
      return true;
    },
    async markFailed(accountId) {
      const r = rows.get(accountId);
      if (!r || r.state !== 'creating') return;
      r.state = 'failed';
      r.updatedAt = stamp();
    },
    async acquireRelayLock(accountId, token, { ttlSecs, windowSecs, maxPerWindow }) {
      const r = rows.get(accountId);
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
    async releaseRelayLock(accountId, token) {
      const r = rows.get(accountId);
      if (r && r.lockToken === token) {
        r.lockToken = null;
        r.lockedUntil = null;
      }
    },
  };
}
