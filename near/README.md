# NEAR contracts

ATNX's contracts on NEAR: a test token, the rolling VI rounds, and the house market. The rounds contract ports the baseline's Solana program `vi_rounds` (Anchor, Solana devnet; source in [atnx-markets](https://github.com/arkanine1000/atnx-markets/tree/78b6ecd/programs/vi_rounds)); what it is and what still depends on it are in [docs/rounds.md](../docs/rounds.md), and its build spec, with the reasons the design differs from Solana, is in [SPEC.md](SPEC.md). The house contract is described [below](#house).

- `usdg/` is USDG, "ATNX test USD": a NEP-141 test token with 6 decimals. Its only minter is the rounds contract. Transfers register an unregistered receiver at the token contract's expense, so nobody has to call `storage_deposit` first.
- `rounds/` is the rounds contract. Each series runs back-to-back rounds on one subject's VI: presale commits, an open at the VI target, live buys on Pennock's dynamic pari-mutuel market, a keeper settle on the 30-minute average, then claims or rollovers. `src/math.rs` is a verbatim copy of the Solana program's `src/math.rs` at atnx-markets commit `78b6ecd`, below a header that names it.
- `house/` is the house contract: anyone goes long or short a market's VI at 1x, 2x or 3x against a vault, at two prices quoted from each print. `src/quote.rs` holds its price arithmetic.
- `integration-tests/` deploys the wasm files to a local near-sandbox and runs them end to end (`tests/rounds.rs`, `tests/house.rs`).

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
taskset -c 0,3-5 cargo near build non-reproducible-wasm --manifest-path house/Cargo.toml

# unit tests: math.rs's own tests plus the contract tests
taskset -c 0,3-5 cargo test -p rounds --lib
taskset -c 0,3-5 cargo test -p usdg
taskset -c 0,3-5 cargo test -p house --lib

# sandbox tests, after the wasm builds; the first run downloads near-sandbox
taskset -c 0,3-5 cargo test -p integration-tests -- --test-threads=1
```

The integration tests read the wasm files from `$ATNX_NEAR_WASM_DIR/<name>/<name>.wasm` if that variable is set, otherwise from `$CARGO_TARGET_DIR/near/…`, and with neither set from `near/target/near/…`, which is where CI's reproducible build puts them. Point `ATNX_NEAR_WASM_DIR` at a directory laid out the same way to run the sandbox tests on downloaded CI artifacts. `cargo test` without `-p` covers `usdg`, `rounds` and `house`: they are the workspace's default members.

CI runs `.github/workflows/near-build.yml` on every push or pull request that touches `near/`: the three unit-test suites, a reproducible build of each contract, then the sandbox tests against those same wasm files. It uploads `usdg.wasm`, `rounds.wasm` and `house.wasm` as artifacts (`usdg-wasm`, `rounds-wasm`, `house-wasm`) and prints in the job summary their size, their SHA-256 in hex and in base58, and the NEP-330 metadata each one embeds. A pull request builds its head commit rather than GitHub's merge commit, so the revision in the metadata exists in the repository.

### Reproducible builds

The wasm files to deploy are CI's, built with `cargo near build reproducible-wasm` from each contract's directory. cargo-near clones the checked-out commit into a temporary directory, so anything uncommitted is left out (CI fails before the build if the checkout is dirty), and builds the clone in the Docker image named in the contract's `[package.metadata.near.reproducible_build]` table:

| Field | Value |
|---|---|
| `image` | `sourcescan/cargo-near:0.23.0-rust-1.99.1` (the tag is descriptive) |
| `image_digest` | `sha256:8013f039e8005627f10ae66b5519d1a6eeeed7d7aef4b5067d5e9a86c4302fcc` (this identifies the image) |
| `passed_env` | none |
| `container_build_command` | `cargo near build non-reproducible-wasm --locked`, so `Cargo.lock` must be committed and current |

The image's cargo-near and Rust versions match `CARGO_NEAR_VERSION` in the workflow and `rust-toolchain.toml`; change all three together. The build writes NEP-330 source metadata into the wasm, which the contract returns from its `contract_source_metadata` view: `version` (the workspace version, 0.1.0), `link` (`repository` from `Cargo.toml` plus `/tree/<commit>`) and `build_info`, which holds the image with its digest, the build command, the contract's path in the repository (`near/usdg`, `near/rounds`, `near/house`) and `source_code_snapshot`, `git+https://github.com/arkanine1000/atnx-near?rev=<commit>`. The commit is part of the wasm, so every commit builds different bytes even where the contract code did not change; the same commit builds the same bytes.

To check a deployed contract against the repository: read its metadata with the `contract_source_metadata` view, check out the commit it names, run `cargo near build reproducible-wasm` in its `contract_path` on a machine with Docker, and compare the SHA-256 with the account's `code_hash` from `view_account`, which is the same digest in base58 (the job summary prints both forms). The contracts deployed on testnet before this build existed return `version` 0.1.0 with no `link` and no `build_info`. Explorer verification (NearBlocks' "Verify and Publish", backed by SourceScan) clones the repository named in `source_code_snapshot`, so it needs the repository to be public.

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

Failures panic with the messages of the Solana program's `lib.rs`, so clients can match on the text: "amount is zero", "series is paused", "round is not the series' presale round", "round is not the series' live round", "round is not settled", "trading closed for the settlement window", "round has not reached its close", "series is not paused", "a live round already exists", "both sides need money before a round can open", "fewer shares than the minimum you set", "a single buy may not exceed 1000x the money on its side", "arithmetic overflow", "nothing to claim", "round index or state does not fit this call", "settlement window must be shorter than the round, round at least 20 s", "fee above the cap", "mint above the per-call cap" and "not the authority or the keeper".

NEAR adds messages where Anchor's account checks did the work: "not the owner", "not the keeper", "no such series", "no such round", "no position in this round", "reference must be 64 lowercase hex characters", "commitment must be 64 lowercase hex characters", "a series with this reference already exists" and "balance too low". An unknown side fails when the arguments are parsed, so lib.rs's `BadSide` has no counterpart.

## house

Anyone goes long or short a market's VI at 1x, 2x or 3x against a vault. Money is an internal ledger, as in rounds: no trading call takes a deposit, so a function-call key or a relayer can sign every one. The numbers below are the defaults that `new` sets; `set_config` changes them, each inside a range fixed in the code.

### Two prices

Each print carries the score S (the number on the chart) and the reading R (the latest raw result the score smooths towards). The contract quotes S and a lead between them:

- gap = |R − S| / S; λ = 30 % at no gap, rising in a straight line to 100 % at a gap of 25 % and beyond (`lead_min_bps`, `lead_full_gap_bps`); lead = S moved λ of the way to R;
- buy price = max(S, lead), sell price = min(S, lead);
- a long opens at the buy price and closes at the sell price; a short opens at the sell price and closes at the buy price; a position is valued at the price it would close at.

Integer arithmetic on hundredths, every rounding in the vault's favour: the gap, λ and the lead's distance from S round up (so the buy price rounds up and the sell price down), profit and loss round down, the fee rounds up and the finder's part of it down. A score of 0 counts as an infinite gap, and no fill happens at a price of 0.

### Positions

- Stake 10 to 250 USDG at 1x, 2x or 3x; 10 pending, open or closing positions per account. The fee, 1 % of the stake, is charged on top of it at the fill: half to the market's finder and half to the treasury, or all to the treasury when the market has none.
- PnL: long stake × leverage × (exit / entry − 1); short stake × leverage × (1 − exit / entry). The payout, stake + PnL, is at least 0 and at most stake + the maximum profit: 9 × stake for a long (`max_profit_bps`), leverage × stake for a short.
- `open` and `close` only place a request, and each names the worst price it accepts. A request fills at the earliest quote in the market's ring of the last 8 whose `last_read_at` is at least `min_fill_delay_secs` (5 s) after it, so the price never depends on who calls `crank` or when. An order with no such quote within `order_ttl_secs` (15 minutes), or whose quote has left the ring, is refunded in full; a close past its limit goes back to Open and the trader asks again. A close can't be withdrawn; an order can be cancelled only once its time to live has passed with no quote to fill at.
- At the fill the maximum profit is reserved in the vault, inside 2 % of the vault's assets per market and side (`market_cap_bps`) and 80 % in all (`utilisation_cap_bps`); an order that doesn't fit is refunded as "market full". It is also refunded when the price is past its limit or 0, the two prices are more than 10 % of S apart (`max_open_gap_bps`), the score is under 100, or the market is no longer open.
- `open` refuses an order while opens are paused, on a market that isn't open, inside the 48-hour cool-off after the market went live, when the newest quote was last read more than 15 minutes ago, when the score is under 100 or the two prices are more than 10 % apart, or when the contract's free NEAR is under its storage floor.
- At the newest quote: a long is liquidated when the buy price is at or below entry × (1 − 1/leverage), a short when the sell price is at or above entry × (1 + 1/leverage), so the score has to be there and not only the reading (at 1x a long's level is 0, so no price above zero liquidates it, and a short's is twice its entry); the stake goes to the vault, less 1 % of it to whoever cranked (`liq_reward_bps`). A position whose close-side PnL reaches the maximum profit is closed at the cap.
- 14 days after its fill (`max_position_secs`, fixed at the fill) a position closes through the close path at the first quote read after that moment that has a non-zero close-side price and its two prices no more than `max_open_gap_bps` apart. This close has no limit, so it skips every other print; while it waits the position can still be liquidated or capped.

### Quotes and markets

- `push_quotes` (keeper): the same print again must repeat its numbers as pushed and only moves `last_read_at`; a new print needs a larger `print_id` and a later `print_at`, and its score moves from the stored score by at most `max_step_bps` (15 %) per 300 s of print time, and at least one hundredth; a larger move is clipped and catches up on later prints (from a score of 0 the pushed score is taken). `print_at` comes from the index's clock and may be up to 30 s after the block time; `read_at` is never after the block time and never goes back. An entry that breaks a rule, or names an unknown or settled market, is skipped and counted; the call fails only for another caller or a bad commitment.
- The keeper or the owner can pause new orders, name a market's finder and move a market from Open to CloseOnly; neither can settle a market or reopen one. `settle_stale` lets anyone settle a market whose newest quote was last read 24 hours ago (`emergency_secs`): every position on it closes at its last score, and pending orders are refunded. A close that was already due settles at its own quote. A settled market's reference can be listed again as a new market.

### The vault

Shares on realised assets only: open positions are not in the share price. 1,000 dead shares are minted at `new`, so the price is always defined; shares have 9 decimals and start at one USDG a share. `lp_deposit` is open to the treasury only unless `lp_open`. To leave, a holder gives notice with `lp_request_withdraw`; from 24 hours later, for one hour, `lp_withdraw` redeems the shares at that moment's price out of unreserved assets; after the hour the request lapses.

USDG comes in only from the treasury: `ft_transfer_call` with `msg` "faucet" adds to the faucet pool, any other `msg` credits the treasury's balance, and every other transfer is returned in full. `faucet` pays out of the pool, at most 10,000 USDG per account in total.

### house methods

Amounts are `U128` strings (6-decimal USDG units); prices, scores, print ids, position ids and times are `U64` strings (prices in hundredths, times in unix seconds); market ids are numbers from 0, leverage and basis points are numbers. Sides are `"Long"` and `"Short"`.

| Method | Who | What it does |
|---|---|---|
| `new(owner, keeper, treasury, token)` | init | Every setting at its default |
| `migrate()` | the owner or the contract itself | Re-reads the stored state by its `state_version` after a code upgrade |
| `set_config(patch)` | owner | `patch` holds any of the settings except `owner`, `token` and `opens_paused`; unknown fields are refused; each value inside its fixed range |
| `set_paused(opens)` | owner or keeper | Pauses or resumes new orders only |
| `list_market(reference, finder, live_since)` | keeper | `reference` is 32 lowercase hex characters; returns the market id |
| `set_market(market, status?, finder?)` | owner or keeper | `status` may only be `"CloseOnly"` |
| `push_quotes(quotes, commitment)` | keeper | `quotes`: `[{market, score_e2, reading_e2, print_id, print_at, read_at}]`, `commitment` 64 lowercase hex characters; returns `{count, accepted, skipped}` |
| `settle_stale(market)` | anyone | See above |
| `faucet(amount)` | anyone | Returns the amount credited |
| `ft_on_transfer(sender_id, amount, msg)` | the token | From the treasury only |
| `withdraw(amount)` | anyone | Debits first, re-credits if the transfer fails; resolves to the amount sent |
| `open(market, side, leverage, stake, limit_e2)` | anyone | Debits stake + fee; returns the position id |
| `close(position_id, limit_e2)` | the position's account | |
| `cancel(position_id)` | the position's account | After the time to live, with no quote to fill at |
| `crank(position_ids)` | anyone | The first 20 ids; returns what it did with each: `filled`, `refunded`, `closed`, `liquidated`, `close_missed`, `closing`, `waiting`, `unknown`, or `ignored` past the 20th |
| `lp_deposit(amount)`, `lp_request_withdraw(shares)`, `lp_withdraw()` | see above | |

Views: `get_config()`, `get_vault()`, `total_assets()`, `convert_to_shares(assets)`, `convert_to_assets(shares)`, `max_withdraw(owner_id)` (the last four NEP-621-style: the shares are entries in this contract, not a token), `get_market(market)`, `get_market_by_reference(reference)`, `list_markets(from?, limit?)`, `get_position(id)` (null once a position has ended), `positions_of(account)`, `history_of(account)` (the last 20 closed positions, newest first), `list_active(from?, limit?)`, `active_count()`, `balance_of(account)`, `faucet_claimed(account)`, `lp_of(account)` and `quote_open(market, side, leverage, stake, account?)`, which runs `open`'s checks and arithmetic on the newest quote and never panics.

### house events

NEP-297 logs with `"standard":"atnx_house","version":"1.0.0"`, every value a string: `quotes_pushed` (count, accepted, skipped, first_print_id, last_print_id, commitment), `market_listed`, `market_status`, `order_placed`, `order_filled`, `order_refunded` (with `reason`: limit, zero_price, spread, score, market_closed, market_full, expired, rolled_out, cancelled), `close_requested` (`by` trader or expiry), `close_missed` (with `reason`: limit or zero_price), `position_closed` (with `reason`: close, cap, liquidation, expiry, settled), `lp_deposit`, `lp_withdraw_requested`, `lp_withdraw`, `lp_withdraw_lapsed`, `deposit`, `withdraw`, `faucet`, `opens_paused`, `config_set` and `migrated`. A `crank` writes at most one event per id.

Failures panic with fixed messages, among them "not the owner", "not the keeper", "not the owner or the keeper", "already listed", "market is not open", "new orders are paused", "market is inside its cool-off", "the market's newest quote is too old", "score is under the minimum to open", "the two prices are too far apart", "the price is zero", "leverage must be 1, 2 or 3", "stake below the minimum", "stake above the maximum", "a limit price is required", "position limit reached for this account", "the contract is under its storage floor", "balance too low", "position is not open", "order is not pending", "an order can be cancelled only once its time to live has passed", "order has a quote to fill at", "market has had a quote within the emergency period", "faucet limit reached for this account", "faucet pool too low", "vault deposits are open to the treasury only", "withdrawal request is not ready yet", "not enough unreserved assets in the vault" and "config value out of range: <field>".

## Known limits

- usdg and rounds pay storage from their own NEAR balance. Anyone can make `rounds` store a position by committing two units, or make `usdg` register an account by sending it one unit. Mainnet would charge storage at deposit time.
- In rounds the keeper is the oracle, as on Solana.
- house: the keeper sets every price; the contract limits how fast a score can move and what the keeper can do, but the index itself is not verified on chain. The share price counts realised results only. The contract pays its own storage and stops calls that add state under its storage floor; closes, fills, liquidations and withdrawals go on.
