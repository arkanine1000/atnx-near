-- bm/004_near_accounts.sql
--
-- NEAR accounts for the rounds on NEAR testnet. A signed-in ATNX user
-- (Supabase Google, X or wallet sign-in) gets one gasless NEAR account,
-- <handle>.atnx.testnet, created by the parent account with zero NEAR.
-- Its only key is a WebCrypto key that never leaves the user's browser
-- (non-extractable, in IndexedDB), added as a function-call key for the
-- rounds contract. Every action the user takes is a NEP-366 delegate the
-- browser signs and /api/near/relay sends, with the relayer paying the gas.
--
--   bm.near_accounts  one row per user: the account, its key, and the
--                     per-user relay lock and hourly cap.
--
-- There is no custody key: a lost browser key means a fresh account. The
-- row then points at the new account and keeps the old ids in
-- previous_account_ids.
--
-- Only the service role writes (the routes, through
-- lib/near/store-supabase.ts). A signed-in user may read their own row.
--
-- The relay lock: a delegate's nonce must land in order, so one delegate
-- per user is in flight at a time, across serverless instances. The route
-- takes the lock with bm.near_relay_acquire (also counting the user's
-- relays per hour) and frees it with bm.near_relay_release; a lock left
-- by a crashed function expires after its TTL.
--
-- Idempotent. Not applied by the branch that adds it; apply by hand.

create table if not exists bm.near_accounts (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  account_id               text not null unique
                           check (length(account_id) between 2 and 64
                                  and account_id ~ '^(([a-z0-9]+[-_])*[a-z0-9]+\.)+([a-z0-9]+[-_])*[a-z0-9]+$'),
  public_key               text not null check (public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- 'creating' while the parent's CreateAccount is in flight.
  state                    text not null default 'creating' check (state in ('creating', 'active')),
  create_tx                text,
  previous_account_ids     text[] not null default '{}',
  relay_lock_token         uuid,
  relay_locked_until       timestamptz,
  relay_window_started_at  timestamptz,
  relay_window_count       integer not null default 0 check (relay_window_count >= 0),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table bm.near_accounts enable row level security;

-- 001 granted select on every bm table to anon by default; not this one.
revoke all on bm.near_accounts from anon, authenticated;
grant select (user_id, account_id, public_key, state, create_tx, previous_account_ids, created_at, updated_at)
  on bm.near_accounts to authenticated;
grant all on bm.near_accounts to service_role;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'bm' and tablename = 'near_accounts' and policyname = 'bm_near_accounts_own_read') then
    create policy bm_near_accounts_own_read on bm.near_accounts
      for select to authenticated using ((select auth.uid()) = user_id);
  end if;
end $$;

-- Take the user's relay lock under p_token for p_ttl_secs, counting the
-- relay against a cap of p_max per p_window_secs. Returns 'ok', 'busy'
-- (someone holds an unexpired lock), 'rate' (the cap is reached) or
-- 'no_account' (no active row).
create or replace function bm.near_relay_acquire(
  p_user uuid,
  p_token uuid,
  p_ttl_secs integer,
  p_window_secs integer,
  p_max integer
) returns text
language plpgsql
set search_path = ''
as $$
declare
  r bm.near_accounts%rowtype;
  fresh_window boolean;
begin
  select * into r from bm.near_accounts where user_id = p_user for update;
  if not found or r.state <> 'active' then
    return 'no_account';
  end if;
  if r.relay_locked_until is not null and r.relay_locked_until > now() then
    return 'busy';
  end if;
  fresh_window := r.relay_window_started_at is null
    or r.relay_window_started_at <= now() - make_interval(secs => p_window_secs);
  if not fresh_window and r.relay_window_count >= p_max then
    return 'rate';
  end if;
  update bm.near_accounts
     set relay_lock_token = p_token,
         relay_locked_until = now() + make_interval(secs => p_ttl_secs),
         relay_window_started_at = case when fresh_window then now() else relay_window_started_at end,
         relay_window_count = case when fresh_window then 1 else relay_window_count + 1 end
   where user_id = p_user;
  return 'ok';
end $$;

-- Free the lock, only if p_token still holds it.
create or replace function bm.near_relay_release(p_user uuid, p_token uuid) returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update bm.near_accounts
     set relay_lock_token = null, relay_locked_until = null
   where user_id = p_user and relay_lock_token = p_token;
  return found;
end $$;

revoke all on function bm.near_relay_acquire(uuid, uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function bm.near_relay_release(uuid, uuid) from public, anon, authenticated;
grant execute on function bm.near_relay_acquire(uuid, uuid, integer, integer, integer) to service_role;
grant execute on function bm.near_relay_release(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
