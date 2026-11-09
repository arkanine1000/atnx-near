//! Sandbox tests: both wasm files deployed to a local near-sandbox.
//!
//! Build the wasm files first (see near/README.md). They are read from
//! `$ATNX_NEAR_WASM_DIR/<name>/<name>.wasm`, else from
//! `$CARGO_TARGET_DIR/near/<name>/<name>.wasm`, else `near/target/near/…`.

use anyhow::Context;
use near_workspaces::network::Sandbox;
use near_workspaces::result::{ExecutionFinalResult, ExecutionSuccess};
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;

const USDG: u128 = 1_000_000;
const ZEROS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const REF: &str = "0123456789abcdef0123456789abcdef00000000000000000000000068e1a2b3";
// Gross amounts that net exactly 600, 400 and 100 USDG at the 1 % fee.
const G600: u128 = 606_060_607;
const G400: u128 = 404_040_405;
const G100: u128 = 101_010_102;

fn wasm(name: &str) -> anyhow::Result<Vec<u8>> {
    let dir = match std::env::var("ATNX_NEAR_WASM_DIR") {
        Ok(d) => PathBuf::from(d),
        Err(_) => std::env::var("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target"))
            .join("near"),
    };
    let path = dir.join(name).join(format!("{name}.wasm"));
    std::fs::read(&path).with_context(|| format!("{} is missing: build it with cargo near first", path.display()))
}

async fn account(root: &Account, name: &str) -> anyhow::Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(30)).transact().await?.into_result()?)
}

async fn call(who: &Account, contract: &AccountId, method: &str, args: Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who.call(contract, method).args_json(args).max_gas().transact().await?)
}

async fn call_ok(who: &Account, contract: &AccountId, method: &str, args: Value) -> anyhow::Result<ExecutionSuccess> {
    match call(who, contract, method, args).await?.into_result() {
        Ok(r) => Ok(r),
        Err(e) => anyhow::bail!("{method} failed: {e:?}"),
    }
}

async fn view<T: serde::de::DeserializeOwned>(c: &Contract, method: &str, args: Value) -> anyhow::Result<T> {
    Ok(c.view(method).args_json(args).await?.json()?)
}

async fn balance(rounds: &Contract, who: &AccountId) -> anyhow::Result<u128> {
    Ok(view::<String>(rounds, "balance_of", json!({ "account_id": who })).await?.parse()?)
}

async fn ft_balance(usdg: &Contract, who: &AccountId) -> anyhow::Result<u128> {
    Ok(view::<String>(usdg, "ft_balance_of", json!({ "account_id": who })).await?.parse()?)
}

fn as_u128(v: &Value) -> u128 {
    v.as_str().expect("a U128 string").parse().unwrap()
}

/// Waits (by fast-forwarding the sandbox) until the chain clock reaches `unix_secs`.
async fn wait_until(worker: &Worker<Sandbox>, unix_secs: u64) -> anyhow::Result<()> {
    for _ in 0..60 {
        let now = worker.view_block().await?.timestamp() / 1_000_000_000;
        if now >= unix_secs {
            return Ok(());
        }
        worker.fast_forward((unix_secs - now).max(1)).await?;
    }
    anyhow::bail!("the sandbox clock did not reach {unix_secs}")
}

struct Env {
    worker: Worker<Sandbox>,
    usdg: Contract,
    rounds: Contract,
    keeper: Account,
    treasury: Account,
    alice: Account,
    bob: Account,
    carol: Account,
}

/// usdg and rounds deployed and initialised, rounds as the minter, fee 1 %
/// with 20 % of it to the finder.
async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdg = account(&root, "usdg").await?.deploy(&wasm("usdg")?).await?.into_result()?;
    let rounds = account(&root, "rounds").await?.deploy(&wasm("rounds")?).await?.into_result()?;
    let keeper = account(&root, "keeper").await?;
    let treasury = account(&root, "treasury").await?;
    let alice = account(&root, "alice").await?;
    let bob = account(&root, "bob").await?;
    let carol = account(&root, "carol").await?;
    call_ok(&root, usdg.id(), "new", json!({ "owner_id": root.id(), "minter_id": rounds.id() })).await?;
    call_ok(
        &root,
        rounds.id(),
        "new",
        json!({
            "owner": root.id(), "keeper": keeper.id(), "treasury": treasury.id(), "token": usdg.id(),
            "fee_bps": 100, "finder_bps": 2000,
        }),
    )
    .await?;
    Ok(Env { worker, usdg, rounds, keeper, treasury, alice, bob, carol })
}

#[tokio::test]
async fn faucet_deposit_and_withdraw() -> anyhow::Result<()> {
    let e = setup().await?;
    let (alice, bob) = (&e.alice, &e.bob);

    // Faucet: the mint lands on the rounds contract, the caller is credited.
    let r = call_ok(alice, e.rounds.id(), "faucet", json!({ "amount": (1_000 * USDG).to_string() })).await?;
    assert_eq!(as_u128(&r.json::<Value>()?), 1_000 * USDG);
    assert!(r.logs().iter().any(|l| l.contains(r#""event":"faucet""#)));
    assert_eq!(balance(&e.rounds, alice.id()).await?, 1_000 * USDG);
    assert_eq!(ft_balance(&e.usdg, e.rounds.id()).await?, 1_000 * USDG);
    let r = call(alice, e.rounds.id(), "faucet", json!({ "amount": (10_000 * USDG + 1).to_string() })).await?;
    assert!(r.is_failure());
    assert!(format!("{:?}", r.into_result().err()).contains("mint above the per-call cap"));
    // Only the rounds contract mints.
    let r = call(alice, e.usdg.id(), "mint", json!({ "receiver_id": alice.id(), "amount": "1" })).await?;
    assert!(r.is_failure());

    // Withdraw: tokens to the caller (registered on usdg for free), balance debited.
    let r = call_ok(alice, e.rounds.id(), "withdraw", json!({ "amount": (300 * USDG).to_string() })).await?;
    assert_eq!(as_u128(&r.json::<Value>()?), 300 * USDG);
    assert!(r.logs().iter().any(|l| l.contains(r#""event":"withdraw""#)));
    assert_eq!(balance(&e.rounds, alice.id()).await?, 700 * USDG);
    assert_eq!(ft_balance(&e.usdg, alice.id()).await?, 300 * USDG);
    assert_eq!(ft_balance(&e.usdg, e.rounds.id()).await?, 700 * USDG);
    let r = call(alice, e.rounds.id(), "withdraw", json!({ "amount": (701 * USDG).to_string() })).await?;
    assert!(format!("{:?}", r.into_result().err()).contains("balance too low"));
    assert_eq!(balance(&e.rounds, alice.id()).await?, 700 * USDG);

    // A plain ft_transfer to an unregistered account registers it.
    alice
        .call(e.usdg.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": bob.id(), "amount": (50 * USDG).to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(ft_balance(&e.usdg, bob.id()).await?, 50 * USDG);

    // Deposit: ft_transfer_call to rounds credits the sender.
    for (who, amount) in [(alice, 200 * USDG), (bob, 50 * USDG)] {
        let r = who
            .call(e.usdg.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": e.rounds.id(), "amount": amount.to_string(), "msg": "" }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        assert_eq!(as_u128(&r.json::<Value>()?), amount, "ft_transfer_call reports the amount used");
        assert!(r.logs().iter().any(|l| l.contains(r#""event":"deposit""#)));
    }
    assert_eq!(balance(&e.rounds, alice.id()).await?, 900 * USDG);
    assert_eq!(balance(&e.rounds, bob.id()).await?, 50 * USDG);
    // alice: 300 withdrawn, 50 sent to bob, 200 deposited.
    assert_eq!((ft_balance(&e.usdg, alice.id()).await?, ft_balance(&e.usdg, bob.id()).await?), (50 * USDG, 0));
    assert_eq!(ft_balance(&e.usdg, e.rounds.id()).await?, 950 * USDG);
    Ok(())
}

/// The worked example of docs/rounds.md on the sandbox: alice and bob
/// commit 600 and 400 net, carol buys UP for a net 100, UP wins.
#[tokio::test]
async fn a_full_round_with_three_accounts() -> anyhow::Result<()> {
    let e = setup().await?;
    let (alice, bob, carol, keeper) = (&e.alice, &e.bob, &e.carol, &e.keeper);
    for (who, amount) in [(alice, G600), (bob, G400), (carol, G100)] {
        call_ok(who, e.rounds.id(), "faucet", json!({ "amount": amount.to_string() })).await?;
    }

    // Only the keeper starts a series; this one is a minute long.
    let args = json!({ "reference": REF, "round_secs": 60, "settle_window_secs": 10, "ante": (10 * USDG).to_string(), "finder": keeper.id() });
    assert!(call(alice, e.rounds.id(), "create_series", args.clone()).await?.is_failure());
    let sid: u32 = call_ok(keeper, e.rounds.id(), "create_series", args).await?.json()?;
    assert_eq!(sid, 1);
    let s: Value = view(&e.rounds, "get_series_by_reference", json!({ "reference": REF })).await?;
    assert_eq!((s["id"].as_u64(), s["presale_round"].as_u64()), (Some(1), Some(1)));

    // Presale and open.
    call_ok(alice, e.rounds.id(), "commit", json!({ "series_id": sid, "round_index": 1, "side": "Up", "amount": G600.to_string() })).await?;
    call_ok(bob, e.rounds.id(), "commit", json!({ "series_id": sid, "round_index": 1, "side": "Down", "amount": G400.to_string() })).await?;
    call_ok(keeper, e.rounds.id(), "open_round", json!({ "series_id": sid, "target_e2": 14_300 })).await?;
    // round_index is required, and a commit still naming the round just opened fails.
    let r = call(carol, e.rounds.id(), "commit", json!({ "series_id": sid, "side": "Up", "amount": "1000000" })).await?;
    assert!(format!("{:?}", r.into_result().err()).contains("round_index"));
    let late = json!({ "series_id": sid, "round_index": 1, "side": "Up", "amount": "1000000" });
    let r = call(carol, e.rounds.id(), "commit", late).await?;
    assert!(format!("{:?}", r.into_result().err()).contains("round is not the series' presale round"));
    let wrong = json!({ "series_id": sid, "round_index": 2, "side": "Up", "amount": "1000000", "min_shares": "0" });
    let r = call(carol, e.rounds.id(), "buy", wrong).await?;
    assert!(format!("{:?}", r.into_result().err()).contains("round is not the series' live round"));
    assert_eq!(balance(&e.rounds, carol.id()).await?, G100);
    let r: Value = view(&e.rounds, "get_round", json!({ "series_id": sid, "round_index": 1 })).await?;
    assert_eq!(r["state"], "Live");
    assert_eq!([&r["m_up"], &r["m_down"], &r["n_up"], &r["n_down"]].map(as_u128), [600 * USDG, 400 * USDG, 1_000 * USDG, 1_000 * USDG]);

    // Carol buys UP with a net 100 at the quoted shares.
    let q: Value = view(&e.rounds, "quote_buy", json!({ "series_id": sid, "round_index": 1, "side": "Up", "amount": G100.to_string() })).await?;
    assert_eq!([&q["shares"], &q["fee"], &q["finder_fee"], &q["net"]].map(as_u128), [154_150_679, 1_010_102, 202_020, 100 * USDG]);
    let buy = json!({ "series_id": sid, "round_index": 1, "side": "Up", "amount": G100.to_string(), "min_shares": "154150680" });
    let r = call(carol, e.rounds.id(), "buy", buy).await?;
    assert!(format!("{:?}", r.into_result().err()).contains("fewer shares than the minimum you set"));
    let buy = json!({ "series_id": sid, "round_index": 1, "side": "Up", "amount": G100.to_string(), "min_shares": q["shares"] });
    let r = call_ok(carol, e.rounds.id(), "buy", buy).await?;
    assert!(r.logs().iter().any(|l| l.contains(r#""event":"buy""#) && l.contains(r#""shares":"154150679""#)));
    let p: Value = view(&e.rounds, "get_position", json!({ "series_id": sid, "round_index": 1, "account_id": carol.id() })).await?;
    assert_eq!(as_u128(&p["shares_up"]), 154_150_679);

    // Settle after the close: UP wins.
    let r: Value = view(&e.rounds, "get_round", json!({ "series_id": sid, "round_index": 1 })).await?;
    let close_at = r["close_at"].as_u64().unwrap();
    let settle = json!({ "series_id": sid, "settle_e2": 15_000, "commitment": ZEROS });
    let early = call(keeper, e.rounds.id(), "settle", settle.clone()).await?;
    assert!(format!("{:?}", early.into_result().err()).contains("round has not reached its close"));
    wait_until(&e.worker, close_at + 1).await?;
    call_ok(keeper, e.rounds.id(), "settle", settle).await?;
    let r: Value = view(&e.rounds, "get_round", json!({ "series_id": sid, "round_index": 1 })).await?;
    assert_eq!((r["state"].as_str(), r["winner"].as_str()), (Some("Settled"), Some("Up")));

    // Claims, the docs numbers.
    for (who, want) in [(carol, 153_424_802u128), (alice, 946_575_197), (bob, 0)] {
        let r = call_ok(who, e.rounds.id(), "claim", json!({ "series_id": sid, "round_index": 1 })).await?;
        assert_eq!(as_u128(&r.json::<Value>()?), want);
        assert_eq!(balance(&e.rounds, who.id()).await?, want);
    }
    let positions: Vec<Value> = view(&e.rounds, "positions_of", json!({ "account_id": alice.id() })).await?;
    assert!(positions.is_empty(), "claimed positions are removed");

    // Fees, then money out.
    call_ok(bob, e.rounds.id(), "withdraw_fees", json!({ "series_id": sid })).await?;
    assert_eq!(balance(&e.rounds, keeper.id()).await?, 1_212_121 + 808_081 + 202_020);
    assert_eq!(balance(&e.rounds, e.treasury.id()).await?, 4_848_486 + 3_232_324 + 808_082);
    call_ok(alice, e.rounds.id(), "withdraw", json!({ "amount": "946575197" })).await?;
    assert_eq!(ft_balance(&e.usdg, alice.id()).await?, 946_575_197);

    // Everything minted is in a balance, in a wallet, or is the one unit of dust.
    let minted = G600 + G400 + G100;
    let inside = ft_balance(&e.usdg, e.rounds.id()).await?;
    let mut ledger = 0;
    for who in [alice.id(), bob.id(), carol.id(), keeper.id(), e.treasury.id()] {
        ledger += balance(&e.rounds, who).await?;
    }
    assert_eq!(inside, ledger + 1);
    assert_eq!(inside + ft_balance(&e.usdg, alice.id()).await?, minted);
    Ok(())
}

/// A rounds contract pointed at an account with no token contract: the
/// transfer fails and the balance comes back; a faucet mint fails and
/// nothing is credited.
#[tokio::test]
async fn a_failed_withdraw_is_refunded() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let fake = account(&root, "notatoken").await?;
    let rounds = account(&root, "rounds").await?.deploy(&wasm("rounds")?).await?.into_result()?;
    let alice = account(&root, "alice").await?;
    call_ok(
        &root,
        rounds.id(),
        "new",
        json!({
            "owner": root.id(), "keeper": root.id(), "treasury": root.id(), "token": fake.id(),
            "fee_bps": 100, "finder_bps": 2000,
        }),
    )
    .await?;
    // The configured token account can credit a balance through ft_on_transfer.
    let r = call_ok(&fake, rounds.id(), "ft_on_transfer", json!({ "sender_id": alice.id(), "amount": (50 * USDG).to_string(), "msg": "" })).await?;
    assert_eq!(as_u128(&r.json::<Value>()?), 0);
    // Any other caller is a wrong token: the full amount goes back.
    let r = call_ok(&alice, rounds.id(), "ft_on_transfer", json!({ "sender_id": alice.id(), "amount": "7", "msg": "" })).await?;
    assert_eq!(as_u128(&r.json::<Value>()?), 7);
    assert_eq!(balance(&rounds, alice.id()).await?, 50 * USDG);

    let r = call(&alice, rounds.id(), "withdraw", json!({ "amount": (50 * USDG).to_string() })).await?;
    assert!(r.is_success(), "the callback itself succeeds");
    let r = r.into_result()?;
    assert_eq!(as_u128(&r.json::<Value>()?), 0, "nothing was sent");
    assert!(!r.receipt_failures().is_empty(), "the ft_transfer receipt failed");
    assert!(r.logs().iter().any(|l| l.contains("balance re-credited")));
    assert!(!r.logs().iter().any(|l| l.contains(r#""event":"withdraw""#)));
    assert_eq!(balance(&rounds, alice.id()).await?, 50 * USDG);

    let r = call_ok(&alice, rounds.id(), "faucet", json!({ "amount": (10 * USDG).to_string() })).await?;
    assert_eq!(as_u128(&r.json::<Value>()?), 0);
    assert!(r.logs().iter().any(|l| l.contains("nothing credited")));
    assert_eq!(balance(&rounds, alice.id()).await?, 50 * USDG);
    Ok(())
}
