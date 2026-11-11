# Try it: every check, with what to expect

The [README](../README.md#try-it) has the two short paths. This page has every check in full, written as "do X, see Y" for a person or an agent.

Three groups: (a) needs only `curl` and `jq`; (b) needs a browser; (c) needs a clone and toolchains. Amounts are in USDG units of 10⁻⁶ (`"100000000"` is 100 USDG); prices and scores are in hundredths of a VI point (`"114476"` is 1,144.76). Outputs below were taken on 2026-11-10 (a11's on 2026-11-11) and trimmed with `…`; the numbers move with every print.

## (a) No login, no install

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

To run a1 to a11 in one go from a clone, run `bash scripts/check-public.sh` (needs `curl` and `jq`, reads only). See one line per step, `ok aN` with the value it checked or `FAIL aN` with what it got, and exit status 0 when every step passes.

**a1. The contract and the source it was built from.** Run:

```bash
curl -s "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"house.atnx.testnet"}}' \
  | jq '.result.code_hash'
house_view contract_source_metadata '{}' | jq '{version, link, contract_path: .build_info.contract_path, build_environment: .build_info.build_environment}'
```

See the code hash from the table and the commit it was built from:

```
"EN6eaeUyNxp1VUJ5nWDtv3wTNmHrx53u7eNPwTScEnb3"
{
  "version": "0.1.0",
  "link": "https://github.com/arkanine1000/atnx-near/tree/5c019b5a2d8466ccdaebcf8b1a943ed082863f0e",
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

The route reads the transaction from a regular RPC node, which keeps recent transactions only, so take the hash from `/pushes` as above: an old push answers 404 too. A keeper transaction with no `push_quotes` call (one on the rounds contract, say) answers 422 `{"error":"not_a_push", …}`; a hash the RPC does not know answers 404 `unknown_transaction`, as `curl -s "$SITE/api/near/house/verify?tx=11111111111111111111111111111111"` shows; a malformed one answers 400 `bad_request`.

**a9. The hash, computed by you.** Run:

```bash
curl -s "$SITE/api/near/house/verify?tx=$TX" | jq -j .canonical | sha256sum
curl -s "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"'"$TX"'","sender_account_id":"keeper.atnx.testnet","wait_until":"FINAL"}}' \
  | jq -r '.result.receipts_outcome[].outcome.logs[] | select(startswith("EVENT_JSON:")) | ltrimstr("EVENT_JSON:") | fromjson
           | select(.event == "quotes_pushed") | .data[0].commitment'
```

See the same 64 hex characters twice: the sha256 of the batch the site returns, computed on your machine, and the commitment in the contract's event, read straight from the public RPC (on macOS, use `shasum -a 256` for `sha256sum`):

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

**a11. A trader's account and a relayed order, on chain.** `guest-6hy3hp2e-h.atnx.testnet` is a guest account made through the site on 2026-11-10, and `CdUcNMujXLZoampMXFp7k72scgVs8dAoEYHzodafkVJD` is the `open` that `relayer.atnx.testnet` sent for it that day. A regular RPC node keeps recent transactions only, so the transaction is read from FastNEAR's archival endpoint. Run:

```bash
ACCOUNT=guest-6hy3hp2e-h.atnx.testnet
ARCHIVAL=https://archival-rpc.testnet.fastnear.com
curl -s "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_account","finality":"final","account_id":"'"$ACCOUNT"'"}}' | jq '.result.amount'
curl -s "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"'"$ACCOUNT"'"}}' \
  | jq -c '.result.keys[] | {public_key, permission: .access_key.permission}'
curl -s "$ARCHIVAL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"CdUcNMujXLZoampMXFp7k72scgVs8dAoEYHzodafkVJD","sender_account_id":"relayer.atnx.testnet","wait_until":"FINAL"}}' \
  | jq '.result.transaction | {signer_id, receiver_id, delegate: (.actions[0].Delegate.delegate_action | {sender_id, receiver_id, public_key,
        method: .actions[0].FunctionCall.method_name, deposit: .actions[0].FunctionCall.deposit, args: (.actions[0].FunctionCall.args | @base64d | fromjson)})}'
```

See an account with 0 NEAR and one key, a function-call key that can only call `house.atnx.testnet`; then a transaction signed by `relayer.atnx.testnet`, which paid its gas, carrying a delegate action that the account signed with that same key: `open` on `house.atnx.testnet`, deposit 0, a 20 USDG UP order at 1x on market 36:

```
"0"
{"public_key":"ed25519:36tXFL1SNFRiAjtR8FkTFNuM1zEkJztH7Z5rHJ41ckER","permission":{"FunctionCall":{"allowance":"250000000000000000000000","method_names":[],"receiver_id":"house.atnx.testnet"}}}
{
  "signer_id": "relayer.atnx.testnet",
  "receiver_id": "guest-6hy3hp2e-h.atnx.testnet",
  "delegate": {
    "sender_id": "guest-6hy3hp2e-h.atnx.testnet",
    "receiver_id": "house.atnx.testnet",
    "public_key": "ed25519:36tXFL1SNFRiAjtR8FkTFNuM1zEkJztH7Z5rHJ41ckER",
    "method": "open",
    "deposit": "0",
    "args": {
      "market": 36,
      "side": "Long",
      "leverage": 1,
      "stake": "20000000",
      "limit_e2": "117751"
    }
  }
}
```

Steps b5 and b10 make the same check on an account and an order of your own.

## (b) In the browser, as a guest

Use a recent Chrome, Firefox or Safari. The account's key lives in this browser's IndexedDB, so clearing the site's data, or closing a private window, loses the account. Guests are capped at 10 per network per hour and 300 a day; past that the ticket says "Too many guest accounts from your network in the last hour. Sign in, or try again later."

**b1.** Open https://atnx-near.vercel.app/app/markets/46a8890c-25ce-4231-9112-fc1b3ba8ac07 (market 36, "Google"; https://atnx-near.vercel.app/app lists the others). See a card "Trade Google's index" marked "TESTNET", with "Buy price" and "Sell price" (step a5's numbers, written 1,144.8 and 1,140.7), a "Sign in to trade" button and "Try as a guest". Tap the "?" beside "Try as a guest": see "Your test account lives in this browser."

**b2.** Tap "Try as a guest". See "Setting up your test account…" for about 5 to 10 seconds, then "You need test USDG to trade." and a "Get 10,000 test USDG" button.

**b3.** Tap "Get 10,000 test USDG". See "Getting test USDG…" for about 4 to 8 seconds, a "Got 10,000 test USDG" notice, then the order form: UP and DOWN with "in at <price>", Amount 100, Leverage 1×, 2× and 3× with 1× (no leverage) selected.

**b4.** Leave UP, 100 and 1×. See "Fee (1 %) 1.00 USDG", "Total 101.00 USDG" (the amount plus the fee), "Liquidation at None" (a 1× UP position has no liquidation level; tap 2× or 3× to see one) and "Maximum win +900.00 USDG". Tap "Advanced": see "You get in at the buy price", "Worst price you accept" (1 % past the price) and "Worth on fill". When the market's two prices differ, as they usually do, "Worth on fill" is a little under 100 USDG, in red; tap the "?" beside it to see "Closing at once pays at the sell price, so a new position usually starts a little down.": the position is valued at the price it would close at, and a long closes at the sell price. The button reads "Open UP 1× · 100 USDG".

**b5.** Tap "Open UP 1× · 100 USDG". See "Sending…", then "Confirming your order… This usually takes about 10 seconds.", and about 10 seconds after the tap "Filled at <entry>." Under "Your positions here": "UP 1× · 100.00 USDG", then "Entry <entry> · No liquidation · 13 d 23 h left", and its value and PnL, starting a little under 100. "View transaction ↗" at the end of the "Filled at" line opens the order on NearBlocks: a transaction signed by `relayer.atnx.testnet` to your account, carrying a delegate action from your account to `house.atnx.testnet`, method `open`, no deposit. The relayer paid the gas.

**b6.** Tap "Close" on the position. See "Closing… This usually takes about 10 seconds.", then, about 10 seconds after the tap, "Closed. <payout> USDG is back in your balance."

**b7. A refusal.** Run `house_view list_markets '{"limit":100}' | jq -r '.[] | select(.opens == false) | "\(.reason): https://atnx-near.vercel.app/app/markets/\(.reference | "\(.[0:8])-\(.[8:12])-\(.[12:16])-\(.[16:20])-\(.[20:])")"'` and open one of the pages it prints. For "the two prices are too far apart", see the form with the Open button off and "The two prices are too far apart right now. Try again in a few minutes.": that market's reading is more than 10 % away from its score, and the contract takes no order there. For "score is under the minimum to open", see "Not tradable yet: the index has to be 100 or more." A market younger than 48 hours says "Not tradable yet: markets open 48 hours after they go live (in …)." The set of refusing markets changes from one print to the next.

**b8.** Open https://atnx-near.vercel.app/app/portfolio. See "Equity" and "Balance", both 10,000 USDG less the fee, plus or minus the result of step b6 (nothing is open, so the two agree), "Open PnL" at 0.00, and the "PnL" chart stepping at the close from b6. Under the tabs, "Open · 0" shows "No open positions." Tap "Closed": see the position from b5 with its "Entry", its "Exit" and "Closed", and above it "Realised <amount> USDG over 1 trade".

**b9.** Open https://atnx-near.vercel.app/app/settings. See "Guest account guest-<8 characters>-h.atnx.testnet ↗" and "Fund from any chain". Tap the "?" beside the account: see "Holds 0 NEAR.", "One key, which can only call house.atnx.testnet." and "relayer.atnx.testnet sends its calls and pays their gas.", read from public RPC when you tap. Keep Solana and 25: after a few seconds see "You send 25.00 USDC on Solana", "Arrives on NEAR", "Fee", "Time", and "Preview only: ATNX runs on NEAR testnet, so no money moves."

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
{ "id": "…", "market": 36, "side": "Long", "leverage": 1, "stake": "100000000", "entry_e2": "…", "exit_e2": "…",
  "payout": "…", "reason": "close", "opened_at": "…", "closed_at": "…" }
```

## (c) From a clone

Needs git, Node 20 or later with npm, and for the contract tests rustup and cargo-near 0.23.0 (`near/rust-toolchain.toml` pins Rust 1.99.1, which rustup installs on the first command). The sandbox tests download near-sandbox on their first run. Running the site itself locally needs the team's database keys, so judges use the hosted demo; c1 to c6 (the tests, the rebuild, the public verifier and the guest trade) need no keys beyond the public ones c5 reads from the site.

```bash
git clone https://github.com/arkanine1000/atnx-near && cd atnx-near
```

**c1. The contract's unit tests.** In `near/`, run `cargo test -p house --lib`. See `test result: ok. 58 passed; 0 failed`, among them the worked example of [docs/house.md](house.md#an-order-step-by-step) (`cargo test -p house --lib worked_example` runs the three worked-example tests alone: a 3x long of 100 filled at 408.80 and closed at 476.41 pays 149.615949).

**c2. The sandbox tests**, which deploy `usdg` and `house` to a local near-sandbox. In `near/`, run:

```bash
cargo near build non-reproducible-wasm --manifest-path usdg/Cargo.toml
cargo near build non-reproducible-wasm --manifest-path house/Cargo.toml
cargo test -p integration-tests --test house -- --test-threads=1
```

See `test result: ok. 6 passed; 0 failed` after about three minutes: faucet, deposits and withdraw; orders filling after a fresh read and positions ending; positions at 1x; a push of 75 markets in one call; the vault's exit and `migrate`; a failed withdraw refunded.

**c3. The deployed code, rebuilt** (needs Docker; CI run 42915086367 ran this build and produced the deployed wasm). From the repository root, run:

```bash
git checkout 5c019b5
(cd near/house && cargo near build reproducible-wasm)
sha256sum near/target/near/house/house.wasm
git checkout -
```

See `c68f835f30accfef64c43c55705b1d44410af10c6a83b9cb59238339c9584662`, the deployed code hash in hex. While `git diff 5c019b5 -- near/house` prints nothing, the contract source in your checkout is the deployed one.

**c4. The web tests.** From the repository root, run `cd atnx-web && npm ci && npm run test:near && npm run test:bm`. See each suite end with `# fail 0`: accounts and handles, the relayer and its house policy, the house checks, the public push routes, the keeper's rules, the commitment, the ticket's numbers. (On 2026-11-11 the two suites ran 199 and 217 tests.)

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

**c6. A whole trade as a guest, from your terminal.** In `atnx-web/`, after `npm ci`, run `npm run house:trade:public`. It needs no env file; `--side down`, `--stake 25` or `--market 12` change the order. See seven numbered steps: a new key saved in `.house-trade-key.json`, a guest account made for it, 50 test USDG from the faucet, an order on market 36 with `Filled at <price>` about 10 seconds later, its close with the payout, then each transaction with `signer relayer.atnx.testnet` and its NearBlocks link, the account holding 0 NEAR with one function-call key for `house.atnx.testnet`, and a last line starting `OK:`. The whole run takes under a minute. A second run trades as the same guest, makes no new account and claims nothing more. If the site's guest limit for your network is reached it says so and exits with status 3; run it again later.

```
5. Order: market 36, UP 1x, 10.00 USDG at a worst price of 1,173.14 (buy price 1,161.52): placed as position 34 (tx uBJ6hqMerofT5Ywamv3zrkuvwXaM2zk8GSzscbPbp4s); waiting for the keeper's next quote
   Filled at 1,161.20
6. Close: position 34 at a worst price of 1,145.95 (sell price 1,157.53): requested (tx J7eBWa5ForEYRHTrXHUKqXgy2GdWXXM7DzjmVTF3gtzr)
   Closed at 1,157.53: payout 9.968394 USDG for a stake of 10.00 (-0.031606 USDG)
7. Proof, read from https://test.rpc.fastnear.com:
   open    uBJ6hqMerofT5Ywamv3zrkuvwXaM2zk8GSzscbPbp4s  signer relayer.atnx.testnet, a Delegate from guest-0m2t7goc-h.atnx.testnet calling open on house.atnx.testnet
   …
   guest-0m2t7goc-h.atnx.testnet holds 0 NEAR
   its access keys (1): ed25519:E9wau1nZ6Vran1Dj4zewyWbaX4amHeduJprbqeLtwPEN function call on house.atnx.testnet, no method list, allowance 0.25 NEAR
OK: guest-0m2t7goc-h.atnx.testnet, a guest with 0 NEAR whose only key is a function-call key for house.atnx.testnet, opened and closed a position; relayer.atnx.testnet signed and paid for every call.
```
