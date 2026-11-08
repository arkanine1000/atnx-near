# Relayer prototype

A NEP-366 meta-transaction relayer for the rounds contract, proven on testnet. The user's browser signs a delegate action with a key scoped to `rounds`; the relayer checks it and sends it in a transaction it pays for, so the user never holds NEAR.

Nothing here is wired up: no route, no package and no deployment use these files. They are kept so the code survives until it moves into atnx-web.

- `relay.mjs`: the server half. `createRelayer({ relayerId, relayerKey, rpcUrl, policy })` returns `relay(signedDelegateBase64)`. Before it pays for anything, it checks the delegate: canonical encoding, sender, receiver, a single zero-deposit call to an allowed method, the gas and argument size, and the signature. It then checks expiry, nonce and key scope against the chain, and runs one relay at a time per sender.
- `client.mjs`: the browser half. `WebCryptoSigner` keeps the user's Ed25519 key as a non-extractable WebCrypto key; `signCall(...)` returns the base64 `SignedDelegate` to POST to the relay route.
- `route.example.ts`: a sketch of the two Next.js route handlers (relay, and first-sign-in account creation) behind Supabase auth. It refers to modules and a `near_accounts` table that do not exist yet.

The prototype ran against near-api-js 7.4.0 and borsh 2.0.0. Keys come from environment variables (`NEAR_RELAYER_KEY`, `NEAR_PARENT_KEY`); none are stored here.
