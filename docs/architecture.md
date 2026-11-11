# Architecture at a glance

```
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │  extension   │  │ /app/submit  │  │ Android share│
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
          │ POST /api/captures/propose (cookie) │ POST /share
          ▼                 ▼                  ▼
   ┌───────────────────────────────────────────────────┐    ┌──────────────────────┐
   │  Next.js @ markets.atnx.app  lib/capture.ts       │───▶│ Supabase (Postgres + │
   │  propose: hash → retrieve → model → route → draft │    │ pgvector, Auth,      │
   │  review:  side panel / /app/submit/review/<draft> │    │ Storage, RLS)        │
   │  commit:  attach or create → upload → audit       │    │                      │
   └───────────────┬───────────────────────────────────┘    └──────────────────────┘
                   │                                        └──────────────────────┘
                   │ Vercel AI Gateway: Gemini Flash (vision), Cohere Embed v4 (text),
                   │                    Jev (typed yes/no verdicts: X post filter on, gate in shadow)
                   │
                   │ VI = total attention across sources, one log, × momentum
                   ▼
   Google Trends · Bluesky · Wikipedia · GDELT · YouTube · Hacker News · X · TikTok
   + the captured posts themselves (TikTok, Instagram, X)
   + the market's own YouTube channel and X account, when verified
                   ▲
                   │ /api/markets/refresh every 5 min, /api/markets/refresh-slow hourly (Vercel Cron)
```

How a submission is decided, stage by stage, is in [`atnx-web/README.md`](../atnx-web/README.md).

On markets.atnx.app the VI crons are not scheduled: production ATNX (atnx.app) computes the VI and writes `vi_history`, and this build reads it.

# Markets on chain

Trading is on chain; there is no simulated exchange in this build.

```
   production ATNX ── vi_history every 5 min ──┐
                                               ▼
   /api/bm/house-keeper (Vercel Cron, 5 min) and /fast (every minute) ── lib/bm/house-keeper.ts
      └─ the house market (NEAR testnet, house.atnx.testnet; BM_NEAR_HOUSE_ENABLED=1): push quotes with their commitment, crank, list markets
   /api/bm/keeper (Vercel Cron, 5 min) ── lib/bm/keeper-run.ts
      ├─ bounded markets (EVM testnets, the baseline's): resolve on a bound touch
      └─ rolling rounds (Solana devnet with BM_ROUNDS_ENABLED=1, the baseline's; NEAR testnet with BM_NEAR_ROUNDS_ENABLED=1): create series, ante, open, settle, void, claim the keeper's antes
                                               │
                     registry: bm.markets, bm.series, bm.rounds, bm.keeper_log (Supabase)
                                               │
   browser ── NEAR: signs a NEP-366 delegate, /api/near/relay sends it and pays the gas
           └─ EVM and Solana: wagmi / Solana wallet adapter, signs trades and claims directly
```

Vercel runs the crons on production deployments only. The house keeps its markets, quotes and positions in `house.atnx.testnet`; of the registry tables its keeper writes only `bm.keeper_log`, and its trader accounts are in `bm.near_accounts` and `bm.near_guests` ([house.md](house.md#accounts-and-relaying)). For the rounds and the bounded markets the registry says which on-chain market or series belongs to which ATNX market and where each round stands; the money and the positions live in the contracts and program accounts. Opening a bounded market and starting a series of rounds go through the server instead: the ticket calls a server action and the keeper key sends the transaction and pays for it, with the connected wallet or NEAR account recorded as opener or finder. Mechanics in [house.md](house.md), [rounds.md](rounds.md) and, for the baseline's bounded markets, [docs/bounded-markets.md in atnx-markets](https://github.com/arkanine1000/atnx-markets/blob/main/docs/bounded-markets.md).

# Tech stack

| | |
| --- | --- |
| Framework | Next.js 16.2.2 (App Router, Server Actions, `proxy.ts` — renamed from `middleware.ts` in 16) |
| UI | React 19.2, Tailwind v4, `next-themes`, `recharts` for sparklines |
| Auth + DB | Supabase (Postgres + RLS + Storage; sign-in with an EVM wallet signature through `signInWithWeb3`, no Google or X in the fork), `@supabase/ssr` 0.10 |
| Signals | `google-trends-api`, Wikipedia REST (opensearch + per-article-daily), YouTube Data API, Bluesky, GDELT on BigQuery, twitterapi.io for X, Apify actors for TikTok hashtags and for TikTok and Instagram posts |
| Extension | Manifest V3, in-worker `OffscreenCanvas` cropping, Shadow DOM + Popover API overlay, `chrome.storage.local` for config |
| Models | Vercel AI SDK + AI Gateway: Gemini Flash / Flash-Lite for vision and text, Cohere Embed v4 for embeddings. The extension only ships the cropped image |
| Images | `sharp` for the review step's server-side crop |
| Chains | NEAR testnet: the contracts in `near/` (near-sdk 5.30), `near-api-js` and `borsh` in the app. Solana devnet and EVM testnets, the baseline's (programs and contracts in [atnx-markets](https://github.com/arkanine1000/atnx-markets)): `@coral-xyz/anchor`, `@solana/web3.js`, `@solana/wallet-adapter-react` (Wallet Standard wallets), wagmi + viem. `@tanstack/react-query` for chain reads |
