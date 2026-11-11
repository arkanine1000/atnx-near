# Rolling rounds on NEAR

`near/rounds`, deployed at `rounds.atnx.testnet`, is the first market design built on NEAR in the hackathon window, before the [house market](house.md). Each market runs back-to-back rounds on its Virality Index, and every round asks one question: will the VI, averaged over the round's last 30 minutes, end at or above where it stood when the round opened? While round N trades, round N+1 takes presale commits. Prices come from Pennock's dynamic pari-mutuel market, so winners are paid out of the losing side's money; every commit, buy and rollover pays a 1 % fee, and the keeper antes 10 USDG on a side nobody has backed. Balances are an internal USDG ledger inside the contract, so no user call takes a deposit and the relayer can send every one. The keeper settles each round with a SHA-256 commitment to the `vi_history` prints it averaged. The contract is a port of the baseline's Solana program `vi_rounds` (source in [atnx-markets](https://github.com/arkanine1000/atnx-markets/tree/78b6ecd/programs/vi_rounds)); [near/SPEC.md](../near/SPEC.md) says where the port differs and why.

The house replaced the rounds as the product. The rounds contract is still deployed and keeps its state. The house build of the site (`NEXT_PUBLIC_BM_NEAR_PRODUCT=house`) takes the rounds out of the navigation and the market page.

## What still depends on it

- **Test USDG.** The rounds contract is the only minter of `usdg.atnx.testnet`, so all test USDG comes from its `faucet`. `npm run house:seed` (`atnx-web/scripts/house-seed.ts`) funds the house that way: faucet calls on the rounds contract from the parent account, a `withdraw` from the rounds ledger to the token, then `ft_transfer_call` to the house and `lp_deposit`.
- **Trader accounts.** The account and guest routes first make a rounds account, `<handle>.atnx.testnet` or `guest-<8 characters>.atnx.testnet`, whose key is scoped to `rounds.atnx.testnet`, and then the house account, whose name is derived from it (`atnx-web/lib/near/house-account.ts`). `bm.near_accounts` and `bm.near_guests` hold the rounds account ids, and the routes answer `not_configured` without `NEXT_PUBLIC_BM_NEAR_ROUNDS`. Details in [Accounts and relaying](house.md#accounts-and-relaying).
- **Shared code.** The house uses the rounds' NEAR web layer: the browser key store, the account and guest routes and the relayer in `atnx-web/lib/near/`, and the account gate, the guest choice, the ticket parts and "Fund from any chain" in `atnx-web/components/rounds/`. The relayer holds one policy per contract and checks each delegate against the policy its receiver names.
- **The keeper account.** `keeper.atnx.testnet` is the keeper of both contracts.

## Methods and tests

Every method, view, event and error message of `rounds` and `usdg` is in [near/README.md](../near/README.md#rounds-methods).

The contract's tests run from `near/`:

```bash
cd near
cargo test -p rounds --lib    # math.rs's own tests plus the contract's
cargo test -p usdg
(cd usdg && cargo near build non-reproducible-wasm)
(cd rounds && cargo near build non-reproducible-wasm)
cargo test -p integration-tests --test rounds -- --test-threads=1   # near-sandbox, on the two wasm files
```

The web layer's tests run from `atnx-web/`: `npm run test:bm` (the pari-mutuel maths in `lib/bm/dpm.ts`, the keeper's rounds steps, the settle commitment) and `npm run test:near` (the relayer's rounds checks, the start action, the settle verification). CI runs the Rust tests on every push under `near/` (`.github/workflows/near-build.yml`).

The full design as it stood before the baseline was removed from this repository (the series reference, presale, open, price function, settlement, rollover, fees and ante, the worked example the unit tests check, the settle commitment, the keeper and the operations) is in [docs/rounds.md at commit be66b35](https://github.com/arkanine1000/atnx-near/blob/be66b35a1b26dc7af8e29fd6f832368b6436c8ae/docs/rounds.md).
