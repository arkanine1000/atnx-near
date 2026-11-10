# Local development

## Web app

```bash
cd atnx-web
npm install
cp .env.local.example .env.local   # fill in the Supabase / CRON values below
npm run dev                        # http://localhost:3000
```

Env vars:

| Name | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | Anon key for browser auth |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | Admin client, bypasses RLS |
| `AI_GATEWAY_API_KEY` | server only, local | Vercel AI Gateway. Not needed on Vercel itself (OIDC) |
| `CRON_SECRET` | server only | Bearer token Vercel sends to `/api/markets/refresh` and `/refresh-slow` |
| `CORS_ALLOWED_ORIGINS` | server only | Comma-separated extra origins allowed to call the cookie-authenticated API (the extension's `chrome-extension://<id>`); the app's own hosts are always allowed |
| `BLUESKY_IDENTIFIER` | server only | Bluesky handle for the post-search VI source (source is skipped when unset) |
| `BLUESKY_APP_PASSWORD` | server only | App password for that account |
| `VI_TRENDS_BENCHMARK` | server only | Optional; anchor keyword for Google Trends, default `sudoku` |

Optional overrides (model ids, link and confirm thresholds, the daily market-creation cap and its exemptions) and the `EVAL_*` variables for the eval script are listed in `atnx-web/.env.local.example`.

Rolling rounds on Solana devnet ([rounds.md](rounds.md)), also in `.env.local.example`:

| Name | Where | Notes |
| --- | --- | --- |
| `BM_ROUNDS_ENABLED` | server only | `1` runs the rounds step of the keeper tick; anything else skips it |
| `BM_SOL_KEEPER_SECRET` | server only | The keeper's Solana key: a JSON array of 64 numbers (`solana-keygen` format) or the same bytes in base58. On devnet it is also the program's authority and treasury |
| `NEXT_PUBLIC_BM_SOL_PROGRAM` | client + server | Program id; defaults to the deployed `vi_rounds` |
| `NEXT_PUBLIC_BM_SOL_USDG` | client + server | The mock USDG mint. Without it the ticket says rounds are not live and the portfolio hides the rounds section |
| `NEXT_PUBLIC_BM_SOL_RPC` | client + server | Devnet RPC; defaults to `https://api.devnet.solana.com`, which rate-limits. Production uses a Helius devnet endpoint |
| `NEXT_PUBLIC_BM_MOCK_SOL_WALLET` | client, `next dev` only | A base58 address the ticket treats as connected, read-only, for screenshots without a wallet extension. Ignored on every Vercel deployment, previews included (`NODE_ENV` is `production` there) |
| `BM_ROUND_SECS`, `BM_SETTLE_WINDOW_SECS`, `BM_FIRST_PRESALE_SECS` | server only | Daily series: 86400, 1800, 3600 |
| `BM_FAST_ROUND_SECS`, `BM_FAST_SETTLE_WINDOW_SECS`, `BM_FAST_FIRST_PRESALE_SECS` | server only | Fast demo series: 3600, 900, 600 |
| `BM_FAST_FROM_CLIENT` | server only | `1` lets the ticket start a fast series on a production build; otherwise only `rounds:start --fast` can |
| `BM_ANTE_USDG` | server only | The keeper's commit on an empty side, default 10 |
| `BM_SETTLE_DELAY_SECS` | server only | How long after a round's close the keeper settles, default 300 |
| `BM_AUTO_ROLL` | server only | `0` stops the bounded-market keeper from rolling new bounded markets (the first iteration); resolution goes on |

The other bounded-market variables are listed in [bounded-markets.md](bounded-markets.md#operations); `BM_MAX_VI_AGE_MIN` (default 30) is shared: neither a bounded market nor a round opens on an older VI.

### Rolling rounds on NEAR testnet

The NEAR build of the same rounds ([rounds.md](rounds.md#near-testnet)). The names are in `.env.local.example`; that file's comment on `NEXT_PUBLIC_BM_NEAR_PARENT` predates the account routes, and it does not list the relayer's two variables.

| Name | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_BM_CHAIN` | client + server | `near` makes the site read, show and trade the NEAR series (registry rows `near:testnet`) and sign in with Google or X; the NEAR "Start rounds" action refuses to run without it. Anything else, or nothing, keeps the Solana build as it was |
| `NEXT_PUBLIC_BM_NEAR_NETWORK` | client + server | Default `testnet`. The keeper's NEAR client refuses to sign on any other |
| `NEXT_PUBLIC_BM_NEAR_RPC` | client + server | One URL or a comma-separated list, tried in order (`lib/near/rpc.ts`): a read one endpoint refuses (rate limited, a 5xx, unreachable) goes to the next. Public, so no keyed URLs. Default `https://test.rpc.fastnear.com`. The public verify routes read the first one |
| `BM_NEAR_RPC` | server only | The server's own list in the same form (the keeper, the relay, account creation, the house checks); may hold keyed URLs, and logs name hosts only. Unset, the server uses `NEXT_PUBLIC_BM_NEAR_RPC`, then the default |
| `NEXT_PUBLIC_BM_NEAR_ROUNDS` | client + server | The rounds contract, `rounds.atnx.testnet`. The browser and the account and relay routes need it set (without it and the parent the ticket says rounds are not live and the routes answer `not_configured`); the keeper falls back to `rounds.atnx.testnet` |
| `NEXT_PUBLIC_BM_NEAR_USDG` | client + server | The token, `usdg.atnx.testnet`; the keeper falls back to it |
| `NEXT_PUBLIC_BM_NEAR_PARENT` | client + server | The parent of user accounts, `atnx.testnet`; accounts are `<handle>.<parent>` and the relayer only relays for direct sub-accounts of it. The e2e scripts default to `atnx.testnet` |
| `BM_NEAR_ROUNDS_ENABLED` | server only | `1` runs the NEAR rounds step of the keeper tick, independently of `BM_ROUNDS_ENABLED` |
| `BM_NEAR_KEEPER_ACCOUNT` | server only | The keeper account, `keeper.atnx.testnet`; it must be the contract's keeper. Also the finder `rounds:start --chain near` uses by default |
| `BM_NEAR_KEEPER_SECRET` | server only | The keeper's key, `ed25519:<base58>` as near-cli writes it |
| `BM_NEAR_PARENT_SECRET` | server only | The parent's key: `/api/near/account` creates user accounts with it, and `rounds:near -- e2e` its throwaway user |
| `BM_NEAR_RELAYER_ACCOUNT` | server only | The account that signs and pays for relayed calls (`/api/near/relay`) |
| `BM_NEAR_RELAYER_SECRET` | server only | Its key |
| `BM_NEAR_GUEST_IP_SALT` | server only | Optional. The salt of the guests' IP hashes in `bm.near_guests`; without it the salt is derived one way from `BM_NEAR_PARENT_SECRET`. Changing it resets the per-IP count |
| `BM_BOUNDED_ENABLED` | server only | `0` skips the keeper tick's bounded-market steps (1–3) on this deployment, so a second deployment sharing the registry leaves the bounded markets to the one that runs them |

`/api/near/guest` and the relay's guest branch need `supabase/bm/005_near_guests.sql` (`bm.near_guests`), applied to production on 2026-11-10. `/api/near/account` writes `bm.near_accounts` and `/api/near/relay` takes its lock, so both need `supabase/bm/004_near_accounts.sql` applied (and the NEAR keeper needs `003_near.sql`); both files are idempotent and are applied by hand, like the other `supabase/bm` files. Both were applied to production on 2026-11-09, from the linked `atnx` checkout with `npx supabase db query --remote --yes -f <file>` (Supabase CLI v3 asks for `--yes` on a hosted write, or `--read-only` for a read).

### The house market on NEAR testnet

The house market ([house.md](house.md)) runs on the same NEAR build, accounts, relayer and keeper account as the rounds above, plus these:

| Name | Where | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_BM_NEAR_PRODUCT` | client + server, build time | `house` on a NEAR build shows the house: the long/short ticket and the portfolio, a house account `<handle>-h.<parent>` beside each rounds account, and the relayer's house policy; the rounds leave the navigation and the market page. Anything else keeps the rounds as they are |
| `NEXT_PUBLIC_BM_NEAR_HOUSE` | client + server | The house contract, `house.atnx.testnet`. The site shows the house only once it is set; the keeper, `house:seed` and the public routes `/api/near/house/pushes` and `/api/near/house/verify` default to `house.atnx.testnet` |
| `BM_NEAR_HOUSE_ENABLED` | server only | `1` turns the house keeper's runs on: `/api/bm/house-keeper` (every five minutes, at minute 1), `/api/bm/house-keeper/fast` (every minute), `house:tick --live`, and the quote on demand after a relayed order or close. Anything else, and the routes answer that nothing ran |
| `BM_NEAR_KEEPER_FAST_SECRET` | server only | A second `ed25519:` key on `BM_NEAR_KEEPER_ACCOUNT`, used only for quotes on demand, so they never take a nonce the cron runs are using. Unset, the main key |
| `BM_NEAR_HOUSE_FAUCET_WARN_USDG` | server only | The tick logs `house-faucet-low` when the contract's faucet pool holds fewer USDG than this. Default 100000 |
| `BM_NEAR_PARENT_ACCOUNT` | server only, scripts | The account `house:seed` seeds from, with `BM_NEAR_PARENT_SECRET`. Default `atnx.testnet` |
| `NEAR_INTENTS_JWT` | server only | Optional. A 1Click partner JWT for the "Fund from any chain" quotes, sent as `X-API-Key`; without it the quotes still work, with 1Click's higher fee |

The house keeper signs as `BM_NEAR_KEEPER_ACCOUNT` with `BM_NEAR_KEEPER_SECRET`, like the rounds step, and must be the contract's keeper. The public routes need no secret beyond the Supabase variables at the top: `/api/near/house/verify` reads the rows with the anon key, as anyone can.

```bash
npm run house:tick                         # one dry five-minute tick; -- --fast the every-minute run, -- --list every eligible market
BM_NEAR_HOUSE_ENABLED=1 npm run house:tick -- --live   # a real one
npm run house:seed -- --contract house.atnx.testnet --vault 10000000 --faucet 2000000   # the plan, in whole USDG; -- --live sends
npm run house:verify:public -- <tx> --supabase-url <url> --anon-key <key>               # one push checked with no env file
```

## Checking the pipeline

```bash
npm run eval:capture -- --cleanup   # 25 fixtures through the one-shot route, resubmits, then the review cases; needs a running dev server
npm run test:vi                      # the VI math, node:test
npm run vi:report                    # what the last hourly run did: coverage, spend, notable markets
npm run vi:audit                     # every live market's score, breakdown, history coverage and cron health
```

## Checking the markets

```bash
npm run test:bm                      # the pari-mutuel maths (dpm.ts), the settlement rule, the bounded-market tests
npm run rounds:sol -- e2e            # a full rounds series on devnet against the deployed program; no .env.local needed
npm run rounds:start                 # the ten liveliest markets; -- "Name" starts daily rounds, -- <uuid> --fast the demo series
BM_ROUNDS_ENABLED=1 npm run rounds:tick   # the rounds steps of one keeper tick, dry (they run only with the variable); -- --live for a real one, -- --bounded adds the bounded markets' steps
npm run bm:keeper:dry                # the same tick as the cron, dry; -- --live for real
```

On NEAR testnet (these read `.env.local`; the ones that sign refuse any network but testnet):

```bash
npm run test:near                    # the NEAR web layer: account names, the relayer and its policy, the rounds checks, the routes, the start action
npm run rounds:near -- status        # the contracts' config, the keeper's balances, the series on chain
npm run rounds:near -- e2e           # two 60-second rounds end to end with the keeper and a throwaway user; --out <dir> keeps each settle's inputs
npm run near:e2e                     # a new gasless account, then a faucet call and a commit through the relayer; -- --full adds a whole round, -- --series <id> uses an existing series
npm run rounds:verify -- <series-uuid-or-reference> <round>   # a settled NEAR round's commitment against the chain and vi_history; read-only
npm run near:guest:e2e               # a guest account through the route code, a faucet, a commit into a 20-minute series it pauses, voids and claims back
npm run rounds:verify:public -- 8 2  # needs no .env.local: the inputs from the site, the commitment from public RPC, the hash computed here; --site <url>
npm run rounds:start -- <uuid> --chain near                    # daily rounds on NEAR; --fast, --finder <account>, --dry as on Solana
BM_ROUNDS_ENABLED=0 BM_NEAR_ROUNDS_ENABLED=1 npm run rounds:tick   # NEAR's rounds step alone, dry; -- --live sends
```

`cargo test -p vi_rounds --lib` and `cargo test -p bounded_vi --lib` run the programs' math tests on a plain Rust toolchain; CI runs both on every push under `programs/`.

## NEAR contracts

The contracts are in `near/`, a Cargo workspace of its own with Rust 1.99.1 pinned in `near/rust-toolchain.toml` and cargo-near 0.23.0 ([near/README.md](../near/README.md)). This machine's compiler crashes under parallel load, so every build runs pinned to four cores with two jobs and its output in `/tmp`, which also keeps the build off `/home`:

```bash
cd near
export CARGO_TARGET_DIR=/tmp/atnx-near-target CARGO_BUILD_JOBS=2
(cd usdg && taskset -c 0,3-5 cargo near build non-reproducible-wasm)
(cd rounds && taskset -c 0,3-5 cargo near build non-reproducible-wasm)
(cd house && taskset -c 0,3-5 cargo near build non-reproducible-wasm)
taskset -c 0,3-5 cargo test -p rounds --lib     # math.rs's own tests plus the contract's
taskset -c 0,3-5 cargo test -p usdg
taskset -c 0,3-5 cargo test -p house --lib
taskset -c 0,3-5 cargo test -p integration-tests -- --test-threads=1   # near-sandbox, after the three wasm builds; --test house for the house alone
```

If a build dies with SIGSEGV or "rustc interrupted", run it again; finished crates are kept. There is no Docker here, so local builds are non-reproducible: they embed `version` and `link` but no build metadata, and their bytes differ from CI's. The wasm files to deploy come from CI, which builds them with `cargo near build reproducible-wasm` (see Deployment).

## Seeding trending markets

A fresh database renders the empty state until someone captures something. To fill it with a curated set of currently-trending memes and moments:

```bash
npm run seed:trending              # creates ~10 markets (needs SUPABASE_SERVICE_ROLE_KEY in .env.local)
npm run seed:trending -- --dry-run # fetches the images and writes previews to .seed-preview/, touches nothing
npm run seed:trending -- --user <auth uuid>   # attribute the captures to a user instead of leaving user_id null
```

Each item becomes a `markets` row, one `captures` row (image is the source page's og:image, uploaded to the `captures` bucket, with a generated card as fallback) and a 7-day `vi_history` series shaped to its trend. Markets whose name already exists are skipped, so re-running is safe. The VI refresh cron takes over scoring from there. The list lives in `scripts/seed-trending.mjs`; edit `TRENDING` to swap in whatever is hot.

## Extension

1. `chrome://extensions` → enable **Developer Mode** → **Load unpacked** → select `atnx-extension/`.
2. Click the toolbar icon to open the side panel, open the gear, and set **Web App URL** to `http://localhost:3000` while developing locally. Chrome will ask to grant the extension access to that origin — accept, or captures can't attach the auth cookie. The field shows only to admins and moderators, so sign in at markets.atnx.app with a staff account first (once a local URL is saved it stays visible). Only `*.atnx.app` and `localhost` / `127.0.0.1` are accepted.
3. Sign in at your web app URL first (connect an EVM wallet and sign the message) so the Supabase auth cookie exists. Then `Ctrl+Shift+X` / `Cmd+Shift+X` to capture.

Change the hotkey at `chrome://extensions/shortcuts`.

## Releasing the extension to the Chrome Web Store

The fork's extension is not published; this is the upstream release flow, kept for reference.

```bash
cd atnx-extension
node package.mjs                 # → dist/atnx-capture-v<version>.zip (only the files the manifest needs)
node ../scripts/store-assets.mjs # regenerates store/screenshot-*.png + promo-small.png (needs Playwright)
```

Then follow `atnx-extension/store/LISTING.md`: it has the listing text, the
per-permission justifications, the data-usage disclosures, and the checklist
for the Developer Dashboard. The privacy policy the listing links to is served
by the web app at `/privacy`, so deploy the web app before submitting. Bump
`version` in `manifest.json` for every upload.

---

# Deployment

- Hosted on **Vercel**, project `atnx-markets`, domain `markets.atnx.app`, Root Directory `atnx-web`. The GitHub integration builds every push: a pull request gets a preview, a push to `main` deploys production. (Until 2026-10-02 the root directory was `.` and only CLI deploys from inside `atnx-web` worked; a `vercel deploy` from inside `atnx-web` now fails, so link at the repository root if a CLI deploy is ever needed.)
- `vercel.json` schedules `/api/bm/keeper` every 5 min (bounded markets unless `BM_BOUNDED_ENABLED=0`, then the rounds: Solana's when `BM_ROUNDS_ENABLED=1`, NEAR's when `BM_NEAR_ROUNDS_ENABLED=1`); Vercel runs crons on the production deployment only. The VI refresh crons stay on production ATNX, whose history this build reads.
- Solana programs are built on GitHub Actions, never locally: `.github/workflows/solana-build.yml` runs `cargo test -p vi_rounds --lib` and `cargo test -p bounded_vi --lib` on the host toolchain, then `anchor build` for `bounded_vi` and `vi_rounds` with Agave pinned to 4.3.0, and uploads one artifact per program. Deploy from the laptop with `programs/deploy.sh vi_rounds` (needs `gh` and the Solana CLI; pays from `~/.config/solana/devnet.json` unless `PAYER` is set; `--dry` only fetches the artifact and copies the IDL); it deploys the artifact of the newest green run on the current branch (`BRANCH=main` to pick another) with the committed keypair in `keys/` and copies the IDL and types to `atnx-web/lib/bm/idl/`. Then `npm run rounds:sol -- e2e` checks the deploy (after a fresh program id, `npm run rounds:sol -- init` first, and the printed mint goes in `NEXT_PUBLIC_BM_SOL_USDG`), and a commit of the new IDL plus a push to `main` ships it to the site. Details in [programs/README.md](../programs/README.md).
- The NEAR build is a second Vercel project, `quest-fi/atnx-near` (`atnx-near.vercel.app`), created 2026-11-09: Root Directory `atnx-web`, linked to `main` of `arkanine1000/atnx-near`, so every push builds (a preview for a branch, production for `main`), and the same `vercel.json` cron runs on its production deployment. Production and preview hold the NEAR variables above, `NEXT_PUBLIC_BM_CHAIN` and `BM_BOUNDED_ENABLED`, with the Supabase variables of the shared database. `markets.atnx.app` moves to this project later; until then it stays on `atnx-markets`.
- NEAR contracts are built on GitHub Actions: `.github/workflows/near-build.yml` runs the unit tests, builds both contracts with `cargo near build reproducible-wasm` in the Docker image pinned in each `Cargo.toml`, runs the near-sandbox tests on those files, and uploads `usdg-wasm` and `rounds-wasm` with their SHA-256 (hex, and base58 as NEAR's `code_hash`) and embedded NEP-330 metadata in the job summary. The wasm names its commit: two runs on one commit built byte-identical files, and the builds of two commits differ only where the commit is written. Details, and how to check a deployed contract against the repository, in [near/README.md](../near/README.md#reproducible-builds). Nothing deploys the contracts from CI.
- `next.config.ts` is intentionally empty — all routing/CORS lives in `proxy.ts` and route handlers.
- The fork's extension defaults to `https://markets.atnx.app` (the published upstream extension to www.atnx.app); no rebuild needed to switch between it and a local server.

## Preview deployments

Every push to a branch other than `main` builds a preview; the URL is on the pull request.

- Env: previews read Vercel's Preview environment, which can be scoped to one branch. `feat/vi-rounds` (merged 2026-10-05) had its own set: the Solana variables and the keeper key as on production, plus the Supabase variables, with `BM_ROUNDS_ENABLED=0`; a new branch needs its own. Add a variable in the dashboard (Settings → Environment Variables, Preview, pick the branch) or with `vercel env add NAME preview <branch>` from a checkout linked at the repository root, then redeploy.
- No cron runs on a preview, so nothing ticks there. A preview uses the same database and devnet program as production: a series started on it is real, and its rounds open when production's keeper next runs with rounds enabled.
- Previews sit behind Vercel deployment protection. For a headless check, create the Protection Bypass for Automation secret (Settings → Deployment Protection) and send it as a header; `x-vercel-set-bypass-cookie: true` keeps the browser through later navigations:

```bash
curl -H "x-vercel-protection-bypass: $BYPASS" https://<preview-url>/app
# Playwright: browser.newContext({ extraHTTPHeaders: { 'x-vercel-protection-bypass': BYPASS, 'x-vercel-set-bypass-cookie': 'true' } })
```

# Known rough edges

- The per-source caches and the X, TikTok and post-read daily ledgers are in-memory per instance; the ledgers re-read `vi_samples` every few minutes, so a multi-instance deployment overspends by at most that window.
- Tests cover the VI math (`npm run test:vi`, node:test through tsx) and the market maths (`npm run test:bm`, `cargo test -p vi_rounds --lib`, `cargo test -p bounded_vi --lib`). `npm run eval:capture` is the regression check for the submission pipeline and the review step; the rest is manual.
- Google Trends has no official API. Rate-limit hiccups surface as an unknown reading and the refresh keeps the market's last value.
- The local Rust compiler crashes, so nothing on the Solana side builds on the laptop; a program change means a push and a CI round trip before it can be deployed.
- Rounds: the keeper is the oracle and the only key that opens and settles; the faucet and starting a series are open to anyone on devnet; a rollover lands in round N+2; pausing a series ends it. More in [rounds.md](rounds.md#known-limits).
- Rounds on NEAR: the contracts pay their own storage on testnet; a lost browser key means a fresh account; nothing calls `withdraw_fees` yet, so the fee counters only grow. More in [rounds.md](rounds.md#on-near-testnet).
- Each free source has a hard ceiling (YouTube's 100 searches a day, Apify's plan limit, the X tweet budget); when one runs out the source goes dark until its window resets and the stored reading stands in for up to two days.
