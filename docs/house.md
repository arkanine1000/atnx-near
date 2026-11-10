# The house market on NEAR testnet

The house market lets anyone go UP (long) or DOWN (short) on a market's Virality Index at 1x (no leverage), 2x or 3x, against a vault, on NEAR testnet. The contract is `near/house`, deployed at `house.atnx.testnet`. It holds every balance, position and price; a keeper pushes each market's newest VI print to it; traders sign in with Google or X, or as a guest, and never hold NEAR. Every number on this page is a contract default (`Config::defaults` in `near/house/src/lib.rs`) unless it says otherwise. The contract's methods, views, events and error messages are listed in [near/README.md](../near/README.md#house); how the VI itself is computed is in [virality-index.md](virality-index.md).

The house replaced the [rolling rounds](rounds.md) as the product on NEAR. `rounds.atnx.testnet` is still deployed.

## Accounts and contracts

| Account | Role |
|---|---|
| `house.atnx.testnet` | The house contract: the internal USDG ledger, the vault, the faucet pool, the markets with their recent quotes, and the positions |
| `usdg.atnx.testnet` | USDG, "ATNX test USD": a NEP-141 test token with 6 decimals. The house takes it in from the treasury only |
| `keeper.atnx.testnet` | The keeper: the only account that pushes quotes and lists markets. It signs with two keys, one for the cron runs and one for quotes on demand, and pays its own gas |
| `relayer.atnx.testnet` | Sends every trader's call as a NEP-366 meta-transaction and pays its gas |
| `atnx.testnet` | Owner of the house config, the treasury (it receives half of each fee and the whole fee where a market has no finder), the only vault depositor while `lp_open` is false, and the parent of every trader account |
| `<handle>-h.atnx.testnet`, `guest-<8 characters>-h.atnx.testnet` | Trader accounts on the house, one per signed-in user or guest ([Accounts and relaying](#accounts-and-relaying)) |
| `rounds.atnx.testnet` | The earlier market design on NEAR ([rounds.md](rounds.md#near-testnet)). Each trader also has a rounds account, `<handle>.atnx.testnet`, from which the house account's name is derived |

## The two prices

Each print carries two numbers: the score S, the number on the chart, and the reading R, the latest raw result the score is smoothing towards. The score follows the reading with a two-hour half-life ([virality-index.md](virality-index.md)), so while R differs from S, part of S's next move is already visible. The contract therefore quotes two prices from every print (`near/house/src/quote.rs`, `prices`):

- gap = |R − S| / S;
- λ = 30 % at no gap, rising in a straight line to 100 % at a gap of 25 % and beyond (`lead_min_bps` 3,000, `lead_full_gap_bps` 2,500);
- lead = S moved λ of the way towards R;
- buy price = max(S, lead), sell price = min(S, lead).

A long opens at the buy price and closes at the sell price; a short opens at the sell price and closes at the buy price. A position is always valued at the price it would close at, so a new position usually starts a little under its stake.

The arithmetic is in integers on hundredths, and every rounding goes the vault's way: the gap, λ and the lead's distance from S round up (the buy price rounds up, the sell price down); profit and loss round down; the fee rounds up and the finder's part of it down. A score of 0 counts as an infinite gap, and nothing fills at a price of 0.

Example, from the contract's tests (`a_small_gap_moves_the_lead_part_of_the_way` in `quote.rs`): S 400.00, R 420.00. The gap is 5 %, λ is 30 % + 70 % × 5/25 = 44 %, the lead is 400.00 + 0.44 × 20.00 = 408.80. Buy 408.80, sell 400.00, and the two prices are 2.20 % of S apart.

Orders are refused, and refunded at the fill, while the two prices are more than 10 % of S apart (`max_open_gap_bps`).

## An order, step by step

The worked example is the contract's own test, `worked_example_long_3x_to_the_cent` in `near/house/src/tests.rs`. Run it with `cd near && cargo test -p house --lib worked_example`.

1. The market's newest quote is S 400.00, R 420.00 (buy 408.80, sell 400.00). The market has a finder.
2. `quote_open(market, "Long", 3, 100 USDG)` answers: allowed; entry 408.80; fee 1.00, of which 0.50 to the finder; cost 101.00; liquidation at 272.53; cap at 1,635.20; maximum profit 900.00; worth on fill 93.54 (closing at once pays at the sell price, 400.00: 300 × (400.00 / 408.80 − 1) = −6.46).
3. `open(market, "Long", 3, 100 USDG, limit 410.00)` debits 101.00 from the trader's balance into the vault's margin. The order is `Pending`; nothing is reserved yet.
4. Ten seconds later the keeper reads the same print again and pushes it. `crank([id])`, which anyone may call, fills the order at that quote: entry 408.80. The vault reserves the maximum profit, 900.00; the fee goes out, 0.50 to the finder and 0.50 to the treasury; the margin holds the stake, 100.00.
5. Later prints walk the score to 480.00 with the reading at 470.00. The gap is 2.09 % (rounded up to 209 bps), λ is 35.86 %, the lead is 476.41: buy 480.00, sell 476.41.
6. `close(id, limit 470.00)`, then the next quote and a crank: the long closes at the sell price, 476.41. PnL = 3 × 100 × (476.41 / 408.80 − 1) = 49.615949; the payout, 149.615949, is credited to the trader's balance. The vault's assets fall by 49.615949 and the reserve and the margin go back to 0.

The same two prints, both sides at each leverage (`worked_example_both_sides_at_2x_and_3x`, `worked_example_both_sides_at_1x`), stake 100:

| Position | In at | Out at | Payout |
|---|---|---|---|
| Long 3x | 408.80 (buy, first print) | 476.41 (sell, second print) | 149.615949 |
| Long 2x | 408.80 | 476.41 | 133.077299 |
| Long 1x | 408.80 | 476.41 | 116.538649 |
| Short 3x | 400.00 (sell, first print) | 480.00 (buy, second print) | 40.000000 |
| Short 2x | 400.00 | 480.00 | 60.000000 |
| Short 1x | 400.00 | 480.00 | 80.000000 |
| Short 3x, the other way | 476.41 (sell, second print) | 408.80 (buy, first print) | 142.574673 |
| Short 2x, the other way | 476.41 | 408.80 | 128.383115 |
| Short 1x, the other way | 476.41 | 408.80 | 114.191557 |

## Positions

- A stake is 10 to 250 USDG, at 1x (the stake itself, no leverage), 2x or 3x; an account holds at most 10 pending, open or closing positions.
- The fee is 1 % of the stake, on top of it, rounded up. `open` debits stake and fee together; at the fill half the fee goes to the market's finder and half to the treasury, or all of it to the treasury when the market has no finder. A refunded order gets both back in full.
- PnL: a long earns stake × leverage × (exit / entry − 1), a short stake × leverage × (1 − exit / entry). The payout, stake + PnL, is never under 0 (the most a position loses is its stake) and never over stake + the maximum profit: nine times the stake for a long (`max_profit_bps` 90,000), leverage × stake for a short. The maximum profit is reserved in the vault at the fill, so the vault can always pay every open position in full.
- **Fills at a price read after the order.** `open` and `close` only place a request, and each names the worst price it accepts. The request fills at the earliest quote in the market's ring of the last 8 whose `last_read_at` is at least 5 s after it (`min_fill_delay_secs`). Which quote that is does not depend on who calls `crank` or when. An order with no such quote within 15 minutes (`order_ttl_secs`), or whose quote has left the ring, is refunded in full. An order can be cancelled only after those 15 minutes, and only when no quote is there to fill it.
- **At the fill** the order is refunded instead when the price is past its limit or 0, the two prices are more than 10 % apart, the score is under 100, the market is no longer open, or the reserve would break a cap: 2 % of the vault's assets per market and side (`market_cap_bps`), 80 % in all (`utilisation_cap_bps`), the refund reason being "market full".
- **`open` refuses** an order while new orders are paused, on a market that isn't open, inside the 48 hours after the market went live on atnx.app (`cooloff_secs`), when the market's newest quote was last read more than 15 minutes ago (`max_quote_age_secs`), when the score is under 100 (`min_score_e2`) or the two prices are more than 10 % apart, or when the contract's free NEAR is under its storage floor. Nothing is debited when `open` refuses.
- **A close** settles at the first quote read at least 5 s after the request. Past its limit, the position goes back to `Open` and the trader asks again. A close cannot be withdrawn.
- **Liquidation.** At the newest quote, a long is liquidated when the buy price is at or below entry × (1 − 1/leverage), and a short when the sell price is at or above entry × (1 + 1/leverage): both prices have to be there, not only the reading. At 1x a long's level is 0, so no price above zero liquidates it, and a short's is twice its entry. The stake goes to the vault, less 1 % of it to whoever cranked (`liq_reward_bps`).
- **The cap.** A position whose close-side PnL reaches the maximum profit is closed at the cap.
- **The end.** 14 days after its fill (`max_position_secs`, fixed at the fill), a position closes at the first quote read after that moment with a non-zero close-side price and the two prices no more than 10 % apart. This close has no limit; while it waits, the position can still be liquidated or capped.
- A position that is worth nothing at its close-side price, but not liquidated because the other price has not reached the level, is shown as "At risk".

## The vault

- The vault counts realised results only: its assets are the deposits, plus what closed positions have lost, minus what they have won, minus withdrawals; open positions are not in the share price. `reserved` is the open positions' maximum profit, set aside out of the assets; `margin` is what pending orders and open positions hold.
- Shares have 9 decimals and start at one USDG a share. 1,000 dead shares are minted at `new`, so the share price is always defined.
- `lp_deposit` is open to the treasury only while `lp_open` is false, as it is now. To leave, a holder gives notice with `lp_request_withdraw`; from 24 hours later (`lp_exit_delay_secs`), for one hour (`lp_exit_window_secs`), `lp_withdraw` redeems the shares at that moment's price, out of unreserved assets only. After the hour the request lapses.
- USDG comes in only from the treasury, through `ft_transfer_call` on the token: `msg` "faucet" adds to the faucet pool, any other `msg` credits the treasury's balance, and a transfer from anyone else is returned in full. `faucet` pays out of the pool, at most 10,000 USDG per account in all (`faucet_per_account`). `withdraw` sends USDG from a balance back to the token, debiting first and crediting back in its callback if the transfer failed.
- Two invariants hold after every call, and the unit tests check both after each one, including two long random sequences of calls: the USDG the contract holds is at least the sum of all balances, the vault's assets, the margin and the faucet pool; and the reserve never exceeds the assets.
- Seeded on 2026-11-10 with 10,000,000 USDG of vault assets and a faucet pool of 2,000,000 USDG; `npm run house:seed` does this from the parent account ([Operations](#operations)).

## Markets

- **Listing.** The keeper lists an atnx.app market when it is live (scored, not deleted), has a score of at least 100, went live more than 48 hours ago, had its VI updated within the last ten minutes, and is not on chain yet (`listingPlan` in `atnx-web/lib/bm/house-rules.ts`). The market's reference is its atnx.app uuid as 32 hex characters. Its finder, who earns half of each fee, is the house account of the market's creator, if the creator has a NEAR account; otherwise there is none.
- **Close only.** A market deleted on atnx.app is moved to `CloseOnly`: positions can close and be liquidated, no order opens. A market never returns from `CloseOnly`.
- **Stale markets.** Anyone can call `settle_stale` on a market whose newest quote was last read 24 hours ago (`emergency_secs`): every position on it closes at its last score and pending orders are refunded. The keeper calls it too, a minute after it becomes possible. A settled market's reference can be listed again as a new market.
- **The score's speed.** A new print's score may move from the stored score by at most 15 % per 300 s of print time (`max_step_bps`), and at least one hundredth; a larger move is clipped and catches up on later prints. The same print pushed again must repeat its numbers and only moves its `last_read_at`; a new print needs a larger `print_id` and a later `print_at`.
- 57 markets were listed on 2026-11-10. `list_markets` shows them with their newest quote and whether they take an order now (`opens`, `reason`).

## The keeper

The keeper is `atnx-web/lib/bm/house-keeper.ts`, signed as `keeper.atnx.testnet`. It has three runs.

| Run | When | What it does |
|---|---|---|
| The tick (`tickHouse`) | Vercel cron `1-59/5 * * * *` on `/api/bm/house-keeper` (`atnx-web/vercel.json`), a minute after the VI's five-minute boundary | Reads each listed market's newest `vi_history` row, reads again after 5 s any market whose print for the current slot is missing, leaves out prints older than ten minutes or without a reading, commits to the rows and sends one `push_quotes`; pages `list_active` twice and cranks what is due in batches of 20; lists markets that qualify, moves deleted ones to close-only, settles stale ones; warns when the faucet pool runs low. Nothing new starts 45 s into the run |
| The minute run (`tickHouseFast`) | Vercel cron `* * * * *` on `/api/bm/house-keeper/fast`, skipping the tick's own minutes | When an order or a close waits for a quote, one transaction with those markets' quotes and the crank. Nothing when nothing waits |
| Quote on demand (`quoteOnDemand`) | Right after the relay route has sent a trader's `open` or `close`, after the response (`after()` in `atnx-web/app/api/near/relay/route.ts`) | Waits until the chain's clock is 5 s past the request, reads that market's newest print, and sends one transaction with the quote and a crank for the position, signed with the keeper's second key so it never takes a nonce the cron is using. This is why an order fills about 10 s after the tap. If it fails, the minute run picks the position up |

`npm run house:tick -- --list` lists every eligible market in one run, with no time budget; it was used for the first deploy.

Every time the contract compares is on the chain's clock, so the keeper takes `read_at` from the latest block just before it reads the rows, never from its own clock.

### The commitment

Every `push_quotes` carries a commitment: the sha256 of a canonical JSON of the `vi_history` rows the quotes came from (`atnx-web/lib/bm/quote-commitment.ts`):

```
{"kind":"quotes","prints":[{"at":"2026-11-10T05:00:42.343564Z","id":1063891,"market":"08bdb018-38e0-4ef7-ad88-15c8e83160f7","raw_vi":163,"vi":159.11}, …],"version":2}
```

One print per market pushed, sorted by market uuid, then by id. Keys are sorted, there is no whitespace, numbers are written as `JSON.stringify` writes them, and timestamps are UTC with six fractional digits and a `Z`. Each quote then carries `score_e2` = 100 × `vi`, `reading_e2` = 100 × `raw_vi`, `print_id` = the row's id and `print_at` = the row's time in whole seconds. `read_at` is not committed: it is a chain fact, not a database one. The contract logs the commitment in its `quotes_pushed` event with the counts of quotes taken and skipped; the commitment covers every quote the call carried, including any the contract skipped.

The rows are public, so anyone can check a push:

- `GET https://atnx-near.vercel.app/api/near/house/pushes` lists the newest pushes from the keeper's log (`bm.keeper_log`).
- `GET https://atnx-near.vercel.app/api/near/house/verify?tx=<hash>` reads the transaction from public RPC, the contract's keeper and its markets' references from the contract, and the rows by id from the database's public REST API, rebuilds the batch, hashes it and compares it with the commitment in the call and in the event, and checks each quote's numbers against its row. It returns the three hashes, the canonical batch (`canonical`, the exact string hashed) and each quote beside its row (`atnx-web/lib/near/house-public.ts`).
- `npm run house:verify:public -- <tx> --supabase-url <url> --anon-key <key>` does the same on any machine, with no env file (`atnx-web/scripts/house-verify-public.ts`).

The commitment shows which public rows a push used. It does not prove that the rows are a correct VI, and nothing on chain checks the index.

## Accounts and relaying

A trader signs in to ATNX with Google or X (Supabase auth), or taps "Try as a guest" with no sign-in. The browser makes an Ed25519 key with WebCrypto, non-extractable, and keeps it in IndexedDB: page script can sign with it but cannot read its bytes (`atnx-web/lib/near/keystore.ts`). The browser sends the public key to `/api/near/account` (signed in) or `/api/near/guest` (a guest).

The route makes two accounts under `atnx.testnet` with the same key: the rounds account `<handle>.atnx.testnet` (a guest's is `guest-<8 random characters>.atnx.testnet`) and, with the house on, the house account `<handle>-h.atnx.testnet` (`atnx-web/lib/near/house-account.ts`). A house account holds 0 NEAR and one key, the browser's, as a function-call key for `house.atnx.testnet` with an empty method list and a 0.25 NEAR allowance. Only the parent can make sub-accounts of itself, so a `-h` name can only ever be made by the platform; no rounds handle ends in `-h`. There is no custody key: ATNX holds no key that can move an account's balance. Clearing the site's data or moving to another browser strands the account with what it holds, and the trader starts a new one.

Every trading call is a NEP-366 delegate action that the browser signs and POSTs to `/api/near/relay`. The relayer checks it and wraps it in a transaction that `relayer.atnx.testnet` signs and pays for (`atnx-web/lib/near/relay.ts`, `houseRelayPolicy`):

1. The sender is the caller's house account (`<label>-h.atnx.testnet`), signed by the key on record, and the receiver is the house contract.
2. One function call, to `faucet`, `open`, `close`, `cancel`, `crank` or `withdraw` (a guest: the same without `withdraw`), with no deposit, at most 150 TGas and at most 1,024 bytes of arguments. The key's method list on chain is empty, so this list is the gate, checked again against the key.
3. One delegate in flight per account, at most 200 relays an hour for a signed-in user and 60 for a guest.
4. The delegate has not expired, its nonce is above the key's, and the key is a function-call key for the house contract.
5. A courtesy check against the contract (`atnx-web/lib/near/house-check.ts`), because a call that fails on chain still costs the relayer its gas: a faucet claim past the account's cap, an order the contract's `open` would refuse, a close or cancel of a position that is not the signer's or not in that state, a crank of more than 20 ids. The refusal carries the contract's own message. A full market is not refused here (the contract takes the order and refunds it at the fill), and the contract checks everything again.

Guests are capped in the database at 3 per client IP per hour and 200 in any 24 hours; the IP is stored only as a salted hash and cleared after a day ([rounds.md](rounds.md#guest-accounts) has the details, which are shared). No guest is made while the relayer or the parent is under 0.05 NEAR.

Checking it on chain: `view_account` on a house account shows `"amount": "0"`, `view_access_key_list` shows its one function-call key for `house.atnx.testnet`, and a relayed call shows `relayer.atnx.testnet` as the signer with a `Delegate` action whose sender is the house account ([README](../README.md#b-in-the-browser-as-a-guest), steps b5 and b10).

## Funding from another chain (preview)

Settings has a "Fund from any chain" panel (`atnx-web/components/rounds/FundFromAnyChain.tsx`). Pick Solana, Base, Arbitrum or Ethereum and an amount of USDC, and it shows a live NEAR Intents 1Click price for bringing it to NEAR: what you send, what arrives, the fee and the time. Every request is a dry quote (`dry: true`, `atnx-web/lib/near/intents.ts`), which returns no deposit address, so no money can move: the app runs on testnet and NEAR Intents has no testnet. The recipient is the all-zero implicit account as a labelled stand-in. The same quote is one POST to `/api/near/intents/quote`. The house ticket links to the panel when an account has no test USDG.

## What the trader sees

The ticket is on every market page with the house on (`atnx-web/components/house/HouseTicket.tsx`), titled "Trade <name>'s index". Its states, one line each:

| State | What it shows |
|---|---|
| The market is not on chain | "Not on chain yet. Markets are added a few minutes after they qualify."; for a market under 100, "Not tradable yet: the index has to be 100 or more."; for a young one, "Not tradable yet: markets open 48 hours after they go live (in 1 d 3 h)." |
| Signed out | The "Buy price" and "Sell price" boxes, "Sign in to trade", and "Try as a guest" with "Your test account lives in this browser."; a market that takes no order says why above the button |
| Setting up | "Setting up your test account…" (a guest) or "Setting up your account…", about 5 to 10 seconds |
| No test USDG | "You need test USDG to trade.", a "Get 10,000 test USDG" button (about 4 to 8 seconds) and "Have USDC on another chain? See what bringing it to NEAR would cost." |
| Lasting refusals, instead of the form | Ended: "This market has ended. Its positions closed at its last score." Close only: "Close only: you can close positions here, not open new ones." No price: "No price on chain yet. Try again in a few minutes." The cool-off and the minimum score as above |
| Passing refusals: the form stays with the button off | "The two prices are too far apart right now. Try again in a few minutes."; "New orders are paused for now. You can still close positions."; "The price feed is late. New orders wait for a fresh price."; "This market is full on the UP side right now."; "You hold the most positions allowed. Close one to open another."; "The amount has to be between 10 and 250 USDG."; "Not enough test USDG for this amount and the fee." |
| The form | UP and DOWN, each with "in at <price>"; the amount (100 by default); 1×, 2× or 3× (1×, no leverage, by default); then "You get in at the buy price", "Worst price you accept" (1 % past the price, editable), "Fee (1 %), on top", "Liquidation at" ("None" for a 1× UP position), "Maximum win" and "Worth on fill", with "Closing at once pays at the sell price, so a new position usually starts a little down."; the button "Open UP 1× · 100 USDG" and "Costs 101.00 USDG with the fee. It fills in a few seconds at a price read after you tap." |
| After the tap | "Confirming your order… This usually takes about 10 seconds.", then "Filled at <entry>." or a refund line such as "Not filled: the two prices were too far apart. Your stake and fee are back in your balance."; after a while "This is taking longer than usual. If it has not filled after 15 minutes, you can cancel it and get your stake and fee back.", and after 15 minutes a Cancel button |
| Your positions here | Side, leverage, stake and entry; the liquidation level and the time left of the 14 days; the value at the price it would close at, its PnL and percentage; "At risk" when it is worth nothing at that price but not liquidated; a "Close" button |
| Closing | "Closing… This usually takes about 10 seconds.", then "Closed. <payout> USDG is back in your balance." or "Not closed: the price moved past your limit in those seconds. Tap Close to try again." |

Under every ticket, "How it works" opens the rules in seven lines, beside "Testnet · test USDG, no value." Prices are written with one decimal from 100 up and two below.

The portfolio (`/app/portfolio`, `atnx-web/components/house/HousePortfolio.tsx`) shows the balance, the value and PnL of open positions, orders confirming, open positions with Close, and the last 20 closed positions as the contract keeps them (`history_of`). Settings shows the trading account with its NearBlocks link, its test USDG and the faucet, and the "Fund from any chain" panel.

The ticket works out every number with the same functions the relay checks with (`atnx-web/lib/bm/house-ticket.ts`, `house-math.ts`) from the contract's config and the market's newest quote; the contract decides.

## Operations

All scripts run from `atnx-web/`. The ones that read `.env.local` refuse to sign on any network but testnet.

| Command | What it does |
|---|---|
| `npm run house:tick` | One dry five-minute tick: reads the database and the chain, sends and writes nothing, prints what it would do |
| `npm run house:tick -- --fast` / `-- --list` | The minute run, or a listing of every eligible market in one go, dry |
| `BM_NEAR_HOUSE_ENABLED=1 npm run house:tick -- --live` | A real tick (`--live --fast`, `--live --list` likewise) |
| `npm run house:seed -- --contract house.atnx.testnet --vault 10000000 --faucet 2000000` | Plans seeding the vault and the faucet pool from the parent account, in whole USDG; `--live` sends: faucet calls on the rounds contract, a withdraw, `ft_transfer_call` to the house and `lp_deposit` |
| `npm run house:verify:public -- <tx> --supabase-url <url> --anon-key <key>` | Checks one push with no env file ([The commitment](#the-commitment)) |
| `npm run test:near`, `npm run test:bm` | The web layer's tests: accounts, the relayer and its house policy, the house checks, the public routes; the keeper's rules, the commitment, the ticket's numbers |
| `cd near && cargo test -p house --lib` | The contract's unit tests (58 on 2026-11-10) |
| `cd near && cargo test -p integration-tests --test house -- --test-threads=1` | The near-sandbox tests (6), after building `usdg` and `house` with `cargo near build non-reproducible-wasm` |

First deploy, in order: deploy the `house-wasm` artifact of a green `near-build` run with `new(owner, keeper, treasury, token)`; seed with `house:seed … --live`; list with `BM_NEAR_HOUSE_ENABLED=1 npm run house:tick -- --live --list`; then turn on the cron runs with `BM_NEAR_HOUSE_ENABLED=1` on the deployment. Nothing in the repository deploys the contract. A code-only redeploy keeps the state; `migrate` re-reads it if a later layout needs converting.

Environment, also in `atnx-web/.env.local.example` and [development.md](development.md#the-house-market-on-near-testnet):

| Name | Effect |
|---|---|
| `NEXT_PUBLIC_BM_NEAR_PRODUCT=house` | On a NEAR build (`NEXT_PUBLIC_BM_CHAIN=near`), shows the house: the ticket and the portfolio, house accounts beside rounds accounts, the relayer's house policy; the rounds leave the navigation and the market page. Read at build time |
| `NEXT_PUBLIC_BM_NEAR_HOUSE` | The house contract, `house.atnx.testnet`. The site shows the house only once it is set; the keeper and the public routes default to it |
| `BM_NEAR_HOUSE_ENABLED=1` | Turns the keeper's runs on: both cron routes, `house:tick --live` and the quote on demand. Anything else, and the routes answer that nothing ran |
| `BM_NEAR_KEEPER_ACCOUNT`, `BM_NEAR_KEEPER_SECRET` | The keeper's account and main key, shared with the rounds step |
| `BM_NEAR_KEEPER_FAST_SECRET` | A second key on the keeper account, used only for quotes on demand; the main key when unset |
| `BM_NEAR_HOUSE_FAUCET_WARN_USDG` | The tick logs `house-faucet-low` when the pool holds less than this (default 100000) |
| `BM_NEAR_PARENT_ACCOUNT` | The parent `house:seed` pays from (default `atnx.testnet`), with `BM_NEAR_PARENT_SECRET` |
| `BM_NEAR_RPC` | The server's RPC endpoints, one URL or a comma-separated list tried in order; it may hold keyed URLs, and logs name hosts only. Unset, the server uses `NEXT_PUBLIC_BM_NEAR_RPC`, then `https://test.rpc.fastnear.com` |

Watching the keeper:

- `bm.keeper_log` rows with `"step": "house"` and `"chain": "near:testnet"` in `detail`: `house-tick` and `house-done` (the run's report) bracket each tick; `house-push`, `house-fast` and `house-on-demand` carry the transaction hash; `house-crank`, `house-list`, `house-close-only` and `house-settle-stale` likewise; `house-push-none` when nothing was fit to push; `house-push-skipped` when the contract skipped quotes; `house-budget` when a run stopped at its time budget; errors carry `error`.
- `GET /api/near/house/pushes` shows the newest pushes without database access.
- A dry run on the deployment: `curl -H "Authorization: Bearer $CRON_SECRET" https://atnx-near.vercel.app/api/bm/house-keeper?dry=1` (and `/fast?dry=1`).
- Vercel → Logs, filtered on `/api/bm/house-keeper` and `/api/near/relay` (`quote on demand did not send` lines).
- On chain: `get_vault`, `active_count`, `list_active`, and `view_account` on `keeper.atnx.testnet` and `relayer.atnx.testnet` for their NEAR.

## Built / not built

As of 2026-11-10.

- [x] Contract `near/house` (near-sdk 5.30): two prices, orders filled at a quote read after them, liquidation, the cap, the 14-day end, the vault with notice-period exits, the faucet pool, close-only and stale markets, `quote_open`, NEP-297 events, `migrate`
- [x] Tests: 58 unit tests (the worked examples, fill timing, refunds, liquidation and the cap on both sides, the score clip, the vault, the storage floor, access control, the config ranges, and two random sequences checking both invariants after every call) and 5 near-sandbox tests (`near/integration-tests/tests/house.rs`, among them a push of 75 markets in one call)
- [x] Reproducible build in CI with NEP-330 metadata; deployed from CI run 42915086367 (commit `5c019b5`) to `house.atnx.testnet`, upgraded in place with `migrate` on 2026-11-10 when 1x was added (first deployed from run 42746055574, commit `5cff59c`)
- [x] Seeded: 10,000,000 USDG in the vault, 2,000,000 in the faucet pool; 57 markets listed
- [x] The keeper's three runs on Vercel cron, with dry mode, the commitment on every push, and `house:verify:public`
- [x] Public routes for the pushes and their verification
- [x] House accounts beside rounds accounts, for signed-in users and guests; the relayer's house policy and checks
- [x] Web: the ticket, the portfolio and Settings on the house, behind `NEXT_PUBLIC_BM_NEAR_PRODUCT=house`
- [x] "Fund from any chain": dry 1Click quotes
- [ ] Real cross-chain deposits through NEAR Intents (mainnet only)
- [ ] Vault deposits from anyone (`lp_open` is false) and a page for vault shares
- [ ] A Withdraw button: the method exists and the relayer passes it for signed-in users, but nothing on the site calls it
- [ ] Storage charged to the accounts that add it
- [ ] The deploy key removed or held by a multisig
- [ ] Any check of the index on chain
- [ ] Mainnet

## Known limits

- The keeper sets every print and the VI is computed off chain by ATNX. The contract limits how fast a score moves and what the keeper can do, and each push is committed to public rows, but nothing on chain checks the index.
- The vault's share price counts realised results only.
- The contract pays its own storage. Below 3 NEAR of free balance (`storage_floor`) it refuses calls that add state; closes, fills, liquidations and withdrawals go on.
- `house.atnx.testnet` keeps its full-access key on testnet, so fixes can ship during judging. Its `code_hash` and `contract_source_metadata` show what runs at any time.
- A lost browser key strands its account; there is no recovery.
- The relayer pays every trader's gas and the parent pays for every account (about 0.007 NEAR each); the keeper pays its own gas. Nothing tops these balances up automatically.
- Fills wait for a quote: about 10 seconds with the quote on demand, up to about a minute when it fails and the minute run picks the order up, and refunded after 15 minutes with no quote.
- The known attack vectors and their mitigations are in the [README](../README.md#known-attack-vectors-and-mitigations).
