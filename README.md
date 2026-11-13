# ATNX: attention markets on NEAR

ATNX scores how much attention a trend, a person or a brand gets online: the Virality Index (VI), recomputed every five minutes from public sources. This repository is ATNX's entry in the NEAR Hackathon: markets on NEAR testnet where anyone goes UP or DOWN on a trend's VI at 1x, 2x or 3x. A vault takes the other side of every trade, which is why the code and the docs call it the house market. A trader signs in with Google or X, or tries it as a guest, and never holds NEAR: every call is gasless. One contract, `house.atnx.testnet`, holds the money, the positions and the prices; a keeper pushes each market's newest VI print to it every five minutes, with a commitment to the public rows the print came from.

**The problem.** The VI is a number that moves with a trend, but there is no plain way to take a position on that number, and a first on-chain trade usually needs a wallet, a gas token and a funded account before it can happen. The house market lists each trend's VI as a market, prices it on chain, and lets a first trade happen from a Google sign-in or a guest account with no wallet and no gas.

| | |
|---|---|
| Hosted demo | https://atnx-near.vercel.app/app (NEAR testnet, test USDG with no value), kept up through 2026-11-25 |
| This entry's contract | [`house.atnx.testnet`](https://testnet.nearblocks.io/address/house.atnx.testnet), source in [`near/house`](near/house) |
| Full description | [docs/house.md](docs/house.md) |
| Tracks | `defi` and `open`. The tracks' hints: TRADING is the house market; NEAR INTENTS is dry 1Click quotes only, because NEAR Intents has no testnet; CHAIN SIGNATURES is not used; BUILD YOUR OWN is this entry's own contract, `near/house` |
| Code built in the hackathon window | [compare `pre-hackathon...be66b35`](https://github.com/arkanine1000/atnx-near/compare/pre-hackathon...be66b35); the baseline's removal and what came after it: [compare `be66b35...hackathon-submission`](https://github.com/arkanine1000/atnx-near/compare/be66b35...hackathon-submission) ([Prior work](#prior-work)) |
| Licence | [MIT](LICENSE) |

## What runs on NEAR, and why it needs NEAR

- **An internal ledger, function-call keys and NEP-366 meta-transactions, so every trade is gasless with no wallet.** Money is a USDG balance inside the contract; no trading call attaches a deposit. A call without a deposit can be signed by a function-call access key and wrapped in a NEP-366 delegate action that another account sends and pays for. Each trader gets a named account, `<handle>-h.atnx.testnet` or `guest-<8 characters>-h.atnx.testnet`, created by the platform with 0 NEAR and one key: the browser's own, a function-call key for `house.atnx.testnet`. `relayer.atnx.testnet` sends and pays for every call. On NEAR each of these is a protocol feature: a parent account creates named sub-accounts, an access key can be limited to one contract, and a delegate action lets another account pay for a user's call; none of it needs a contract of its own. Steps [b5 and b10](docs/try-it.md#b-in-the-browser-as-a-guest) check this on chain from a browser, step [a11](docs/try-it.md#a-no-login-no-install) from a terminal.
- **The keeper's committed prices.** `push_quotes` carries each market's newest print and the sha256 of the canonical batch of the public `vi_history` rows it came from; the contract logs the same hash in a `quotes_pushed` event. The contract derives both prices from the print itself, limits how fast a score may move, and fills every order at a quote read after it. Steps [a7 to a9](docs/try-it.md#a-no-login-no-install) check a push.
- **A dry-run cross-chain funding quote.** Settings has "Fund from any chain": a live NEAR Intents 1Click price for bringing USDC from Solana, Base, Arbitrum or Ethereum to NEAR. Every request is a dry quote (`dry: true`), so no money moves: the app runs on testnet and NEAR Intents has no testnet. Step [a10](docs/try-it.md#a-no-login-no-install).

## Deployed contracts

All on NEAR testnet. `code_hash` is the SHA-256 of the deployed wasm in base58, as `view_account` returns it.

| Account | What it is | Code hash | How to check |
|---|---|---|---|
| `house.atnx.testnet` | This entry: the house market (`near/house`). Owner and treasury `atnx.testnet`, keeper `keeper.atnx.testnet` | `EN6eaeUyNxp1VUJ5nWDtv3wTNmHrx53u7eNPwTScEnb3` (hex `c68f835f30accfef64c43c55705b1d44410af10c6a83b9cb59238339c9584662`) | Step [a1](docs/try-it.md#a-no-login-no-install). Built by [CI run 42915086367](https://github.com/arkanine1000/atnx-near/actions/runs/42915086367) (`near-build`, reproducible) from commit `5c019b5`, which its `contract_source_metadata` view names; rebuild it with step [c3](docs/try-it.md#c-from-a-clone) |
| `usdg.atnx.testnet` | USDG, "ATNX test USD": a NEP-141 test token with 6 decimals (`near/usdg`) | `3ew3uCaQ95H1vnmL3CHvLamsiaTQ6aFjPv6nYs9x5AsQ` | `view_account` as in step a1; its `contract_source_metadata` names commit `4f0791e` |
| `rounds.atnx.testnet` | An earlier market design on NEAR, built in the same hackathon window and still deployed: rolling pari-mutuel rounds on the VI ([docs/rounds.md](docs/rounds.md)). The house replaced it as the product | `3XiZgR4xdsPX7fotjtp4d9cc1DAN81SmvWXGLDXJLizw` | As above; commit `4f0791e` |
| `keeper.atnx.testnet`, `relayer.atnx.testnet`, `atnx.testnet` | The keeper, the relayer, and the owner, treasury and parent of every trader account. Plain accounts, no contract | | |

The vault was seeded with 10,000,000 test USDG and the faucet pool with 2,000,000. Deposits into the vault are open to the treasury only for now (`lp_open` is false). The contract account keeps its deploy key on testnet so fixes can ship during judging; the code hash above shows what runs at any moment.

## Try it

The app runs on NEAR testnet; the money is test USDG with no value. Two short paths follow. Every check, with its exact command and the output to expect, is in [docs/try-it.md](docs/try-it.md): (a) from a terminal with no login, (b) in a browser as a guest, (c) from a clone.

### In a browser (for a human judge)

About two minutes, with no wallet and no sign-in.

1. Open https://atnx-near.vercel.app/app/markets/46a8890c-25ce-4231-9112-fc1b3ba8ac07 (the "Google" market). See the card "Trade Google's index" with a buy price and a sell price.
2. Tap "Try as a guest". See "Setting up your test account…" for 5 to 10 seconds, then a "Get 10,000 test USDG" button.
3. Tap "Get 10,000 test USDG". See the order form: UP and DOWN, each with "in at <price>", Amount 100, and Leverage with 1× selected.
4. Tap "Open UP 1× · 100 USDG". See "Confirming your order…", and about 10 seconds after the tap "Filled at <price>." with "View transaction ↗". The link opens the order on NearBlocks: `relayer.atnx.testnet` sent it and paid its gas.
5. Tap "Close" on the position. About 10 seconds later, see "Closed. <payout> USDG is back in your balance."
6. Open https://atnx-near.vercel.app/app/portfolio. See "Equity" and the "PnL" chart stepping at that close; tap "Closed" to see the trade.

Steps [b1 to b10](docs/try-it.md#b-in-the-browser-as-a-guest) say what each screen shows in full, and add a market that refuses orders, Settings with the cross-chain quote, and your account checked on chain.

### From a terminal (for an agent or a script)

Needs `curl` and `jq`; no login. Paste this first:

```bash
RPC=https://test.rpc.fastnear.com
SITE=https://atnx-near.vercel.app
house_view() {  # house_view <method> '<arguments as JSON>'
  curl -s "$RPC" -H 'content-type: application/json' -d "$(jq -nc --arg m "$1" --arg a "$(printf '%s' "$2" | base64 | tr -d '\n')" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:"house.atnx.testnet",method_name:$m,args_base64:$a}}')" \
  | jq '.result.result | implode | fromjson'
}
```

1. **The source of the deployed contract.** Run `house_view contract_source_metadata '{}' | jq '{version, link}'`. See the commit the deployed wasm was built from: `"link": "https://github.com/arkanine1000/atnx-near/tree/5c019b5a2d8466ccdaebcf8b1a943ed082863f0e"`.
2. **One market's two prices.** Run `house_view get_market '{"market":36}' | jq '.quote | {score_e2, reading_e2, lead_e2, buy_e2, sell_e2}'`. See the score, the reading, the lead between them, and the two prices, buy = max(score, lead) and sell = min(score, lead), in hundredths of a VI point.
3. **A keeper push, checked against public data.** Run:

   ```bash
   TX=$(curl -s "$SITE/api/near/house/pushes?limit=1" | jq -r '.items[0].txHash')
   curl -s "$SITE/api/near/house/verify?tx=$TX" | jq '{ok, quotes, rowsFound, hashes}'
   ```

   See `"ok": true` and three equal hashes: the one in the keeper's call, the one in the contract's event, and the one recomputed from the public rows.

Steps [a1 to a11](docs/try-it.md#a-no-login-no-install) cover the code hash, the vault, the settings, a quote for an order, a refusal, the hash computed by you, and a trader's account and a relayed order on chain. In a clone, `bash scripts/check-public.sh` runs all eleven: see one `ok` line per step and exit status 0. Steps [c1 to c6](docs/try-it.md#c-from-a-clone) run the tests, rebuild the deployed code reproducibly, verify a push on your own machine, and trade as a guest from the terminal: `cd atnx-web && npm ci && npm run house:trade:public` makes a guest, opens and closes a 10 USDG position through the relayer, and prints each transaction's signer and the account's 0 NEAR.

## How it works

- **Two prices.** Each print carries the score S and the reading R the score is smoothing towards. The contract quotes a lead, S moved λ of the way to R (λ is 30 % at no gap and 100 % from a 25 % gap), and two prices: buy = max(S, lead), sell = min(S, lead). Longs open at the buy price and close at the sell price; shorts the other way round. Orders are refused while the two prices are more than 10 % of S apart. ([docs/house.md](docs/house.md#the-two-prices))
- **Orders.** `open` and `close` only place a request, with the worst price it accepts. It fills at the earliest quote read at least 5 s after it, whoever calls `crank` and whenever. Right after the relay sends an order, the keeper sends that market's quote and the crank in one transaction, so a fill takes about 10 seconds; a request with no quote for 15 minutes is refunded. ([An order, step by step](docs/house.md#an-order-step-by-step))
- **Positions.** 10 to 250 USDG at 1x (no leverage), 2x or 3x, a 1 % fee on top, at most 10 per account. A position can lose at most its stake; a long can win at most nine times its stake and a short its leverage times its stake, and that maximum is reserved in the vault at the fill. Liquidation needs both prices at the level; a 1x long has no level above zero. A position ends after 14 days. ([Positions](docs/house.md#positions))
- **The vault.** Shares on realised results only, 2 % of the assets per market and side, 80 % in all; exits by 24 hours' notice. ([The vault](docs/house.md#the-vault))
- **The keeper.** Three runs: the five-minute tick (push every market, crank, list), the every-minute run (orders waiting for a quote), and quotes on demand after a trader's order. ([The keeper](docs/house.md#the-keeper))
- **Accounts.** A browser key that page script cannot read, a named account with 0 NEAR under `atnx.testnet`, and a relayer that checks every delegate against the house contract before paying for it. ([Accounts and relaying](docs/house.md#accounts-and-relaying))

| Docs | |
|---|---|
| [docs/try-it.md](docs/try-it.md) | Every check as "do X, see Y": from a terminal, in a browser, from a clone |
| [docs/house.md](docs/house.md) | The house market in full: prices, orders with the worked example, positions, the vault, markets, the keeper and the commitment, accounts and relaying, the UI's states, operations, built and not built, if a part stops, limits |
| [near/README.md](near/README.md#house) | Every house method, view, event and error message; how to build and test the contracts; reproducible builds |
| [docs/virality-index.md](docs/virality-index.md), [docs/vi-sources.md](docs/vi-sources.md) | How the VI is computed and what it reads |
| [docs/development.md](docs/development.md) | Local setup and every environment variable |
| [docs/architecture.md](docs/architecture.md), [docs/web-app.md](docs/web-app.md), [docs/database.md](docs/database.md) | The app around the market |
| [docs/rounds.md](docs/rounds.md) | The earlier design on NEAR, rolling rounds: what still depends on its contract, and where its methods and tests are |

## Roadmap

The money here is test USDG with no value. What comes before real money:

- **Index inputs.** Take short-lived noise out of the readings before they are smoothed, and read the slower sources closer to real time.
- **Keeper.** Pause new orders automatically when a source goes silent or most markets move together (today the pause is a manual call), and put a delay on setting changes.
- **A verifiable index.** Compute the index in a trusted execution environment whose attestation can be checked. Today each push is committed to public rows, which shows what a push used, not that the rows are right.
- **Vault.** Open deposits to everyone, with delayed deposits and a share price that counts open positions.
- **Accounts.** Charge storage to the account that adds it, and remove the contract's deploy key.
- **Mainnet.** Deposits from other chains through NEAR Intents.

The limits of what is built are listed in [docs/house.md](docs/house.md#known-limits).

## Built and not built

As of 2026-11-10. Details in [docs/house.md](docs/house.md#built--not-built).

Built: the `near/house` contract with 58 unit tests and 6 sandbox tests; a reproducible CI build deployed to `house.atnx.testnet`, seeded and with 57 markets listed; the keeper's three runs on Vercel cron with a commitment on every push; the public push and verify routes and `house:verify:public`; gasless named accounts for signed-in users and guests, with the relayer's house policy; the ticket, the portfolio and Settings on https://atnx-near.vercel.app; "Fund from any chain" with dry 1Click quotes.

Not built: real cross-chain deposits through NEAR Intents (mainnet only); vault deposits from anyone, and a page for vault shares; a Withdraw button (the contract method exists); storage charged to the accounts that add it; the deploy key removed; any check of the index on chain; mainnet.

## Prior work

Disclosed under the hackathon's rules (Q-002 to Q-005):

- **ATNX exists off chain** at https://atnx.app: the Virality Index and paper trading on it. The VI that the keeper pushes is computed there and written to the shared database; this repository reads it.
- **This repository started as ATNX's Solana build**: bounded UP/DOWN markets and rolling rounds on Solana devnet, a port of the bounded markets to the Robinhood EVM testnet, the capture pipeline and the VI pipeline (`atnx-web/`) and a Chrome extension (`atnx-extension/`). All of it is baseline. The Solana programs and the EVM contracts are still deployed on their test networks and are not part of this entry; their source, docs and addresses are in https://github.com/arkanine1000/atnx-markets. This repository's history before their removal on 2026-11-11 also holds the baseline's two Solana devnet program-address keypairs (`keys/`), which fix the addresses of the devnet programs and hold no funds.
- **Tags.** [`pre-hackathon`](https://github.com/arkanine1000/atnx-near/releases/tag/pre-hackathon) is commit `78b6ecd` (2026-10-12), the last commit before the hackathon's announcement on 2026-10-19; the next commit is from 2026-11-08. `hackathon-submission` marks the submitted commit. The work judged is the diff `pre-hackathon...hackathon-submission`: everything under `near/` (the house, the rounds port and the test token), the NEAR client, accounts, relayer and guests (`atnx-web/lib/near/`), the house keeper, its rules and the commitment (`atnx-web/lib/bm/house-*.ts`, `quote-commitment.ts`), the house UI (`atnx-web/components/house/`), the NEAR and keeper routes (`atnx-web/app/api/near/`, `atnx-web/app/api/bm/house-keeper/`) and the funding panel. GitHub shows at most 300 files of a diff, so it is linked in two parts: [compare `pre-hackathon...be66b35`](https://github.com/arkanine1000/atnx-near/compare/pre-hackathon...be66b35), the work built in the window (177 files, none deleted), and [compare `be66b35...hackathon-submission`](https://github.com/arkanine1000/atnx-near/compare/be66b35...hackathon-submission), the baseline's removal and what came after it. The diff also lists the baseline's Solana and EVM sources as deleted, because they were removed from this repository on 2026-11-11. `git diff --stat --diff-filter=AM pre-hackathon hackathon-submission` lists only the files added or changed.
- **The rounds on NEAR** (`rounds.atnx.testnet`) were built in the same window, before the house, and are still deployed; the house replaced them as the product.

## Libraries, services and templates

- **Contracts:** near-sdk 5.30 and near-contract-standards 5.30 (the token's NEP-141, NEP-145 and NEP-148); cargo-near 0.23.0 with the `sourcescan/cargo-near:0.23.0-rust-1.99.1` image for reproducible builds; near-workspaces 0.24, tokio, serde_json and anyhow in the sandbox tests.
- **Web:** Next.js 16.2.2, React 19.2.4, near-api-js 7.4, borsh 2, Supabase (`@supabase/supabase-js`, `@supabase/ssr`), TanStack Query 5, Tailwind CSS 4, tsx for the tests.
- **Services:** Supabase (database and Google and X sign-in), Vercel (hosting and cron), public NEAR testnet RPC endpoints (FastNEAR first, with Intear and dRPC as fallbacks), the NEAR Intents 1Click API (dry quotes only), NearBlocks (explorer links).
- **Templates:** none. The relayer was ported from the team's own testnet prototype in `near/relayer-proto`, written in the window.

## The team's other entry

QuestFi on NEAR: https://github.com/arkanine1000/questfi-near

## Licence

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 ATNX.
