# Rolling VI rounds

The [house market](house.md) is the current product on NEAR; the rounds below are the earlier design, still deployed at `rounds.atnx.testnet`.

The second iteration of the hackathon build, first on Solana devnet and since 2026-11-08 on NEAR testnet as well. Each subject gets a series of back-to-back rounds on its Virality Index, and every round asks one question: will the VI, averaged over the round's last 30 minutes, end at or above where it stood when the round opened? While round N trades, round N+1 takes presale commits. The engine is Pennock's dynamic pari-mutuel market, so winners are paid out of the losing side's money. The platform's only stake is the keeper's opening ante, 10 USDG on a side nobody has backed, which wins or loses like anyone's money; beyond that it is never the other side of a trade. This replaces the [bounded markets](bounded-markets.md), which stay deployed. Program addresses are in the [README](../README.md); build and deploy steps for the program are in [programs/README.md](../programs/README.md).

The site is moving to NEAR, and the Solana series wind down at the swap. The mechanics below are the same on both chains; [NEAR testnet](#near-testnet) covers what the NEAR contracts, the gasless accounts, the oracle commitment and the keeper's second chain change. The NEAR contracts' methods, build and tests are in [near/README.md](../near/README.md).

## How it works

The program is `programs/vi_rounds`: `src/lib.rs` holds the accounts and instructions, `src/math.rs` the arithmetic. Money is mock USDG with 6 decimals, minted by the program's own `faucet` (up to 10,000 per call, testnet only). On NEAR the same rules run in `near/rounds`, whose `src/math.rs` is a verbatim copy of the Solana file, over an internal ledger ([NEAR testnet](#near-testnet)).

### Why these parameters

Measured on the live index over 14 days and 84 markets: a 24-hour window ends at or above its open 51 % of the time, with a median move of 10 %. Over one hour the median move is 1.3 %, against 0.11 % of print-to-print jitter. The mean of the last 30 minutes of prints differs from the last print by 0.6 %.

So the target is the VI at the open, which makes a daily round close to an even question; rounds last 24 hours; the close is a 30-minute average, so a single print cannot decide a round; and a 1-hour series exists only as a fast demo, labelled as such wherever it appears.

### Series

One running series per subject and speed at a time. The ATNX market's uuid goes into a 32-byte reference that seeds the series account (bytes 0–15 the uuid, byte 16 set to 1 for the fast series, bytes 17–23 zero, bytes 24–31 a nonce: the start time in unix seconds, big-endian, so a market can run more than one series over time). The reference is stored in `bm.series.reference` and every keeper path reads it back; it is never recomputed from the market id. The wallet that starts a series is its finder and earns a share of its fees.

A series copies the fee terms from the program config when it is created, so a later config change does not touch a running series. It holds the round length, the settlement window, the ante, a paused flag, the index of the live round and of the presale round, and two fee counters. Each series has one USDG vault, owned by the series account. Starting a series also creates round 1 in presale.

| | Daily | Fast demo |
|---|---|---|
| Round length | 24 h | 1 h |
| Settlement window | 30 min | 15 min |
| First presale | 1 h | 10 min |
| Ante | 10 USDG | 10 USDG |

### Presale

Anyone commits USDG to UP or DOWN in the series' presale round. Commits are locked until the round settles or is voided. There is no cap and no pricing during presale: the pots U and D simply add up (net of the fee). The ticket shows the price a commit would clear at if the round opened now.

### Open

When a presale round's time comes (the series start plus the first presale for round 1, the previous round's close after that) and no round is live, the keeper opens it at the subject's current VI, which becomes the target. Both pots must hold money; if one is empty, the keeper first commits the ante on that side. Opening sets

```
M1 = U,  M2 = D,  N1 = N2 = T = U + D
```

where M is the money and N the shares on each side (1 = UP, 2 = DOWN). A presale commit of u on UP holds u·T/U shares, so every UP commit clears at the same price, U/T, and every DOWN commit at D/T. The live price starts exactly there. Opening also fixes `close_at = now + round length` and `trade_until = close_at − settlement window`, and creates the next round in presale.

### Live

Live trading is buy-only, by spend. Buying UP with a net spend m (after the fee) gives

```
n = N2 · ln(1 + m / M1),   then M1 += m, N1 += n
```

and the same with the sides swapped for DOWN. This is price function I: the price of an UP share, M1/N2, equals the payoff per DOWN share. The implied chance of UP is

```
MPr(UP) = M1·N1 / (M1·N1 + M2·N2)
```

A single buy may not exceed 1,000 times the money already on its side. Every buy carries a minimum share count; the ticket sets it 1 % below the quote. There is no selling: the exit before settlement is buying the other side. Trading stops at `trade_until`, when the settlement window starts, so nobody can buy the side the averaging is already showing.

The only transcendental function on chain is `ln`, in 1e18 fixed point with every step rounded down, so rounding always favours the pool. `atnx-web/lib/bm/dpm.ts` mirrors `math.rs` in BigInt and agrees with it bit for bit.

### Settle

At least five minutes after the close, the keeper takes the plain mean of the subject's `vi_history` prints recorded in `[close − window, close]`, rounded to two decimals, and posts it. The program decides the winner: UP if the average is at or above the target, so a tie goes UP. A winning position is paid

```
payout = net stake + shares · M_lose / N_win
```

and a losing one nothing. This is variant I: winning stakes are refunded and only the losing side's money is redistributed, so a correct bet never gets back less than its net stake. If no print has landed in the window 30 minutes after the close, the keeper voids the round and everyone gets their net stakes back.

`settle` also takes a 32-byte `commitment`, reserved for a hash of the oracle's inputs. Solana settles post zeros. On NEAR the keeper posts the SHA-256 of the inputs it settled on and keeps the inputs in the registry ([Oracle commitment](#oracle-commitment)).

### Claim and rollover

`claim` pays a settled position (or refunds a void one) and closes the position account, returning its rent. `claim_rollover` commits the payout to the winning side of the series' current presale round, without tokens leaving the vault. It takes the 1 % fee on the whole rolled amount, the refunded stake included, so rolling a payout costs 1 % of it where claiming costs nothing. It is refused on a paused series and has nothing to roll for a losing position. Round N+1 opens in the same keeper tick that settles round N, so by the time anyone can claim round N, the presale round is N+2: a rollover lands in N+2.

### Fees

1 % on every commit, buy and rollover, rounded up; the finder gets 20 % of it (rounded down) and the platform the rest. A presale commit of 50 USDG puts 49.50 in the pot and adds 0.10 to the finder's counter and 0.40 to the platform's. Both counters live on the series, and `withdraw_fees` pays the finder's counter to the finder and the platform's to the treasury. Claims and refunds carry no fee. A void round refunds net stakes only: the fee paid on the way in stays in the series' counters.

### Ante

The ante is an ordinary presale commit from the keeper wallet's own mock USDG. When the wallet runs low the keeper mints from the faucet, topping it up to 10,000. It is not paid out of fee income or a treasury balance: on devnet the keeper key is also the treasury, but the fee counters sit in the series vault and the ante never touches them. It pays the 1 % fee like any commit, so an ante of 10 USDG puts 9.90 in the pot. It wins or loses like anyone else's money, which makes it the one piece of house money at risk: on a round nobody else joins, the keeper is the lone finder's counterparty for that 10 USDG, and no more. Once the round is settled or void the keeper claims its own position (step 6 of the [keeper](#keeper)), so a winning or refunded ante, and the position's rent, come back to the keeper wallet. The registry records which side got the ante and how much. If nobody commits at all, the keeper antes both sides.

### Worked example

Presale pots, net of the fee: U = 600, D = 400 USDG, so T = 1,000. The round opens with M1 = 600, M2 = 400, N1 = N2 = 1,000; an UP share costs 0.60.

| Step | Numbers |
|---|---|
| Live buy of UP, net 100 | n = 1,000 · ln(1 + 100/600) = 154.150679 shares |
| Pools after | M1 = 700, N1 = 1,154.150679, M2 = 400, N2 = 1,000; MPr(UP) = 0.669 |
| UP wins: a 60 USDG presale commit | 60 · 1,000/600 = 100 shares; paid 60 + 100 · 400/1,154.150679 = 94.657519 |
| UP wins: the live buyer | 100 + 154.150679 · 400/1,154.150679 = 153.424802 |
| UP wins: every UP holder together | 600 + 100 + 400 = 1,100 = M1 + M2, less rounding dust |

These numbers are a unit test in `math.rs` (`pennock_example`). The devnet end-to-end run replays the example with the fee on (commits of 600 and 400, a buy that nets exactly 100) and checks each on-chain result against the TypeScript quote.

Source: D. M. Pennock, "A Dynamic Pari-Mutuel Market for Hedging, Wagering, and Information Aggregation", EC 2004.

## What the trader sees

One rule runs through the ticket and the cards: plain words for someone who has never traded, no tabs or jargon. The ticket shows one round, not a switch between rounds; the cards show a status pill and one line of verdict. "Presale" is the word this document and the code use for a round waiting to open; the ticket and the cards say "Opens soon", "Opens in 42m" or "Starts in 42m" instead.

### The ticket

The ticket is `atnx-web/components/rounds/RoundTicket.tsx`, in the market page's side column on desktop and behind the UP / DOWN dock on phones. It reads like a trade ticket: numbers, at most one sentence, a button.

It shows one round at a time: the live round whenever the series has one, otherwise the round waiting to open, which is round 1 before it opens and the short gap between a settle and the next open (usually the same keeper tick). While a round is live, the ticket offers nothing on the next one. A wallet that already holds money there, from a rollover or an earlier commit, sees one muted line under the pane: "You also have X USDG on UP in round N+1, which opens when this one settles." A rollover from the claim list still commits to the series' next round on chain (round N+2 by the time round N can be claimed; see [Claim and rollover](#claim-and-rollover)).

Every state ends in the same footer: a collapsed "How rounds work" disclosure (five bullets: target at the open, the round's length and the trading stop, the averaged close, what winners get, claim or roll; a devnet SOL note; a "Show me" link that opens the How ATNX works modal at its "UP or DOWN" step, which ends "Buy while the round runs. Before a market's first round opens, early commits on a side all pay the same price.") with "Devnet · mock USDG, no value." beside it. The states, in order:

1. No program configured: "Rounds are not live on Solana devnet yet."
2. No series on the market: the question ("Will {name}'s index be higher in 24 hours?"), a "Start rounds" button and "You earn a share of every fee in this series." It is blocked while the market is still being scored, has no score, or its VI is over 30 minutes old. Starting needs a connected Solana wallet, which becomes the finder; the keeper pays for the accounts. Then "Starting rounds on chain…" until the registry row appears.
3. A series, no wallet: the question, one status line for the round the ticket will show with a countdown chip, and a connect button. With a live round the line is "Round N · target T" with the live pane's chip ("Xh Ym left" until trading stops, then "Closes in …", then "Settling") and the button reads "Connect Solana wallet to trade"; with only a round waiting to open it is "Round N · opens soon" with an "Opens in …" or "Opening…" chip and the button reads "Connect Solana wallet to commit".
4. Wallet connected, no USDG: "You need test USDG to take a side." and one button that creates the USDG account and mints 1,000 test USDG.
5. The ticket proper: a "Round N · Live" or "Round N · Opens soon" label over one pane.
   - Live: "Target T · now V" with a time-left chip, UP and DOWN with their chance ("61% UP"), the spend with quick amounts and Max, "If UP wins you get X USDG" with the profit, and details (shares, average price, fee, finder's share, both pools and the chance of UP before and after). The button reads "Buy UP for 25 USDG".
   - Waiting to open: "Pots X UP · Y DOWN" with an "Opens in …" or "Opening…" chip, UP and DOWN with their price per share ("no commits yet" while both pots are empty), the amount, and one outcome line: "At today's pots your 25 USDG buys ~N shares at ~P¢" once the other side has money, else "Price set when the round opens; nobody pays more for being early." Details hold what the commit pays if its side wins, the fee, the finder's share and the keeper's ante. The button reads "Commit 25 USDG to UP".

   Under either pane, a wallet with a position in that round sees what it holds on each side and what that pays if the side wins ("You have X on UP", and beside it "pays Y if UP wins").
6. Averaging: after `trade_until` the live pane shows "Averaging the last 30 minutes…" with a "Closes in …" chip, and no buying.
7. Settling: "Settling…" after the close, until the keeper settles; the page re-reads itself every 8 seconds. Once the round settles, the round waiting to open takes its place until the keeper opens it.
8. Claims, one row for each settled or void round where the wallet still has a position ("Round N · UP won · 820 vs 812", with "· your side lost" for a losing position; "Round N · void · stake refunded"): "Claim X USDG", "Roll X into round N+2 (UP)" for a winner, or "Close position (returns rent)" for a loser.

There is no sell button: the program has no sell, and the exit before settlement is buying the other side. See [Open design questions](#open-design-questions).

### Cards and the list

Listing cards (`atnx-web/components/MarketCard.tsx`) show a market's current round with two components from `atnx-web/components/rounds/RoundBadge.tsx`, fed from the registry only (no chain reads in lists; `getRoundBadges` in `atnx-web/lib/bm/round-badges.ts`, one round per market, a round in flight before one waiting to open and the daily series before the fast one):

- `RoundPill`, the status pill on the image's top right, opposite the rank: "LIVE · 3h 33m" (time to the close) in cyan, "LIVE · closing" once trading has stopped, then "SETTLING", "OPENS IN 42m" and "OPENING" in grey. On a list row it sits at the right of the name from `sm` up and above the score on phones.
- `RoundVerdict`, the line under the name: "UP is winning" or "DOWN is winning" (the index now against the target; at or above is UP), "Closing now" in the averaging window, "Settling", or "Starts in 42m" for a round waiting to open.

The round number and the target are only in the hover text ("Round N: UP wins if the index ends at or above T. VI now V."). A market with no series shows neither, and once rounds are deployed the card draws no bounds rail for a bounded market.

The markets list (`/app`) has two tabs with counts over the whole list under the current search and category filter: Live, the markets whose round is in state `live`, and Up next, everything else (a round opening, settling or waiting to open, or no series yet). It opens on Live when anything is live. A small sort control beside the tabs orders by Virality (the default), Closing soonest (live rounds by their close, the rest after them by virality) or Newest. `?tab=live|next` and `?sort=closing|newest` keep the choice in the URL. Details in [web-app.md](web-app.md).

### Elsewhere

- Market header: `RoundChip`, "Round 12 · UP 61% · target 143 · 3h 12m" (time to the close, then "settling"), or "Round N · opens in 42m" (then "opening") before a round opens. A market with no series shows no chip.
- Chart: the live round's target as a line.
- Activity tab: settled rounds with their transactions (`RoundHistory`), or "No rounds yet on this market."
- `/app/portfolio`: the wallet's round positions across every series (one row per position, named by market: round, side, net stake, what it is now, one action; open rounds above settled ones), then the bounded-market positions on the EVM testnets.
- Settings: a Solana wallet block with the faucet.

Since 2026-10-06, once the rounds program is deployed (`isRoundsDeployed()`), a market page shows rounds only, even where a bounded market from the first iteration is still open on the subject: no bounded ticket, price chip, bound lines on the chart, trade log or Bounds and Opened-at-VI tiles, and the list builds no bounds badges. See [bounded-markets.md](bounded-markets.md) for what that leaves the open bounded markets.

## Keeper

The rounds steps are step 4 of the existing keeper tick (`atnx-web/lib/bm/keeper-run.ts`, the Vercel cron every five minutes, which runs on production deployments only). The steps themselves live in `atnx-web/lib/bm/rounds-core.ts`, and each chain plugs in through an adapter: `rounds.ts` for Solana, which runs only when `BM_ROUNDS_ENABLED=1`, and `rounds-near.ts` for NEAR, which runs only when `BM_NEAR_ROUNDS_ENABLED=1` ([The keeper on both chains](#the-keeper-on-both-chains)). A chain's step stops starting new work 45 seconds into the tick; the next tick picks up where it left off. Within a tick, for each chain:

1. Reconcile rounds a previous run left `opening` or `settling` (older than two minutes) from the chain.
2. Pending series (a start that crashed half way): create on chain, or adopt the series if it is already there.
3. Live rounds at least `BM_SETTLE_DELAY_SECS` (five minutes) past their close: average the window's prints and settle, or void when no print has arrived 30 minutes after the close.
4. Presale rounds whose time has come, on a series with no live round: check the VI is fresh (otherwise `open-deferred`), ante an empty side, open at the current VI, insert the next presale with its opening time set to the new round's close.
5. Paused series: pause on chain if needed and void the presale round (refunds). A live round still settles in step 3; once nothing is left to settle, the series reads `ended`.
6. The keeper's antes: settled or void rounds the keeper anted on, finished in the last 7 days (by the registry row's `updated_at`, at most 50, from `listRoundsToClaim` in `rounds-registry.ts`). Where the keeper's position account still exists, claim it (on Solana `sendClaim` in `sol.ts`): the payout or refund goes to the keeper's USDG account, created if missing, and the position's rent comes back; a losing ante pays nothing but its account still closes. On NEAR the claim credits the keeper's balance inside the contract and deletes the position. A position already claimed is gone and is skipped. Each claim logs `claimed-ante` and counts in `claimed` on the tick's report. The first live run, on 2026-10-06, recovered 39.6 USDG and the rent from the two fast test rounds.

Settling N frees the live slot that opening N+1 needs, and opening N+1 frees the presale slot for N+2, which is why the order matters. Round N+1 can open only after N settles, so it opens 5 to 10 minutes after N closes: the settle delay plus the wait for the next tick.

The program checks `close_at` and `trade_until` against the chain clock, which ran about six seconds behind the wall clock on devnet during the lifecycle test. The settle delay keeps the settle well clear of that; a settle sent right at the close would fail with `TooEarly`.

On Solana the keeper signs with a plain keypair wallet (`keypairWallet` in `atnx-web/lib/bm/sol.ts`), not Anchor's `Wallet` class: that class exists only in Anchor's CommonJS build, and the bundle Turbopack builds has no such export.

Registry states (`atnx-web/supabase/bm/002_rounds.sql`):

| Table | States |
|---|---|
| `bm.series` | `pending` → `active` → `paused` → `ended`, or `failed` |
| `bm.rounds` | `presale` → `opening` → `live` → `settling` → `settled` or `void` (`failed` is allowed by the schema) |

Both chains share these tables; `bm.series.chain` tells their rows apart ([The registry's chain column](#the-registrys-chain-column)). The registry is not the ledger: commits, shares and payouts live in program accounts on Solana and in the contract's state on NEAR. `opening` and `settling` mark a transaction in flight, and every move is a compare-and-set update. Unique partial indexes allow one running series per market, chain and speed, one round in flight or live per series, and one presale per series. When the registry and the chain disagree, the chain wins: reconciliation moves the row to what the chain shows, or, when the transaction never landed, puts it back so the same tick retries.

Dry mode reads everything, logs `would-settle`, `would-open`, `would-ante`, `would-void`, `would-claim-ante` and the like with their numbers, and writes and sends nothing.

## NEAR testnet

The same rounds run on NEAR testnet in two contracts under `near/`, and the site is moving there: `markets.atnx.app` will move to the NEAR deployment, and the Solana series wind down at the swap. Until then the NEAR build runs as its own Vercel project ([Operations](#operations)). Everything in [How it works](#how-it-works) holds unchanged: the presale, the open at the VI, Pennock's market with price function I, the 30-minute averaged settle, variant I payouts, the rollover into N+2, the 1 % fee with 20 % of it to the finder, and the keeper's 10 USDG ante. `near/SPEC.md` lists where the port differs from `programs/vi_rounds/src/lib.rs` and why; the methods, events and error messages are in [near/README.md](../near/README.md).

### Contracts and accounts

| Account | Role |
|---|---|
| `usdg.atnx.testnet` | USDG, "ATNX test USD": a NEP-141 test token with 6 decimals, minted only by the rounds contract. A transfer registers an unregistered receiver at the token's expense, so nobody calls `storage_deposit` first |
| `rounds.atnx.testnet` | The rounds contract: series, rounds, positions, fee counters and every account's USDG balance |
| `keeper.atnx.testnet` | The keeper: the only account that creates series, opens, settles and voids rounds. It antes from its own balance in the contract, signs its own transactions and pays their gas |
| `atnx.testnet` | Owner of the rounds contract's config, the treasury (the platform's share of the fees is credited to its balance), and the parent of every user account, `<handle>.atnx.testnet` |

The rounds config on chain, read on 2026-11-09: fee 100 bps, finder share 2,000 bps of the fee, 8 series created. A series copies the fee terms when it is created, as on Solana.

### The internal ledger, and why

Each account has a USDG balance inside `rounds`. It is funded once, with `faucet` (the contract mints test USDG to itself and credits the caller, up to 10,000 per call) or with `ft_transfer_call` on the token with `rounds` as the receiver. From then on `commit`, `buy`, `claim`, `claim_rollover` and `withdraw_fees` move balances inside the contract and attach no deposit. `withdraw` sends USDG back to the caller's token account. There is no vault per series: the token balance of `rounds` backs every internal balance, pot and fee counter.

The reason is gas. A call that attaches no deposit can be signed by a function-call access key, and such a call can be wrapped in a NEP-366 delegate action that another account sends and pays for. A transfer on the token needs 1 yoctoNEAR attached (`ft_transfer`, `ft_transfer_call`), which a function-call key cannot attach. Keeping the money inside the contract is what lets a user trade from an account that holds no NEAR, behind an ordinary sign-in.

Only `faucet` and `withdraw` call another contract. `faucet` credits the caller in its callback, and only if the mint succeeded; `withdraw` debits first and credits the amount back in its callback if the transfer failed. No round state waits on a promise.

### Accounts behind the sign-in

The NEAR build has no wallet to connect. A user signs in to ATNX with Google or X (Supabase), and the first time the ticket needs an account, or from Settings, the browser makes an Ed25519 key with WebCrypto, non-extractable, stores it in IndexedDB under the ATNX user id (`atnx-web/lib/near/keystore.ts`), and POSTs the public key to `/api/near/account`. Page script can sign with that key but cannot read its bytes.

The route (`atnx-web/lib/near/routes.ts`) picks the account name, `<handle>.atnx.testnet`: the X username, else the ATNX profile handle, cleaned to NEAR's rules (lowercase letters and digits, single `-` or `_` between them), never a reserved name such as `admin`, `keeper` or `treasury`; with a four-character suffix if the name is taken, else `u` and seven random characters. The account id is public on chain, so it is never made from the email or the real name. The parent account then signs one transaction, `CreateAccount` plus `AddKey`, and waits for finality. The new account holds zero NEAR (a zero-balance account, under 770 bytes) and one key, the browser's, added as a function-call key for `rounds.atnx.testnet` and six methods only: `commit`, `buy`, `claim`, `claim_rollover`, `faucet` and `withdraw`, with an allowance of 0.25 NEAR. Each account costs the parent about 0.007 NEAR.

The account is recorded in `bm.near_accounts` (`atnx-web/supabase/bm/004_near_accounts.sql`): the user, the account id, the public key, the state (`creating` while the transaction is in flight, then `active`), the creation transaction and any previous account ids. A signed-in user can read only their own row; only the service role writes.

There is no custody key. The account has no full-access key, ATNX holds no key that can move its balance, and the parent cannot add one. Clearing the site's data, or signing in from another browser, leaves the user without the key. The ticket then offers a new account ("Start a new account here"); the route makes one only when asked (`fresh`), at most five accounts per user in all, and keeps the old ids in `previous_account_ids`. The old account stays on chain with whatever it holds, and nobody can move it.

### Guest accounts

The NEAR build can be tried with no sign-in: "Try as a guest" sits beside Google and X in the sign-in modal and under the ticket's sign-in button, with the line "Your test account lives in this browser." The browser makes a key the same way, stores it in IndexedDB under `guest` with the account id once it exists, and POSTs the public key to `/api/near/guest` with no session (`atnx-web/lib/near/guest.ts`, `handleGuestCreate` in `atnx-web/lib/near/routes.ts`). The route makes `guest-<8 random lowercase letters or digits>.atnx.testnet` with the user accounts' own code: zero NEAR, and the browser's key as its only key, a function-call key for `rounds.atnx.testnet` and the same six methods. A second POST with the same key returns the same account.

A guest is not a Supabase user. The Supabase project is shared with atnx.app, so an anonymous sign-in would give every scripted guest the `authenticated` role there. A guest is a row in `bm.near_guests` (`atnx-web/supabase/bm/005_near_guests.sql`): the account, its key, the salted hash of the IP that asked for it, its state (`creating`, `active`, or `failed`, which still counts) and the relay lock. Only the service role can read or write it. User handles never take the `guest` name: `guest` and `guest-…` are reserved.

What guests cost is capped in the database, in one call per new guest (`bm.near_guest_reserve`, under a transaction-level advisory lock so concurrent requests cannot both slip under it): at most 3 guests per client IP per hour and 200 overall in any 24 hours. The IP is read from `x-forwarded-for` (its first entry; Vercel overwrites the header), else `x-real-ip`; an IPv6 address counts by its /64, and a request with no readable address falls in one shared bucket. What is stored is HMAC-SHA256 of that bucket under a server-only salt (`BM_NEAR_GUEST_IP_SALT`, or one derived from the parent's key), never the IP, and each reservation clears the hashes older than a day. No guest is made while the relayer or the parent is under 0.05 NEAR.

A guest's calls go to `/api/near/relay` with `guest: true` and no cookie. That branch never reads the session: the delegate's sender must be an active row in `bm.near_guests`, and the delegate gets every check below against that row's account and key, the guest's own relay lock, and the rounds checks. A guest gets 60 relays an hour, and the faucet, `commit`, `buy`, `claim` and `claim_rollover` only: not `withdraw`, which would make `usdg.atnx.testnet` pay to register every guest. The branches never cross: a guest's delegate on the user branch is `sender_mismatch` (or `signed_out`), and a user's on the guest branch is `not_a_guest`.

A guest can do everything a signed-in trader can on the ticket, the portfolio and Settings except "Start rounds", whose finder earns fees: a guest sees "Sign in to start rounds". The header shows a "Guest" pill with the account and a Sign in item. Settings, which a guest can open on the NEAR build, shows the guest account, the faucet, Fund from any chain and what a lost key means. A guest who signs in gets their own account as before; the guest account stays in the browser, separate, and is used again after signing out. Nothing merges them.

### The relayer

Every user action is a NEP-366 delegate action that the browser signs (`atnx-web/lib/near/client.ts`) and POSTs to `/api/near/relay`. The relayer (`atnx-web/lib/near/relay.ts`, ported from the testnet prototype in `near/relayer-proto`) wraps it in a transaction that `BM_NEAR_RELAYER_ACCOUNT` signs and pays for. The route checks, in this order, and refuses with a reason code before anything is sent:

1. The user is signed in and has an active account.
2. The delegate: it re-encodes to the same bytes; its sender is the user's account, a direct sub-account of the parent, and not the relayer; it is signed by the key on record for that account and the signature verifies; its receiver is the rounds contract; it holds one action, a function call to one of the six user methods, with no deposit, at most 100 TGas and at most 1,024 bytes of JSON arguments.
3. The user's relay lock (`bm.near_relay_acquire`): one delegate per user in flight across serverless instances, because delegate nonces must land in order; the lock expires after 60 seconds. At most 200 relays per user per hour.
4. The chain: the delegate has not expired and is valid for at most 600 more blocks, its nonce is above the key's, and the key is a function-call key scoped to the rounds contract and that method. A full-access key is refused.
5. The contract (`atnx-web/lib/near/rounds-check.ts`): the round named is the series' presale or live round, the series is not paused, the balance covers the amount, a buy's quote meets its `min_shares`, a claim has a position behind it. The refusal carries the contract's own error text. A faucet call is refused for an account already holding 10,000 USDG or more.

The relayer also refuses to send when its own spendable balance is under 0.05 NEAR. The client attaches 30 TGas to plain calls and 50 TGas to `faucet` and `withdraw`; unused gas goes back to the relayer. A delegate that passes every check and still fails on chain (the chain moved between the check and the send) costs the relayer its gas, and the route returns the contract's panic message.

### Commits and buys name their round

`commit` and `buy`, and the `quote_buy` view, take the `round_index` they act on and fail unless it is still the series' presale round (a commit) or live round (a buy): "round is not the series' presale round", "round is not the series' live round". A commit sent just as the keeper opens round N therefore fails instead of landing in round N+1, which is what Solana gets from the client naming the round's account. The ticket sends the round it shows, and the relayer's contract check refuses a stale one before paying.

### Oracle commitment

On NEAR, `settle` carries a commitment to what the keeper settled on (`atnx-web/lib/bm/commitment.ts`). When a live round is due, the keeper builds its settle inputs:

| Field | Value |
|---|---|
| `version` | 1 |
| `market_id` | the ATNX market's uuid, lowercase |
| `series_reference` | the series' 64-hex reference |
| `round_index` | the round |
| `window_start`, `window_end` | the round's `close_at` on chain, less the settlement window, and `close_at` |
| `prints` | the `vi_history` prints recorded in `[window_start, window_end]`, as `{ at, vi }`, sorted by time, then by value |
| `average_e2` | the posted `settle_e2`: 100 × the mean of those prints in that order, rounded to two decimals |

Timestamps are UTC with six fractional digits and a `Z`, as Postgres records them. The commitment is the SHA-256 of the inputs' canonical JSON (keys sorted, no whitespace, numbers as `JSON.stringify` writes them, which is RFC 8785's number form), as 64 lowercase hex characters. The keeper writes the inputs to `bm.rounds.settle_inputs` and the hash to `bm.rounds.settle_commitment` with the move to `settling`, before it sends the settle, so a settle that lands while the run dies still has its inputs on record. The contract stores the commitment on the round and emits it in `round_settled`.

`npm run rounds:verify -- <series-uuid-or-reference> <round>` checks a settled NEAR round without writing or sending anything. It re-canonicalises the stored inputs (jsonb reorders keys), recomputes the hash and compares it with the round's `commitment` on chain, recomputes the average from the prints and compares it with `settle_e2`, checks the window against the round's close and the series' settlement window and the market, reference and round against what the registry (or, with `--onchain`, the chain) says, and, unless `--no-history` is given, reads `vi_history` for the window again and says whether it still holds the same prints. `--onchain <near-series-id> <round> --inputs <file.json>` checks a saved inputs file against the chain without the registry; `npm run rounds:near -- e2e --out <dir>` writes one per settle. The exit code is 0 when everything matches, 1 on a mismatch, 2 when the round cannot be checked (not NEAR, not settled, no inputs).

Anyone can check a settled NEAR round without keys or an env file. `GET /api/near/rounds/settled` lists the latest settled rounds from the registry (the contract's series id, the round, the market, target, settle average, winner and settle transaction). `GET /api/near/rounds/verify?series=<id>&round=<n>` returns the registry's canonical settle inputs and commitment, the round's commitment read live from `rounds.atnx.testnet` over public RPC, the hash recomputed on the server, and `match` (`atnx-web/lib/near/verify.ts`). `npm run rounds:verify:public -- [<series> <round>] [--site <url>]` runs on any machine with no env file: it takes the inputs from the site (by default `https://atnx-near.vercel.app`, and the latest settled round when none is named), reads the round and its series straight from `https://test.rpc.fastnear.com`, hashes the inputs itself with `lib/bm/commitment.ts`, checks their reference, round, window and average against the chain, and prints OK or MISMATCH. It never uses the site's own hash.

The commitment makes a settlement checkable after the fact; it does not stop the keeper from choosing its prints. Solana settles keep the zero commitment, and the Solana keeper averages the prints in the order the database returns them.

### The keeper on both chains

Step 4 of the tick runs each chain's rounds step side by side, each on its own registry rows, so one chain's trouble or slowness never holds up the other; both stop starting new work 45 seconds into the tick. Three variables decide what a deployment's tick does:

| Variable | Effect |
|---|---|
| `BM_ROUNDS_ENABLED=1` | The Solana devnet rounds step |
| `BM_NEAR_ROUNDS_ENABLED=1` | The NEAR testnet rounds step, signed as `BM_NEAR_KEEPER_ACCOUNT` with `BM_NEAR_KEEPER_SECRET` |
| `BM_BOUNDED_ENABLED=0` | Skips steps 1–3, the bounded markets, so a second deployment sharing the registry leaves them to the deployment that runs them |

On NEAR the keeper finds a series by its reference (`get_series_by_reference`) and calls it by the contract's numeric id, which the registry keeps in `bm.series.onchain_series_id` and which is checked against the chain on every read. Rounds and positions have no addresses. The ante comes out of the keeper's balance inside the contract, which the keeper tops up from the faucet to 10,000 USDG whenever it is below what the antes need; a claimed ante goes back into that balance. The keeper's NEAR client refuses to sign when `NEXT_PUBLIC_BM_NEAR_NETWORK` is not `testnet`. NEAR's counts also come back under `near` in the tick's report, and its `bm.keeper_log` entries carry `"chain": "near:testnet"` in `detail`.

### The registry's chain column

Both chains share `bm.series` and `bm.rounds`; `bm.series.chain` is `solana:devnet` or `near:testnet`. A NEAR row holds the contract account in `program_id`, the finder's NEAR account id in `finder_wallet`, the contract's series id in `onchain_series_id` and null in `series_pubkey`; its rounds leave `round_pubkey` null, and its transaction columns hold NEAR transaction hashes. `atnx-web/supabase/bm/003_near.sql` adds `onchain_series_id`, `settle_inputs` and `settle_commitment`, checks that only constrain rows whose chain starts with `near:` (testnet only, NEAR account ids, no `series_pubkey`, a positive series id), and a unique index that allows one registry row per on-chain NEAR series. It is additive; the Solana rows pass its checks as they are. 002's unique index allows one running series per market, chain and speed, so a market can run a Solana series and a NEAR series at once.

Every list the keeper works from takes the chain, and rounds are filtered through an inner join on their series inside the query, so one chain's rows never crowd the other's out of a limit. The site reads one chain: with `NEXT_PUBLIC_BM_CHAIN=near` the market page, the list badges, the portfolio and `/api/bm/rounds` read the `near:testnet` rows, and with anything else the `solana:devnet` rows, as before NEAR existed. A series of the other chain reads as no series (`/api/bm/rounds?series=` returns 404 for it).

### What the trader sees on NEAR

The NEAR ticket (`atnx-web/components/rounds/NearRoundTicket.tsx`) has the Solana ticket's states, panes and copy ([The ticket](#the-ticket)), with the wallet replaced by the ATNX sign-in: "Sign in to trade" ("Sign in to commit" before a round opens), then "Setting up your account…" while the account is created, then "Get 1,000 test USDG" or the ticket itself. The footer's note reads "Testnet · test USDG, no value." where Solana's reads "Devnet · mock USDG, no value." "Start rounds" needs an active account, which becomes the finder: the server takes it from the session and `bm.near_accounts`, never from the browser, and the keeper creates the series on chain. An account whose key is in another browser is offered a new one in plain words. Signed out, "Try as a guest" sits under the sign-in button ([Guest accounts](#guest-accounts)). The portfolio lists the account's positions (`positions_of`); Settings shows the account with its NearBlocks link, the test USDG balance, the faucet and what a lost browser key means. A fast series can be started from the site only under the same rule as on Solana (`next dev`, or `BM_FAST_FROM_CLIENT=1`).

## Built / not built

### Solana devnet, as of 2026-10-06


- [x] Program `vi_rounds` (Anchor 0.31.1): series, presale, open, buy, settle, void, claim, rollover, fees, faucet
- [x] Math unit tests on the host (`cargo test -p vi_rounds --lib`): `ln` against a reference table and a 2,000-point sweep, monotonicity, the worked example, presale clearing, fee split, a randomised payout-conservation run, the ratio cap
- [x] CI: the host tests, then an Anchor build of both programs (`.github/workflows/solana-build.yml`)
- [x] Deployed on Solana devnet, 2026-10-05: program, config and mint in the [README](../README.md); authority, keeper and treasury are the devnet payer `5a5yfYQBX3QYqWZ55agFTHQoxg5Lc4TvT8g3roMfqa2S`
- [x] End-to-end on devnet (`npm run rounds:sol -- e2e`, 2026-10-05): two 30-second rounds with presale, buys, settle, claim, rollover, ante, pause and void, and fee withdrawals; on-chain shares equal the TypeScript quote exactly; a buy costs about 34k compute units; the vault ended with zero dust
- [x] Registry schema `002_rounds.sql`, applied
- [x] Keeper step, with reconciliation and dry mode; `rounds:start` and `rounds:tick`
- [x] Keeper lifecycle on devnet against the live registry (2026-10-05), on a throwaway fast series with 15-minute rounds: start, ante on both sides, open round 1, settle on two prints (average 735.38 against a target of 735.28, UP), ante, open round 2 with round 3 in presale, pause through the registry (round 3's presale voided, series paused on chain), round 2 settled later and the series ended
- [x] Web: ticket, header chip, card pill and verdict, round history, portfolio, Solana wallet (Wallet Standard: Phantom, Solflare, Backpack), Settings faucet
- [x] Vercel env: production and the `feat/vi-rounds` preview (see Operations)
- [x] Preview deployment of `feat/vi-rounds`: every page rendered with the preview env. Three daily series started from Phantom on it: Kanye West, with three presale commits of 25 USDG (finder fees 0.15); Bitcoin, with one commit of 50 USDG (49.50 net; fees 0.10 to the finder, 0.40 to the platform); and Meta. The preview shares production's registry and program but does not run the keeper, so all three waited in presale for production's cron.
- [x] Merged to `main` (PR #12, 2026-10-05): production runs the rounds step with `BM_ROUNDS_ENABLED=1`
- [x] Rounds opened by production's keeper: four daily series started from the user's wallet (Kanye West, Bitcoin and Meta on 2026-10-05, SpaceX on 2026-10-06 at 16:39 UTC), round 1 live on each with round 2 waiting to open; 168 clean ticks overnight
- [x] Market pages and the list show rounds only once the program is deployed (PR #16, 2026-10-06; see [What the trader sees](#what-the-trader-sees))
- [x] The keeper claims its antes on settled and void rounds (PR #17, 2026-10-06; step 6 of the [keeper](#keeper)); the first live run recovered 39.6 USDG and the rent from the two fast test rounds
- [x] The ticket shows one round at a time, with no switch between rounds; the How ATNX works step reworded to match (PR #18, 2026-10-06)
- [x] Markets list: Live and Up next tabs with counts, and a sort control (Virality, Closing soonest, Newest), both in the URL (PR #19, 2026-10-06)
- [x] Market cards: a status pill on the image and a verdict line under the name (PR #20, 2026-10-06)
- [ ] Buy, claim and rollover from the ticket with a real wallet: still unexercised (the e2e covers them with script keypairs; Phantom has made presale commits only). Claim and rollover wait on the first production settlements, due 2026-10-06 between 21:25 and 21:50 UTC
- [ ] A round settled by production's keeper, checked against `vi_history` by hand (same settlements)
- [ ] Selling a position before settlement: the program has none and the exit is buying the other side; whether to add a hedge button is an [open design question](#open-design-questions)
- [ ] EVM port
- [ ] Oracle commitments (the `commitment` field on `settle` is the hook; zeros on Solana, built on NEAR below)
- [ ] Solana trade log on the market page
- [ ] Rollover crank (rollovers are by hand, one claim at a time)
- [ ] Extension captions for rounds
- [ ] Admin tab for rounds (`bm.series`, `bm.rounds` and `bm.keeper_log` are the place to look)

### NEAR testnet, as of 2026-11-09


- [x] Contracts `usdg` (NEP-141, NEP-145 and NEP-148 through near-contract-standards) and `rounds` (near-sdk 5.30), ported from `vi_rounds` over an internal ledger; `math.rs` is a verbatim copy
- [x] `commit`, `buy` and `quote_buy` name their round
- [x] Tests: `cargo test -p rounds --lib` (math.rs's own tests, plus the worked example with the fee on, a replay of the Solana e2e, settles UP, DOWN and on a tie, void and refunds, pause, a rollover into N+2, fee withdrawal, the error paths and payout conservation), `cargo test -p usdg`, and near-sandbox tests (`integration-tests`: faucet, deposit and withdraw, a full round with three accounts, a refunded withdraw)
- [x] Deployed on testnet: `usdg.atnx.testnet` and `rounds.atnx.testnet`, with owner and treasury `atnx.testnet`, keeper `keeper.atnx.testnet`, a 100 bps fee and a 2,000 bps finder share. The deployed code is a non-reproducible build: its `contract_source_metadata` has `version` 0.1.0 and no `link` or `build_info`
- [x] CI (`.github/workflows/near-build.yml`): the unit tests, a reproducible build of each contract in Docker with NEP-330 build metadata, the sandbox tests on those same files, and the wasm uploaded with its SHA-256 and metadata in the job summary (2026-11-09; details in [near/README.md](../near/README.md#reproducible-builds))
- [x] Keeper step on NEAR beside Solana's, through one orchestration (`rounds-core.ts`), with reconciliation and dry mode
- [x] Oracle commitments on NEAR settles, the inputs kept in `bm.rounds.settle_inputs`, and `npm run rounds:verify`
- [x] Scripts: `rounds:near` (`status`, and `e2e`: two 60-second rounds on the deployed contracts with the keeper and a throwaway user, checked against `dpm.ts`), `near:e2e` (the account route and the relayer on testnet without a browser), `rounds:start --chain near`, `rounds:tick` covering NEAR
- [x] Gasless accounts behind the sign-in, the relayer with its policy, the rounds checks and the relay lock (`npm run test:near`)
- [x] Registry schema `003_near.sql` (NEAR columns, checks and index) and `004_near_accounts.sql` (`bm.near_accounts` and the relay lock), both applied to production on 2026-11-09
- [x] Guest accounts with no sign-in (`/api/near/guest`, the relay's guest branch, the caps), and public verification of settled rounds (`/api/near/rounds/settled`, `/api/near/rounds/verify`, `rounds:verify:public`); `npm run near:guest:e2e` ran on testnet on 2026-11-09
- [ ] `005_near_guests.sql` (`bm.near_guests`, the guest caps and relay lock) applied to production; until then `/api/near/guest` answers `server_error`
- [x] Web: the NEAR ticket, "Start rounds" with the signed-in user's account as finder, portfolio, settings, Google and X sign-in; the site reads only its own chain's rows
- [x] `BM_BOUNDED_ENABLED=0` turns the bounded markets' keeper steps off for a deployment, and `rounds:tick` runs the rounds steps only
- [x] Merged to `main` of `arkanine1000/atnx-near`: the contracts (PR #1) and the app (PR #2), 2026-11-09
- [x] Vercel project `quest-fi/atnx-near` (`atnx-near.vercel.app`, created 2026-11-09), linked to the repository's `main`, with the NEAR variables on production and preview and the keeper cron
- [ ] `markets.atnx.app` moved to the NEAR deployment, and the Solana series wound down
- [ ] A CI-built, reproducible wasm deployed, so the code on chain can be checked against the repository; explorer verification also needs the repository public
- [ ] Anything that calls `withdraw_fees` besides the e2e
- [ ] Storage charged at deposit time rather than paid by the contracts

## Known limits

The list below was written for Solana devnet. The limits that come from the mechanics and the keeper hold on NEAR too; what NEAR adds or changes is under [On NEAR testnet](#on-near-testnet).

- Centralised oracle: the keeper reads the VI history that production ATNX writes and posts the average. The VI itself is computed by production ATNX.
- Trading stops when the settlement window starts. The next round keeps taking commits on chain, but the ticket does not offer them while a round is live; a rollover still lands there.
- A rollover lands in round N+2, not N+1, and pays the 1 % fee on the whole rolled amount, stake included.
- Rounds drift: round N+1 opens only once N is settled, at least `BM_SETTLE_DELAY_SECS` (five minutes) after N's close plus the wait for the next tick, so each round starts 5 to 10 minutes after the previous one closed.
- A correct bet never loses its net stake, but the 1 % fee is not refunded: with little money on the losing side, a winner can get back slightly less than it spent.
- A void round refunds net stakes only; the fee paid on each commit and buy stays with the series.
- The ante is the keeper wallet's faucet USDG, not savings from fees or a treasury. It pays the fee like any commit. On devnet the faucet makes it free; with real money it would need a budget. A round nobody commits to is the keeper against itself. This is the one house exposure, capped at 10 USDG a side per round by design, so that every series opens on time.
- A series nobody joins idles on antes alone, one round a day at the keeper's expense (the fee on two antes and the transaction costs), until someone pauses it. No rule ends it on its own; the obvious one, ending a series after two consecutive rounds with no money from anyone but the keeper and returning the market to "Not started", is not built.
- The keeper claims its antes only on rounds finished in the last 7 days, at most 50 a tick; an older unclaimed ante stays in the vault until claimed with the keeper key.
- No selling before settlement; the exit is buying the other side, and trading stops 30 minutes before the close of a daily round. See [Open design questions](#open-design-questions).
- No cap on presale commits; a single live buy is capped at 1,000 times its side's money.
- A settlement window settles on whatever prints it holds; if the VI cron missed runs, that may be few. With none, the round is voided 30 minutes after the close.
- The program times trading and settlement by the chain clock, which ran about six seconds behind the wall clock on devnet; a countdown on the page is a few seconds early.
- Pausing a series through the registry ends it: on the next tick the series is paused on chain and its presale round voided, and from then on buys on the live round and rollovers are refused; the live round still settles and can be claimed, and the series cannot be resumed. A new series on the same market gets a new reference from its nonce.
- A market can run a daily and a fast series at the same time, but the market page shows only the daily one. A card shows one round, a live one before one waiting to open and then the daily series first, so a live fast round can stand in for a daily round that has not opened.
- A bounded market still open on a subject has no ticket on the market page once rounds are deployed: its holders see it in the portfolio's EVM section, which redeems a win once it resolves, but its "Trade" link opens the market page, so an open bounded position cannot be sold from the site.
- The faucet and series start are open to anyone (testnet only): one running series per market and speed, the keeper pays the rent.
- The ticket's fast toggle renders only under `next dev` (`NODE_ENV` is `production` on every Vercel deployment, previews included), and `startSeriesAction` ignores `fast=true` on a production build unless `BM_FAST_FROM_CLIENT=1` is set, so a wallet cannot fill production with hourly series. On production the intended route is `rounds:start -- <uuid> --fast` from the laptop.

### On NEAR testnet

- Storage is paid by the contracts. `rounds` and `usdg` pay for their state from their own NEAR balance, which is fine on testnet: anyone can make `rounds` store a position by committing two units, or make `usdg` register an account by sending it one unit. A claimed position is deleted, which frees its storage. Once a contract's balance no longer covers its storage, every call that adds state fails until someone sends it NEAR. On 2026-11-09 `rounds` held 3.20 NEAR against 250,894 bytes of state (2.51 NEAR of it locked for storage) and `usdg` 2.20 NEAR against 164,326 bytes (1.64 NEAR). Mainnet would charge storage at deposit time.
- A guest account lives in one browser only, with the same no-recovery rule, and is not tied to anyone: clearing the site's data strands it. Guests cost the parent about 0.007 NEAR each (at most 200 a day, so up to about 1.4 NEAR a day) and the relayer their gas (at most 60 relays a guest an hour); `rounds` pays the storage of their balances and positions.
- A lost browser key means a fresh account. There is no custody key and no recovery: clearing the site's data, or moving to another browser, strands the old account with its balance and positions, and the user starts again with a new one, at most five in all.
- `withdraw_fees` is not called by anything yet: not the keeper, not the site. Anyone may call it, but not from a user account: the account's key does not cover it and the relayer refuses it. Only `rounds:near -- e2e` calls it, on its own series.
- So the fee counters only grow. Each series' `finder_fees` and `platform_fees` (in `get_series`) hold every fee since the series started, including those paid into void rounds; none of it is in the finder's or the treasury's balance until `withdraw_fees` runs.
- The fee is unchanged: 1 % on every commit, buy and rollover, rounded up, with 20 % of it to the finder, copied into each series when it is created.
- The relayer pays every user's gas and the parent pays for each new account (about 0.007 NEAR). A user gets at most 200 relayed calls an hour, one at a time, and no faucet call once holding 10,000 USDG; the relayer stops sending below 0.05 NEAR of its own.
- The deployed contracts predate the reproducible build, so their code cannot be checked against the repository yet; and `arkanine1000/atnx-near` is private, so explorer verification would fail even for a reproducible deploy.
- The keeper is still the oracle. The commitment records what it settled on and `rounds:verify` checks that against `vi_history`, but nothing on chain checks the prints.
- The keeper pays its own gas from `keeper.atnx.testnet`'s NEAR (0.48 NEAR on 2026-11-09); nothing tops that up.

## Operations

- Env vars (see [development.md](development.md) for the full table and `atnx-web/.env.local.example`): `BM_ROUNDS_ENABLED=1` turns the keeper step on; `BM_SOL_KEEPER_SECRET` is the keeper key; `NEXT_PUBLIC_BM_SOL_PROGRAM`, `NEXT_PUBLIC_BM_SOL_USDG`, `NEXT_PUBLIC_BM_SOL_RPC` point the app at the program; `BM_ROUND_SECS` (86400), `BM_SETTLE_WINDOW_SECS` (1800), `BM_FIRST_PRESALE_SECS` (3600), `BM_FAST_ROUND_SECS` (3600), `BM_FAST_SETTLE_WINDOW_SECS` (900), `BM_FAST_FIRST_PRESALE_SECS` (600), `BM_ANTE_USDG` (10) and `BM_SETTLE_DELAY_SECS` (300) override the defaults; `BM_AUTO_ROLL=0` stops the bounded keeper from rolling new bounded markets.
- Vercel: production has `NEXT_PUBLIC_BM_SOL_PROGRAM`, `NEXT_PUBLIC_BM_SOL_USDG`, `NEXT_PUBLIC_BM_SOL_RPC` (a Helius devnet endpoint), `BM_SOL_KEEPER_SECRET`, `BM_ROUNDS_ENABLED=1` and `BM_AUTO_ROLL=0`. The preview for branch `feat/vi-rounds` (merged 2026-10-05) had the same plus the Supabase variables, with `BM_ROUNDS_ENABLED=0`; crons do not run on previews anyway. Recipe for preview checks in [development.md](development.md#preview-deployments).
- Tests: `cargo test -p vi_rounds --lib` (CI runs it; the local compiler crashes) and `cd atnx-web && npm run test:bm` (`dpm.ts`, the settlement rule, the bounded-market tests).
- Deploy the program: push a change under `programs/`, wait for `solana-build` to go green, then run `programs/deploy.sh vi_rounds` (needs the `gh` CLI and the Solana CLI; `--dry` only fetches the artifact and copies the IDL). It deploys from the laptop and copies the IDL and types into `atnx-web/lib/bm/idl/`. After a fresh program id, run `cd atnx-web && npm run rounds:sol -- init` once (config and mint) and put the printed mint in `NEXT_PUBLIC_BM_SOL_USDG`.
- Check a deploy end to end: `npm run rounds:sol -- e2e` (pays from `~/.config/solana/devnet.json`, or `SOL_PAYER`; needs no `.env.local`).
- Start a series: `npm run rounds:start` lists the ten liveliest candidates; `npm run rounds:start -- "Name"` starts daily rounds, `-- <uuid> --fast` the fast demo, `--finder <pubkey>` names a finder other than the keeper, `--dry` validates only. On the site, the ticket's "Start rounds" starts daily rounds with the connected wallet as finder.
- Run a tick by hand: `BM_ROUNDS_ENABLED=1 npm run rounds:tick` is a dry run (without the variable the rounds step is skipped); add `-- --live` for a real one, handy for on-camera timing on a fast series. It runs the rounds steps only; `-- --bounded` adds the bounded markets' steps, and `npm run bm:keeper:dry` runs the whole tick as the cron does. On production: `curl -H "Authorization: Bearer $CRON_SECRET" https://markets.atnx.app/api/bm/keeper?dry=1`.
- Stop a series: set its `bm.series.state` to `paused`. The next tick pauses it on chain and voids its presale round (refunds). Buys on the live round and rollovers stop with the pause, the round still settles and its positions can be claimed, and the series then reads `ended`. There is no resume; start a new series instead.
- Logs: every non-dry tick writes `bm.keeper_log` rows with `series_id` and `round_id` (`action`, `tx_hash`, `detail`, `error`); `bm.rounds` holds each round's target, settlement average, print count, winner, ante and transactions. Vercel → Logs, filtered on `/api/bm/keeper`, has the cron's output.

### Operations on NEAR testnet

- Env vars: `NEXT_PUBLIC_BM_CHAIN=near` makes a build show and trade the NEAR rounds; `BM_NEAR_ROUNDS_ENABLED=1` turns the NEAR keeper step on, signing as `BM_NEAR_KEEPER_ACCOUNT` with `BM_NEAR_KEEPER_SECRET`; `BM_NEAR_PARENT_SECRET` creates user and guest accounts and `BM_NEAR_RELAYER_ACCOUNT` / `BM_NEAR_RELAYER_SECRET` relay their calls; `BM_NEAR_GUEST_IP_SALT` (optional) salts the guests' IP hashes; `BM_BOUNDED_ENABLED=0` leaves the bounded markets to another deployment. The full table, with the `NEXT_PUBLIC_BM_NEAR_*` variables, is in [development.md](development.md#rolling-rounds-on-near-testnet).
- Vercel: the NEAR build is the project `quest-fi/atnx-near` (`atnx-near.vercel.app`, Root Directory `atnx-web`), linked to `main` of `arkanine1000/atnx-near`, with the same `vercel.json` cron, which runs on its production deployment only. It shares the registry with `markets.atnx.app`, which stays on the `atnx-markets` project until the swap. Production and preview hold the NEAR variables above and `BM_BOUNDED_ENABLED`.
- Tests: in `near/`, `cargo test -p rounds --lib`, `cargo test -p usdg` and the sandbox tests (on this machine pinned, as in [development.md](development.md#near-contracts)); `cd atnx-web && npm run test:near` (accounts, handles, the relayer and its policy, the rounds checks, the routes, the start action) and `npm run test:bm`, which includes the shared keeper steps, the commitment and the NEAR client.
- The wasm to deploy is the `usdg-wasm` or `rounds-wasm` artifact of a green `near-build` run, a reproducible build whose metadata names its commit ([near/README.md](../near/README.md#reproducible-builds)). Nothing in the repository deploys it.
- Check the contracts: `npm run rounds:near -- status` prints the config, the keeper's balances and the series on chain; `npm run rounds:near -- e2e` runs two 60-second rounds end to end with the keeper and a throwaway user it creates under the parent and deletes at the end (`--out <dir>` keeps each settle's inputs); `npm run near:e2e` creates a gasless account and relays a faucet call and a commit through the same code as the routes, into a series it creates with the keeper key (`-- --series <id>` commits into an existing one instead), and `-- --full` adds a whole 60-second round.
- Start a series: `npm run rounds:start -- <uuid> --chain near` (daily; add `--fast` for the demo series, `--finder <account>` for a finder other than the keeper, `--dry` to validate). On the site, "Start rounds" on the NEAR ticket starts daily rounds with the signed-in user's account as finder.
- Run a tick by hand: `BM_ROUNDS_ENABLED=0 BM_NEAR_ROUNDS_ENABLED=1 npm run rounds:tick` is a dry run of NEAR's step alone; `-- --live` sends. On the NEAR deployment: `curl -H "Authorization: Bearer $CRON_SECRET" https://atnx-near.vercel.app/api/bm/keeper?dry=1`.
- Check a settlement: `npm run rounds:verify -- <series-uuid-or-reference> <round>` ([Oracle commitment](#oracle-commitment)), or, from anywhere with no env file, `npm run rounds:verify:public -- <series> <round>`.
- Check the guest path: `npm run near:guest:e2e` makes a guest through the route code (in-memory store, not `bm.near_guests`), relays a faucet call, checks the refusals that keep guests and users apart, commits into a 20-minute series it creates with the keeper key outside the registry, pauses the series, voids its presale round and claims the commit back as the guest, and checks the guest's NEAR stayed 0 (`-- --series <id>` commits into an existing series instead).
- Stop a series: as on Solana, set `bm.series.state` to `paused`; the next tick sets `paused` on chain and voids the presale round.
- Logs: NEAR's `bm.keeper_log` rows carry `"chain": "near:testnet"` in `detail`; a failure of the whole NEAR step logs as `near-rounds`. Transactions are on NearBlocks (`https://testnet.nearblocks.io/txns/<hash>`).

## Open design questions

- Selling a position before settlement. The bounded markets could sell back to their pool at any time; a round has no pool to sell into. For and against a "Lock in" hedge button, and the upstream alternative, in `docs/private/open-question-sell.md` (kept out of the public repository). Not decided; for the market design owner.
- Oracle commitments: what the 32-byte `commitment` on `settle` would point at. A design note in `docs/private/oracle-commitments-maybe.md`. Answered on NEAR, where it is the hash of the settle inputs ([Oracle commitment](#oracle-commitment)); Solana's settles keep zeros.
