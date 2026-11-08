-- bm/003_near.sql
--
-- Rolling VI rounds on NEAR testnet (near/rounds at rounds.atnx.testnet),
-- beside the Solana devnet rounds of 002. Both chains share bm.series and
-- bm.rounds; bm.series.chain tells them apart ('solana:devnet',
-- 'near:testnet') and the keeper's step for each chain only reads its own
-- rows (lib/bm/rounds-registry.ts).
--
-- Additive only. Existing rows, columns, indexes and policies are left as
-- they are: every new column is nullable with no default, and every new
-- check only constrains rows whose chain starts with 'near:', so the
-- Solana rows pass them trivially.
--
-- What a NEAR row holds where a Solana row holds an address:
--
--   bm.series.chain          'near:testnet'
--   bm.series.program_id     the contract account, rounds.atnx.testnet
--   bm.series.finder_wallet  the finder's NEAR account id
--   bm.series.series_pubkey  null: a NEAR series has no address; it is
--                            onchain_series_id (new) in program_id
--   bm.rounds.round_pubkey   null: rounds are named (series id, index)
--   *_tx, keeper_log.tx_hash NEAR transaction hashes (base58), which the
--                            existing text columns already take
--
-- and, new: bm.rounds.settle_inputs, the canonical JSON of what the keeper
-- settled a NEAR round on, and settle_commitment, its sha256, which the
-- settle call posted on chain as the round's `commitment`
-- (lib/bm/commitment.ts; `npm run rounds:verify` recomputes it). Solana
-- rounds keep a zero commitment and leave both null.
--
-- None of the existing columns needed widening: chain, program_id,
-- finder_wallet and the tx columns are unconstrained text in 002.
--
-- Idempotent.

alter table bm.series add column if not exists onchain_series_id bigint;
alter table bm.rounds add column if not exists settle_inputs jsonb;
alter table bm.rounds add column if not exists settle_commitment text;

comment on column bm.series.onchain_series_id is
  'NEAR only: the series id in the rounds contract (program_id), from 1. Null on Solana rows, which use series_pubkey.';
comment on column bm.rounds.settle_inputs is
  'NEAR only: the canonical oracle inputs the settle committed to (market, reference, round, window, prints, average_e2). jsonb reorders keys; re-canonicalise before hashing.';
comment on column bm.rounds.settle_commitment is
  'NEAR only: sha256 hex of the canonical settle_inputs, as posted on chain in the round''s commitment.';

do $$ begin
  -- A NEAR series: testnet only, NEAR account ids for the finder and the
  -- contract, and a positive on-chain id once it has one.
  if not exists (
    select 1 from pg_constraint
    where conname = 'bm_series_near_shape' and conrelid = 'bm.series'::regclass
  ) then
    alter table bm.series add constraint bm_series_near_shape check (
      chain not like 'near:%'
      or (
        chain = 'near:testnet'
        and char_length(finder_wallet) between 2 and 64
        and finder_wallet ~ '^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$'
        and char_length(program_id) between 2 and 64
        and program_id ~ '^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$'
        and series_pubkey is null
        and (onchain_series_id is null or onchain_series_id between 1 and 4294967295)
      )
    );
  end if;

  -- The numeric id belongs to NEAR rows only.
  if not exists (
    select 1 from pg_constraint
    where conname = 'bm_series_onchain_id_near_only' and conrelid = 'bm.series'::regclass
  ) then
    alter table bm.series add constraint bm_series_onchain_id_near_only
      check (onchain_series_id is null or chain like 'near:%');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'bm_rounds_settle_commitment_hex' and conrelid = 'bm.rounds'::regclass
  ) then
    alter table bm.rounds add constraint bm_rounds_settle_commitment_hex
      check (settle_commitment is null or settle_commitment ~ '^[0-9a-f]{64}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'bm_rounds_settle_inputs_object' and conrelid = 'bm.rounds'::regclass
  ) then
    alter table bm.rounds add constraint bm_rounds_settle_inputs_object
      check (settle_inputs is null or jsonb_typeof(settle_inputs) = 'object');
  end if;
end $$;

-- One registry row per on-chain NEAR series (a failed or ended row keeps
-- its id, and a new series always gets a new one).
create unique index if not exists bm_series_near_onchain_id
  on bm.series (program_id, onchain_series_id)
  where onchain_series_id is not null;

-- The grants and RLS policies of 002 cover the new columns (table-level
-- select for anon and authenticated, all for service_role).

notify pgrst, 'reload schema';
