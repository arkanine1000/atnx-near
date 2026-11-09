-- bm/005_near_guests.sql
--
-- Guest accounts for the rounds on NEAR testnet: a gasless NEAR account,
-- guest-<8 random lowercase letters or digits>.atnx.testnet, for someone who
-- has not signed in (lib/near/guest.ts). It is made the way a user's account
-- is (004): zero NEAR, and one key, a WebCrypto key that never leaves the
-- guest's browser, added as a function-call key for the rounds contract.
--
-- A guest is NOT a Supabase user. The Supabase project is shared with
-- atnx.app, and an anonymous sign-in would give every scripted guest the
-- `authenticated` role there. A guest is only a row here:
--
--   bm.near_guests  one row per guest account: the account, its key, the
--                   salted hash of the IP that asked for it, its state,
--                   and the relay lock and hourly cap (as in 004).
--
-- Nobody but the service role can read or write it: no grant to anon or
-- authenticated, and RLS on with no policy. The routes
-- (lib/near/store-supabase.ts, supabaseNearGuestStore) use the service role.
--
-- The abuse caps are enforced here, in one function call per new guest
-- (bm.near_guest_reserve): at most p_ip_max guests per IP hash per
-- p_ip_window_secs, and at most p_day_max guests overall per
-- p_day_window_secs. The app passes 3 per hour and 200 per 24 hours
-- (GUEST_CAPS in lib/near/guest.ts); the function refuses caps outside sane
-- bounds. Reservations take one transaction-level advisory lock, so two
-- concurrent requests cannot both pass the counts. A guest whose creation
-- failed stays as 'failed' and still counts.
--
-- ip_hash is HMAC-SHA256 of the client's IP (an IPv6 address by its /64)
-- under a server-only salt; the raw IP is never stored. It is only needed
-- for the per-IP cap, so each reservation clears the hashes of rows older
-- than the longer of the two windows.
--
-- The relay lock works as 004's, keyed on the account id:
-- bm.near_guest_relay_acquire / bm.near_guest_relay_release. The app gives
-- a guest 60 relays an hour (a signed-in user 200).
--
-- Idempotent. Not applied by the branch that adds it; apply by hand.

create table if not exists bm.near_guests (
  account_id               text primary key
                           check (length(account_id) between 2 and 64
                                  and account_id ~ '^guest-[0-9a-z]{8}\.(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$'),
  public_key               text not null unique check (public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  ip_hash                  text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  -- 'creating' while the parent's CreateAccount is in flight; 'failed' when
  -- it did not land (the row keeps counting against the caps).
  state                    text not null default 'creating' check (state in ('creating', 'active', 'failed')),
  create_tx                text,
  relay_lock_token         uuid,
  relay_locked_until       timestamptz,
  relay_window_started_at  timestamptz,
  relay_window_count       integer not null default 0 check (relay_window_count >= 0),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table bm.near_guests is
  'NEAR testnet guest accounts (no Supabase user): account, browser key, salted IP hash, state, relay lock. Service role only.';
comment on column bm.near_guests.ip_hash is
  'HMAC-SHA256 of the client IP (IPv6 by /64) under a server-only salt; cleared once no cap needs it. Never the raw IP.';

-- The per-IP count and the overall count of bm.near_guest_reserve.
create index if not exists bm_near_guests_ip_recent on bm.near_guests (ip_hash, created_at);
create index if not exists bm_near_guests_recent on bm.near_guests (created_at);

alter table bm.near_guests enable row level security;

-- 001 grants select on every new bm table to anon and authenticated by
-- default; not this one. No policy either, so even a stray grant reads
-- nothing.
revoke all on bm.near_guests from public, anon, authenticated;
grant all on bm.near_guests to service_role;

-- Reserve a guest: insert (p_account_id, p_public_key, p_ip_hash) in state
-- 'creating' if the caps allow it. Returns 'ok', 'key_taken' (a row has
-- this key), 'account_taken' (a row has this account id), 'ip_limit' (this
-- IP hash made p_ip_max guests in the last p_ip_window_secs) or
-- 'day_limit' (p_day_max guests in the last p_day_window_secs).
create or replace function bm.near_guest_reserve(
  p_account_id text,
  p_public_key text,
  p_ip_hash text,
  p_ip_max integer,
  p_ip_window_secs integer,
  p_day_max integer,
  p_day_window_secs integer
) returns text
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  if p_ip_max is null or p_ip_max not between 1 and 20
     or p_ip_window_secs is null or p_ip_window_secs not between 60 and 86400
     or p_day_max is null or p_day_max not between 1 and 2000
     or p_day_window_secs is null or p_day_window_secs not between 3600 and 604800 then
    raise exception 'bm.near_guest_reserve: caps out of bounds';
  end if;
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'bm.near_guest_reserve: bad ip hash';
  end if;

  -- One reservation at a time, until this transaction ends, so two
  -- requests cannot both pass the counts below.
  perform pg_advisory_xact_lock(hashtextextended('bm.near_guest_reserve', 0));

  -- Hashes no cap needs any more.
  update bm.near_guests
     set ip_hash = null
   where ip_hash is not null
     and created_at < now() - make_interval(secs => greatest(p_ip_window_secs, p_day_window_secs));

  if exists (select 1 from bm.near_guests where public_key = p_public_key) then
    return 'key_taken';
  end if;
  if exists (select 1 from bm.near_guests where account_id = p_account_id) then
    return 'account_taken';
  end if;

  select count(*) into n
    from bm.near_guests
   where ip_hash = p_ip_hash
     and created_at > now() - make_interval(secs => p_ip_window_secs);
  if n >= p_ip_max then
    return 'ip_limit';
  end if;

  select count(*) into n
    from bm.near_guests
   where created_at > now() - make_interval(secs => p_day_window_secs);
  if n >= p_day_max then
    return 'day_limit';
  end if;

  insert into bm.near_guests (account_id, public_key, ip_hash, state)
  values (p_account_id, p_public_key, p_ip_hash, 'creating');
  return 'ok';
end $$;

-- 004's relay lock, for a guest: take the lock under p_token for
-- p_ttl_secs, counting the relay against p_max per p_window_secs. Returns
-- 'ok', 'busy', 'rate' or 'no_account' (no active row).
create or replace function bm.near_guest_relay_acquire(
  p_account text,
  p_token uuid,
  p_ttl_secs integer,
  p_window_secs integer,
  p_max integer
) returns text
language plpgsql
set search_path = ''
as $$
declare
  r bm.near_guests%rowtype;
  fresh_window boolean;
begin
  select * into r from bm.near_guests where account_id = p_account for update;
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
  update bm.near_guests
     set relay_lock_token = p_token,
         relay_locked_until = now() + make_interval(secs => p_ttl_secs),
         relay_window_started_at = case when fresh_window then now() else relay_window_started_at end,
         relay_window_count = case when fresh_window then 1 else relay_window_count + 1 end
   where account_id = p_account;
  return 'ok';
end $$;

-- Free the lock, only if p_token still holds it.
create or replace function bm.near_guest_relay_release(p_account text, p_token uuid) returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update bm.near_guests
     set relay_lock_token = null, relay_locked_until = null
   where account_id = p_account and relay_lock_token = p_token;
  return found;
end $$;

revoke all on function bm.near_guest_reserve(text, text, text, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function bm.near_guest_relay_acquire(text, uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function bm.near_guest_relay_release(text, uuid) from public, anon, authenticated;
grant execute on function bm.near_guest_reserve(text, text, text, integer, integer, integer, integer) to service_role;
grant execute on function bm.near_guest_relay_acquire(text, uuid, integer, integer, integer) to service_role;
grant execute on function bm.near_guest_relay_release(text, uuid) to service_role;

notify pgrst, 'reload schema';
