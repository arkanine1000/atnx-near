//! Sandbox tests for the house contract: usdg and house deployed to a
//! local near-sandbox.
//!
//! Build both wasm files first (see near/README.md). They are read from
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
const DAY: u64 = 86_400;
const REF: &str = "0123456789abcdef0123456789abcdef";
const ANY_LONG: &str = "18446744073709551615";

fn commitment() -> String {
    "ab".repeat(32)
}

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

async fn fails_with(who: &Account, contract: &AccountId, method: &str, args: Value, msg: &str) -> anyhow::Result<()> {
    let r = call(who, contract, method, args).await?;
    let err = format!("{:?}", r.into_result().err());
    anyhow::ensure!(err.contains(msg), "{method}: expected {msg:?}, got {err}");
    Ok(())
}

async fn view<T: serde::de::DeserializeOwned>(c: &Contract, method: &str, args: Value) -> anyhow::Result<T> {
    Ok(c.view(method).args_json(args).await?.json()?)
}

async fn balance(house: &Contract, who: &AccountId) -> anyhow::Result<u128> {
    Ok(view::<String>(house, "balance_of", json!({ "account": who })).await?.parse()?)
}

async fn ft_balance(usdg: &Contract, who: &AccountId) -> anyhow::Result<u128> {
    Ok(view::<String>(usdg, "ft_balance_of", json!({ "account_id": who })).await?.parse()?)
}

fn n(v: &Value) -> u128 {
    v.as_str().unwrap_or_else(|| panic!("a string number, got {v}")).parse().unwrap()
}

async fn now(worker: &Worker<Sandbox>) -> anyhow::Result<u64> {
    Ok(worker.view_block().await?.timestamp() / 1_000_000_000)
}

/// Lets the sandbox clock run `secs` seconds on.
async fn wait(worker: &Worker<Sandbox>, secs: u64) -> anyhow::Result<()> {
    let target = now(worker).await? + secs;
    for _ in 0..60 {
        let t = now(worker).await?;
        if t >= target {
            return Ok(());
        }
        worker.fast_forward((target - t).max(1)).await?;
    }
    anyhow::bail!("the sandbox clock did not move {secs} s")
}

struct Env {
    worker: Worker<Sandbox>,
    root: Account,
    usdg: Contract,
    house: Contract,
    keeper: Account,
    treasury: Account,
    alice: Account,
    bob: Account,
    next_print: u64,
}

impl Env {
    /// A quote for `market` read now: a new print at `print_at`, or the
    /// stored print again when `print_id` is the stored one.
    async fn push(&mut self, market: u32, score: u64, reading: u64, print_id: u64, print_at: u64) -> anyhow::Result<Value> {
        let read_at = now(&self.worker).await?;
        let q = json!({
            "market": market, "score_e2": score.to_string(), "reading_e2": reading.to_string(),
            "print_id": print_id.to_string(), "print_at": print_at.to_string(), "read_at": read_at.to_string(),
        });
        let r = call_ok(&self.keeper, self.house.id(), "push_quotes", json!({ "quotes": [q], "commitment": commitment() })).await?;
        Ok(r.json()?)
    }

    /// A new print, recorded now.
    async fn print(&mut self, market: u32, score: u64, reading: u64) -> anyhow::Result<u64> {
        let id = self.next_print;
        self.next_print += 1;
        let at = now(&self.worker).await?;
        let r = self.push(market, score, reading, id, at).await?;
        anyhow::ensure!(r["accepted"] == 1, "{r}");
        Ok(id)
    }

    /// The keeper reads the market's newest print again.
    async fn reread(&mut self, market: u32) -> anyhow::Result<()> {
        let m: Value = view(&self.house, "get_market", json!({ "market": market })).await?;
        let q = &m["quotes"][m["quotes"].as_array().unwrap().len() - 1];
        let (s, r, id, at) = (n(&q["pushed_score_e2"]), n(&q["reading_e2"]), n(&q["print_id"]), n(&q["print_at"]));
        let out = self.push(market, s as u64, r as u64, id as u64, at as u64).await?;
        anyhow::ensure!(out["accepted"] == 1, "{out}");
        Ok(())
    }

    async fn crank(&self, ids: &[u64]) -> anyhow::Result<(Vec<String>, ExecutionSuccess)> {
        let ids: Vec<String> = ids.iter().map(|i| i.to_string()).collect();
        let r = call_ok(&self.keeper, self.house.id(), "crank", json!({ "position_ids": ids })).await?;
        Ok((r.json()?, r))
    }

    async fn open(&self, who: &Account, market: u32, side: &str, leverage: u8, stake: u128, limit: &str) -> anyhow::Result<u64> {
        let args = json!({ "market": market, "side": side, "leverage": leverage, "stake": stake.to_string(), "limit_e2": limit });
        let id: String = call_ok(who, self.house.id(), "open", args).await?.json()?;
        Ok(id.parse()?)
    }

    /// The USDG the contract holds covers every balance, the vault, the
    /// margin and the faucet pool, and the reserve is inside the assets.
    async fn invariants(&self) -> anyhow::Result<()> {
        let v: Value = view(&self.house, "get_vault", json!({})).await?;
        let held = ft_balance(&self.usdg, self.house.id()).await?;
        let owed = n(&v["ledger_total"]) + n(&v["assets"]) + n(&v["margin"]) + n(&v["faucet_pool"]);
        anyhow::ensure!(held >= owed, "the house holds {held} and owes {owed}");
        anyhow::ensure!(n(&v["reserved"]) <= n(&v["assets"]), "reserve above assets: {v}");
        Ok(())
    }
}

/// usdg (with the treasury as its minter, for test money) and house
/// deployed; 200,000 USDG minted to the treasury; 100,000 of it in the
/// vault and 50,000 in the faucet pool; one market with a first print at
/// score 500.
async fn setup() -> anyhow::Result<(Env, u32)> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let usdg = account(&root, "usdg").await?.deploy(&wasm("usdg")?).await?.into_result()?;
    let house = account(&root, "house").await?.deploy(&wasm("house")?).await?.into_result()?;
    let keeper = account(&root, "keeper").await?;
    let treasury = account(&root, "treasury").await?;
    let alice = account(&root, "alice").await?;
    let bob = account(&root, "bob").await?;
    call_ok(&root, usdg.id(), "new", json!({ "owner_id": root.id(), "minter_id": treasury.id() })).await?;
    call_ok(&root, house.id(), "new", json!({ "owner": root.id(), "keeper": keeper.id(), "treasury": treasury.id(), "token": usdg.id() })).await?;
    call_ok(&treasury, usdg.id(), "mint", json!({ "receiver_id": treasury.id(), "amount": (200_000 * USDG).to_string() })).await?;
    for (amount, msg) in [(100_000 * USDG, ""), (50_000 * USDG, "faucet")] {
        let r = treasury
            .call(usdg.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": house.id(), "amount": amount.to_string(), "msg": msg }))
            .deposit(NearToken::from_yoctonear(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        assert_eq!(n(&r.json::<Value>()?), amount, "the house keeps the whole transfer");
    }
    call_ok(&treasury, house.id(), "lp_deposit", json!({ "amount": (100_000 * USDG).to_string() })).await?;
    let t = now(&worker).await?;
    let market: u32 =
        call_ok(&keeper, house.id(), "list_market", json!({ "reference": REF, "finder": keeper.id(), "live_since": (t - 3 * DAY).to_string() }))
            .await?
            .json()?;
    let mut e = Env { worker, root, usdg, house, keeper, treasury, alice, bob, next_print: 1_000 };
    e.print(market, 50_000, 50_000).await?;
    for who in [&e.alice, &e.bob] {
        call_ok(who, e.house.id(), "faucet", json!({ "amount": (1_000 * USDG).to_string() })).await?;
    }
    e.invariants().await?;
    Ok((e, market))
}

/// Money in and out: the faucet, a deposit from the treasury, one from
/// anyone else returned in full, a withdrawal to the wallet.
#[tokio::test]
async fn faucet_deposits_and_withdraw() -> anyhow::Result<()> {
    let (e, _) = setup().await?;
    let (alice, house) = (&e.alice, e.house.id());
    assert_eq!(balance(&e.house, alice.id()).await?, 1_000 * USDG);
    let claimed: String = view(&e.house, "faucet_claimed", json!({ "account": alice.id() })).await?;
    assert_eq!(claimed, (1_000 * USDG).to_string());
    fails_with(alice, house, "faucet", json!({ "amount": (9_000 * USDG + 1).to_string() }), "faucet limit reached for this account").await?;

    // alice withdraws, then tries to send the tokens back: refused, returned in full.
    let r = call_ok(alice, house, "withdraw", json!({ "amount": (300 * USDG).to_string() })).await?;
    assert_eq!(n(&r.json::<Value>()?), 300 * USDG);
    assert!(r.logs().iter().any(|l| l.contains(r#""event":"withdraw""#)));
    assert_eq!(ft_balance(&e.usdg, alice.id()).await?, 300 * USDG);
    let r = alice
        .call(e.usdg.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": house, "amount": (100 * USDG).to_string(), "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(n(&r.json::<Value>()?), 0, "nothing used: the house takes the token from the treasury only");
    assert_eq!(ft_balance(&e.usdg, alice.id()).await?, 300 * USDG);
    assert_eq!(balance(&e.house, alice.id()).await?, 700 * USDG);
    e.invariants().await?;
    Ok(())
}

/// The trading path on chain: an order fills at the quote read after it,
/// an unreachable limit is refunded in full, a close past its limit is
/// missed and asked again, a short is liquidated and a long reaches its
/// cap.
#[tokio::test]
async fn orders_fill_after_a_fresh_read_and_positions_end() -> anyhow::Result<()> {
    let (mut e, m) = setup().await?;
    let (alice, bob, house) = (e.alice.clone(), e.bob.clone(), e.house.id().clone());

    let q: Value = view(&e.house, "quote_open", json!({ "market": m, "side": "Long", "leverage": 3, "stake": (100 * USDG).to_string() })).await?;
    assert_eq!((q["allowed"].as_bool(), q["entry_e2"].as_str(), q["fee"].as_str()), (Some(true), Some("50000"), Some("1000000")));
    let a = e.open(&alice, m, "Long", 3, 100 * USDG, ANY_LONG).await?;
    let b = e.open(&bob, m, "Long", 3, 100 * USDG, "49999").await?;
    let p: Value = view(&e.house, "get_position", json!({ "id": a.to_string() })).await?;
    assert_eq!((p["state"].as_str(), p["entry_e2"].is_null()), (Some("Pending"), true));
    let (out, _) = e.crank(&[a, b]).await?;
    assert_eq!(out, ["waiting", "waiting"], "the print on chain was read before the orders");
    wait(&e.worker, 6).await?;
    e.reread(m).await?;
    let (out, r) = e.crank(&[a, b, 12_345]).await?;
    assert_eq!(out, ["filled", "refunded", "unknown"]);
    assert!(r.logs().iter().any(|l| l.contains(r#""event":"order_refunded""#) && l.contains(r#""reason":"limit""#)));
    println!("crank of a fill and a refund burnt {} TGas", r.total_gas_burnt.as_tgas());
    assert_eq!(balance(&e.house, bob.id()).await?, 1_000 * USDG, "refunded in full, fee included");
    let p: Value = view(&e.house, "get_position", json!({ "id": a.to_string() })).await?;
    assert_eq!((p["state"].as_str(), p["entry_e2"].as_str(), p["reserved"].as_str()), (Some("Open"), Some("50000"), Some("900000000")));
    e.invariants().await?;

    // A close whose limit the next quote misses goes back to Open.
    call_ok(&alice, &house, "close", json!({ "position_id": a.to_string(), "limit_e2": "50001" })).await?;
    wait(&e.worker, 6).await?;
    e.reread(m).await?;
    let (out, r) = e.crank(&[a]).await?;
    assert_eq!(out, ["close_missed"]);
    assert!(r.logs().iter().any(|l| l.contains(r#""event":"close_missed""#) && l.contains(r#""reason":"limit""#)));

    // A short from 500, and the score at 700 three minutes later (with the
    // score allowed to move 100 % per five minutes): liquidated.
    call_ok(&e.root, &house, "set_config", json!({ "patch": { "max_step_bps": 10_000 } })).await?;
    let s = e.open(&bob, m, "Short", 3, 100 * USDG, "1").await?;
    wait(&e.worker, 6).await?;
    e.reread(m).await?;
    assert_eq!(e.crank(&[s]).await?.0, ["filled"]);
    wait(&e.worker, 180).await?;
    e.print(m, 70_000, 70_000).await?;
    let (out, r) = e.crank(&[s, a]).await?;
    assert_eq!(out, ["liquidated", "waiting"]);
    assert!(r.logs().iter().any(|l| l.contains(r#""reason":"liquidation""#)));
    // The long from 500 at 3x: 100 + 300 × 200/500 = 220 at the sell price 700.
    call_ok(&alice, &house, "close", json!({ "position_id": a.to_string(), "limit_e2": "69000" })).await?;
    wait(&e.worker, 6).await?;
    e.reread(m).await?;
    let before = balance(&e.house, alice.id()).await?;
    assert_eq!(e.crank(&[a]).await?.0, ["closed"]);
    assert_eq!(balance(&e.house, alice.id()).await?, before + 220 * USDG);
    let h: Vec<Value> = view(&e.house, "history_of", json!({ "account": alice.id() })).await?;
    assert_eq!((h[0]["reason"].as_str(), h[0]["payout"].as_str(), h[0]["exit_e2"].as_str()), (Some("close"), Some("220000000"), Some("70000")));
    assert!(view::<Value>(&e.house, "get_position", json!({ "id": a.to_string() })).await?.is_null());

    // The cap: with the maximum profit at 1.5 × stake, a 3x long from 700 caps at 1,050.
    call_ok(&e.root, &house, "set_config", json!({ "patch": { "max_profit_bps": 15_000 } })).await?;
    let c = e.open(&alice, m, "Long", 3, 100 * USDG, ANY_LONG).await?;
    wait(&e.worker, 6).await?;
    e.reread(m).await?;
    assert_eq!(e.crank(&[c]).await?.0, ["filled"]);
    wait(&e.worker, 240).await?;
    e.print(m, 110_000, 110_000).await?;
    let before = balance(&e.house, alice.id()).await?;
    let (out, r) = e.crank(&[c]).await?;
    assert_eq!(out, ["closed"]);
    assert!(r.logs().iter().any(|l| l.contains(r#""reason":"cap""#)));
    assert_eq!(balance(&e.house, alice.id()).await?, before + 250 * USDG);
    let v: Value = view(&e.house, "get_vault", json!({})).await?;
    assert_eq!((n(&v["reserved"]), n(&v["margin"])), (0, 0));
    e.invariants().await?;
    Ok(())
}

/// One push with a quote for each of 75 markets, the batch the keeper sends
/// every five minutes, and bad entries skipped inside it.
#[tokio::test]
async fn a_push_of_75_markets_fits_one_call() -> anyhow::Result<()> {
    let (mut e, _) = setup().await?;
    let t = now(&e.worker).await?;
    for i in 1..75u32 {
        let reference = format!("{i:032x}");
        let id: u32 = call_ok(&e.keeper, e.house.id(), "list_market", json!({ "reference": reference, "finder": null, "live_since": (t - 3 * DAY).to_string() }))
            .await?
            .json()?;
        assert_eq!(id, i);
    }
    wait(&e.worker, 300).await?;
    let read_at = now(&e.worker).await?;
    let mut quotes: Vec<Value> = (0..75u32)
        .map(|m| {
            let id = e.next_print + m as u64;
            json!({ "market": m, "score_e2": "51000", "reading_e2": "52000", "print_id": id.to_string(), "print_at": (read_at - 10).to_string(), "read_at": read_at.to_string() })
        })
        .collect();
    e.next_print += 75;
    quotes.push(json!({ "market": 999, "score_e2": "1", "reading_e2": "1", "print_id": "1", "print_at": "1", "read_at": read_at.to_string() }));
    let r = call_ok(&e.keeper, e.house.id(), "push_quotes", json!({ "quotes": quotes, "commitment": commitment() })).await?;
    let counts: Value = r.json()?;
    assert_eq!((counts["count"].as_u64(), counts["accepted"].as_u64(), counts["skipped"].as_u64()), (Some(76), Some(75), Some(1)));
    println!("push_quotes of 75 markets burnt {} TGas", r.total_gas_burnt.as_tgas());
    assert!(r.total_gas_burnt.as_tgas() < 150);
    let m: Value = view(&e.house, "get_market", json!({ "market": 74 })).await?;
    assert_eq!(m["quotes"][0]["score_e2"].as_str(), Some("51000"));
    fails_with(&e.alice, e.house.id(), "push_quotes", json!({ "quotes": [], "commitment": commitment() }), "not the keeper").await?;
    Ok(())
}

/// The vault exit by notice on chain, and a redeploy of the same code with
/// `migrate` keeping every balance and position.
#[tokio::test]
async fn vault_exit_and_migrate() -> anyhow::Result<()> {
    let (mut e, m) = setup().await?;
    let (treasury, house) = (e.treasury.clone(), e.house.id().clone());
    let a = e.open(&e.alice.clone(), m, "Long", 2, 50 * USDG, ANY_LONG).await?;
    wait(&e.worker, 6).await?;
    e.reread(m).await?;
    assert_eq!(e.crank(&[a]).await?.0, ["filled"]);

    // With no delay, a request is ready at once and open for ten minutes.
    call_ok(&e.root, &house, "set_config", json!({ "patch": { "lp_exit_delay_secs": "0", "lp_exit_window_secs": "600" } })).await?;
    fails_with(&e.keeper, &house, "set_config", json!({ "patch": { "fee_bps": 1 } }), "not the owner").await?;
    fails_with(&e.root, &house, "set_config", json!({ "patch": { "fee_bps": 501 } }), "config value out of range: fee_bps").await?;
    let lp: Value = view(&e.house, "lp_of", json!({ "account": treasury.id() })).await?;
    let shares = n(&lp["shares"]) / 10;
    call_ok(&treasury, &house, "lp_request_withdraw", json!({ "shares": shares.to_string() })).await?;
    let paid: String = call_ok(&treasury, &house, "lp_withdraw", json!({})).await?.json()?;
    assert_eq!(paid, (10_000 * USDG).to_string());
    let before = ft_balance(&e.usdg, treasury.id()).await?;
    call_ok(&treasury, &house, "withdraw", json!({ "amount": (10_000 * USDG).to_string() })).await?;
    assert_eq!(ft_balance(&e.usdg, treasury.id()).await?, before + 10_000 * USDG);
    e.invariants().await?;

    // Redeploy and migrate: only the owner (or the contract itself).
    let before: (Value, Value, Value) = (
        view(&e.house, "get_vault", json!({})).await?,
        view(&e.house, "get_position", json!({ "id": a.to_string() })).await?,
        view(&e.house, "get_config", json!({})).await?,
    );
    e.house.as_account().deploy(&wasm("house")?).await?.into_result()?;
    fails_with(&e.alice, &house, "migrate", json!({}), "not the owner").await?;
    let r = call_ok(&e.root, &house, "migrate", json!({})).await?;
    assert!(r.logs().iter().any(|l| l.contains(r#""event":"migrated""#)));
    call_ok(e.house.as_account(), &house, "migrate", json!({})).await?;
    let after: (Value, Value, Value) = (
        view(&e.house, "get_vault", json!({})).await?,
        view(&e.house, "get_position", json!({ "id": a.to_string() })).await?,
        view(&e.house, "get_config", json!({})).await?,
    );
    assert_eq!(after, before);
    // And the migrated state trades on.
    call_ok(&e.alice, &house, "close", json!({ "position_id": a.to_string(), "limit_e2": "1" })).await?;
    wait(&e.worker, 6).await?;
    e.reread(m).await?;
    assert_eq!(e.crank(&[a]).await?.0, ["closed"]);
    e.invariants().await?;
    Ok(())
}

/// A house pointed at an account with no token contract: the transfer
/// fails and the balance comes back.
#[tokio::test]
async fn a_failed_withdraw_is_refunded() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let fake = account(&root, "notatoken").await?;
    let treasury = account(&root, "treasury").await?;
    let house = account(&root, "house").await?.deploy(&wasm("house")?).await?.into_result()?;
    call_ok(&root, house.id(), "new", json!({ "owner": root.id(), "keeper": root.id(), "treasury": treasury.id(), "token": fake.id() })).await?;
    let r = call_ok(&fake, house.id(), "ft_on_transfer", json!({ "sender_id": treasury.id(), "amount": (50 * USDG).to_string(), "msg": "" })).await?;
    assert_eq!(n(&r.json::<Value>()?), 0);
    let r = call_ok(&fake, house.id(), "ft_on_transfer", json!({ "sender_id": root.id(), "amount": "7", "msg": "" })).await?;
    assert_eq!(n(&r.json::<Value>()?), 7, "not from the treasury: returned");
    assert_eq!(balance(&house, treasury.id()).await?, 50 * USDG);

    let r = call(&treasury, house.id(), "withdraw", json!({ "amount": (50 * USDG).to_string() })).await?;
    assert!(r.is_success(), "the callback itself succeeds");
    let r = r.into_result()?;
    assert_eq!(n(&r.json::<Value>()?), 0, "nothing was sent");
    assert!(!r.receipt_failures().is_empty(), "the ft_transfer receipt failed");
    assert!(r.logs().iter().any(|l| l.contains("balance re-credited")));
    assert_eq!(balance(&house, treasury.id()).await?, 50 * USDG);
    Ok(())
}
