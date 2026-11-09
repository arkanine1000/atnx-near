// NearAccountStore on bm.near_accounts (supabase/bm/004_near_accounts.sql),
// and NearGuestStore on bm.near_guests (005_near_guests.sql), through the
// service-role client. Server only. Every state change is a
// compare-and-set on the row as last read; the relay lock and the hourly
// cap are one SQL function each, so they are atomic across serverless
// instances.
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import type { GuestReserveResult, LockResult, NearAccountRow, NearAccountStore, NearGuestRow, NearGuestStore, ReserveResult } from './store';

interface NearAccountDbRow {
  user_id: string;
  account_id: string;
  public_key: string;
  state: 'creating' | 'active';
  create_tx: string | null;
  previous_account_ids: string[];
  relay_lock_token: string | null;
  relay_locked_until: string | null;
  relay_window_started_at: string | null;
  relay_window_count: number;
  created_at: string;
  updated_at: string;
}

// bm.near_guests (supabase/bm/005_near_guests.sql).
interface NearGuestDbRow {
  account_id: string;
  public_key: string;
  ip_hash: string | null;
  state: 'creating' | 'active' | 'failed';
  create_tx: string | null;
  relay_lock_token: string | null;
  relay_locked_until: string | null;
  relay_window_started_at: string | null;
  relay_window_count: number;
  created_at: string;
  updated_at: string;
}

type Optional<T> = { [K in keyof T]?: T[K] };

// Only what this file touches, so lib/supabase/database-bm.ts stays as the
// registry migrations left it.
type NearDatabase = {
  bm: {
    Tables: {
      near_accounts: {
        Row: NearAccountDbRow;
        Insert: Optional<NearAccountDbRow> & { user_id: string; account_id: string; public_key: string };
        Update: Optional<NearAccountDbRow>;
        Relationships: [];
      };
      near_guests: {
        Row: NearGuestDbRow;
        Insert: Optional<NearGuestDbRow> & { account_id: string; public_key: string };
        Update: Optional<NearGuestDbRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      near_relay_acquire: {
        Args: { p_user: string; p_token: string; p_ttl_secs: number; p_window_secs: number; p_max: number };
        Returns: string;
      };
      near_relay_release: {
        Args: { p_user: string; p_token: string };
        Returns: boolean;
      };
      near_guest_reserve: {
        Args: {
          p_account_id: string;
          p_public_key: string;
          p_ip_hash: string;
          p_ip_max: number;
          p_ip_window_secs: number;
          p_day_max: number;
          p_day_window_secs: number;
        };
        Returns: string;
      };
      near_guest_relay_acquire: {
        Args: { p_account: string; p_token: string; p_ttl_secs: number; p_window_secs: number; p_max: number };
        Returns: string;
      };
      near_guest_relay_release: {
        Args: { p_account: string; p_token: string };
        Returns: boolean;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

const COLUMNS = 'user_id, account_id, public_key, state, create_tx, previous_account_ids, created_at, updated_at';

function db() {
  return (createAdminClient() as unknown as SupabaseClient<NearDatabase>).schema('bm');
}

function toRow(r: Pick<NearAccountDbRow, 'user_id' | 'account_id' | 'public_key' | 'state' | 'create_tx' | 'previous_account_ids' | 'created_at' | 'updated_at'>): NearAccountRow {
  return {
    userId: r.user_id,
    accountId: r.account_id,
    publicKey: r.public_key,
    state: r.state,
    createTx: r.create_tx,
    previousAccountIds: r.previous_account_ids ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// 23505 on the account id's unique index rather than the primary key.
function isAccountConflict(err: { code?: string; message?: string; details?: string }): boolean {
  return err.code === '23505' && /account_id/.test(`${err.message ?? ''} ${err.details ?? ''}`);
}

export function supabaseNearAccountStore(): NearAccountStore {
  return {
    async getByUser(userId) {
      const { data, error } = await db().from('near_accounts').select(COLUMNS).eq('user_id', userId).maybeSingle();
      if (error) throw error;
      return data ? toRow(data) : null;
    },

    async accountIdTaken(accountId) {
      const { data, error } = await db().from('near_accounts').select('user_id').eq('account_id', accountId).limit(1);
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },

    async insertCreating({ userId, accountId, publicKey }): Promise<ReserveResult> {
      const { error } = await db().from('near_accounts').insert({ user_id: userId, account_id: accountId, public_key: publicKey, state: 'creating' });
      if (!error) return 'ok';
      if (isAccountConflict(error)) return 'account_taken';
      if (error.code === '23505') return 'user_exists';
      throw error;
    },

    async replaceIfUnchanged(expected, next) {
      const previous =
        expected.state === 'active' && expected.accountId !== next.accountId ? [...expected.previousAccountIds, expected.accountId] : expected.previousAccountIds;
      const { data, error } = await db()
        .from('near_accounts')
        .update({
          account_id: next.accountId,
          public_key: next.publicKey,
          state: 'creating',
          create_tx: null,
          previous_account_ids: previous,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', expected.userId)
        .eq('state', expected.state)
        .eq('account_id', expected.accountId)
        .eq('updated_at', expected.updatedAt)
        .select('user_id');
      if (error) {
        if (isAccountConflict(error)) return 'account_taken';
        throw error;
      }
      return (data?.length ?? 0) > 0 ? 'ok' : 'changed';
    },

    async markActive(userId, accountId, createTx) {
      const { data, error } = await db()
        .from('near_accounts')
        .update({ state: 'active', create_tx: createTx, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('account_id', accountId)
        .eq('state', 'creating')
        .select('user_id');
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },

    async abortCreating(userId, accountId, restore) {
      const q = db().from('near_accounts');
      const { error } = restore
        ? await q
            .update({
              account_id: restore.accountId,
              public_key: restore.publicKey,
              state: restore.state,
              create_tx: restore.createTx,
              previous_account_ids: restore.previousAccountIds,
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', userId)
            .eq('account_id', accountId)
            .eq('state', 'creating')
        : await q.delete().eq('user_id', userId).eq('account_id', accountId).eq('state', 'creating');
      if (error) throw error;
    },

    async acquireRelayLock(userId, token, { ttlSecs, windowSecs, maxPerWindow }): Promise<LockResult> {
      const { data, error } = await db().rpc('near_relay_acquire', {
        p_user: userId,
        p_token: token,
        p_ttl_secs: ttlSecs,
        p_window_secs: windowSecs,
        p_max: maxPerWindow,
      });
      if (error) throw error;
      if (data === 'ok' || data === 'busy' || data === 'rate' || data === 'no_account') return data;
      throw new Error(`near_relay_acquire returned ${String(data)}`);
    },

    async releaseRelayLock(userId, token) {
      const { error } = await db().rpc('near_relay_release', { p_user: userId, p_token: token });
      if (error) throw error;
    },
  };
}

// ---------------------------------------------------------------- guests

const GUEST_COLUMNS = 'account_id, public_key, state, create_tx, created_at, updated_at';

function toGuest(r: Pick<NearGuestDbRow, 'account_id' | 'public_key' | 'state' | 'create_tx' | 'created_at' | 'updated_at'>): NearGuestRow {
  return { accountId: r.account_id, publicKey: r.public_key, state: r.state, createTx: r.create_tx, createdAt: r.created_at, updatedAt: r.updated_at };
}

const RESERVE_RESULTS: readonly GuestReserveResult[] = ['ok', 'ip_limit', 'day_limit', 'key_taken', 'account_taken'];

// NearGuestStore on bm.near_guests: the caps and the insert are one SQL
// function (bm.near_guest_reserve), as are the relay lock and its count.
// Never selects ip_hash: nothing outside the database needs it.
export function supabaseNearGuestStore(): NearGuestStore {
  return {
    async getByAccount(accountId) {
      const { data, error } = await db().from('near_guests').select(GUEST_COLUMNS).eq('account_id', accountId).maybeSingle();
      if (error) throw error;
      return data ? toGuest(data) : null;
    },

    async getByPublicKey(publicKey) {
      const { data, error } = await db().from('near_guests').select(GUEST_COLUMNS).eq('public_key', publicKey).maybeSingle();
      if (error) throw error;
      return data ? toGuest(data) : null;
    },

    async reserve({ accountId, publicKey, ipHash }, caps) {
      const { data, error } = await db().rpc('near_guest_reserve', {
        p_account_id: accountId,
        p_public_key: publicKey,
        p_ip_hash: ipHash,
        p_ip_max: caps.perIp,
        p_ip_window_secs: caps.ipWindowSecs,
        p_day_max: caps.perDay,
        p_day_window_secs: caps.dayWindowSecs,
      });
      if (error) throw error;
      if ((RESERVE_RESULTS as readonly string[]).includes(data as string)) return data as GuestReserveResult;
      throw new Error(`near_guest_reserve returned ${String(data)}`);
    },

    async markActive(accountId, createTx) {
      const { data, error } = await db()
        .from('near_guests')
        .update({ state: 'active', create_tx: createTx, updated_at: new Date().toISOString() })
        .eq('account_id', accountId)
        .eq('state', 'creating')
        .select('account_id');
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },

    async markFailed(accountId) {
      const { error } = await db()
        .from('near_guests')
        .update({ state: 'failed', updated_at: new Date().toISOString() })
        .eq('account_id', accountId)
        .eq('state', 'creating');
      if (error) throw error;
    },

    async acquireRelayLock(accountId, token, { ttlSecs, windowSecs, maxPerWindow }): Promise<LockResult> {
      const { data, error } = await db().rpc('near_guest_relay_acquire', {
        p_account: accountId,
        p_token: token,
        p_ttl_secs: ttlSecs,
        p_window_secs: windowSecs,
        p_max: maxPerWindow,
      });
      if (error) throw error;
      if (data === 'ok' || data === 'busy' || data === 'rate' || data === 'no_account') return data;
      throw new Error(`near_guest_relay_acquire returned ${String(data)}`);
    },

    async releaseRelayLock(accountId, token) {
      const { error } = await db().rpc('near_guest_relay_release', { p_account: accountId, p_token: token });
      if (error) throw error;
    },
  };
}
