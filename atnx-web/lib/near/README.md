# lib/near

The NEAR web layer of the rounds: configuration (`config.ts`), the gasless user accounts and the relayer (`routes.ts`, `relay.ts`, `server.ts`), the contract reads and calls (`rounds.ts`, `client.ts`), and the "Fund from any chain" preview (`intents.ts`). The contract itself is in `near/` at the repo root. Tests: `npm run test:near`.

## Fund from any chain (NEAR Intents, dry run)

### What it does

Settings, in the NEAR build, has a "Fund from any chain" block (`components/rounds/FundFromAnyChain.tsx`, inside `NearAccountSettings`). The trader picks the chain their USDC is on (Solana, Base, Arbitrum or Ethereum) and types an amount. The block then shows a live price from NEAR Intents' 1Click API: what they send, what arrives on NEAR, the fee and the estimated time. Under it is the line "Preview only: ATNX runs on NEAR testnet, so no money moves." The ticket's "You need test USDG" state links to the block (`/app/settings#fund-from-any-chain`).

The browser calls `POST /api/near/intents/quote` with `{ chain, amount }` (`app/api/near/intents/quote/route.ts`). The route needs no sign-in and reads no user data. It checks the input (1 to 100,000 USDC, at most 6 decimals, one of the four chains), confirms that both ends of the route are in 1Click's `GET /v0/tokens` list, asks `POST /v0/quote` for a dry quote, and returns the amounts in 6-decimal units. The tokens list is cached for five minutes per server instance, and a stale list stays in use for up to an hour if a refresh fails. Each call to 1Click gives up after 10 seconds (8 for the tokens list). The route only answers in the NEAR build (`NEXT_PUBLIC_BM_CHAIN=near`).

The fee is what is lost on the way: the amount sent minus the amount that arrives, both read from the quote. It is not worked out from a published fee schedule. The docs put the fee for requests without a key at an extra 0.25 % ([Fees](https://docs.near-intents.org/resources/fees.md)), and the hackathon FAQ (Q-006) says 0.2 %. The quotes seen on 2026-11-09 for USDC to USDC carried a 1 basis point app fee from 1Click, and about 1.7 basis points in total. An optional partner key in `NEAR_INTENTS_JWT` (server-only) is sent as `X-API-Key`. No key is needed, and none is set.

### Why it is a dry run

NEAR Intents has no testnet and none is planned. The hackathon FAQ (Q-007) says to use mainnet with separate dev accounts, tiny amounts and `dry: true` quotes. The docs' FAQ also says there is no testnet, and recommends mainnet with separate test accounts. ATNX trades on NEAR testnet with a test token (USDG), so real USDC arriving on NEAR mainnet would have nowhere to go. A dry quote returns the price and the time without a deposit address, `timeWhenInactive` or `deadline` ([quote endpoint](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote.md)). With no deposit address there is nowhere to send funds, so nothing can move.

Several checks keep it dry:
- The request type allows only `dry: true`.
- `postQuote` checks `dry === true` on the request object, and again on the exact JSON it sends.
- A response that carries a `depositAddress`, or whose echoed request is not dry, is refused.
- `lib/near/intents.test.ts` checks every chain and amount. It also checks that a forged `dry: false`, and a getter that turns false between the two checks, are refused before anything is sent.

### The request

| Field | Value |
|---|---|
| `swapType` | `EXACT_INPUT`: the amount is what the trader sends |
| `originAsset` | native USDC on the chosen chain, e.g. `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near` |
| `depositType` | `ORIGIN_CHAIN` |
| `destinationAsset` | native USDC on NEAR, `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| `recipientType`, `recipient` | `DESTINATION_CHAIN`, the stand-in below |
| `refundType`, `refundTo` | `INTENTS`, the same stand-in |
| `slippageTolerance` | 100 (1 %) |
| `deadline` | now + 30 minutes |

The asset ids come from `GET /v0/tokens` (2026-11-09) and are checked against it on every quote. A chain that drops out of the list shows as unavailable.

### The recipient: a stand-in, not the trader's account

Every preview is priced for delivery to the all-zero implicit NEAR account (`0000…0000`, 64 hex characters, the implicit-account format the docs list for NEAR). It is the refund account too. The block's preview line says so in its hover text.

- The trader's ATNX account exists on testnet only (`<handle>.atnx.testnet`). Its mainnet look-alike (`<handle>.atnx.near`) is not theirs, so quoting a delivery to it would describe a transfer to a stranger, or to no one. 1Click refuses it anyway: a named recipient that does not exist on mainnet got `400 {"message":"Internal server error"}` on 2026-11-09, with the refund account set to the stand-in or to the same name.
- Nobody holds a key for the all-zero account. A dry quote has no deposit address, so no money can reach it. `PREVIEW_RECIPIENT` appears only in `buildDryQuoteRequest`. A real quote must never use it, because anything sent there could never be recovered.
- For the price, the recipient matters little: the swap sets the amounts, and every quote seen gave `withdrawFee: "0"`. A real recipient could carry a different withdrawal fee, and its quote would show it.
- A refund only happens when a swap fails, so the refund side does not change the price either. A real version would refund to the sender's address on the origin chain (`refundType: ORIGIN_CHAIN`), and ATNX does not have that address.

Plain-word errors (`quoteErrorText`):

| What 1Click says | What the trader sees |
|---|---|
| 400 "Amount is too low for bridge, try at least N" | "That is too little to send from {chain}." Then "Try at least X USDC." when N > 0, or "Try a larger amount." |
| any other 400, e.g. "tokenIn is not valid" | "USDC can't come over from {chain} right now. Try another chain." |
| 429 | "Too many price checks just now. Try again in a minute." |
| 5xx or 401, an unreadable answer, a network error | "Live prices are unavailable right now. Try again later." |
| no answer within 10 s | "Getting a price took too long. Try again." |

### How a mainnet version would deliver into the rounds contract

A real quote (`dry: false`) returns a `depositAddress` on the origin chain. The trader sends their USDC there. 1Click swaps it, then withdraws native USDC on NEAR to the `recipient`. The `/v0/status` endpoint tracks progress, and the quote's `signature` should be kept in case of a dispute. Two ways to land that USDC in the trader's balance inside `rounds`:

1. **Straight into the contract, with `customRecipientMsg`.** Set `recipient` to the rounds contract, keep `recipientType: DESTINATION_CHAIN`, and put a message for the contract in `customRecipientMsg`, e.g. `{"credit_to":"alice.atnx.near"}`. 1Click then withdraws with `ft_transfer_call` instead of `ft_transfer`, so the contract's `ft_on_transfer` runs. The docs mark `customRecipientMsg` **HIGHLY EXPERIMENTAL**. Funds are lost if it is used with a token that is not NEP-141, if the recipient's `storage_deposit` is not enough, or if the recipient does not implement `ft_on_transfer`. Before this could be used, the contract would need three changes:
   - Its token must be native USDC (`17208628…`), not USDG.
   - It must be registered with the USDC contract (`storage_deposit`) before the first delivery. USDG registers receivers for free; USDC on NEAR expects the usual NEP-145 registration.
   - `ft_on_transfer` must credit the account named in `msg`. Today it credits `sender_id` and ignores `msg` (`near/rounds/src/lib.rs`). For a delivery from 1Click, the sender is the NEAR Intents contract that makes the withdrawal (`intents.near`), not the trader. When `ft_on_transfer` returns tokens, they go back to that sender, and the docs do not say what happens to them after that. So the contract should credit whatever arrives with a valid `msg`, and treat any refund as a loss path.
2. **To the trader's own NEAR account, then into the contract.** Deliver with a plain `ft_transfer` to the trader's mainnet account. Then the trader calls `ft_transfer_call` on USDC into `rounds`. Once the contract's token is USDC, today's `ft_on_transfer` handles that as it is, because the sender is the trader. This needs no experimental field. It does need the trader's account registered with USDC, and a second step on the USDC contract that attaches 1 yoctoNEAR. The browser's key can only call the rounds contract, with no deposit, so the account set-up would have to change.

`recipientType: INTENTS`, which keeps the USDC in the trader's NEAR Intents balance and withdraws it later with an `ft_withdraw` intent carrying `msg` and `storage_deposit`, has the same `sender_id` issue as option 1.

### Checking it

- `npm run test:near` runs `lib/near/intents.test.ts`: request building (always dry), input checks, response parsing on recorded 1Click answers, error sentences, the timeout, and the token cache.
- `npm run near:intents:quote` (or `-- eth 100`) makes one live dry quote through the same code as the route. It prints what it sent, 1Click's raw answer, and the lines the block shows.
