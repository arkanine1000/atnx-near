# NEAR contracts

Two contracts that run ATNX's rolling VI rounds on NEAR. They port `programs/vi_rounds` (Anchor, Solana devnet). The mechanics are in [docs/rounds.md](../docs/rounds.md); the build spec, and the reasons the design differs from Solana, are in [SPEC.md](SPEC.md).

- `usdg/` is USDG, "ATNX test USD": a NEP-141 test token with 6 decimals. Its only minter is the rounds contract. Transfers register an unregistered receiver at the token contract's expense, so nobody has to call `storage_deposit` first.
- `rounds/` is the rounds contract. Each series runs back-to-back rounds on one subject's VI: presale commits, an open at the VI target, live buys on Pennock's dynamic pari-mutuel market, a keeper settle on the 30-minute average, then claims or rollovers. `src/math.rs` is a verbatim copy of `programs/vi_rounds/src/math.rs`; change that file and copy it here.
- `integration-tests/` deploys both wasm files to a local near-sandbox and runs them end to end.

## How money moves

Each account has an internal USDG balance inside `rounds`. An account funds it once, either with `faucet` (the rounds contract mints test USDG to itself and credits the caller) or with `ft_transfer_call` on the token, with `rounds` as the receiver. After that, `commit`, `buy`, `claim`, `claim_rollover` and `withdraw_fees` only move internal balances and attach no deposit. A function-call access key can sign them, or a relayer can submit them as NEP-366 meta-transactions, so users never need NEAR. `withdraw` sends USDG back to the caller's token account.

Only `faucet` and `withdraw` make cross-contract calls. `faucet` credits the caller in its callback, and only if the mint succeeded. `withdraw` debits first and credits the amount back in its callback if the transfer failed.

Both contracts pay their own storage from their NEAR balance, which is fine on testnet. `rounds` deletes a position once it is claimed.

## Build and test

Rust 1.99.1 with the `wasm32-unknown-unknown` target, pinned in `rust-toolchain.toml`, and cargo-near 0.23.0. rustup installs the pinned toolchain the first time a command runs in `near/`. It counts as a separate toolchain from `stable`, even when `stable` is the same release. On this machine the compiler crashes under parallel load, so every command runs pinned to four cores with two jobs and its output in `/tmp`. If a build dies with SIGSEGV or "rustc interrupted", run it again; finished crates are kept.

```
cd near
export CARGO_TARGET_DIR=/tmp/atnx-near-target CARGO_BUILD_JOBS=2

# wasm, written to $CARGO_TARGET_DIR/near/<name>/<name>.wasm
taskset -c 0,3-5 cargo near build non-reproducible-wasm --manifest-path usdg/Cargo.toml
taskset -c 0,3-5 cargo near build non-reproducible-wasm --manifest-path rounds/Cargo.toml

# unit tests: math.rs's own tests plus the contract tests
taskset -c 0,3-5 cargo test -p rounds --lib
taskset -c 0,3-5 cargo test -p usdg

# sandbox tests, after both wasm builds; the first run downloads near-sandbox
taskset -c 0,3-5 cargo test -p integration-tests -- --test-threads=1
```

The integration tests read the wasm files from `$ATNX_NEAR_WASM_DIR/<name>/<name>.wasm` if that variable is set, otherwise from `$CARGO_TARGET_DIR/near/…`, and with neither set from `near/target/near/…`, which is where CI's reproducible build puts them. Point `ATNX_NEAR_WASM_DIR` at a directory laid out the same way to run the sandbox tests on downloaded CI artifacts. `cargo test` without `-p` covers `usdg` and `rounds` only: they are the workspace's default members.

CI runs `.github/workflows/near-build.yml` on every push or pull request that touches `near/`: both unit-test suites, a reproducible build of each contract, then the sandbox tests against those same two wasm files. It uploads `usdg.wasm` and `rounds.wasm` as artifacts (`usdg-wasm`, `rounds-wasm`) and prints in the job summary their size, their SHA-256 in hex and in base58, and the NEP-330 metadata each one embeds. A pull request builds its head commit rather than GitHub's merge commit, so the revision in the metadata exists in the repository.

### Reproducible builds

The wasm files to deploy are CI's, built with `cargo near build reproducible-wasm` from each contract's directory. cargo-near clones the checked-out commit into a temporary directory, so anything uncommitted is left out (CI fails before the build if the checkout is dirty), and builds the clone in the Docker image named in the contract's `[package.metadata.near.reproducible_build]` table:

| Field | Value |
|---|---|
| `image` | `sourcescan/cargo-near:0.23.0-rust-1.99.1` (the tag is descriptive) |
| `image_digest` | `sha256:8013f039e8005627f10ae66b5519d1a6eeeed7d7aef4b5067d5e9a86c4302fcc` (this identifies the image) |
| `passed_env` | none |
| `container_build_command` | `cargo near build non-reproducible-wasm --locked`, so `Cargo.lock` must be committed and current |

The image's cargo-near and Rust versions match `CARGO_NEAR_VERSION` in the workflow and `rust-toolchain.toml`; change all three together. The build writes NEP-330 source metadata into the wasm, which the contract returns from its `contract_source_metadata` view: `version` (the workspace version, 0.1.0), `link` (`repository` from `Cargo.toml` plus `/tree/<commit>`) and `build_info`, which holds the image with its digest, the build command, the contract's path in the repository (`near/usdg`, `near/rounds`) and `source_code_snapshot`, `git+https://github.com/arkanine1000/atnx-near?rev=<commit>`. The commit is part of the wasm, so every commit builds different bytes even where the contract code did not change; the same commit builds the same bytes.

To check a deployed contract against the repository: read its metadata with the `contract_source_metadata` view, check out the commit it names, run `cargo near build reproducible-wasm` in its `contract_path` on a machine with Docker, and compare the SHA-256 with the account's `code_hash` from `view_account`, which is the same digest in base58 (the job summary prints both forms). The contracts deployed on testnet before this build existed return `version` 0.1.0 with no `link` and no `build_info`. Explorer verification (NearBlocks' "Verify and Publish", backed by SourceScan) clones the repository named in `source_code_snapshot`, so it needs the repository to be public; `arkanine1000/atnx-near` is private.

This machine has no Docker, so builds here stay `non-reproducible-wasm` (above). They embed `version` and `link` but no `build_info`, and their bytes differ from CI's.

## usdg methods

| Method | Who | Notes |
|---|---|---|
| `new(owner_id, minter_id)` | init | Metadata "ATNX test USD", USDG, 6 decimals; supply 0 |
| `mint(receiver_id, amount)` | the minter | Registers the receiver if needed and emits `ft_mint` |
| `set_minter(minter_id)` | the owner | |
| `ft_transfer`, `ft_transfer_call` | anyone, 1 yoctoNEAR | NEP-141; registers an unregistered receiver for free |
| `ft_total_supply`, `ft_balance_of`, `ft_metadata` | view | NEP-141, NEP-148 |
| `storage_deposit`, `storage_withdraw`, `storage_unregister`, `storage_balance_bounds`, `storage_balance_of` | NEP-145 | An account registered for free gets no storage refund when it unregisters |

## rounds methods

Amounts are `U128` strings in 6-decimal USDG units. Times are unix seconds from the block timestamp. Sides are `"Up"` and `"Down"`. Series ids start at 1, and so do round indexes within a series. `commit`, `buy` and `quote_buy` take the round they act on, and fail if it is no longer the presale or live round. A commit sent just as the keeper opens round N fails instead of landing in N+1. `reference` and `commitment` are 64 lowercase hex characters. No method accepts a deposit.

| Method | Who | What it does |
|---|---|---|
| `new(owner, keeper, treasury, token, fee_bps, finder_bps)` | init | Fee at most 500 bps; finder share at most 10,000 bps of the fee |
| `set_config(keeper?, treasury?, fee_bps?, finder_bps?)` | owner | New fee terms apply to series created later |
| `faucet(amount)` | anyone | At most 10,000 USDG per call; resolves to the amount credited (0 if the mint failed) |
| `ft_on_transfer(sender_id, amount, msg)` | the token | Credits `sender_id`. Calls from any other account get the full amount back. `msg` is ignored |
| `withdraw(amount)` | anyone | Resolves to the amount sent (0 if the transfer failed and the balance was credited back) |
| `create_series(reference, round_secs, settle_window_secs, ante, finder)` | keeper | Returns the series id and creates round 1 in presale. The series copies the config's fee terms. `round_secs` ≥ 20 and the window must be shorter than the round |
| `set_series(series_id, paused?, finder?, ante?)` | owner or keeper | |
| `commit(series_id, round_index, side, amount)` | anyone | Into round `round_index`, which must be the series' current presale round, from the internal balance; 1 % fee |
| `open_round(series_id, target_e2)` | keeper | Opens the presale round (both pots must hold money) and creates the next one in presale |
| `buy(series_id, round_index, side, amount, min_shares)` | anyone | In round `round_index`, which must be the live round, until `trade_until`; 1 % fee; at most 1,000 times the money on that side |
| `settle(series_id, settle_e2, commitment)` | keeper | At or after `close_at`. UP wins if `settle_e2 >= target_e2` |
| `void_round(series_id, round_index)` | keeper | Either the live round once past its close, or the presale round of a paused series. The second ends the series |
| `claim(series_id, round_index)` | holder | Credits the payout or refund and deletes the position; returns the amount |
| `claim_rollover(series_id, round_index)` | holder | Commits a settled payout to the winning side of the current presale round (round N+2 by the time N can be claimed). The 1 % fee applies to the whole amount. Returns the net amount committed |
| `withdraw_fees(series_id)` | anyone | Credits the finder's counter to the finder and the platform's counter to the treasury |
| `on_faucet`, `on_withdraw` | the contract itself | Callbacks |

Views: `get_config()`, `get_series(series_id)`, `get_series_by_reference(reference)`, `list_series(from_index?, limit?)` (`from_index` is an offset, `limit` defaults to 50 and is capped at 100), `get_round(series_id, round_index)`, `get_position(series_id, round_index, account_id)`, `positions_of(account_id)`, `balance_of(account_id)`, and `quote_buy(series_id, round_index, side, amount) -> { shares, fee, finder_fee, net }`. `quote_buy` runs the same checks and arithmetic as `buy`, except for the balance and `min_shares`.

### Events

NEP-297 logs, one object per event, with every value a string:

```
EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":"commit","data":[{"series_id":"1","round_index":"1","account":"alice.near","side":"Up","amount":"50000000","fee":"500000","net":"49500000","presale_up":"49500000","presale_down":"0"}]}
```

| Event | Data |
|---|---|
| `series_created` | series_id, round_index, reference, finder, round_secs, settle_window_secs, ante |
| `commit` | series_id, round_index, account, side, amount, fee, net, presale_up, presale_down |
| `round_opened` | series_id, round_index, target_e2, m_up, m_down, shares, opened_at, close_at, trade_until, next_round_index |
| `buy` | series_id, round_index, account, side, amount, fee, net, shares, m_up, m_down, n_up, n_down |
| `round_settled` | series_id, round_index, winner, settle_e2, target_e2, commitment |
| `round_voided` | series_id, round_index |
| `claim` | series_id, round_index, account, amount |
| `rollover` | series_id, round_index, next_round_index, account, side, amount, fee, net; a `commit` event for the next round follows |
| `fees_withdrawn` | series_id, finder, finder_amount, treasury, platform_amount |
| `deposit`, `withdraw`, `faucet` | account, amount |

### Errors

Failures panic with the lib.rs messages, so clients can match on the text: "amount is zero", "series is paused", "round is not the series' presale round", "round is not the series' live round", "round is not settled", "trading closed for the settlement window", "round has not reached its close", "series is not paused", "a live round already exists", "both sides need money before a round can open", "fewer shares than the minimum you set", "a single buy may not exceed 1000x the money on its side", "arithmetic overflow", "nothing to claim", "round index or state does not fit this call", "settlement window must be shorter than the round, round at least 20 s", "fee above the cap", "mint above the per-call cap" and "not the authority or the keeper".

NEAR adds messages where Anchor's account checks did the work: "not the owner", "not the keeper", "no such series", "no such round", "no position in this round", "reference must be 64 lowercase hex characters", "commitment must be 64 lowercase hex characters", "a series with this reference already exists" and "balance too low". An unknown side fails when the arguments are parsed, so lib.rs's `BadSide` has no counterpart.

## Known limits

- Both contracts pay storage from their own NEAR balance. Anyone can make `rounds` store a position by committing two units, or make `usdg` register an account by sending it one unit. Mainnet would charge storage at deposit time.
- The keeper is the oracle, as on Solana.
