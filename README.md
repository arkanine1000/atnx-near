# ATNX house market on NEAR

ATNX scores how much attention a trend, a person or a brand gets online: the Virality Index (VI), recomputed every five minutes from public sources. This repository is ATNX's entry in the NEAR Hackathon: a house market on NEAR testnet where anyone goes UP or DOWN on a market's VI at 2x or 3x leverage against a vault. A trader signs in with Google or X, or tries it as a guest, and never holds NEAR: every call is gasless. One contract, `house.atnx.testnet`, holds the money, the positions and the prices; a keeper pushes each market's newest VI print to it every five minutes, with a commitment to the public rows the print came from.

**The problem.** The VI is a number that moves with a trend, but there is no plain way to take a position on that number, and a first on-chain trade usually needs a wallet, a gas token and a funded account before it can happen. The house market lists each trend's VI as a market, prices it on chain, and lets a first trade happen from a Google sign-in or a guest account with no wallet and no gas.

| | |
|---|---|
| Hosted demo | https://atnx-near.vercel.app (NEAR testnet, test USDG with no value) |
| This entry's contract | [`house.atnx.testnet`](https://testnet.nearblocks.io/address/house.atnx.testnet), source in [`near/house`](near/house) |
| Full description | [docs/house.md](docs/house.md) |
| Code built in the hackathon window | [compare `pre-hackathon...hackathon-submission`](https://github.com/arkanine1000/atnx-near/compare/pre-hackathon...hackathon-submission) ([Prior work](#prior-work)) |
| Licence | [MIT](LICENSE) |

## What runs on NEAR, and why it needs NEAR

- **An internal ledger, function-call keys and NEP-366 meta-transactions, so every trade is gasless with no wallet.** Money is a USDG balance inside the contract; no trading call attaches a deposit. A call without a deposit can be signed by a function-call access key and wrapped in a NEP-366 delegate action that another account sends and pays for. Each trader gets a named account, `<handle>-h.atnx.testnet` or `guest-<8 characters>-h.atnx.testnet`, created by the platform with 0 NEAR and one key: the browser's own, a function-call key for `house.atnx.testnet`. `relayer.atnx.testnet` sends and pays for every call. On NEAR each of these is a protocol feature: a parent account creates named sub-accounts, an access key can be limited to one contract, and a delegate action lets another account pay for a user's call; none of it needs a contract of its own. Steps [b5 and b10](#b-in-the-browser-as-a-guest) check this on chain.
- **The keeper's committed prices.** `push_quotes` carries each market's newest print and the sha256 of the canonical batch of the public `vi_history` rows it came from; the contract logs the same hash in a `quotes_pushed` event. The contract derives both prices from the print itself, limits how fast a score may move, and fills every order at a quote read after it. Steps [a7 to a9](#a-no-login-no-install) check a push.
- **A dry-run cross-chain funding quote.** Settings has "Fund from any chain": a live NEAR Intents 1Click price for bringing USDC from Solana, Base, Arbitrum or Ethereum to NEAR. Every request is a dry quote (`dry: true`), so no money moves: the app runs on testnet and NEAR Intents has no testnet. Step [a10](#a-no-login-no-install).

## Deployed contracts

All on NEAR testnet. `code_hash` is the SHA-256 of the deployed wasm in base58, as `view_account` returns it.

| Account | What it is | Code hash | How to check |
|---|---|---|---|
| `house.atnx.testnet` | This entry: the house market (`near/house`). Owner and treasury `atnx.testnet`, keeper `keeper.atnx.testnet` | `zpFF3Wq4VEjXXUBE3bKUU8oL5tzRiLW8T2hmbaWoCgW` (hex `0ecf86deaf2376c9e515fc336138c9d6be63bef8c2482667ee8beb50302ac59f`) | Step [a1](#a-no-login-no-install). Built by [CI run 42746055574](https://github.com/arkanine1000/atnx-near/actions/runs/42746055574) (`near-build`, reproducible) from commit `5cff59c`, which its `contract_source_metadata` view names; rebuild it with step [c3](#c-from-a-clone) |
| `usdg.atnx.testnet` | USDG, "ATNX test USD": a NEP-141 test token with 6 decimals (`near/usdg`) | `3ew3uCaQ95H1vnmL3CHvLamsiaTQ6aFjPv6nYs9x5AsQ` | `view_account` as in step a1; its `contract_source_metadata` names commit `4f0791e` |
| `rounds.atnx.testnet` | An earlier market design on NEAR, built in the same hackathon window and still deployed: rolling pari-mutuel rounds on the VI ([docs/rounds.md](docs/rounds.md)). The house replaced it as the product | `3XiZgR4xdsPX7fotjtp4d9cc1DAN81SmvWXGLDXJLizw` | As above; commit `4f0791e` |
| `keeper.atnx.testnet`, `relayer.atnx.testnet`, `atnx.testnet` | The keeper, the relayer, and the owner, treasury and parent of every trader account. Plain accounts, no contract | | |

The vault was seeded with 10,000,000 test USDG and the faucet pool with 2,000,000. Deposits into the vault are open to the treasury only for now (`lp_open` is false). The contract account keeps its deploy key on testnet so fixes can ship during judging; the code hash above shows what runs at any moment.

## Try it

Three groups: (a) needs only `curl` and `jq`; (b) needs a browser; (c) needs a clone and toolchains. Amounts are in USDG units of 10⁻⁶ (`"100000000"` is 100 USDG); prices and scores are in hundredths of a VI point (`"114476"` is 1,144.76). Outputs below were taken on 2026-11-10 and trimmed with `…`; the numbers move with every print.

### (a) No login, no install

Paste this first. It defines `house_view`, a read-only view call on `house.atnx.testnet` over a public RPC endpoint (`https://rpc.testnet.fastnear.com`, `https://testnet-rpc.intea.rs` and `https://near-testnet.drpc.org` also answer).

```bash
RPC=https://test.rpc.fastnear.com
SITE=https://atnx-near.vercel.app
house_view() {  # house_view <method> '<arguments as JSON>'
  curl -s "$RPC" -H 'content-type: application/json' -d "$(jq -nc --arg m "$1" --arg a "$(printf '%s' "$2" | base64 | tr -d '\n')" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:"house.atnx.testnet",method_name:$m,args_base64:$a}}')" \
  | jq '.result.result | implode | fromjson'
}
```

**a1. The contract and the source it was built from.** Run:

```bash
curl -s "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"house.atnx.testnet"}}' \
  | jq '.result.code_hash'
house_view contract_source_metadata '{}' | jq '{version, link, contract_path: .build_info.contract_path, build_environment: .build_info.build_environment}'
```

See the code hash from the table and the commit it was built from:

```
"zpFF3Wq4VEjXXUBE3bKUU8oL5tzRiLW8T2hmbaWoCgW"
{
  "version": "0.1.0",
  "link": "https://github.com/arkanine1000/atnx-near/tree/5cff59ce1ea57e182ef7c8df308f5d823f194525",
  "contract_path": "near/house",
  "build_environment": "sourcescan/cargo-near:0.23.0-rust-1.99.1@sha256:8013f039e8005627f10ae66b5519d1a6eeeed7d7aef4b5067d5e9a86c4302fcc"
}
```

**a2. The vault.** Run `house_view get_vault '{}' | jq '{assets, reserved, free, margin, faucet_pool, share_price, lp_open}'`. See the vault's realised assets (about 10,000,000 USDG), what open positions reserve, the faucet pool and that deposits are closed to the public:

```
{ "assets": "10000007505852", "reserved": "0", "free": "10000007505852", "margin": "0",
  "faucet_pool": "1970000000000", "share_price": "1000000", "lp_open": false }
```

**a3. The settings.** Run `house_view get_config '{}' | jq '{keeper, treasury, token, fee_bps, finder_bps, lead_min_bps, lead_full_gap_bps, max_open_gap_bps, min_score_e2, cooloff_secs, min_stake, max_stake, min_fill_delay_secs, max_step_bps, opens_paused}'`. See the rules the rest of this README describes: a 1 % fee, half to the market's finder; the lead moving 30 % of the way to the reading at no gap and all the way from a 25 % gap; orders refused past a 10 % gap; a minimum score of 100; a 48-hour cool-off; stakes of 10 to 250 USDG; fills at least 5 s after the order; the score moving at most 15 % per five minutes:

```
{ "keeper": "keeper.atnx.testnet", "treasury": "atnx.testnet", "token": "usdg.atnx.testnet",
  "fee_bps": 100, "finder_bps": 5000, "lead_min_bps": 3000, "lead_full_gap_bps": 2500,
  "max_open_gap_bps": 1000, "min_score_e2": "10000", "cooloff_secs": "172800",
  "min_stake": "10000000", "max_stake": "250000000", "min_fill_delay_secs": "5",
  "max_step_bps": 1500, "opens_paused": false }
```

**a4. The markets, and which refuse orders now.** Run `house_view list_markets '{"limit":100}' | jq '{markets: length, refusing: [.[] | select(.opens == false) | {id, reason, spread_bps: .quote.spread_bps}]}'`. See the number of listed markets and the few that refuse a new order at this moment, each with the contract's reason:

```
{ "markets": 57,
  "refusing": [ { "id": 25, "reason": "the two prices are too far apart", "spread_bps": "1064" },
                { "id": 39, "reason": "score is under the minimum to open", "spread_bps": "963" },
                { "id": 56, "reason": "the two prices are too far apart", "spread_bps": "1233" } ] }
```

**a5. One market's two prices.** Market 36 is "Google". Run `house_view get_market '{"market":36}' | jq '.quote | {score_e2, reading_e2, lead_e2, buy_e2, sell_e2, spread_bps, print_id, print_at}'`. See the score S, the reading R the score is smoothing towards, the lead between them, and the two prices, buy = max(S, lead) and sell = min(S, lead):

```
{ "score_e2": "114069", "reading_e2": "115300", "lead_e2": "114476",
  "buy_e2": "114476", "sell_e2": "114069", "spread_bps": "36", "print_id": "1063926", "print_at": "1794286849" }
```

To recompute them from S and R with the contract's rule (the gap, λ from 30 % to 100 %, every rounding up), run:

```bash
house_view get_market '{"market":36}' | jq '.quote | (.score_e2 | tonumber) as $s | (.reading_e2 | tonumber) as $r | (($r - $s) | fabs) as $d
  | (if $d == 0 then 0 else ($d * 10000 / $s | ceil) end) as $gap
  | (if $gap >= 2500 then 10000 else ([3000 + (7000 * $gap / 2500 | ceil), 10000] | min) end) as $lambda
  | ([($d * $lambda / 10000 | ceil), $d] | min) as $moved | (if $r >= $s then $s + $moved else $s - $moved end) as $lead
  | {gap_bps: $gap, lambda_bps: $lambda, lead: $lead, buy: ([$s, $lead] | max), sell: ([$s, $lead] | min),
     contract_says: {lead: .lead_e2 | tonumber, buy: .buy_e2 | tonumber, sell: .sell_e2 | tonumber}}'
```

See the same three numbers twice: `{ "gap_bps": 108, "lambda_bps": 3303, "lead": 114476, "buy": 114476, "sell": 114069, "contract_says": { "lead": 114476, "buy": 114476, "sell": 114069 } }`.

**a6. A quote for an order, and a refusal.** Run:

```bash
house_view quote_open '{"market":36,"side":"Long","leverage":2,"stake":"100000000"}' \
  | jq '{allowed, reason, entry_e2, fee, cost, liquidation_e2, max_profit, value_on_fill, would_fill}'
ID=$(house_view list_markets '{"limit":100}' | jq '[.[] | select(.opens == false)][0].id')
house_view quote_open "{\"market\":$ID,\"side\":\"Long\",\"leverage\":2,\"stake\":\"100000000\"}" | jq '{allowed, reason, buy_e2, sell_e2, spread_bps}'
```

See what `open` would do for a 2x UP of 100 USDG: entry at the buy price, a fee of 1 on top, the liquidation level at half the entry, a maximum win of 900, and `value_on_fill`, what the position would be worth the moment it filled. It is a little under 100 because a long is valued at the sell price. Then a refused order with the contract's reason (if no market refuses at that moment, `ID` is `null` and the second call answers "no such market"):

```
{ "allowed": true, "reason": null, "entry_e2": "114476", "fee": "1000000", "cost": "101000000",
  "liquidation_e2": "57238", "max_profit": "900000000", "value_on_fill": "99288933", "would_fill": true }
{ "allowed": false, "reason": "the two prices are too far apart", "buy_e2": "20229", "sell_e2": "18284", "spread_bps": "1064" }
```

**a7. The keeper's recent pushes.** Run `curl -s "$SITE/api/near/house/pushes?limit=3" | jq '.items[] | {txHash, at, run, quotes, accepted, skipped, commitment}'`. See one push every five minutes from the tick (`"run": "tick"`, every listed market), and extra ones from the every-minute run (`fast`) and from quotes sent right after a trader's order (`on_demand`, whose log row keeps no commitment):

```
{ "txHash": "48yjwRe6bM5dGWLUHMrzTKcoQpLqmpPU2GCr3s61iZxS", "at": "2026-11-10T05:01:34.623698+00:00", "run": "tick",
  "quotes": 57, "accepted": 57, "skipped": 0, "commitment": "7db3f848cfab5ac3b9ffda91c5f4dc05bb91173710b44b155ed5227b77430d46" }
…
```

**a8. A push, verified.** Run:

```bash
TX=$(curl -s "$SITE/api/near/house/pushes?limit=1" | jq -r '.items[0].txHash')
curl -s "$SITE/api/near/house/verify?tx=$TX" | jq '{tx, keeper, quotes, rowsFound, hashes, ok, problems, first: .compared[0]}'
```

See the site read the transaction from the chain, fetch the `vi_history` rows (57 here) by id from the database's public REST API, rebuild the batch and hash it: the commitment in the call, the one in the contract's event and the one computed agree, and each quote matches its row (`vi` 159.11 is `score_e2` 15911):

```
{ "tx": "48yjwRe6bM5dGWLUHMrzTKcoQpLqmpPU2GCr3s61iZxS", "keeper": "keeper.atnx.testnet", "quotes": 57, "rowsFound": 57,
  "hashes": { "call": "7db3f848…0d46", "event": "7db3f848…0d46", "recomputed": "7db3f848…0d46" },
  "ok": true, "problems": [],
  "first": { "market": 4, "reference": "08bdb01838e04ef7ad8815c8e83160f7", "printId": "1063891", "scoreE2": "15911",
             "readingE2": "16300", "printAt": 1794286842, "readAt": 1794286889,
             "row": { "id": 1063891, "market_id": "08bdb018-38e0-4ef7-ad88-15c8e83160f7", "vi": 159.11, "raw_vi": 163,
                      "recorded_at": "2026-11-10T05:00:42.343564+00:00" } } }
```

`curl -s "$SITE/api/near/house/verify?tx=o7cE4x2gDKJkxtTREnadMLiFKawdyFY7EswuEu1GUYe"` (a keeper transaction on the rounds contract) answers 422 `{"error":"not_a_push", …}`; an unknown hash answers 404 `unknown_transaction`; a malformed one 400.

**a9. The hash, computed by you.** Run:

```bash
curl -s "$SITE/api/near/house/verify?tx=$TX" | jq -j .canonical | sha256sum
curl -s "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"'"$TX"'","sender_account_id":"keeper.atnx.testnet","wait_until":"FINAL"}}' \
  | jq -r '.result.receipts_outcome[].outcome.logs[] | select(startswith("EVENT_JSON:")) | ltrimstr("EVENT_JSON:") | fromjson
           | select(.event == "quotes_pushed") | .data[0].commitment'
```

See the same 64 hex characters twice: the sha256 of the batch the site returns, computed on your machine, and the commitment in the contract's event, read straight from the public RPC:

```
7db3f848cfab5ac3b9ffda91c5f4dc05bb91173710b44b155ed5227b77430d46  -
7db3f848cfab5ac3b9ffda91c5f4dc05bb91173710b44b155ed5227b77430d46
```

**a10. A dry cross-chain funding quote.** Run `curl -s -X POST "$SITE/api/near/intents/quote" -H 'content-type: application/json' -d '{"chain":"sol","amount":"25"}' | jq .`. See a live NEAR Intents 1Click price for 25 USDC from Solana to NEAR, marked as a preview, with the all-zero stand-in recipient:

```
{ "quote": { "chain": "sol", "sendUnits": "25000000", "receiveUnits": "24994975", "minReceiveUnits": "24745025",
             "feeUnits": "5025", "timeSecs": 20, "quotedAt": "2026-11-10T05:06:37.047Z" },
  "preview": true,
  "recipient": { "kind": "placeholder", "accountId": "0000000000000000000000000000000000000000000000000000000000000000" } }
```

### (b) In the browser, as a guest

Use a recent Chrome, Firefox or Safari. The account's key lives in this browser's IndexedDB, so clearing the site's data, or closing a private window, loses the account. Guests are capped at 3 per network per hour and 200 a day; past that the ticket says "Too many guest accounts from your network in the last hour. Sign in, or try again later."

**b1.** Open https://atnx-near.vercel.app/app/markets/46a8890c-25ce-4231-9112-fc1b3ba8ac07 (market 36, "Google"; https://atnx-near.vercel.app/app lists the others). See a card "Trade Google's index" with "Buy price" and "Sell price" (step a5's numbers, written 1,144.8 and 1,140.7), a "Sign in to trade" button and "Try as a guest" with "Your test account lives in this browser."

**b2.** Tap "Try as a guest". See "Setting up your test account…" for about 5 to 10 seconds, then "You need test USDG to trade." and a "Get 10,000 test USDG" button.

**b3.** Tap "Get 10,000 test USDG". See "Getting test USDG…" for about 4 to 8 seconds, a "Got 10,000 test USDG" notice, then the order form: UP and DOWN with "in at <price>", Amount 100, Leverage 2× and 3×.

**b4.** Leave UP, 100 and 2×. See "You get in at the buy price", "Worst price you accept" (1 % past the price), "Fee (1 %), on top 1.00 USDG", "Liquidation at", "Maximum win +900.00 USDG" and "Worth on fill". When the market's two prices differ, as they usually do, "Worth on fill" is a little under 100 USDG, in red, with "Closing at once pays at the sell price, so a new position usually starts a little down.": the position is valued at the price it would close at, and a long closes at the sell price. The button reads "Open UP 2× · 100 USDG", above "Costs 101.00 USDG with the fee. It fills in a few seconds at a price read after you tap."

**b5.** Tap "Open UP 2× · 100 USDG". See "Sending…", then "Confirming your order… This usually takes about 10 seconds.", and about 10 seconds after the tap "Filled at <entry>." Under "Your positions here": "UP 2× · 100.00 USDG · entry <entry>", the liquidation level, "13 d 23 h left", and its value and PnL, starting a little under 100. Under the form, "View last transaction <hash> ↗" opens the order on NearBlocks: a transaction signed by `relayer.atnx.testnet` to your account, carrying a delegate action from your account to `house.atnx.testnet`, method `open`, no deposit. The relayer paid the gas.

**b6.** Tap "Close" on the position. See "Closing… This usually takes about 10 seconds.", then, about 10 seconds after the tap, "Closed. <payout> USDG is back in your balance."

**b7. A refusal.** Run `house_view list_markets '{"limit":100}' | jq -r '.[] | select(.opens == false) | "\(.reason): https://atnx-near.vercel.app/app/markets/\(.reference | "\(.[0:8])-\(.[8:12])-\(.[12:16])-\(.[16:20])-\(.[20:])")"'` and open one of the pages it prints. For "the two prices are too far apart", see the form with the Open button off and "The two prices are too far apart right now. Try again in a few minutes.": that market's reading is more than 10 % away from its score, and the contract takes no order there. For "score is under the minimum to open", see "Not tradable yet: the index has to be 100 or more." A market younger than 48 hours says "Not tradable yet: markets open 48 hours after they go live (in …)." The set of refusing markets changes from one print to the next.

**b8.** Open https://atnx-near.vercel.app/app/portfolio. See the balance (10,000 USDG less the fee, plus or minus the result of step b6), "Open positions", and under "Closed" the position from b5 with its entry, its exit and "Closed".

**b9.** Open https://atnx-near.vercel.app/app/settings. See "Guest account guest-<8 characters>-h.atnx.testnet ↗" and "Fund from any chain". Keep Solana and 25: after a few seconds see "You send 25.00 USDC on Solana", "Arrives on NEAR", "Fee", "Time", and "Preview only: ATNX runs on NEAR testnet, so no money moves."

**b10. Your account on chain.** Copy the account id from b9 and run:

```bash
ACCOUNT=guest-xxxxxxxx-h.atnx.testnet   # yours, from Settings
curl -s "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"'"$ACCOUNT"'"}}' | jq '.result.amount'
curl -s "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"'"$ACCOUNT"'"}}' \
  | jq '.result.keys[].access_key.permission'
house_view history_of "{\"account\":\"$ACCOUNT\"}" | jq '.[0]'
```

See 0 NEAR, one key that can only call `house.atnx.testnet` (the empty `method_names` means any of its methods; the relayer passes only the trading ones), and the closed position from b6:

```
"0"
{ "FunctionCall": { "allowance": "250000000000000000000000", "method_names": [], "receiver_id": "house.atnx.testnet" } }
{ "id": "…", "market": 36, "side": "Long", "leverage": 2, "stake": "100000000", "entry_e2": "…", "exit_e2": "…",
  "payout": "…", "reason": "close", "opened_at": "…", "closed_at": "…" }
```

### (c) From a clone

Needs git, Node 20 or later with npm, and for the contract tests rustup and cargo-near 0.23.0 (`near/rust-toolchain.toml` pins Rust 1.99.1, which rustup installs on the first command). The sandbox tests download near-sandbox on their first run.

```bash
git clone https://github.com/arkanine1000/atnx-near && cd atnx-near
```

**c1. The contract's unit tests.** In `near/`, run `cargo test -p house --lib`. See `test result: ok. 54 passed; 0 failed`, among them the worked example of [docs/house.md](docs/house.md#an-order-step-by-step) (`cargo test -p house --lib worked_example` runs those two alone: a 3x long of 100 filled at 408.80 and closed at 476.41 pays 149.615949).

**c2. The sandbox tests**, which deploy `usdg` and `house` to a local near-sandbox. In `near/`, run:

```bash
cargo near build non-reproducible-wasm --manifest-path usdg/Cargo.toml
cargo near build non-reproducible-wasm --manifest-path house/Cargo.toml
cargo test -p integration-tests --test house -- --test-threads=1
```

See `test result: ok. 5 passed; 0 failed` after about two minutes: faucet, deposits and withdraw; orders filling after a fresh read and positions ending; a push of 75 markets in one call; the vault's exit and `migrate`; a failed withdraw refunded.

**c3. The deployed code, rebuilt** (needs Docker; not run on the machine that wrote this README, which has none; CI run 42746055574 ran it). From the repository root, run:

```bash
git checkout 5cff59c
(cd near/house && cargo near build reproducible-wasm)
sha256sum near/target/near/house/house.wasm
git checkout -
```

See `0ecf86deaf2376c9e515fc336138c9d6be63bef8c2482667ee8beb50302ac59f`, the deployed code hash in hex. While `git diff 5cff59c -- near/house` prints nothing, the contract source in your checkout is the deployed one.

**c4. The web tests.** From the repository root, run `cd atnx-web && npm ci && npm run test:near && npm run test:bm`. See each suite end with `# fail 0`: accounts and handles, the relayer and its house policy, the house checks, the public push routes, the keeper's rules, the commitment, the ticket's numbers. (`npm ci` was not run here; the suites were, on the existing install: 153 and 202 tests on 2026-11-10.)

**c5. A push, verified on your machine.** `house:verify:public` reads the transaction from public RPC and the rows from the database's public REST API, and hashes them itself. It needs the database's public URL and anon key, the ones the site's pages carry; these lines take both from the site's JavaScript. In `atnx-web/`, run:

```bash
SITE=https://atnx-near.vercel.app
TX=$(curl -s "$SITE/api/near/house/pushes?limit=1" | jq -r '.items[0].txHash')
JS=$(curl -s "$SITE/app" | grep -o '/_next/static/chunks/[^"]*\.js' | sort -u | while read -r c; do curl -s "$SITE$c"; done)
SUPABASE_URL=$(grep -o 'https://[a-z0-9]*\.supabase\.co' <<<"$JS" | head -1)
ANON_KEY=$(grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' <<<"$JS" | head -1)
npm run house:verify:public -- "$TX" --supabase-url "$SUPABASE_URL" --anon-key "$ANON_KEY"
```

See (after npm echoes the command):

```
house quote push FA2svCzRWxonzXqvPp4rXMgNapC1Q4vfepZTa8cFGQr5
  sent by                  keeper.atnx.testnet
  to                       house.atnx.testnet
  quotes                   57
  taken by the contract    57
  skipped by the contract  0
  rows found               57
  commitment in the call   381d89d7fecbc30c5604c20305d6b2f252bfa6f835fcc5e056a98bf81e489a34
  commitment in the event  381d89d7fecbc30c5604c20305d6b2f252bfa6f835fcc5e056a98bf81e489a34
  sha256 computed here     381d89d7fecbc30c5604c20305d6b2f252bfa6f835fcc5e056a98bf81e489a34
OK: the rows hash to the commitment on chain and every quote matches its row.
```

## How it works

- **Two prices.** Each print carries the score S and the reading R the score is smoothing towards. The contract quotes a lead, S moved λ of the way to R (λ is 30 % at no gap and 100 % from a 25 % gap), and two prices: buy = max(S, lead), sell = min(S, lead). Longs open at the buy price and close at the sell price; shorts the other way round. Orders are refused while the two prices are more than 10 % of S apart. ([docs/house.md](docs/house.md#the-two-prices))
- **Orders.** `open` and `close` only place a request, with the worst price it accepts. It fills at the earliest quote read at least 5 s after it, whoever calls `crank` and whenever. Right after the relay sends an order, the keeper sends that market's quote and the crank in one transaction, so a fill takes about 10 seconds; a request with no quote for 15 minutes is refunded. ([An order, step by step](docs/house.md#an-order-step-by-step))
- **Positions.** 10 to 250 USDG at 2x or 3x, a 1 % fee on top, at most 10 per account. A position can lose at most its stake; a long can win at most nine times its stake and a short its leverage times its stake, and that maximum is reserved in the vault at the fill. Liquidation needs both prices at the level. A position ends after 14 days. ([Positions](docs/house.md#positions))
- **The vault.** Shares on realised results only, 2 % of the assets per market and side, 80 % in all; exits by 24 hours' notice. ([The vault](docs/house.md#the-vault))
- **The keeper.** Three runs: the five-minute tick (push every market, crank, list), the every-minute run (orders waiting for a quote), and quotes on demand after a trader's order. ([The keeper](docs/house.md#the-keeper))
- **Accounts.** A browser key that page script cannot read, a named account with 0 NEAR under `atnx.testnet`, and a relayer that checks every delegate against the house contract before paying for it. ([Accounts and relaying](docs/house.md#accounts-and-relaying))

| Docs | |
|---|---|
| [docs/house.md](docs/house.md) | The house market in full: prices, orders with the worked example, positions, the vault, markets, the keeper and the commitment, accounts and relaying, the UI's states, operations, built and not built, limits |
| [near/README.md](near/README.md#house) | Every house method, view, event and error message; how to build and test the contracts; reproducible builds |
| [docs/virality-index.md](docs/virality-index.md), [docs/vi-sources.md](docs/vi-sources.md) | How the VI is computed and what it reads |
| [docs/development.md](docs/development.md) | Local setup and every environment variable |
| [docs/architecture.md](docs/architecture.md), [docs/web-app.md](docs/web-app.md), [docs/database.md](docs/database.md) | The app around the market |
| [docs/rounds.md](docs/rounds.md), [docs/bounded-markets.md](docs/bounded-markets.md) | The earlier designs: rolling rounds on Solana and NEAR (its NEAR section covers the guest accounts and the relayer the house shares) and bounded markets on Solana and an EVM testnet |
| [programs/README.md](programs/README.md), [contracts/README.md](contracts/README.md) | The baseline's Solana programs and EVM contracts |

## Known attack vectors and mitigations

Each class below is described with what the contract or the platform does about it. None of it is a guarantee; the money is test USDG with no value.

- **A smoothed score shows part of its next move.** While the reading R differs from the score S, S tends to follow it, and both are in every print. Mitigation: a long opens at the buy price and a short at the sell price, so an order in the direction the reading points pays the lead, part or all of the way to R, rather than S, and every position closes at the other price; the fill uses a quote read after the order, so an order cannot pick its print; and orders are refused when the two prices are more than 10 % apart. What the two prices do not close: below a 25 % gap the lead covers only part of the distance to R, so the visible move is narrowed, not priced in full. Planned: take short-lived noise out of the readings before they are smoothed, so the score and the reading agree more of the time.
- **Inputs that lag public data.** Some VI sources reach the index after the public can see them ([docs/virality-index.md](docs/virality-index.md) lists each source's cadence), so a move visible elsewhere can reach the score later. Mitigation: the contract clips how fast a score moves (15 % per five minutes of print time); a market opens to orders only 48 hours after it went live and with a score of at least 100; stakes are 10 to 250 USDG, 10 positions per account; a win is capped; and each market and side can reserve at most 2 % of the vault. Planned: read the lagging sources closer to real time, and let a position that is in profit close only once it has been open through one more reading.
- **An outage in one source moves every market.** When one source stops answering, its share of the sum is left out or held, and many markets can move at once in the same direction. Mitigation: such a move reaches the reading first, which widens the two prices and stops orders past a 10 % gap; the score clip slows it on chain; the keeper pushes no print older than ten minutes or without a reading, and the contract refuses orders once a market's quote is 15 minutes old; the owner or the keeper can pause new orders while closes, fills, liquidations and withdrawals go on; and the reserve caps (2 % per market and side, 80 % in all) bound what open positions can claim from the vault. Planned: the keeper pauses new orders by itself when most markets move the same way at once or a source goes silent; today the pause is a manual call.
- **The keeper key and the unverified index.** The keeper signs every print, and the VI is computed off chain by ATNX; nothing on chain checks that a print is the true index. Mitigation: the contract derives both prices itself, takes a new print only with a larger id and a later time, and clips its score; the keeper's other powers are listing markets, moving a market to close-only, naming a finder and pausing new orders, and it cannot reopen a market, settle one that has had a quote in the last 24 hours, change a setting or move anyone's balance; the owner can change settings only inside ranges fixed in the code; every push is committed to public rows anyone can check (steps a7 to a9, c5); and anyone can settle a market at its last score once it has had no quote for 24 hours. The commitment proves which rows a push used, not that the rows are right. Planned: a delay on setting changes, then computing the index in a trusted execution environment whose attestation can be checked.
- **The vault's share price counts realised results only.** Open positions are not in the share price, so it can differ from what the vault would be worth if they all closed now. Mitigation: deposits are open to the treasury only (`lp_open` is false); leaving needs 24 hours' notice and is paid within a one-hour window, at that moment's price, out of unreserved assets only; and every open position's maximum profit is reserved when it fills. Planned, before deposits open to everyone: delayed deposits, and a share price that counts open positions.
- **Free accounts and storage.** An account costs its owner nothing, so one person can make many, each with its own faucet allowance, and every account, balance and position is state the contract pays for. Mitigation: at most 3 guests per network per hour and 200 a day; at most 60 relayed calls a guest and 200 a signed-in user per hour; 10,000 test USDG per account from the faucet in all; 10 positions per account; and below 3 NEAR of free balance the contract refuses calls that add state, while closes, fills, liquidations and withdrawals go on. Planned for mainnet: storage charged to the account that adds it.
- **The retained deploy key.** `house.atnx.testnet` keeps its full-access key on testnet (`view_access_key_list` on the account, as in step b10, shows `"FullAccess"`), so the team can deploy new code during judging, and new code can change anything. Mitigation: what runs is checkable at any moment: the `code_hash` (step a1), the commit in `contract_source_metadata`, and a reproducible build of that commit (step c3); any new deploy changes the code hash. Removing the key before any real money is not built.

## Built and not built

As of 2026-11-10. Details in [docs/house.md](docs/house.md#built--not-built).

Built: the `near/house` contract with 54 unit tests and 5 sandbox tests; a reproducible CI build deployed to `house.atnx.testnet`, seeded and with 57 markets listed; the keeper's three runs on Vercel cron with a commitment on every push; the public push and verify routes and `house:verify:public`; gasless named accounts for signed-in users and guests, with the relayer's house policy; the ticket, the portfolio and Settings on https://atnx-near.vercel.app; "Fund from any chain" with dry 1Click quotes.

Not built: real cross-chain deposits through NEAR Intents (mainnet only); vault deposits from anyone, and a page for vault shares; a Withdraw button (the contract method exists); storage charged to the accounts that add it; the deploy key removed; any check of the index on chain; mainnet.

## Prior work

Disclosed under the hackathon's rules (Q-002 to Q-005):

- **ATNX exists off chain** at https://atnx.app: the Virality Index and paper trading on it. The VI that the keeper pushes is computed there and written to the shared database; this repository reads it.
- **This repository started as ATNX's Solana build**, entered in the Colosseum Crypto World's Fair: bounded UP/DOWN markets and rolling rounds on Solana devnet (`programs/`), a port of the bounded markets to the Robinhood EVM testnet (`contracts/`), the capture pipeline and the VI pipeline (`atnx-web/`) and a Chrome extension (`atnx-extension/`). All of it is baseline.
- **Tags.** [`pre-hackathon`](https://github.com/arkanine1000/atnx-near/releases/tag/pre-hackathon) is commit `78b6ecd` (2026-10-12), the last commit before the hackathon's announcement on 2026-10-19; the next commit is from 2026-11-08. `hackathon-submission` marks the submitted commit. The work judged is [compare `pre-hackathon...hackathon-submission`](https://github.com/arkanine1000/atnx-near/compare/pre-hackathon...hackathon-submission): everything under `near/` (the house, the rounds port and the test token), the NEAR client, accounts, relayer and guests (`atnx-web/lib/near/`), the house keeper, its rules and the commitment (`atnx-web/lib/bm/house-*.ts`, `quote-commitment.ts`), the house UI (`atnx-web/components/house/`), the NEAR and keeper routes (`atnx-web/app/api/near/`, `atnx-web/app/api/bm/house-keeper/`) and the funding panel.
- **The rounds on NEAR** (`rounds.atnx.testnet`) were built in the same window, before the house, and are still deployed; the house replaced them as the product.

The baseline's deployments, still deployed and not part of this entry:

| Chain | Program or contract | Test token |
|---|---|---|
| Solana devnet, `vi_rounds` (rolling rounds, [docs/rounds.md](docs/rounds.md)) | [`5PsYwtsaexsFLGz6pwnVAtBTLzRqmGHxQJFnYWv42aQX`](https://explorer.solana.com/address/5PsYwtsaexsFLGz6pwnVAtBTLzRqmGHxQJFnYWv42aQX?cluster=devnet) | [`9LurpUewiUvun2sUiDL4wjRKog91CqRFXXshaTGnXGHx`](https://explorer.solana.com/address/9LurpUewiUvun2sUiDL4wjRKog91CqRFXXshaTGnXGHx?cluster=devnet) |
| Solana devnet, `bounded_vi` (bounded markets, [docs/bounded-markets.md](docs/bounded-markets.md)) | [`5xdrKVQPYpCJ4YkzDysTmV3XPQN5vVwHV1RhAQ2xvABG`](https://explorer.solana.com/address/5xdrKVQPYpCJ4YkzDysTmV3XPQN5vVwHV1RhAQ2xvABG?cluster=devnet) | [`9cgEJ7nexdmx2n4cDFaC93jvJnfreSNnTjkAXGZtxLEd`](https://explorer.solana.com/address/9cgEJ7nexdmx2n4cDFaC93jvJnfreSNnTjkAXGZtxLEd?cluster=devnet) |
| Robinhood Testnet (46630), the bounded markets' EVM port | [`0x0cDab5681546b887bA8772290869ef9001B2d47C`](https://explorer.testnet.chain.robinhood.com/address/0x0cDab5681546b887bA8772290869ef9001B2d47C) | [`0x3cCAADFa951Cd18fd68c2575402ee28E390Bf641`](https://explorer.testnet.chain.robinhood.com/address/0x3cCAADFa951Cd18fd68c2575402ee28E390Bf641) |

## Libraries, services and templates

- **Contracts:** near-sdk 5.30 and near-contract-standards 5.30 (the token's NEP-141, NEP-145 and NEP-148); cargo-near 0.23.0 with the `sourcescan/cargo-near:0.23.0-rust-1.99.1` image for reproducible builds; near-workspaces 0.24, tokio, serde_json and anyhow in the sandbox tests.
- **Web:** Next.js 16.2.2, React 19.2.4, near-api-js 7.4, borsh 2, Supabase (`@supabase/supabase-js`, `@supabase/ssr`), TanStack Query 5, Tailwind CSS 4, tsx for the tests.
- **Services:** Supabase (database and Google and X sign-in), Vercel (hosting and cron), FastNEAR's public testnet RPC, the NEAR Intents 1Click API (dry quotes only), NearBlocks (explorer links).
- **Templates:** none. The relayer was ported from the team's own testnet prototype in `near/relayer-proto`, written in the window.
- **AI code:** much of this repository was written with an AI coding agent (Claude Code).

## The team's other entry

TODO(team): name the other entry here, or delete this line if there is none

## Licence

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 ATNX.
