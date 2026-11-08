# NEAR contracts: build spec

This file specifies the port of `programs/vi_rounds` (Anchor, Solana devnet) to NEAR. The mechanics are those in [docs/rounds.md](../docs/rounds.md), which stay authoritative: presale pots, opening at the VI target, Pennock's dynamic pari-mutuel market (variant I, price function I), the 30-minute averaged settle by the keeper, claims, rollovers and fees. Where this spec and `programs/vi_rounds/src/lib.rs` disagree, this spec wins. Everything else follows lib.rs exactly: state transitions, checks, rounding and error cases.

Testnet accounts: parent `atnx.testnet`. Contracts go on `usdg.atnx.testnet` and `rounds.atnx.testnet`; the keeper is `keeper.atnx.testnet`. User accounts may be sub-accounts like `alice.atnx.testnet`.

## Layout

```
near/
  Cargo.toml          workspace: members usdg, rounds, integration-tests; default-members usdg, rounds
  usdg/               NEP-141 test token
  rounds/             the rounds contract
    src/math.rs       verbatim copy of programs/vi_rounds/src/math.rs (header comment: copied from, keep in sync)
  integration-tests/  near-workspaces tests against both wasm files
```

Use near-sdk 5.30 and near-contract-standards of the same version. Rust 1.99 is installed. In the release profile set `codegen-units = 1`, `opt-level = "z"`, `lto = true`, `panic = "abort"` and `overflow-checks = true`.

## Why the design differs from Solana

1. **Internal ledger.** Users fund the contract once, and after that every commit, buy, claim, rollover and faucet call moves balances inside `rounds` and attaches no deposit. Calls without a deposit can be signed by a function-call access key and relayed as NEP-366 meta-transactions, so the relayer pays gas and users never hold NEAR. That is what makes Google login with gasless bets possible. (`ft_transfer` needs 1 yoctoNEAR, which function-call keys can't attach.)
2. **Async calls.** Only `faucet` and `withdraw` make cross-contract calls. Each one finishes its own state before the promise, or debits first and refunds in a `#[private]` callback. No round state is left half-updated across a promise.
3. **Storage.** On testnet `rounds` pays its own storage from its NEAR balance, and a claimed position is removed. This is documented as a known limit; mainnet would charge storage at deposit time.

## usdg (NEP-141 test token)

- `new(owner_id, minter_id)`: metadata name "ATNX test USD", symbol "USDG", 6 decimals, total supply 0.
- The standard NEP-141, NEP-145 and NEP-148 methods, via near-contract-standards.
- `mint(receiver_id, amount: U128)`, callable only by `minter_id` (the rounds contract), with no deposit. It registers the receiver if needed, with the contract paying for storage, and emits an `ft_mint` event.
- `ft_transfer` and `ft_transfer_call` auto-register an unregistered receiver at the contract's expense instead of panicking. This is a test token, and judges shouldn't have to call `storage_deposit` first.
- `set_minter(minter_id)`: owner only.

## rounds

Amounts at the interface are `U128` (6-decimal USDG units); internally they're u64, as math.rs expects, with checked conversion. Times are unix seconds from `env::block_timestamp_ms() / 1000`. Sides are `"Up"` / `"Down"` in JSON (enum `Side`).

### State

- `Config`: `owner`, `keeper`, `treasury`, `token` (the usdg account), `fee_bps` (100), `finder_bps` (2000), `series_count`.
- `balances: LookupMap<AccountId, u64>`: the internal ledger.
- `series: LookupMap<u32, Series>`, plus `series_by_reference: LookupMap<String, u32>` (reference = 64 hex characters, the same 32-byte layout as on Solana; see docs/rounds.md, Series).
- `Series`: the lib.rs fields, with `finder: AccountId` and `reference: String`.
- `rounds: LookupMap<(u32, u32), Round>`, keyed by (series_id, round_index). `Round` has the lib.rs fields, with `commitment` as a 64-hex `String`.
- `positions: LookupMap<(u32, u32, AccountId), Position>`, with the lib.rs fields, plus `account_positions: LookupMap<AccountId, IterableSet<(u32, u32)>>` so `positions_of` works. Remove an entry from both when its position is closed.

### Methods (port each from lib.rs; the NEAR differences are noted)

- `new(owner, keeper, treasury, token, fee_bps, finder_bps)`.
- `set_config(...)`: owner only.
- `faucet(amount: U128)`: anyone, at most 10,000 USDG per call. It calls `token.mint(receiver = rounds, amount)` with callback `on_faucet(account_id, amount)`, which credits the caller's internal balance only if the mint succeeded.
- `ft_on_transfer(sender_id, amount, msg)`: accepts only `predecessor == token`, credits `sender_id`'s balance and returns `U128(0)`. Any other token is rejected by returning the full amount. `msg` is ignored.
- `withdraw(amount: U128)`: debit the caller first, then `token.ft_transfer(caller, amount)` with 1 yocto attached from the contract's own balance, then callback `on_withdraw(account_id, amount)`, which re-credits the caller if the transfer failed.
- `create_series(reference, round_secs, settle_window_secs, ante: U128, finder: AccountId) -> u32`: keeper only. The series is created by the keeper on behalf of the finder (on Solana anyone could call this). It creates round 1 in presale.
- `set_series(series_id, paused: Option<bool>, finder: Option<AccountId>, ante: Option<U128>)`: keeper or owner.
- `commit(series_id, side, amount: U128)`: from the caller's internal balance. The fee is split as in lib.rs.
- `open_round(series_id, target_e2: u64)`: keeper only. It opens the presale round and creates the next presale round (the next index is derived; no `next_index` argument).
- `buy(series_id, side, amount: U128, min_shares: U128)`: from the internal balance.
- `settle(series_id, settle_e2: u64, commitment: String)`: keeper only.
- `void_round(series_id, round_index)`: keeper only, with the same conditions as lib.rs.
- `claim(series_id, round_index)`: credits the payout or refund to the caller's internal balance; no token transfer. It then removes the position.
- `claim_rollover(series_id, round_index)`: as in lib.rs, with everything inside the ledger.
- `withdraw_fees(series_id)`: anyone may call it. It credits the finder's and the treasury's internal balances and zeroes the counters.

Views:
- `get_config`, `get_series(series_id)`, `get_series_by_reference(reference)`, `list_series(from_index, limit)`
- `get_round(series_id, round_index)`, `get_position(series_id, round_index, account_id)`, `positions_of(account_id)`, `balance_of(account_id)`
- `quote_buy(series_id, side, amount) -> { shares, fee, finder_fee, net }`, which uses the same math as `buy`.

Errors: panic with the lib.rs error messages (e.g. `"fewer shares than the minimum you set"`) via `env::panic_str`, so clients can match on them.

Events: emit NEP-297 logs, `EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":"<name>","data":[{...}]}`, for `series_created`, `commit`, `round_opened`, `buy`, `round_settled`, `round_voided`, `claim`, `rollover`, `fees_withdrawn`, `deposit`, `withdraw` and `faucet`. The data carries series_id, round_index, account, side and amounts as strings. These events replace the missing Solana trade log.

## Tests

1. `cargo test -p rounds --lib` runs math.rs's own tests unchanged.
2. Unit tests with near-sdk's `unit-testing` feature and `testing_env!` cover:
   - the worked example from docs/rounds.md with the fee on: commits of 600 and 400, then a buy that nets exactly 100. Shares and payouts must equal the TypeScript and Solana numbers;
   - settle UP and DOWN, a tie going UP, void and refunds, a rollover landing in round N+2;
   - pause voiding the presale round, fee withdrawal;
   - the error paths: slippage, ratio cap, trading closed, too early, empty side, access control on keeper and owner methods, a wrong token in `ft_on_transfer`, the faucet cap;
   - payout conservation: paid out ≤ pots, with dust ≥ 0.
3. `integration-tests` (near-workspaces): deploy both wasm files to a sandbox and test faucet → balance, `ft_transfer_call` deposit → balance, withdraw, one full round with three accounts, and a failed withdraw being refunded.

## Building on this machine

The machine's compiler segfaults under parallel load. Always build pinned and at two jobs, with the target directory in /tmp:

```
CARGO_TARGET_DIR=/tmp/atnx-near-target CARGO_BUILD_JOBS=2 taskset -c 0,3-5 cargo near build non-reproducible-wasm --manifest-path near/rounds/Cargo.toml
CARGO_TARGET_DIR=/tmp/atnx-near-target CARGO_BUILD_JOBS=2 taskset -c 0,3-5 cargo test -p rounds
```

If a build dies with SIGSEGV, run it again: finished crates are kept in the target directory.
