// NearAccountStore on bm.near_accounts (supabase/bm/004_near_accounts.sql),
// through the service-role client. Server only. Every state change is a
// compare-and-set on the row as last read; the relay lock and the hourly
// cap are one SQL function each, so they are atomic across serverless
// instances.
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import type { LockResult, NearAccountRow, NearAccountStore, ReserveResult } from './store';

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
