//! Unit tests on the mocked blockchain (`near-sdk` `unit-testing`).
//!
//! Every state-changing call goes through `T::call`, `T::fails` or one of
//! the money helpers, and each of them checks afterwards:
//! 1. the USDG the contract holds (tracked here, on the token's side) is at
//!    least the sum of the ledger balances, the vault's assets, the margin
//!    and the faucet pool, and equal to it plus withdrawals in flight;
//! 2. the vault's reserve is at most its assets;
//! and that the ledger total is the sum of every balance, the margin and the
//! reserve are what the active positions hold, the books add up to the
//! reserve and the shares are the holders' plus the dead shares.

use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;
use std::collections::BTreeSet;
use std::panic::{catch_unwind, AssertUnwindSafe};

const T0: u64 = 1_760_000_000;
const REF_A: &str = "0123456789abcdef0123456789abcdef";
const REF_B: &str = "fedcba9876543210fedcba9876543210";
const VAULT: u64 = 10_000_000 * USDG;
const POOL: u64 = 1_000_000 * USDG;
const STAKE: u64 = 100 * USDG;
const ANY_LONG: u64 = u64::MAX;
const ANY_SHORT: u64 = 1;

fn commitment() -> String {
    "ab".repeat(32)
}
fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acc("owner.near")
}
fn keeper() -> AccountId {
    acc("keeper.near")
}
fn treasury() -> AccountId {
    acc("treasury.near")
}
fn token() -> AccountId {
    acc("usdg.near")
}
fn house() -> AccountId {
    acc("house.near")
}
fn finder() -> AccountId {
    acc("finder.near")
}
fn alice() -> AccountId {
    acc("alice.near")
}
fn bob() -> AccountId {
    acc("bob.near")
}
fn carol() -> AccountId {
    acc("carol.near")
}
fn dave() -> AccountId {
    acc("dave.near")
}

fn qin(market: u32, score: u64, reading: u64, print_id: u64, print_at: u64, read_at: u64) -> QuoteIn {
    QuoteIn {
        market,
        score_e2: U64(score),
        reading_e2: U64(reading),
        print_id: U64(print_id),
        print_at: U64(print_at),
        read_at: U64(read_at),
    }
}

/// An optional view number, 0 when null.
fn n(v: Option<U64>) -> u64 {
    v.map(|v| v.0).unwrap_or(0)
}

thread_local! {
    /// While set, the panic hook stays silent: expected failures don't
    /// flood the output, and real assertion failures still print.
    static QUIET: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn quiet_panics() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if !QUIET.with(|q| q.get()) {
                default(info)
            }
        }));
    });
}

/// Runs `f`, returning its result or None if it panicked, quietly.
fn attempt<R>(f: impl FnOnce() -> R) -> Result<R, Box<dyn std::any::Any + Send>> {
    quiet_panics();
    QUIET.with(|q| q.set(true));
    let r = catch_unwind(AssertUnwindSafe(f));
    QUIET.with(|q| q.set(false));
    r
}

/// Runs `f`, which must panic with a message containing `msg`.
fn expect_err(msg: &str, f: impl FnOnce()) {
    let err = attempt(f).expect_err(&format!("expected a panic with {msg:?}"));
    let text = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(text.contains(msg), "expected {msg:?}, got {text:?}");
}

/// `make()` built once per thread. The mocked VM's runtime config is slow
/// to build and the same for every call.
fn cached<C: Clone + 'static>(make: fn() -> C) -> C {
    thread_local! {
        static SLOT: std::cell::RefCell<Vec<Box<dyn std::any::Any>>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    SLOT.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some(c) = slot.iter().find_map(|b| b.downcast_ref::<C>()) {
            return c.clone();
        }
        let c = make();
        slot.push(Box::new(c.clone()));
        c
    })
}

fn ctx(who: &AccountId, now: u64, balance: NearToken) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(house())
            .predecessor_account_id(who.clone())
            .signer_account_id(who.clone())
            .block_timestamp(now * 1_000_000_000)
            .account_balance(balance)
            .build(),
        cached(near_sdk::test_vm_config),
        cached(near_sdk::RuntimeFeesConfig::test)
    );
}

struct T {
    c: Contract,
    now: u64,
    /// The contract's USDG, as the token contract would report it.
    token_held: u128,
    /// Debited by `withdraw`, not yet resolved by `on_withdraw`.
    in_flight: u128,
    /// Every account a test has touched: their balances must sum to the
    /// ledger total.
    known: BTreeSet<AccountId>,
    balance: NearToken,
    next_print: u64,
}

impl T {
    fn new() -> Self {
        let balance = NearToken::from_near(100);
        // A fresh store: testing_env! carries storage over between contexts,
        // and a test may build more than one contract on its thread.
        ctx(&owner(), T0, balance);
        near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
        ctx(&owner(), T0, balance);
        let c = Contract::new(owner(), keeper(), treasury(), token());
        let known = [owner(), keeper(), treasury(), token(), house(), finder()].into_iter().collect();
        let t = T { c, now: T0, token_held: 0, in_flight: 0, known, balance, next_print: 1_000 };
        t.check();
        t
    }

    fn ctx(&self, who: &AccountId) {
        ctx(who, self.now, self.balance);
    }

    /// A call from `who` now; the invariants are checked afterwards.
    fn call<R>(&mut self, who: &AccountId, f: impl FnOnce(&mut Contract) -> R) -> R {
        self.known.insert(who.clone());
        self.ctx(who);
        let r = f(&mut self.c);
        self.check();
        r
    }

    /// A call that must fail with `msg`; the invariants are checked afterwards.
    fn fails(&mut self, who: &AccountId, msg: &str, f: impl FnOnce(&mut Contract)) {
        self.known.insert(who.clone());
        self.ctx(who);
        let c = &mut self.c;
        expect_err(msg, move || f(c));
        self.check();
    }

    /// The contract for views that read the clock (resets the logs).
    fn view(&self) -> &Contract {
        self.ctx(&house());
        &self.c
    }

    fn check(&self) {
        let c = &self.c;
        let v = c.get_vault();
        let (ledger, assets, reserved, margin, pool) =
            (v.ledger_total.0, v.assets.0, v.reserved.0, v.margin.0, v.faucet_pool.0);
        let owed = ledger + assets + margin + pool;
        assert!(self.token_held >= owed, "invariant 1: the contract holds {} and owes {owed}", self.token_held);
        assert!(reserved <= assets, "invariant 2: reserved {reserved} above assets {assets}");
        assert_eq!(self.token_held, owed + self.in_flight, "every unit is accounted for");
        let sum: u128 = self.known.iter().map(|a| c.balance_of(a.clone()).0).sum();
        assert_eq!(sum, ledger, "ledger_total is the sum of the balances");
        let n = c.active_count();
        let (mut held, mut res, mut seen) = (0u128, 0u128, 0u32);
        let mut from = 0;
        while from < n {
            let page = c.list_active(Some(from), Some(100));
            for p in &page {
                if p.state == PositionState::Pending {
                    held += p.stake.0 + p.fee.0;
                    assert_eq!(p.reserved.0, 0, "a pending order reserves nothing");
                } else {
                    held += p.stake.0;
                    res += p.reserved.0;
                }
            }
            seen += page.len() as u32;
            from += 100;
        }
        assert_eq!(seen, n);
        assert_eq!(held, margin, "the margin is what the active positions hold");
        assert_eq!(res, reserved, "the reserve is the open positions' maximum profit");
        let mut books = 0u128;
        let mut from = 0;
        loop {
            let ms = c.list_markets(Some(from), Some(100));
            if ms.is_empty() {
                break;
            }
            books += ms.iter().map(|m| m.long.reserved.0 + m.short.reserved.0).sum::<u128>();
            from += 100;
        }
        assert_eq!(books, reserved, "the books add up to the reserve");
        let lp: u128 = self.known.iter().map(|a| c.lp_of(a.clone()).shares.0).sum();
        assert_eq!(lp + DEAD_SHARES, v.shares.0, "the shares are the holders' plus the dead shares");
    }

    /// `ft_transfer_call` on `via` from `sender`: the tokens move in, the
    /// contract's `ft_on_transfer` runs, and what it returns moves back.
    /// Only the configured token's units are tracked.
    fn transfer_call(&mut self, via: &AccountId, sender: &AccountId, amount: u64, msg: &str) -> u64 {
        self.known.insert(sender.clone());
        self.ctx(via);
        let real = via == &token();
        if real {
            self.token_held += amount as u128;
        }
        let back = self.c.ft_on_transfer(sender.clone(), u(amount), msg.to_string()).0;
        if real {
            self.token_held -= back;
        }
        self.check();
        back as u64
    }

    /// A withdrawal and its callback.
    fn withdraw(&mut self, who: &AccountId, amount: u64, transfer_ok: bool) -> u64 {
        self.known.insert(who.clone());
        self.ctx(who);
        let _ = self.c.withdraw(u(amount));
        self.in_flight += amount as u128;
        self.check();
        self.ctx(&house());
        let result = if transfer_ok { Ok(()) } else { Err(PromiseError::Failed) };
        let sent = self.c.on_withdraw(who.clone(), u(amount), result).0;
        self.in_flight -= amount as u128;
        self.token_held -= sent;
        self.check();
        sent as u64
    }

    /// The treasury seeds the vault and the faucet pool.
    fn seed(&mut self, vault: u64, pool: u64) {
        if vault > 0 {
            assert_eq!(self.transfer_call(&token(), &treasury(), vault, ""), 0);
            self.call(&treasury(), |c| c.lp_deposit(u(vault)));
        }
        if pool > 0 {
            assert_eq!(self.transfer_call(&token(), &treasury(), pool, "faucet"), 0);
        }
    }

    fn faucet(&mut self, who: &AccountId, amount: u64) {
        self.call(who, |c| c.faucet(u(amount)));
    }

    /// Lists a market that went live three days ago.
    fn list(&mut self, reference: &str, finder: Option<AccountId>) -> u32 {
        let live = self.now - 3 * DAY;
        self.call(&keeper(), |c| c.list_market(reference.to_string(), finder, U64(live)))
    }

    fn push_raw(&mut self, quotes: Vec<QuoteIn>) {
        self.call(&keeper(), |c| c.push_quotes(quotes, commitment()));
    }

    /// A new print, recorded and read now.
    fn push(&mut self, market: u32, score: u64, reading: u64) -> u64 {
        let id = self.next_print;
        self.next_print += 1;
        let now = self.now;
        self.push_raw(vec![qin(market, score, reading, id, now, now)]);
        id
    }

    /// A new print five minutes on.
    fn next(&mut self, market: u32, score: u64, reading: u64) -> u64 {
        self.now += 300;
        self.push(market, score, reading)
    }

    /// The keeper reads the market's newest print again, now.
    fn reread(&mut self, market: u32) {
        let q = self.c.get_market(market).unwrap().quote.unwrap();
        let now = self.now;
        self.push_raw(vec![qin(market, q.pushed_score_e2.0, q.reading_e2.0, q.print_id.0, q.print_at.0, now)]);
    }

    /// New prints every five minutes until the stored score is `score`.
    fn walk(&mut self, market: u32, score: u64, reading: u64) {
        for _ in 0..200 {
            self.next(market, score, reading);
            if self.score(market) == score {
                return;
            }
        }
        panic!("the score did not reach {score}");
    }

    fn score(&self, market: u32) -> u64 {
        self.c.get_market(market).unwrap().quote.unwrap().score_e2.0
    }

    fn open(&mut self, who: &AccountId, market: u32, side: Side, leverage: u8, stake: u64, limit: u64) -> u64 {
        self.call(who, |c| c.open(market, side, leverage, u(stake), U64(limit))).0
    }

    /// An order with no effective limit, filled at a re-read of the newest print.
    fn filled(&mut self, who: &AccountId, market: u32, side: Side, leverage: u8, stake: u64) -> u64 {
        let limit = if side == Side::Long { ANY_LONG } else { ANY_SHORT };
        let id = self.open(who, market, side, leverage, stake, limit);
        self.now += 10;
        self.reread(market);
        assert_eq!(self.crank(&keeper(), &[id]), ["filled"]);
        id
    }

    fn crank(&mut self, who: &AccountId, ids: &[u64]) -> Vec<String> {
        self.call(who, |c| c.crank(ids.iter().map(|i| U64(*i)).collect()))
    }

    fn close(&mut self, who: &AccountId, id: u64, limit: u64) {
        self.call(who, |c| c.close(U64(id), U64(limit)));
    }

    fn pos(&self, id: u64) -> Option<PositionView> {
        self.c.get_position(U64(id))
    }

    fn bal(&self, who: &AccountId) -> u64 {
        self.c.balance_of(who.clone()).0 as u64
    }

    fn vault(&self) -> VaultView {
        self.c.get_vault()
    }

    fn last_closed(&self, who: &AccountId) -> ClosedView {
        self.c.history_of(who.clone()).into_iter().next().expect("a history entry")
    }
}

/// A vault of 10M from the treasury, a faucet pool of 1M, market 0 with a
/// finder and a first print at (score, reading), and 10,000 USDG each for
/// alice and bob.
fn setup(score: u64, reading: u64) -> (T, u32) {
    let mut t = T::new();
    t.seed(VAULT, POOL);
    let m = t.list(REF_A, Some(finder()));
    t.push(m, score, reading);
    t.faucet(&alice(), 10_000 * USDG);
    t.faucet(&bob(), 10_000 * USDG);
    (t, m)
}

fn logs_with(event: &str) -> Vec<String> {
    get_logs().into_iter().filter(|l| l.contains(&format!("\"event\":\"{event}\""))).collect()
}

/// The reason in the last call's `order_refunded` event for position `id`.
fn refunded(id: u64) -> String {
    let ev = logs_with("order_refunded");
    let l = ev.iter().find(|l| l.contains(&format!(r#""id":"{id}""#))).unwrap_or_else(|| panic!("no refund of {id} in {ev:?}"));
    l.split(r#""reason":""#).nth(1).and_then(|x| x.split('"').next()).unwrap_or_default().to_string()
}

// ------------------------------------------------- the worked example

/// Score 400, reading 420: the lead is 408.80. A 3x long of 100 fills at
/// 408.80 and pays a fee of 1 (half to the finder). Later the score is 480
/// and the reading 470: the sell price is 476.41 and the payout 149.61.
#[test]
fn worked_example_long_3x_to_the_cent() {
    let (mut t, m) = setup(40_000, 42_000);
    let alice0 = t.bal(&alice());
    let (finder0, treasury0) = (t.bal(&finder()), t.bal(&treasury()));

    let q = t.view().quote_open(m, Side::Long, 3, u(STAKE), Some(alice()));
    assert!(q.allowed, "{:?}", q.reason);
    assert!(q.would_fill, "{:?}", q.fill_reason);
    assert_eq!((q.score_e2.0, q.reading_e2.0, q.buy_e2.0, q.sell_e2.0, q.spread_bps.0), (40_000, 42_000, 40_880, 40_000, 220));
    assert_eq!((q.entry_e2.0, q.fee.0, q.finder_fee.0, q.cost.0), (40_880, USDG as u128, USDG as u128 / 2, 101 * USDG as u128));
    assert_eq!((q.liquidation_e2.0, q.cap_e2.0, q.max_profit.0), (27_253, 163_520, 900 * USDG as u128));
    // Closed at once at the sell price, 400.00: 300 × (400 / 408.8 − 1) = −6.4579…
    assert_eq!(q.value_on_fill.0, 93_542_074);

    let id = t.open(&alice(), m, Side::Long, 3, STAKE, 41_000);
    assert_eq!(t.bal(&alice()), alice0 - 101 * USDG, "stake and fee are debited at the order");
    assert_eq!((t.vault().margin.0, t.vault().reserved.0), (101 * USDG as u128, 0));
    t.now += 10;
    t.reread(m);
    assert_eq!(t.crank(&bob(), &[id]), ["filled"]);
    let p = t.pos(id).unwrap();
    assert_eq!(p.state, PositionState::Open);
    assert_eq!((n(p.entry_e2), n(p.liquidation_e2), n(p.cap_e2), p.reserved.0), (40_880, 27_253, 163_520, 900_000_000));
    assert_eq!(t.bal(&finder()) - finder0, 500_000, "half the fee to the finder");
    assert_eq!(t.bal(&treasury()) - treasury0, 500_000, "half to the treasury");
    assert_eq!((t.vault().margin.0, t.vault().reserved.0), (100 * USDG as u128, 900 * USDG as u128));

    t.walk(m, 48_000, 47_000);
    t.now += 10;
    t.close(&alice(), id, 47_000);
    t.now += 10;
    t.reread(m);
    assert_eq!(t.crank(&carol(), &[id]), ["closed"]);
    let h = t.last_closed(&alice());
    assert_eq!((h.reason.as_str(), h.entry_e2.0, h.exit_e2.0), ("close", 40_880, 47_641));
    assert_eq!(h.payout.0, 149_615_949);
    assert_eq!(h.payout.0 / 10_000, 14_961, "149.61");
    assert_eq!(t.bal(&alice()), alice0 - 101 * USDG + 149_615_949);
    let v = t.vault();
    assert_eq!((v.assets.0, v.reserved.0, v.margin.0), (VAULT as u128 - 49_615_949, 0, 0));
    assert!(t.pos(id).is_none());
}

/// Opens at the first print, closes at the second. Returns the entry, the
/// exit, the payout and the fee's split (finder, treasury).
fn round_trip(side: Side, leverage: u8, first: (u64, u64), second: (u64, u64), with_finder: bool) -> (u64, u64, u64, u64, u64) {
    let mut t = T::new();
    t.seed(VAULT, POOL);
    let m = t.list(REF_A, if with_finder { Some(finder()) } else { None });
    t.push(m, first.0, first.1);
    t.faucet(&alice(), 10_000 * USDG);
    let (f0, t0) = (t.bal(&finder()), t.bal(&treasury()));
    let id = t.filled(&alice(), m, side, leverage, STAKE);
    let entry = n(t.pos(id).unwrap().entry_e2);
    let fees = (t.bal(&finder()) - f0, t.bal(&treasury()) - t0);
    t.walk(m, second.0, second.1);
    t.now += 10;
    t.close(&alice(), id, if side == Side::Long { ANY_SHORT } else { ANY_LONG });
    t.now += 10;
    t.reread(m);
    assert_eq!(t.crank(&keeper(), &[id]), ["closed"]);
    let h = t.last_closed(&alice());
    (entry, h.exit_e2.0, h.payout.0 as u64, fees.0, fees.1)
}

#[test]
fn worked_example_both_sides_at_2x_and_3x() {
    let (up, down) = ((40_000, 42_000), (48_000, 47_000));
    // Longs: in at the buy price 408.80, out at the sell price 476.41.
    assert_eq!(round_trip(Side::Long, 3, up, down, true), (40_880, 47_641, 149_615_949, 500_000, 500_000));
    assert_eq!(round_trip(Side::Long, 2, up, down, true), (40_880, 47_641, 133_077_299, 500_000, 500_000));
    // Shorts the same way: in at the sell price 400, out at the buy price 480.
    assert_eq!(round_trip(Side::Short, 3, up, down, true), (40_000, 48_000, 40_000_000, 500_000, 500_000));
    assert_eq!(round_trip(Side::Short, 2, up, down, true), (40_000, 48_000, 60_000_000, 500_000, 500_000));
    // Shorts the other way: in at 476.41, out at 408.80.
    assert_eq!(round_trip(Side::Short, 3, down, up, true), (47_641, 40_880, 142_574_673, 500_000, 500_000));
    assert_eq!(round_trip(Side::Short, 2, down, up, true), (47_641, 40_880, 128_383_115, 500_000, 500_000));
}

#[test]
fn a_market_with_no_finder_pays_the_whole_fee_to_the_treasury() {
    let r = round_trip(Side::Long, 3, (40_000, 42_000), (48_000, 47_000), false);
    assert_eq!((r.3, r.4), (0, USDG));
    assert_eq!(r.2, 149_615_949);
}

// ------------------------------------------------------- fill timing

/// Prints Q1 (read before the order), then Q2, Q3, Q4 at five-minute
/// intervals. However late `crank` is called, and whoever calls it, the
/// order fills at Q2.
#[test]
fn an_order_fills_at_the_earliest_quote_read_after_it() {
    for late in [0u64, 1, 2] {
        let (mut t, m) = setup(50_000, 50_000);
        t.now += 10;
        let id = t.open(&alice(), m, Side::Long, 3, STAKE, ANY_LONG);
        t.now += 2;
        assert_eq!(t.crank(&alice(), &[id]), ["waiting"], "the print read before the order does not count");
        let q2 = t.next(m, 51_000, 52_000);
        for i in 0..late {
            t.next(m, 55_000 + 1_000 * i, 56_000);
        }
        t.now += 1_000;
        let who = [carol(), keeper(), alice()][late as usize].clone();
        assert_eq!(t.crank(&who, &[id]), ["filled"]);
        let p = t.pos(id).unwrap();
        assert_eq!(n(p.fill_print_id), q2);
        // Q2: S 510, R 520, gap 196.08 → 197 bps, lambda 3,552, lead 513.552 → 513.56.
        assert_eq!(n(p.entry_e2), 51_356);
        let q2_read = t.c.get_market(m).unwrap().quotes.iter().find(|q| q.print_id.0 == q2).unwrap().first_read_at;
        assert_eq!(n(p.opened_at), q2_read.0);
    }
}

/// A print read before the order, or read again inside `min_fill_delay_secs`
/// of it, is not used; read again after that, it is.
#[test]
fn a_quote_read_before_the_order_does_not_fill_it() {
    let (mut t, m) = setup(50_000, 50_000);
    let placed = t.now + 100;
    t.now = placed;
    let id = t.open(&alice(), m, Side::Long, 2, STAKE, ANY_LONG);
    t.now = placed + 4;
    t.reread(m);
    assert_eq!(t.crank(&bob(), &[id]), ["waiting"], "read 4 s after the order: inside the delay");
    t.now = placed + 5;
    t.reread(m);
    assert_eq!(t.crank(&bob(), &[id]), ["filled"], "read 5 s after: the same print fills it");
    let p = t.pos(id).unwrap();
    assert_eq!((n(p.entry_e2), n(p.opened_at)), (50_000, placed + 5));
}

/// A first quote that arrives after the order's time to live refunds it,
/// however late the crank.
#[test]
fn a_quote_after_the_time_to_live_refunds_the_order() {
    let (mut t, m) = setup(50_000, 50_000);
    let placed = t.now + 10;
    t.now = placed;
    let id = t.open(&alice(), m, Side::Long, 3, STAKE, ANY_LONG);
    let before = t.bal(&alice());
    t.now = placed + 901;
    t.push(m, 50_100, 50_100);
    assert_eq!(t.crank(&bob(), &[id]), ["refunded"]);
    assert_eq!(t.bal(&alice()), before + 101 * USDG);
    assert_eq!(refunded(id), "expired");
    assert!(t.c.history_of(alice()).is_empty(), "a refunded order is not history");
}

/// A quote that has left the ring before anyone cranked the order refunds it.
#[test]
fn an_order_whose_quote_left_the_ring_is_refunded() {
    let (mut t, m) = setup(50_000, 50_000);
    t.now += 10;
    let id = t.open(&alice(), m, Side::Long, 3, STAKE, ANY_LONG);
    for _ in 0..RING {
        t.next(m, 50_000, 50_000);
    }
    assert_eq!(t.c.get_market(m).unwrap().quotes.len(), RING);
    assert_eq!(t.crank(&bob(), &[id]), ["filled"], "its quote is the oldest still in the ring");
    let id2 = t.open(&alice(), m, Side::Long, 3, STAKE, ANY_LONG);
    for _ in 0..=RING {
        t.next(m, 50_000, 50_000);
    }
    assert_eq!(t.crank(&bob(), &[id2]), ["refunded"]);
    assert_eq!(refunded(id2), "rolled_out");
}

// ------------------------------------------------------------ refunds

/// An order whose limit can't be met is refunded in full, fee included, and
/// reserves nothing at any point.
#[test]
fn a_limit_that_cannot_be_met_refunds_in_full_and_reserves_nothing() {
    let (mut t, m) = setup(50_000, 50_000);
    let before = t.bal(&alice());
    let long = t.open(&alice(), m, Side::Long, 3, 250 * USDG, 49_999);
    let short = t.open(&alice(), m, Side::Short, 3, 250 * USDG, 50_001);
    assert_eq!(t.vault().reserved.0, 0);
    t.now += 10;
    t.reread(m);
    assert_eq!(t.vault().reserved.0, 0);
    assert_eq!(t.crank(&bob(), &[long, short]), ["refunded", "refunded"]);
    assert_eq!(t.vault().reserved.0, 0);
    assert_eq!(t.bal(&alice()), before, "stake and fee back to the unit");
    let logs = logs_with("order_refunded");
    assert_eq!(logs.len(), 2);
    assert!(logs[0].contains(r#""amount":"252500000","reason":"limit""#), "{}", logs[0]);
    assert_eq!((refunded(long), refunded(short)), ("limit".to_string(), "limit".to_string()));
    assert!(t.c.history_of(alice()).is_empty());
    assert!(t.c.positions_of(alice()).is_empty());
}

/// Two 3x longs of 100 reserve 1,800, the whole per-side cap of a vault of
/// 90,000: a third is refunded as "market full" at the fill. The short side
/// has its own cap.
#[test]
fn market_full_is_a_refund_at_the_fill() {
    let mut t = T::new();
    t.seed(90_000 * USDG, POOL);
    let m = t.list(REF_A, None);
    t.push(m, 50_000, 50_000);
    for who in [alice(), bob()] {
        t.faucet(&who, 10_000 * USDG);
    }
    let a = t.open(&alice(), m, Side::Long, 3, STAKE, ANY_LONG);
    let b = t.open(&bob(), m, Side::Long, 3, STAKE, ANY_LONG);
    let c = t.open(&bob(), m, Side::Long, 3, STAKE, ANY_LONG);
    let s = t.open(&alice(), m, Side::Short, 3, STAKE, ANY_SHORT);
    let q = t.view().quote_open(m, Side::Long, 3, u(STAKE), None);
    assert!(q.would_fill, "the cap is not full before the fills");
    t.now += 10;
    t.reread(m);
    assert_eq!(t.crank(&carol(), &[a, b, c, s]), ["filled", "filled", "refunded", "filled"]);
    assert_eq!(refunded(c), "market_full");
    let mk = t.c.get_market(m).unwrap();
    assert_eq!(
        (mk.long.reserved.0, mk.side_cap.0, mk.long.count, mk.short.count),
        (1_800 * USDG as u128, 1_800 * USDG as u128, 2, 1)
    );
    let q = t.view().quote_open(m, Side::Long, 3, u(STAKE), None);
    assert!(q.allowed, "open does not check the caps: the fill does");
    assert_eq!((q.would_fill, q.fill_reason.as_deref()), (false, Some("market_full")));

    // The total cap: 1 % of the vault in all.
    t.call(&owner(), |c| {
        c.set_config(ConfigPatch { market_cap_bps: Some(10_000), utilisation_cap_bps: Some(100), ..Default::default() })
    });
    let d = t.open(&alice(), m, Side::Short, 2, STAKE, ANY_SHORT);
    t.now += 10;
    t.reread(m);
    assert_eq!(t.crank(&carol(), &[d]), ["refunded"], "1,800 + 300 + 200 is above 900");
    assert_eq!(refunded(d), "market_full");
}

/// Two prices more than 10 % apart: `open` refuses the order; an order
/// placed while they were close is refunded if they are apart at its fill.
#[test]
fn the_open_guard_applies_at_the_order_and_at_the_fill() {
    let (mut t, m) = setup(50_000, 50_000);
    let id = t.open(&alice(), m, Side::Long, 3, STAKE, ANY_LONG);
    // S 500, R 600: gap 20 %, lambda 0.86, lead 586: the prices are 17.2 % apart.
    t.next(m, 50_000, 60_000);
    let q = t.c.get_market(m).unwrap().quote.unwrap();
    assert_eq!((q.buy_e2.0, q.spread_bps.0), (58_600, 1_720));
    let before = t.bal(&alice());
    assert_eq!(t.crank(&bob(), &[id]), ["refunded"]);
    assert_eq!(refunded(id), "spread");
    assert_eq!(t.bal(&alice()), before + 101 * USDG);
    t.fails(&alice(), "the two prices are too far apart", |c| {
        c.open(m, Side::Short, 3, u(STAKE), U64(ANY_SHORT));
    });
    let q = t.view().quote_open(m, Side::Short, 3, u(STAKE), Some(alice()));
    assert_eq!((q.allowed, q.reason.as_deref()), (false, Some("the two prices are too far apart")));
    assert_eq!(q.fill_reason.as_deref(), Some("spread"));
    // With lambda at 1 the lead is the reading: exactly 10 % apart is allowed.
    t.call(&owner(), |c| c.set_config(ConfigPatch { lead_min_bps: Some(10_000), ..Default::default() }));
    t.next(m, 50_000, 55_000);
    assert_eq!(t.c.get_market(m).unwrap().quote.unwrap().spread_bps.0, 1_000);
    assert!(t.view().quote_open(m, Side::Long, 3, u(STAKE), None).allowed);
    t.next(m, 50_000, 55_001);
    assert!(!t.view().quote_open(m, Side::Long, 3, u(STAKE), None).allowed);
}

// -------------------------------------------------------------- closes

/// A close inside its limit settles at the first quote read after it; past
/// its limit the position goes back to Open, and the trader asks again.
#[test]
fn a_close_settles_inside_its_limit_or_goes_back_to_open() {
    let (mut t, m) = setup(50_000, 50_000);
    let id = t.filled(&alice(), m, Side::Long, 3, STAKE);
    t.now += 30;
    t.close(&alice(), id, 49_000);
    assert_eq!(t.pos(id).unwrap().state, PositionState::Closing);
    assert_eq!(t.crank(&bob(), &[id]), ["waiting"], "no quote read after the request yet");
    // The next print reads 480 with the reading at 470: the sell price 476.41 is below the limit.
    t.next(m, 48_000, 47_000);
    assert_eq!(t.crank(&bob(), &[id]), ["close_missed"]);
    let missed = logs_with("close_missed");
    assert!(missed[0].contains(r#""price_e2":"47641","limit_e2":"49000","reason":"limit""#), "{}", missed[0]);
    let p = t.pos(id).unwrap();
    assert_eq!((p.state, p.close_limit_e2, p.close_requested_at), (PositionState::Open, None, None));
    // The trader asks again with a limit the next print meets.
    t.now += 30;
    t.close(&alice(), id, 47_000);
    t.next(m, 48_500, 48_500);
    let before = t.bal(&alice());
    assert_eq!(t.crank(&bob(), &[id]), ["closed"]);
    // 100 + 300 × (485 − 500) / 500 = 91.
    assert_eq!(t.bal(&alice()) - before, 91 * USDG);
    assert_eq!(t.last_closed(&alice()).exit_e2.0, 48_500);
}

/// There is no way to withdraw a close, and an order can be cancelled only
/// after its time to live, and only with no quote to fill at.
#[test]
fn a_close_cannot_be_withdrawn_and_an_order_waits_for_its_ttl() {
    let (mut t, m) = setup(50_000, 50_000);
    let id = t.filled(&alice(), m, Side::Short, 2, STAKE);
    t.close(&alice(), id, ANY_LONG);
    t.fails(&alice(), "position is not open", |c| c.close(U64(id), U64(60_000)));
    t.fails(&alice(), "order is not pending", |c| c.cancel(U64(id)));
    t.fails(&bob(), "not your position", |c| c.close(U64(id), U64(1)));

    let placed = t.now;
    let o = t.open(&alice(), m, Side::Long, 3, STAKE, ANY_LONG);
    t.fails(&bob(), "not your position", |c| c.cancel(U64(o)));
    t.now = placed + 899;
    t.fails(&alice(), "an order can be cancelled only once its time to live has passed", |c| c.cancel(U64(o)));
    t.now = placed + 900;
    let before = t.bal(&alice());
    t.call(&alice(), |c| c.cancel(U64(o)));
    assert_eq!(t.bal(&alice()) - before, 101 * USDG);
    assert_eq!(refunded(o), "cancelled");

    // An order with a quote to fill at can't be cancelled; crank decides it.
    t.next(m, 50_000, 50_000);
    let placed = t.now;
    let o = t.open(&alice(), m, Side::Long, 3, STAKE, 1);
    t.now += 10;
    t.reread(m);
    t.now = placed + 1_000;
    t.fails(&alice(), "order has a quote to fill at", |c| c.cancel(U64(o)));
    assert_eq!(t.crank(&alice(), &[o]), ["refunded"]);
    assert_eq!(refunded(o), "limit");
}

// -------------------------------------------------------- liquidation

/// A 3x long from 600 is liquidated when the buy price is at or below 400:
/// the score and the lead both. A low reading alone leaves the score above
/// the level, so nothing happens; the position shows as at risk.
#[test]
fn a_long_is_liquidated_only_when_both_prices_reach_the_level() {
    let (mut t, m) = setup(60_000, 60_000);
    let id = t.filled(&alice(), m, Side::Long, 3, STAKE);
    assert_eq!(n(t.pos(id).unwrap().liquidation_e2), 40_000);
    // 310 s after the stored print the score may move 15.5 %: to 507. The
    // reading pulls the lead, and the sell price, to 100.
    t.next(m, 50_000, 10_000);
    let q = t.c.get_market(m).unwrap().quote.unwrap();
    assert_eq!((q.score_e2.0, q.pushed_score_e2.0, q.buy_e2.0, q.sell_e2.0), (50_700, 50_000, 50_700, 10_000));
    assert_eq!(t.crank(&bob(), &[id]), ["waiting"]);
    let p = t.pos(id).unwrap();
    assert_eq!((p.value.unwrap().0, p.at_risk), (0, true));
    t.walk(m, 40_001, 39_000);
    assert_eq!(t.crank(&bob(), &[id]), ["waiting"], "the buy price 400.01 is above the level");
    let v0 = t.vault();
    t.next(m, 40_000, 39_000);
    assert_eq!(t.crank(&carol(), &[id]), ["liquidated"]);
    assert_eq!(t.bal(&carol()), USDG, "1 % of the stake to the caller");
    let v = t.vault();
    assert_eq!(v.assets.0 - v0.assets.0, 99 * USDG as u128, "the rest of the stake to the vault");
    assert_eq!(v0.reserved.0 - v.reserved.0, 900 * USDG as u128, "the reserve is released");
    let h = t.last_closed(&alice());
    // Recorded at the close-side price of that quote: the sell price 396.30.
    assert_eq!((h.reason.as_str(), h.payout.0, h.exit_e2.0), ("liquidation", 0, 39_630));
    let logs = logs_with("position_closed");
    assert!(logs[0].contains(r#""reason":"liquidation","print_id":""#), "{}", logs[0]);
    assert!(logs[0].contains(r#""reward":"1000000","caller":"carol.near""#), "{}", logs[0]);
}

/// A 3x short from 600 is liquidated when the sell price is at or above 800.
#[test]
fn a_short_is_liquidated_only_when_both_prices_reach_the_level() {
    let (mut t, m) = setup(60_000, 60_000);
    let id = t.filled(&alice(), m, Side::Short, 3, STAKE);
    assert_eq!(n(t.pos(id).unwrap().liquidation_e2), 80_000);
    t.next(m, 70_000, 400_000);
    let q = t.c.get_market(m).unwrap().quote.unwrap();
    assert_eq!((q.score_e2.0, q.sell_e2.0, q.buy_e2.0), (69_300, 69_300, 400_000));
    assert_eq!(t.crank(&bob(), &[id]), ["waiting"], "a high reading alone does not liquidate");
    t.walk(m, 79_999, 81_000);
    assert_eq!(t.crank(&bob(), &[id]), ["waiting"]);
    t.next(m, 80_000, 81_000);
    assert_eq!(t.crank(&bob(), &[id]), ["liquidated"]);
    assert_eq!(t.bal(&bob()), 10_000 * USDG + USDG);
    assert_eq!(t.vault().reserved.0, 0);
}

/// A 3x long from 500 reaches its cap (a payout of ten times the stake) when
/// the sell price is 2,000; it is closed there.
#[test]
fn a_long_is_closed_at_the_cap() {
    let (mut t, m) = setup(50_000, 50_000);
    let id = t.filled(&alice(), m, Side::Long, 3, STAKE);
    assert_eq!(n(t.pos(id).unwrap().cap_e2), 200_000);
    t.walk(m, 100_000, 100_000);
    t.next(m, 100_000, 10_000_000);
    assert_eq!(t.crank(&bob(), &[id]), ["waiting"], "a high reading alone does not reach the cap");
    t.walk(m, 199_999, 199_999);
    assert_eq!(t.crank(&bob(), &[id]), ["waiting"]);
    let before = t.bal(&alice());
    t.next(m, 200_000, 200_000);
    assert_eq!(t.crank(&bob(), &[id]), ["closed"]);
    assert_eq!(t.bal(&alice()) - before, 1_000 * USDG);
    let h = t.last_closed(&alice());
    assert_eq!((h.reason.as_str(), h.exit_e2.0), ("cap", 200_000));
    assert_eq!(t.vault().assets.0, VAULT as u128 - 900 * USDG as u128);
}

/// With the maximum profit set to 1.5 × stake, a 3x short from 600 is
/// capped once the buy price is 300.
#[test]
fn a_short_is_closed_at_the_cap() {
    let (mut t, m) = setup(60_000, 60_000);
    t.call(&owner(), |c| c.set_config(ConfigPatch { max_profit_bps: Some(15_000), ..Default::default() }));
    let id = t.filled(&alice(), m, Side::Short, 3, STAKE);
    let p = t.pos(id).unwrap();
    assert_eq!((p.reserved.0, n(p.cap_e2)), (150 * USDG as u128, 30_000));
    t.walk(m, 30_001, 30_001);
    assert_eq!(t.crank(&bob(), &[id]), ["waiting"]);
    let before = t.bal(&alice());
    t.next(m, 30_000, 30_000);
    assert_eq!(t.crank(&bob(), &[id]), ["closed"]);
    assert_eq!(t.bal(&alice()) - before, 250 * USDG);
}

/// After `max_position_secs` a position closes through the close path: at
/// the first quote read after its end, with no limit, however late anyone
/// cranks it.
#[test]
fn a_position_ends_after_14_days_at_the_first_quote_after_its_end() {
    let (mut t, m) = setup(50_000, 50_000);
    let a = t.filled(&alice(), m, Side::Long, 3, STAKE);
    let b = t.filled(&bob(), m, Side::Long, 3, STAKE);
    let end = n(t.pos(a).unwrap().expires_at);
    assert_eq!(end, n(t.pos(a).unwrap().opened_at) + 14 * DAY);
    assert_eq!(n(t.pos(b).unwrap().expires_at), end + 10);
    t.now = end - 100;
    t.push(m, 52_000, 52_000);
    t.now = end + 10;
    t.fails(&bob(), "position has reached its end and is closing", |c| c.close(U64(b), U64(1)));
    assert_eq!(t.crank(&keeper(), &[a]), ["closing"]);
    let p = t.pos(a).unwrap();
    assert_eq!((p.state, n(p.close_requested_at), p.close_limit_e2), (PositionState::Closing, end, None));
    assert!(logs_with("close_requested")[0].contains(r#""by":"expiry""#));
    t.fails(&alice(), "position is not open", |c| c.close(U64(a), U64(1)));
    t.next(m, 55_000, 55_000);
    t.next(m, 58_000, 58_000);
    let (a0, b0) = (t.bal(&alice()), t.bal(&bob()));
    assert_eq!(t.crank(&keeper(), &[a, b]), ["closed", "closed"]);
    // 100 + 300 × (550 − 500) / 500 = 130 for both, however late the crank.
    assert_eq!((t.bal(&alice()) - a0, t.bal(&bob()) - b0), (130 * USDG, 130 * USDG));
    assert_eq!(t.last_closed(&bob()).reason, "expiry");
}

// --------------------------------------------------------- push rules

/// One entry that breaks a rule never fails a push: it is skipped and
/// counted, and the rest of the batch is applied.
#[test]
fn a_push_skips_and_counts_entries_that_break_a_rule() {
    let (mut t, m) = setup(10_000, 10_000);
    let other = t.list(REF_B, None);
    t.now += 300;
    let now = t.now;
    let batch = vec![
        qin(m, 10_500, 10_400, 1_001, now - 10, now),     // a new print: accepted
        qin(99, 10_000, 10_000, 1_002, now, now),         // an unknown market
        qin(m, 10_000, 10_000, 999, now - 20, now),       // an older print
        qin(m, 10_600, 10_400, 1_001, now - 10, now),     // the same print with other numbers
        qin(m, 10_500, 10_400, 1_001, now - 10, now - 5), // a read time going back
        qin(m, 10_500, 10_400, 1_001, now - 10, now + 1), // a read time after the block time
        qin(other, 20_000, 20_000, 1_003, now + 1, now),  // a print time after the block time
        qin(other, 20_000, 20_000, 1_003, now - 1, now),  // a first print: accepted
        qin(m, 10_500, 10_400, 1_001, now - 10, now),     // the same print read again: accepted
    ];
    let r = t.call(&keeper(), |c| c.push_quotes(batch, commitment()));
    assert_eq!(r, PushResult { count: 9, accepted: 3, skipped: 6 });
    let ev = logs_with("quotes_pushed");
    assert_eq!(ev.len(), 1, "one event for the whole batch");
    assert!(
        ev[0].ends_with(&format!(
            r#""data":[{{"count":"9","accepted":"3","skipped":"6","first_print_id":"999","last_print_id":"1003","commitment":"{}"}}]}}"#,
            commitment()
        )),
        "{}",
        ev[0]
    );
    let q = t.c.get_market(m).unwrap().quote.unwrap();
    assert_eq!((q.print_id.0, q.score_e2.0, q.reading_e2.0, q.last_read_at.0), (1_001, 10_500, 10_400, now));
    assert_eq!(t.score(other), 20_000);

    // The call itself fails only for another caller or a bad commitment.
    for who in [owner(), alice(), treasury()] {
        t.fails(&who, "not the keeper", |c| {
            c.push_quotes(vec![], commitment());
        });
    }
    let bad = "commitment must be 64 lowercase hex characters";
    t.fails(&keeper(), bad, |c| {
        c.push_quotes(vec![], "AB".repeat(32));
    });
    t.fails(&keeper(), bad, |c| {
        c.push_quotes(vec![], "ab".repeat(31));
    });
    let r = t.call(&keeper(), |c| c.push_quotes(vec![], commitment()));
    assert_eq!(r, PushResult { count: 0, accepted: 0, skipped: 0 });
    // Entries past the first MAX_QUOTES_PER_PUSH are skipped.
    t.now += 1;
    let now = t.now;
    let at = q.print_at.0;
    let many: Vec<QuoteIn> = (0..MAX_QUOTES_PER_PUSH + 3).map(|_| qin(m, 10_500, 10_400, 1_001, at, now)).collect();
    let r = t.call(&keeper(), |c| c.push_quotes(many, commitment()));
    assert_eq!(r, PushResult { count: MAX_QUOTES_PER_PUSH as u32 + 3, accepted: MAX_QUOTES_PER_PUSH as u32, skipped: 3 });
}

/// A new print's score moves with the print's own time, at most 15 % per
/// five minutes however many prints arrive, and a print 2–3 minutes after
/// the last one can be pushed at once.
#[test]
fn the_score_moves_with_the_print_time_however_many_prints_arrive() {
    let (mut t, m) = setup(100_000, 100_000);
    // The second print of the hour, 150 s after the first: 7.5 % at most.
    t.now += 150;
    t.push(m, 120_000, 120_000);
    let q = t.c.get_market(m).unwrap().quote.unwrap();
    assert_eq!((q.score_e2.0, q.pushed_score_e2.0), (107_500, 120_000));
    // Ten prints 30 s apart: 1.5 % each, about 16 % over the five minutes.
    let mut expect = 107_500u64;
    for _ in 0..10 {
        t.now += 30;
        t.push(m, 200_000, 200_000);
        expect += expect * 150 / 10_000;
        assert_eq!(t.score(m), expect);
    }
    assert!(expect * 100 < 107_500 * 117, "{expect}");
    // One second later: the 10 bps minimum.
    t.now += 1;
    t.push(m, 300_000, 300_000);
    assert_eq!(t.score(m), expect + expect / 1_000);
    // A print not later than the stored one is skipped, whatever its id.
    let stored = t.c.get_market(m).unwrap().quote.unwrap();
    t.now += 60;
    let now = t.now;
    let r = t.call(&keeper(), |c| c.push_quotes(vec![qin(m, 1, 1, 5_000, stored.print_at.0, now)], commitment()));
    assert_eq!(r.skipped, 1);
    assert_eq!(t.c.get_market(m).unwrap().quote.unwrap().print_id, stored.print_id);
    // On the way down the same rule applies: eleven minutes after the
    // stored print, 33 %.
    t.now += 600;
    t.push(m, 1_000, 1_000);
    let s0 = expect + expect / 1_000;
    assert_eq!(t.score(m), s0 - s0 * 3_300 / 10_000);
}

/// The ring keeps the numbers as pushed next to the clipped score, so a
/// clipped print can be read again with its own numbers.
#[test]
fn a_clipped_print_is_read_again_with_its_pushed_numbers() {
    let (mut t, m) = setup(10_000, 10_000);
    let id = t.next(m, 20_000, 11_600);
    let q = t.c.get_market(m).unwrap().quote.unwrap();
    assert_eq!((q.score_e2.0, q.pushed_score_e2.0, q.reading_e2.0), (11_500, 20_000, 11_600));
    let print_at = q.print_at.0;
    let o = t.open(&alice(), m, Side::Short, 2, STAKE, ANY_SHORT);
    t.now += 20;
    let now = t.now;
    let r = t.call(&keeper(), |c| c.push_quotes(vec![qin(m, 20_000, 11_600, id, print_at, now)], commitment()));
    assert_eq!((r.accepted, r.skipped), (1, 0));
    let mk = t.c.get_market(m).unwrap();
    let q = mk.quote.unwrap();
    assert_eq!((mk.quotes.len(), q.score_e2.0, q.last_read_at.0, q.first_read_at.0), (2, 11_500, now, print_at));
    // The clipped score is not what was pushed: that entry is skipped.
    let r = t.call(&keeper(), |c| c.push_quotes(vec![qin(m, 11_500, 11_600, id, print_at, now)], commitment()));
    assert_eq!((r.accepted, r.skipped), (0, 1));
    // The order placed before the re-read fills at the clipped print's prices.
    assert_eq!(t.crank(&bob(), &[o]), ["filled"]);
    assert_eq!(n(t.pos(o).unwrap().entry_e2), 11_500, "a short opens at the sell price, the clipped score");
}

// ------------------------------------------------------------ markets

/// A reference whose market is settled is listed again as a new market;
/// one whose market is open or close-only is refused.
#[test]
fn a_settled_reference_is_listed_again_as_a_new_market() {
    let (mut t, m) = setup(50_000, 50_000);
    let live = U64(t.now - 3 * DAY);
    t.fails(&keeper(), "already listed", |c| {
        c.list_market(REF_A.to_string(), None, live);
    });
    t.call(&keeper(), |c| c.set_market(m, Some(MarketStatus::CloseOnly), None));
    t.fails(&keeper(), "already listed", |c| {
        c.list_market(REF_A.to_string(), None, live);
    });
    t.now += DAY;
    t.call(&carol(), |c| c.settle_stale(m));
    let m2 = t.list(REF_A, Some(finder()));
    assert_eq!(m2, m + 1);
    assert!(logs_with("market_listed")[0].contains(&format!(r#""replaces":"{m}""#)));
    assert_eq!(t.c.get_market_by_reference(REF_A.to_string()).unwrap().id, m2);
    assert_eq!(t.c.get_market(m).unwrap().status, MarketStatus::Settled, "the old market stays settled");
    t.push(m2, 60_000, 60_000);
    let id = t.filled(&alice(), m2, Side::Long, 3, STAKE);
    assert_eq!(n(t.pos(id).unwrap().entry_e2), 60_000);
    t.fails(&keeper(), "already listed", |c| {
        c.list_market(REF_A.to_string(), None, live);
    });
    t.fails(&keeper(), "reference must be 32 lowercase hex characters", |c| {
        c.list_market(REF_A.to_uppercase(), None, live);
    });
    t.fails(&keeper(), "reference must be 32 lowercase hex characters", |c| {
        c.list_market(REF_A[..31].to_string(), None, live);
    });
    let future = U64(t.now + 1);
    t.fails(&keeper(), "live_since is after the block time", |c| {
        c.list_market(REF_B.to_string(), None, future);
    });
}

/// After `emergency_secs` without a read anyone can settle a market at its
/// last score: every position closes at that one price and pending orders
/// are refunded. A close that was already due settles at its own quote.
#[test]
fn a_stale_market_settles_at_its_last_score_for_everyone() {
    let (mut t, m) = setup(50_000, 50_000);
    t.faucet(&carol(), 1_000 * USDG);
    t.faucet(&dave(), 1_000 * USDG);
    let a = t.filled(&alice(), m, Side::Long, 3, STAKE);
    let b = t.filled(&bob(), m, Side::Short, 3, STAKE);
    let d = t.filled(&dave(), m, Side::Long, 2, STAKE);
    t.walk(m, 55_000, 54_000);
    // dave's close is due at a re-read nobody cranked.
    t.now += 10;
    t.close(&dave(), d, ANY_SHORT);
    t.now += 10;
    t.reread(m);
    let read = t.now;
    t.now += 1;
    let o = t.open(&carol(), m, Side::Long, 3, STAKE, ANY_LONG);
    // A re-read keeps the market fresh even with no new print.
    t.now = read + DAY - 100;
    t.reread(m);
    let read = t.now;
    t.now = read + DAY - 1;
    t.fails(&carol(), "market has had a quote within the emergency period", |c| c.settle_stale(m));
    for who in [keeper(), owner()] {
        t.fails(&who, "a market can only move from Open to CloseOnly", |c| {
            c.set_market(m, Some(MarketStatus::Settled), None)
        });
    }
    t.now = read + DAY;
    t.call(&carol(), |c| c.settle_stale(m));
    let mk = t.c.get_market(m).unwrap();
    assert_eq!((mk.status, mk.final_e2, mk.settled_at), (MarketStatus::Settled, Some(U64(55_000)), Some(U64(t.now))));
    assert!(logs_with("market_status")[0].contains(r#""status":"Settled","final_e2":"55000","by":"carol.near""#));
    t.fails(&bob(), "market is already settled", |c| c.settle_stale(m));
    t.fails(&alice(), "market is not open", |c| {
        c.open(m, Side::Long, 3, u(STAKE), U64(ANY_LONG));
    });
    let r = t.call(&keeper(), |c| c.push_quotes(vec![qin(m, 1, 1, 99_999, read, read)], commitment()));
    assert_eq!(r.skipped, 1, "a settled market takes no quotes");
    let p = t.pos(a).unwrap();
    assert_eq!(p.value, Some(u(130 * USDG)), "positions are valued at the final price");

    let (a0, b0, c0, d0) = (t.bal(&alice()), t.bal(&bob()), t.bal(&carol()), t.bal(&dave()));
    assert_eq!(t.crank(&carol(), &[a, b, d, o]), ["closed", "closed", "closed", "refunded"]);
    // One price, 550, for the long and the short alike.
    assert_eq!(t.bal(&alice()) - a0, 130 * USDG);
    assert_eq!(t.bal(&bob()) - b0, 70 * USDG);
    assert_eq!(t.last_closed(&alice()).reason, "settled");
    assert_eq!(t.last_closed(&bob()).exit_e2.0, 55_000);
    // dave's close settled at its quote, the sell price 546.49: 100 + 200 × 46.49 / 500.
    let h = t.last_closed(&dave());
    assert_eq!((h.reason.as_str(), h.exit_e2.0, h.payout.0), ("close", 54_649, 118_596_000));
    assert_eq!(t.bal(&dave()) - d0, 118_596_000);
    assert_eq!(t.bal(&carol()) - c0, 101 * USDG);
    assert_eq!(refunded(o), "market_closed");
    assert_eq!(t.c.active_count(), 0);

    // A market with no quote at all settles a day after its listing, at 0.
    let e = t.list(REF_B, None);
    t.now += DAY - 1;
    t.fails(&carol(), "market has had a quote within the emergency period", |c| c.settle_stale(e));
    t.now += 1;
    t.call(&carol(), |c| c.settle_stale(e));
    assert_eq!(t.c.get_market(e).unwrap().final_e2, Some(U64(0)));
}

/// Moving a market to CloseOnly refunds its pending orders at the next
/// crank and keeps closes and liquidations going; it never reopens.
#[test]
fn a_close_only_market_refunds_orders_and_keeps_exits() {
    let (mut t, m) = setup(50_000, 50_000);
    let a = t.filled(&alice(), m, Side::Long, 3, STAKE);
    let o = t.open(&bob(), m, Side::Long, 3, STAKE, ANY_LONG);
    t.call(&owner(), |c| c.set_market(m, Some(MarketStatus::CloseOnly), None));
    t.fails(&keeper(), "a market can only move from Open to CloseOnly", |c| {
        c.set_market(m, Some(MarketStatus::Open), None)
    });
    t.fails(&alice(), "market is not open", |c| {
        c.open(m, Side::Short, 3, u(STAKE), U64(ANY_SHORT));
    });
    t.now += 10;
    t.reread(m);
    assert_eq!(t.crank(&carol(), &[o]), ["refunded"]);
    assert_eq!(refunded(o), "market_closed");
    t.close(&alice(), a, ANY_SHORT);
    t.next(m, 52_000, 52_000);
    assert_eq!(t.crank(&carol(), &[a]), ["closed"]);
    t.fails(&keeper(), "no such market", |c| c.set_market(7, None, None));
}

// --------------------------------------------------------- the vault

/// The vault starts with dead shares at one USDG a share. The treasury
/// deposits; others only once `lp_open` is set. Exits go by notice: too
/// early fails, inside the window pays, after it the request lapses.
#[test]
fn the_vault_mints_shares_and_exits_by_notice() {
    let mut t = T::new();
    let v = t.vault();
    assert_eq!((v.shares.0, v.dead_shares.0, v.assets.0, v.share_price.0), (DEAD_SHARES, DEAD_SHARES, 0, USDG as u128));
    assert_eq!(t.c.convert_to_shares(u(USDG)).0, SHARE, "one USDG buys one share");
    t.seed(1_000_000 * USDG, POOL);
    let v = t.vault();
    assert_eq!((v.shares.0, v.share_price.0, t.c.total_assets().0), (DEAD_SHARES + 1_000_000 * SHARE, USDG as u128, 1_000_000 * USDG as u128));
    assert!(logs_with("lp_deposit").is_empty(), "the last call was the faucet deposit");
    assert_eq!(t.c.lp_of(treasury()).shares.0, 1_000_000 * SHARE);

    t.faucet(&alice(), 1_000 * USDG);
    t.fails(&alice(), "vault deposits are open to the treasury only", |c| {
        c.lp_deposit(u(100 * USDG));
    });
    t.call(&owner(), |c| c.set_config(ConfigPatch { lp_open: Some(true), ..Default::default() }));
    assert_eq!(t.call(&alice(), |c| c.lp_deposit(u(100 * USDG))).0, 100 * SHARE);
    assert!(logs_with("lp_deposit")[0].contains(r#""amount":"100000000","shares":"100000000000""#));
    t.fails(&alice(), "amount is zero", |c| {
        c.lp_deposit(u(0));
    });
    t.fails(&alice(), "balance too low", |c| {
        c.lp_deposit(u(901 * USDG));
    });
    let lp = t.c.lp_of(alice());
    assert_eq!((lp.shares.0, lp.value.0, lp.request), (100 * SHARE, 100 * USDG as u128, None));

    t.fails(&alice(), "no withdrawal request", |c| {
        c.lp_withdraw();
    });
    t.fails(&alice(), "not enough shares", |c| c.lp_request_withdraw(U128(100 * SHARE + 1)));
    t.fails(&alice(), "amount is zero", |c| c.lp_request_withdraw(U128(0)));
    t.call(&alice(), |c| c.lp_request_withdraw(U128(50 * SHARE)));
    let ready = t.now + DAY;
    let r = t.view().lp_of(alice()).request.unwrap();
    assert_eq!((r.ready_at.0, r.closes_at.0, r.state.as_str()), (ready, ready + 3_600, "waiting"));
    t.fails(&alice(), "withdrawal request is not ready yet", |c| {
        c.lp_withdraw();
    });
    t.fails(&alice(), "a withdrawal request is already pending", |c| c.lp_request_withdraw(U128(1)));
    assert_eq!(t.view().max_withdraw(alice()).0, 0);
    t.now = ready - 1;
    t.fails(&alice(), "withdrawal request is not ready yet", |c| {
        c.lp_withdraw();
    });
    t.now = ready;
    assert_eq!(t.view().max_withdraw(alice()).0, 50 * USDG as u128);
    let before = t.bal(&alice());
    assert_eq!(t.call(&alice(), |c| c.lp_withdraw()).0, 50 * USDG as u128);
    assert_eq!(t.bal(&alice()) - before, 50 * USDG);
    assert_eq!(t.c.lp_of(alice()).shares.0, 50 * SHARE);
    assert!(t.c.lp_of(alice()).request.is_none());

    // A request not used inside its window lapses; the shares stay.
    t.call(&alice(), |c| c.lp_request_withdraw(U128(20 * SHARE)));
    let ready = t.now + DAY;
    t.now = ready + 3_600;
    assert_eq!(t.view().lp_of(alice()).request.unwrap().state, "ready", "the last second of the window");
    t.now = ready + 3_601;
    assert_eq!(t.view().lp_of(alice()).request.unwrap().state, "lapsed");
    assert_eq!(t.view().max_withdraw(alice()).0, 0);
    assert_eq!(t.call(&alice(), |c| c.lp_withdraw()).0, 0);
    assert!(logs_with("lp_withdraw_lapsed")[0].contains(r#""shares":"20000000000""#));
    assert!(t.c.lp_of(alice()).request.is_none());
    assert_eq!(t.c.lp_of(alice()).shares.0, 50 * SHARE);
    // A lapsed request is replaced by a new one without a lapse call too.
    t.call(&alice(), |c| c.lp_request_withdraw(U128(SHARE)));
    t.now += DAY + 4_000;
    t.call(&alice(), |c| c.lp_request_withdraw(U128(2 * SHARE)));
    assert_eq!(t.c.lp_of(alice()).request.unwrap().shares.0, 2 * SHARE);
}

/// Share holders take out unreserved assets only, and the share price
/// moves only when a position ends.
#[test]
fn share_holders_take_out_unreserved_assets_only() {
    let mut t = T::new();
    t.seed(100_000 * USDG, POOL);
    let m = t.list(REF_A, None);
    t.push(m, 50_000, 50_000);
    t.faucet(&alice(), 1_000 * USDG);
    let id = t.filled(&alice(), m, Side::Long, 3, 200 * USDG);
    assert_eq!(t.vault().reserved.0, 1_800 * USDG as u128);
    let all = t.c.lp_of(treasury()).shares.0;
    t.call(&treasury(), |c| c.lp_request_withdraw(U128(all)));
    t.now += DAY;
    assert_eq!(t.view().max_withdraw(treasury()).0, 0);
    t.fails(&treasury(), "not enough unreserved assets in the vault", |c| {
        c.lp_withdraw();
    });
    // An open loss is not in the price.
    let price = t.vault().share_price.0;
    t.next(m, 43_000, 42_000);
    assert!(t.pos(id).unwrap().value.unwrap().0 < 200 * USDG as u128);
    assert_eq!(t.vault().share_price.0, price);
    // Realised, it is: the stake (less the reward) joins the assets.
    t.walk(m, 33_333, 33_000);
    assert_eq!(t.crank(&bob(), &[id]), ["liquidated"]);
    let v = t.vault();
    assert_eq!((v.assets.0, v.reserved.0), (100_000 * USDG as u128 + 198 * USDG as u128, 0));
    assert!(v.share_price.0 > price);
    let paid = t.call(&treasury(), |c| c.lp_withdraw()).0;
    assert_eq!(paid, 100_197_999_999, "every share but the dead ones, rounded down");
    let v = t.vault();
    assert_eq!((v.shares.0, v.assets.0), (DEAD_SHARES, 100_000 * USDG as u128 + 198 * USDG as u128 - paid));
    assert!(v.share_price.0 > 0, "the price stays defined");
}

// --------------------------------------------------- money in and out

#[test]
fn the_token_is_taken_from_the_treasury_only() {
    let mut t = T::new();
    assert_eq!(t.transfer_call(&token(), &alice(), 5 * USDG, ""), 5 * USDG, "from anyone else: returned in full");
    assert_eq!(t.transfer_call(&token(), &alice(), 5 * USDG, "faucet"), 5 * USDG);
    assert_eq!(t.transfer_call(&acc("other-token.near"), &treasury(), 5 * USDG, ""), 5 * USDG, "another token");
    assert_eq!(t.transfer_call(&alice(), &treasury(), 5 * USDG, ""), 5 * USDG, "a direct call is another token");
    assert!(get_logs().is_empty());
    assert_eq!((t.bal(&alice()), t.bal(&treasury()), t.vault().faucet_pool.0), (0, 0, 0));
    assert_eq!(t.transfer_call(&token(), &treasury(), 7 * USDG, "anything"), 0);
    assert_eq!(t.bal(&treasury()), 7 * USDG);
    assert_eq!(
        get_logs(),
        vec![r#"EVENT_JSON:{"standard":"atnx_house","version":"1.0.0","event":"deposit","data":[{"account":"treasury.near","amount":"7000000","to":"balance"}]}"#]
    );
    assert_eq!(t.transfer_call(&token(), &treasury(), 9 * USDG, "faucet"), 0);
    assert_eq!((t.bal(&treasury()), t.vault().faucet_pool.0), (7 * USDG, 9 * USDG as u128));
    assert!(get_logs()[0].contains(r#""to":"faucet_pool""#));
}

#[test]
fn the_faucet_is_capped_per_account() {
    let mut t = T::new();
    t.seed(0, 15_000 * USDG);
    t.fails(&alice(), "amount is zero", |c| {
        c.faucet(u(0));
    });
    t.faucet(&alice(), 6_000 * USDG);
    t.fails(&alice(), "faucet limit reached for this account", |c| {
        c.faucet(u(4_000 * USDG + 1));
    });
    t.faucet(&alice(), 4_000 * USDG);
    assert!(logs_with("faucet")[0].contains(r#""amount":"4000000000","claimed":"10000000000""#));
    t.fails(&alice(), "faucet limit reached for this account", |c| {
        c.faucet(u(1));
    });
    assert_eq!((t.bal(&alice()), t.c.faucet_claimed(alice()).0), (10_000 * USDG, 10_000 * USDG as u128));
    // Spending it does not reopen the faucet.
    t.withdraw(&alice(), 10_000 * USDG, true);
    t.fails(&alice(), "faucet limit reached for this account", |c| {
        c.faucet(u(1));
    });
    t.faucet(&bob(), 5_000 * USDG);
    t.fails(&carol(), "faucet pool too low", |c| {
        c.faucet(u(1));
    });
    assert_eq!(t.transfer_call(&token(), &treasury(), 50 * USDG, "faucet"), 0);
    t.faucet(&carol(), 50 * USDG);
}

#[test]
fn withdraw_debits_first_and_refunds_a_failed_transfer() {
    let (mut t, _) = setup(50_000, 50_000);
    t.fails(&alice(), "amount is zero", |c| {
        let _ = c.withdraw(u(0));
    });
    t.fails(&alice(), "balance too low", |c| {
        let _ = c.withdraw(u(10_000 * USDG + 1));
    });
    assert_eq!(t.withdraw(&alice(), 3_000 * USDG, false), 0, "the transfer failed: re-credited");
    assert_eq!(t.bal(&alice()), 10_000 * USDG);
    assert_eq!(t.withdraw(&alice(), 3_000 * USDG, true), 3_000 * USDG);
    assert_eq!(t.bal(&alice()), 7_000 * USDG);
    assert!(logs_with("withdraw")[0].contains(r#""account":"alice.near","amount":"3000000000""#));
}

/// Under the storage floor, calls that add state stop; closes, fills,
/// cranks, quotes, withdrawals and vault exits go on.
#[test]
fn under_the_storage_floor_only_state_growth_stops() {
    let (mut t, m) = setup(50_000, 50_000);
    let a = t.filled(&alice(), m, Side::Long, 3, STAKE);
    let o = t.open(&bob(), m, Side::Long, 3, STAKE, ANY_LONG);
    // The mocked account uses 300 KB, which locks 3 NEAR: with 5 NEAR the
    // contract has 2 free, under its 3 NEAR floor.
    t.balance = NearToken::from_near(5);
    let floor = "the contract is under its storage floor";
    t.fails(&alice(), floor, |c| {
        c.open(m, Side::Long, 3, u(STAKE), U64(ANY_LONG));
    });
    t.fails(&carol(), floor, |c| {
        c.faucet(u(USDG));
    });
    t.fails(&treasury(), floor, |c| {
        c.lp_deposit(u(USDG / 10));
    });
    let live = U64(t.now - 3 * DAY);
    t.fails(&keeper(), floor, |c| {
        c.list_market(REF_B.to_string(), None, live);
    });
    assert_eq!(t.view().quote_open(m, Side::Long, 3, u(STAKE), None).reason.as_deref(), Some(floor));
    assert_eq!(t.view().get_market(m).unwrap().reason.as_deref(), Some(floor));
    // Into an existing balance or the pool, a deposit is still taken.
    assert_eq!(t.transfer_call(&token(), &treasury(), 5 * USDG, ""), 0);
    assert_eq!(t.transfer_call(&token(), &treasury(), 5 * USDG, "faucet"), 0);
    t.close(&alice(), a, ANY_SHORT);
    t.now += 10;
    t.reread(m);
    assert_eq!(t.crank(&carol(), &[a, o]), ["closed", "filled"]);
    assert_eq!(t.withdraw(&alice(), 10 * USDG, true), 10 * USDG);
    t.call(&treasury(), |c| c.lp_request_withdraw(U128(SHARE)));
    t.balance = NearToken::from_near(100);
    t.open(&alice(), m, Side::Long, 3, STAKE, ANY_LONG);

    // A deposit that would add a ledger entry under the floor is returned.
    drop(t);
    let mut t = T::new();
    t.balance = NearToken::from_near(5);
    assert_eq!(t.transfer_call(&token(), &treasury(), 5 * USDG, ""), 5 * USDG);
    assert_eq!(t.transfer_call(&token(), &treasury(), 5 * USDG, "faucet"), 0);
}

// ------------------------------------------------------ open checks

/// `open` checks every term before it debits anything, and `quote_open`
/// reports the same reason.
#[test]
fn open_checks_every_term_before_it_debits() {
    let (mut t, m) = setup(50_000, 50_000);
    let try_open = |t: &mut T, msg: &str, side: Side, lev: u8, stake: u64, limit: u64| {
        t.fails(&alice(), msg, move |c| {
            c.open(m, side, lev, u(stake), U64(limit));
        });
    };
    for lev in [0, 1, 4] {
        try_open(&mut t, "leverage must be 2 or 3", Side::Long, lev, STAKE, ANY_LONG);
    }
    try_open(&mut t, "stake below the minimum", Side::Long, 3, 10 * USDG - 1, ANY_LONG);
    try_open(&mut t, "stake above the maximum", Side::Short, 3, 250 * USDG + 1, ANY_SHORT);
    try_open(&mut t, "a limit price is required", Side::Long, 3, STAKE, 0);
    try_open(&mut t, "stake below the minimum", Side::Long, 3, 0, ANY_LONG);
    t.fails(&alice(), "arithmetic overflow", |c| {
        c.open(m, Side::Long, 3, U128(u64::MAX as u128 + 1), U64(ANY_LONG));
    });
    t.fails(&alice(), "no such market", |c| {
        c.open(9, Side::Long, 3, u(STAKE), U64(ANY_LONG));
    });
    let q = t.view().quote_open(m, Side::Long, 1, u(STAKE), None);
    assert_eq!((q.allowed, q.reason.as_deref(), q.fill_reason.as_deref()), (false, Some("leverage must be 2 or 3"), Some("leverage")));
    assert_eq!(t.bal(&alice()), 10_000 * USDG, "nothing debited");

    // The edges of the stake range, then the position limit (pending included).
    t.open(&alice(), m, Side::Long, 3, 10 * USDG, ANY_LONG);
    t.open(&alice(), m, Side::Short, 2, 250 * USDG, ANY_SHORT);
    for _ in 0..8 {
        t.open(&alice(), m, Side::Long, 2, STAKE, ANY_LONG);
    }
    assert_eq!(t.c.positions_of(alice()).len(), 10);
    try_open(&mut t, "position limit reached for this account", Side::Long, 3, STAKE, ANY_LONG);
    assert_eq!(
        t.view().quote_open(m, Side::Long, 3, u(STAKE), Some(alice())).reason.as_deref(),
        Some("position limit reached for this account")
    );
    t.fails(&dave(), "balance too low", |c| {
        c.open(m, Side::Long, 3, u(STAKE), U64(ANY_LONG));
    });

    // Paused by the keeper, resumed by the owner.
    t.call(&keeper(), |c| c.set_paused(true));
    assert!(logs_with("opens_paused")[0].contains(r#""paused":"true","by":"keeper.near""#));
    t.fails(&bob(), "new orders are paused", |c| {
        c.open(m, Side::Long, 3, u(STAKE), U64(ANY_LONG));
    });
    t.call(&owner(), |c| c.set_paused(false));
    t.open(&bob(), m, Side::Long, 3, STAKE, ANY_LONG);

    // A quote too old, then read again: fresh.
    let last = t.c.get_market(m).unwrap().quote.unwrap().last_read_at.0;
    t.now = last + 901;
    t.fails(&bob(), "the market's newest quote is too old", |c| {
        c.open(m, Side::Long, 3, u(STAKE), U64(ANY_LONG));
    });
    t.reread(m);
    t.open(&bob(), m, Side::Long, 3, STAKE, ANY_LONG);

    // No quote yet; inside the cool-off; a score under 100.
    let b = t.list(REF_B, None);
    t.fails(&bob(), "market has no quote", |c| {
        c.open(b, Side::Long, 3, u(STAKE), U64(ANY_LONG));
    });
    t.push(b, 9_999, 9_999);
    t.fails(&bob(), "score is under the minimum to open", |c| {
        c.open(b, Side::Long, 3, u(STAKE), U64(ANY_LONG));
    });
    let live = U64(t.now - 2 * DAY + 1);
    let young = t.call(&keeper(), |c| c.list_market("00112233445566778899aabbccddeeff".to_string(), None, live));
    t.push(young, 50_000, 50_000);
    t.fails(&bob(), "market is inside its cool-off", |c| {
        c.open(young, Side::Long, 3, u(STAKE), U64(ANY_LONG));
    });
    t.now += 1;
    t.reread(young);
    t.open(&bob(), young, Side::Long, 3, STAKE, ANY_LONG);
}

// ------------------------------------------------------------- crank

/// One bad id never fails the batch, and ids beyond the first 20 are
/// ignored.
#[test]
fn a_crank_skips_bad_ids_and_ignores_ids_beyond_20() {
    let (mut t, m) = setup(50_000, 50_000);
    let a = t.open(&alice(), m, Side::Long, 3, STAKE, ANY_LONG);
    t.now += 10;
    t.reread(m);
    t.now += 1;
    let w = t.open(&bob(), m, Side::Long, 3, STAKE, ANY_LONG);
    assert_eq!(t.crank(&carol(), &[999_999, a, w, a, 0]), ["unknown", "filled", "waiting", "waiting", "unknown"]);
    let mut ids: Vec<u64> = vec![999; MAX_CRANK_IDS];
    ids.push(w);
    t.now += 10;
    t.reread(m);
    let out = t.crank(&carol(), &ids);
    assert_eq!(out.len(), MAX_CRANK_IDS + 1);
    assert_eq!(out[MAX_CRANK_IDS], "ignored");
    assert_eq!(t.pos(w).unwrap().state, PositionState::Pending, "the 21st id was not processed");
    assert_eq!(t.crank(&carol(), &[w]), ["filled"]);
}

fn long_account(i: usize) -> AccountId {
    acc(&format!("{}{:08}", "a".repeat(56), i))
}

/// 20 fills, then 20 liquidations by a caller with a 64-character id, of
/// positions held by 64-character accounts on a market with a 64-character
/// finder: each batch's logs stay well inside 16 KB and 100 entries.
#[test]
fn a_crank_of_20_with_64_character_accounts_fits_the_log_limits() {
    let mut t = T::new();
    t.seed(VAULT, POOL);
    let m = t.list(REF_A, Some(long_account(999)));
    t.known.insert(long_account(999));
    t.push(m, 50_000, 50_000);
    let ids: Vec<u64> = (0..MAX_CRANK_IDS)
        .map(|i| {
            let who = long_account(i);
            assert_eq!(who.as_str().len(), 64);
            t.faucet(&who, 1_000 * USDG);
            t.open(&who, m, Side::Long, 3, 250 * USDG, ANY_LONG)
        })
        .collect();
    t.now += 10;
    t.reread(m);
    let caller = long_account(500);
    assert!(t.crank(&caller, &ids).iter().all(|a| a == "filled"));
    let logs = get_logs();
    let bytes: usize = logs.iter().map(|l| l.len()).sum();
    assert_eq!(logs.len(), MAX_CRANK_IDS);
    assert!(bytes < 16_384, "20 fills wrote {bytes} bytes of logs");
    println!("log bytes for 20 fills with 64-character ids: {bytes}");
    t.walk(m, 33_000, 33_000);
    assert!(t.crank(&caller, &ids).iter().all(|a| a == "liquidated"));
    let logs = get_logs();
    let bytes: usize = logs.iter().map(|l| l.len()).sum();
    assert_eq!(logs.len(), MAX_CRANK_IDS);
    assert!(bytes < 16_384 * 2 / 3, "20 liquidations wrote {bytes} bytes of logs");
    println!("log bytes for 20 liquidations with 64-character ids: {bytes}");
    assert_eq!(t.bal(&caller), 20 * 2_500_000);
}

// ----------------------------------------------------- access control

#[test]
fn keeper_and_owner_methods_are_guarded() {
    let (mut t, m) = setup(50_000, 50_000);
    let live = U64(t.now - 3 * DAY);
    for who in [owner(), alice(), treasury(), finder()] {
        t.fails(&who, "not the keeper", |c| {
            c.push_quotes(vec![], commitment());
        });
        t.fails(&who, "not the keeper", |c| {
            c.list_market(REF_B.to_string(), None, live);
        });
    }
    for who in [alice(), treasury(), finder()] {
        t.fails(&who, "not the owner or the keeper", |c| c.set_market(m, Some(MarketStatus::CloseOnly), None));
        t.fails(&who, "not the owner or the keeper", |c| c.set_paused(true));
    }
    for who in [keeper(), alice(), treasury()] {
        t.fails(&who, "not the owner", |c| c.set_config(ConfigPatch::default()));
    }
    // The finder can be named by the keeper or the owner.
    t.call(&keeper(), |c| c.set_market(m, None, Some(carol())));
    assert_eq!(t.c.get_market(m).unwrap().finder, Some(carol()));
    t.call(&owner(), |c| c.set_market(m, None, Some(dave())));
    assert_eq!(t.c.get_market(m).unwrap().status, MarketStatus::Open);
    // The owner hands the keeper role on.
    t.call(&owner(), |c| c.set_config(ConfigPatch { keeper: Some(carol()), ..Default::default() }));
    t.fails(&keeper(), "not the keeper", |c| {
        c.push_quotes(vec![], commitment());
    });
    t.call(&carol(), |c| c.push_quotes(vec![], commitment()));
    t.fails(&keeper(), "not the owner or the keeper", |c| c.set_paused(true));
}

/// Every number in `set_config` stays inside a range fixed in the code.
#[test]
fn set_config_stays_inside_fixed_ranges() {
    let mut t = T::new();
    let d = ConfigPatch::default;
    let s = U64;
    let bad: Vec<(ConfigPatch, &str)> = vec![
        (ConfigPatch { fee_bps: Some(501), ..d() }, "fee_bps"),
        (ConfigPatch { finder_bps: Some(10_001), ..d() }, "finder_bps"),
        (ConfigPatch { lead_min_bps: Some(10_001), ..d() }, "lead_min_bps"),
        (ConfigPatch { lead_full_gap_bps: Some(0), ..d() }, "lead_full_gap_bps"),
        (ConfigPatch { lead_full_gap_bps: Some(10_001), ..d() }, "lead_full_gap_bps"),
        (ConfigPatch { max_open_gap_bps: Some(99), ..d() }, "max_open_gap_bps"),
        (ConfigPatch { max_open_gap_bps: Some(100_001), ..d() }, "max_open_gap_bps"),
        (ConfigPatch { max_profit_bps: Some(999), ..d() }, "max_profit_bps"),
        (ConfigPatch { max_profit_bps: Some(90_001), ..d() }, "max_profit_bps"),
        (ConfigPatch { min_score_e2: Some(s(0)), ..d() }, "min_score_e2"),
        (ConfigPatch { cooloff_secs: Some(s(30 * DAY + 1)), ..d() }, "cooloff_secs"),
        (ConfigPatch { market_cap_bps: Some(0), ..d() }, "market_cap_bps"),
        (ConfigPatch { market_cap_bps: Some(10_001), ..d() }, "market_cap_bps"),
        (ConfigPatch { utilisation_cap_bps: Some(0), ..d() }, "utilisation_cap_bps"),
        (ConfigPatch { utilisation_cap_bps: Some(9_001), ..d() }, "utilisation_cap_bps"),
        (ConfigPatch { min_stake: Some(u(USDG - 1)), ..d() }, "min_stake"),
        (ConfigPatch { max_stake: Some(u(10 * USDG - 1)), ..d() }, "max_stake"),
        (ConfigPatch { max_stake: Some(u(100_000 * USDG + 1)), ..d() }, "max_stake"),
        (ConfigPatch { max_positions_per_account: Some(0), ..d() }, "max_positions_per_account"),
        (ConfigPatch { max_positions_per_account: Some(51), ..d() }, "max_positions_per_account"),
        (ConfigPatch { min_fill_delay_secs: Some(s(601)), ..d() }, "min_fill_delay_secs"),
        (ConfigPatch { order_ttl_secs: Some(s(59)), ..d() }, "order_ttl_secs"),
        (ConfigPatch { order_ttl_secs: Some(s(DAY + 1)), ..d() }, "order_ttl_secs"),
        (ConfigPatch { min_fill_delay_secs: Some(s(500)), order_ttl_secs: Some(s(500)), ..d() }, "order_ttl_secs"),
        (ConfigPatch { max_quote_age_secs: Some(s(59)), ..d() }, "max_quote_age_secs"),
        (ConfigPatch { max_quote_age_secs: Some(s(DAY + 1)), ..d() }, "max_quote_age_secs"),
        (ConfigPatch { emergency_secs: Some(s(3_599)), ..d() }, "emergency_secs"),
        (ConfigPatch { emergency_secs: Some(s(7 * DAY + 1)), ..d() }, "emergency_secs"),
        (ConfigPatch { max_quote_age_secs: Some(s(DAY)), emergency_secs: Some(s(3_600)), ..d() }, "emergency_secs"),
        (ConfigPatch { max_position_secs: Some(s(DAY - 1)), ..d() }, "max_position_secs"),
        (ConfigPatch { max_position_secs: Some(s(90 * DAY + 1)), ..d() }, "max_position_secs"),
        (ConfigPatch { lp_exit_delay_secs: Some(s(7 * DAY + 1)), ..d() }, "lp_exit_delay_secs"),
        (ConfigPatch { lp_exit_window_secs: Some(s(599)), ..d() }, "lp_exit_window_secs"),
        (ConfigPatch { lp_exit_window_secs: Some(s(7 * DAY + 1)), ..d() }, "lp_exit_window_secs"),
        (ConfigPatch { max_step_bps: Some(0), ..d() }, "max_step_bps"),
        (ConfigPatch { max_step_bps: Some(10_001), ..d() }, "max_step_bps"),
        (ConfigPatch { liq_reward_bps: Some(1_001), ..d() }, "liq_reward_bps"),
        (ConfigPatch { faucet_per_account: Some(u(1_000_000 * USDG + 1)), ..d() }, "faucet_per_account"),
        (ConfigPatch { storage_floor: Some(U128(1_000 * NEAR_YOCTO + 1)), ..d() }, "storage_floor"),
    ];
    let before = t.c.get_config();
    for (patch, field) in bad {
        t.fails(&owner(), &format!("config value out of range: {field}"), move |c| c.set_config(patch));
    }
    assert_eq!(t.c.get_config(), before, "nothing changed");
    t.call(&owner(), |c| {
        c.set_config(ConfigPatch { fee_bps: Some(500), lead_min_bps: Some(10_000), lp_open: Some(true), ..d() })
    });
    assert!(logs_with("config_set")[0].contains(r#""fields":"fee_bps,lead_min_bps,lp_open""#));
    let c = t.c.get_config();
    assert_eq!((c.fee_bps, c.lead_min_bps, c.lp_open, c.max_step_bps), (500, 10_000, true, 1_500));

    // Unknown fields are refused when the argument is parsed.
    assert!(serde_json::from_str::<ConfigPatch>(r#"{"fee_bp":1}"#).is_err());
    let p: ConfigPatch = serde_json::from_str(r#"{"fee_bps":1,"cooloff_secs":"60","min_stake":"2000000"}"#).unwrap();
    assert_eq!((p.fee_bps, p.cooloff_secs, p.min_stake, p.keeper), (Some(1), Some(U64(60)), Some(u(2 * USDG)), None));
    // The config as JSON: numbers as strings, bps as numbers, one flat object.
    let v = serde_json::to_value(Contract::new(owner(), keeper(), treasury(), token()).get_config()).unwrap();
    assert_eq!((v["fee_bps"].as_u64(), v["cooloff_secs"].as_str(), v["min_stake"].as_str()), (Some(100), Some("172800"), Some("10000000")));
    assert_eq!((v["storage_floor"].as_str(), v["max_profit_bps"].as_u64(), v["opens_paused"].as_bool()), (Some("3000000000000000000000000"), Some(90_000), Some(false)));
    assert!(v.get("min_quote_gap_secs").is_none());
}

// -------------------------------------------------------------- views

#[test]
fn views_speak_strings_and_nulls() {
    let (mut t, m) = setup(40_000, 42_000);
    let o = t.open(&alice(), m, Side::Long, 3, STAKE, ANY_LONG);
    let v = serde_json::to_value(t.pos(o).unwrap()).unwrap();
    assert_eq!((v["id"].as_str(), v["side"].as_str(), v["state"].as_str(), v["leverage"].as_u64()), (Some("1"), Some("Long"), Some("Pending"), Some(3)));
    assert_eq!((v["stake"].as_str(), v["reserved"].as_str(), v["placed_at"].as_str()), (Some("100000000"), Some("0"), Some(T0.to_string().as_str())));
    for f in ["entry_e2", "opened_at", "close_requested_at", "close_limit_e2", "value"] {
        assert!(v[f].is_null(), "{f} is null while pending");
    }
    t.now += 10;
    t.reread(m);
    t.crank(&bob(), &[o]);
    t.close(&alice(), o, 40_000);
    let v = serde_json::to_value(t.pos(o).unwrap()).unwrap();
    assert_eq!((v["state"].as_str(), v["entry_e2"].as_str(), v["close_limit_e2"].as_str()), (Some("Closing"), Some("40880"), Some("40000")));
    assert_eq!(v["reserved"].as_str(), Some("900000000"));
    let ids: Vec<String> = t.c.list_active(None, None).iter().map(|p| p.id.0.to_string()).collect();
    assert_eq!(ids, ["1"]);
    let mk = serde_json::to_value(t.c.get_market(m).unwrap()).unwrap();
    assert_eq!((mk["id"].as_u64(), mk["status"].as_str(), mk["live_since"].as_str()), (Some(0), Some("Open"), Some((T0 - 3 * DAY).to_string().as_str())));
    let q = &mk["quotes"][0];
    assert_eq!((q["score_e2"].as_str(), q["pushed_score_e2"].as_str(), q["reading_e2"].as_str(), q["print_id"].as_str()), (Some("40000"), Some("40000"), Some("42000"), Some("1000")));
    assert_eq!((q["print_at"].as_str(), q["last_read_at"].as_str()), (Some(T0.to_string().as_str()), Some((T0 + 10).to_string().as_str())));
    assert!(mk["final_e2"].is_null());
    assert_eq!((mk["long"]["reserved"].as_str(), mk["long"]["count"].as_u64()), (Some("900000000"), Some(1)));
    let vault = serde_json::to_value(t.c.get_vault()).unwrap();
    for f in ["assets", "reserved", "free", "margin", "shares", "share_price", "faucet_pool"] {
        assert!(vault[f].is_string(), "{f}");
    }
    assert_eq!(t.c.list_markets(Some(1), None), vec![]);
    assert!(t.c.get_market_by_reference(REF_B.to_string()).is_none());
    assert_eq!(t.c.history_of(bob()), vec![]);
    assert!(t.c.get_position(U64(77)).is_none());

    // History: closed positions only, newest first, no signed numbers.
    t.now += 10;
    t.reread(m);
    t.crank(&bob(), &[o]);
    assert!(t.pos(o).is_none(), "an ended position is gone");
    let h = serde_json::to_value(t.c.history_of(alice())).unwrap();
    let mut keys: Vec<&str> = h[0].as_object().unwrap().keys().map(|k| k.as_str()).collect();
    keys.sort();
    assert_eq!(
        keys,
        ["closed_at", "entry_e2", "exit_e2", "id", "leverage", "market", "opened_at", "payout", "reason", "side", "stake"]
    );
    assert_eq!((h[0]["id"].as_str(), h[0]["payout"].as_str(), h[0]["reason"].as_str()), (Some("1"), Some("93542074"), Some("close")));

    // quote_open never panics, whatever it is asked.
    for (market, lev, stake) in [(9, 3, STAKE as u128), (m, 0, STAKE as u128), (m, 3, u128::MAX), (m, 3, 0), (m, 255, u64::MAX as u128)] {
        for side in [Side::Long, Side::Short] {
            let q = t.view().quote_open(market, side, lev, U128(stake), Some(dave()));
            assert!(!q.allowed && q.reason.is_some());
        }
    }
    let q = t.view().quote_open(m, Side::Long, 3, u(STAKE), None);
    assert_eq!((q.lead_e2.0, q.buy_e2.0, q.sell_e2.0, q.entry_e2.0), (40_880, 40_880, 40_000, 40_880));
    let v = serde_json::to_value(&q).unwrap();
    for f in ["score_e2", "lead_e2", "buy_e2", "sell_e2", "entry_e2", "fee", "liquidation_e2", "cap_e2", "max_profit", "value_on_fill"] {
        assert!(v[f].is_string(), "{f}");
    }
    assert!(v["allowed"].as_bool().unwrap() && v["reason"].is_null());
}

// ------------------------------------------------------------ migrate

/// `migrate` re-reads the stored state: only the owner or the contract
/// itself may call it, and an unknown layout fails.
#[test]
fn migrate_keeps_the_state_and_checks_the_caller_and_the_version() {
    let (mut t, m) = setup(50_000, 50_000);
    let a = t.filled(&alice(), m, Side::Long, 3, STAKE);
    let before = (t.c.get_config(), t.vault(), t.c.get_market(m), t.pos(a), t.bal(&alice()), t.c.history_of(alice()));
    t.ctx(&owner());
    let old = std::mem::replace(&mut t.c, Contract::new(owner(), keeper(), treasury(), token()));
    env::state_write(&old);
    drop(old); // writes every collection's entries
    t.ctx(&alice());
    expect_err("not the owner", || {
        Contract::migrate();
    });
    t.ctx(&owner());
    t.c = Contract::migrate();
    let after = (t.c.get_config(), t.vault(), t.c.get_market(m), t.pos(a), t.bal(&alice()), t.c.history_of(alice()));
    assert_eq!(after, before);
    assert!(logs_with("migrated")[0].contains(r#""state_version":"1""#));
    t.check();
    t.ctx(&house());
    let again = Contract::migrate();
    assert_eq!(again.get_config(), t.c.get_config(), "the contract account may migrate too");
    drop(again);
    // Trading goes on from the migrated state.
    t.close(&alice(), a, ANY_SHORT);
    t.next(m, 51_000, 51_000);
    assert_eq!(t.crank(&bob(), &[a]), ["closed"]);
    // An unknown layout, and no state at all.
    t.ctx(&owner());
    let raw = env::storage_read(b"STATE").unwrap();
    let mut v2 = raw.clone();
    v2[0] = 2;
    env::storage_write(b"STATE", &v2);
    expect_err("unknown state version", || {
        Contract::migrate();
    });
    env::storage_remove(b"STATE");
    expect_err("no contract state to migrate", || {
        Contract::migrate();
    });
    env::storage_write(b"STATE", &raw);
}

// ------------------------------------------------------- zero prices

/// A reading of 0 makes the sell price 0: no fill happens there, a close
/// with a limit goes back to Open, an end-of-life close waits for the next
/// print, and nothing divides by zero. A score of 0 is handled too.
#[test]
fn zero_readings_and_zero_scores_never_fill_or_divide_by_zero() {
    let (mut t, m) = setup(10_173, 10_173);
    let long = t.filled(&alice(), m, Side::Long, 3, STAKE);
    let short = t.filled(&bob(), m, Side::Short, 3, STAKE);
    t.close(&alice(), long, ANY_SHORT);
    let pl = t.open(&alice(), m, Side::Long, 3, STAKE, ANY_LONG);
    let ps = t.open(&bob(), m, Side::Short, 3, STAKE, ANY_SHORT);
    t.next(m, 10_173, 0);
    let q = t.c.get_market(m).unwrap().quote.unwrap();
    assert_eq!((q.buy_e2.0, q.sell_e2.0, q.spread_bps.0), (10_173, 0, 10_000));
    assert_eq!(t.crank(&carol(), &[pl, ps, long, short]), ["refunded", "refunded", "close_missed", "waiting"]);
    assert_eq!((refunded(pl), refunded(ps)), ("spread".to_string(), "zero_price".to_string()));
    assert!(logs_with("close_missed")[0].contains(r#""reason":"zero_price""#));
    let p = t.pos(long).unwrap();
    assert_eq!((p.state, p.value, p.at_risk), (PositionState::Open, Some(u(0)), true));
    assert_eq!(t.pos(short).unwrap().value, Some(u(STAKE)));
    t.fails(&bob(), "the two prices are too far apart", |c| {
        c.open(m, Side::Short, 3, u(STAKE), U64(ANY_SHORT));
    });
    t.call(&owner(), |c| c.set_config(ConfigPatch { max_open_gap_bps: Some(100_000), ..Default::default() }));
    t.fails(&bob(), "the price is zero", |c| {
        c.open(m, Side::Short, 3, u(STAKE), U64(ANY_SHORT));
    });

    // At its end, the long's close skips the zero-price print and settles at the next one.
    let end = n(t.pos(long).unwrap().expires_at);
    t.now = end + 10;
    t.push(m, 10_173, 0);
    assert_eq!(t.crank(&carol(), &[long]), ["closing"]);
    assert_eq!(t.crank(&carol(), &[long]), ["waiting"]);
    t.next(m, 10_173, 10_173);
    assert_eq!(t.crank(&carol(), &[long]), ["closed"]);
    let h = t.last_closed(&alice());
    assert_eq!((h.reason.as_str(), h.exit_e2.0, h.payout.0), ("expiry", 10_173, STAKE as u128));

    // A first print with a score of 0, and readings above a score of 0.
    let z = t.list(REF_B, None);
    t.push(z, 0, 0);
    let q = t.c.get_market(z).unwrap().quote.unwrap();
    assert_eq!((q.buy_e2.0, q.sell_e2.0, q.spread_bps.0), (0, 0, 0));
    t.fails(&bob(), "score is under the minimum to open", |c| {
        c.open(z, Side::Long, 3, u(STAKE), U64(ANY_LONG));
    });
    t.next(z, 0, 5_000);
    let q = t.c.get_market(z).unwrap().quote.unwrap();
    assert_eq!((q.score_e2.0, q.buy_e2.0, q.sell_e2.0, q.spread_bps.0), (0, 5_000, 0, u64::MAX));
    assert_eq!(t.view().quote_open(z, Side::Long, 3, u(STAKE), None).reason.as_deref(), Some("score is under the minimum to open"));
    t.next(z, 5_000, 5_000);
    assert_eq!(t.score(z), 5_000, "from a score of 0 the pushed score is taken as it is");
    let quote = t.view().quote_open(z, Side::Short, 2, u(STAKE), None);
    assert!(!quote.allowed);
}

// -------------------------------------------------- a random sequence

/// A small deterministic generator, so the sequence is the same every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }
    fn pick<'a, X>(&mut self, v: &'a [X]) -> &'a X {
        &v[self.below(v.len() as u64) as usize]
    }
}

impl T {
    /// A call that may fail; the invariants are checked either way.
    fn try_call<R>(&mut self, who: &AccountId, f: impl FnOnce(&mut Contract) -> R) -> Option<R> {
        self.known.insert(who.clone());
        self.ctx(who);
        let c = &mut self.c;
        let r = attempt(move || f(c)).ok();
        self.check();
        r
    }

    fn active_ids(&self) -> Vec<u64> {
        let n = self.c.active_count();
        (0..n).step_by(100).flat_map(|from| self.c.list_active(Some(from), Some(100))).map(|p| p.id.0).collect()
    }
}

/// The keeper's own idea of a market: its latest score and reading.
struct Feed {
    id: u32,
    score: u64,
    reading: u64,
    live: bool,
}

/// Thousands of random opens, quotes, re-reads, cranks, closes, cancels,
/// withdrawals, faucet claims, vault moves, pauses, retirements and time
/// jumps. After every step both invariants hold and every unit is accounted
/// for; at the end every market settles, every position ends, and the
/// margin and the reserve are back at zero.
fn random_run(seed: u64, coverage: bool) {
    let mut rng = Rng(seed);
    let mut t = T::new();
    t.seed(150_000 * USDG, 2_000_000 * USDG);
    // A lower profit cap and a one-day life, so caps and ends happen too.
    t.call(&owner(), |c| {
        c.set_config(ConfigPatch {
            max_profit_bps: Some(20_000),
            max_position_secs: Some(U64(DAY)),
            lp_open: Some(true),
            ..Default::default()
        })
    });
    let traders: Vec<AccountId> = (0..24).map(|i| acc(&format!("trader{i}.near"))).collect();
    for who in &traders {
        t.faucet(who, 5_000 * USDG);
    }
    let callers: Vec<AccountId> = vec![keeper(), carol(), traders[0].clone(), traders[5].clone()];
    let mut refs = 0u32;
    let mut feeds: Vec<Feed> = Vec::new();
    let mut list = |t: &mut T, feeds: &mut Vec<Feed>, rng: &mut Rng| {
        refs += 1;
        let finder = if refs % 3 == 0 { None } else { Some(finder()) };
        let id = t.list(&format!("{refs:032x}"), finder);
        let score = 20_000 + rng.below(80_000);
        t.push(id, score, score);
        feeds.push(Feed { id, score, reading: score, live: true });
    };
    for _ in 0..3 {
        list(&mut t, &mut feeds, &mut rng);
    }
    let mut lp_exits = 0u32;
    let mut actions: std::collections::BTreeMap<String, u32> = Default::default();
    let mut reasons: std::collections::BTreeMap<String, u32> = Default::default();
    let mut tally = |out: &[String], actions: &mut std::collections::BTreeMap<String, u32>| {
        for a in out {
            *actions.entry(a.clone()).or_default() += 1;
        }
        for l in logs_with("position_closed").iter().chain(logs_with("order_refunded").iter()) {
            let r = l.split(r#""reason":""#).nth(1).and_then(|x| x.split('"').next()).unwrap_or("?");
            *reasons.entry(r.to_string()).or_default() += 1;
        }
    };

    for _ in 0..6_000 {
        match rng.below(100) {
            0..=24 => {
                let who = rng.pick(&traders).clone();
                let live: Vec<&Feed> = feeds.iter().filter(|f| f.live || rng.below(10) == 0).collect();
                let f = *rng.pick(&live);
                let (m, side) = (f.id, if rng.below(2) == 0 { Side::Long } else { Side::Short });
                let leverage = match rng.below(40) {
                    0 => 1,
                    1 => 4,
                    x => 2 + (x % 2) as u8,
                };
                let stake = match rng.below(20) {
                    0 => rng.below(10 * USDG),
                    1 => 250 * USDG + 1 + rng.below(USDG),
                    _ => 10 * USDG + rng.below(240 * USDG),
                };
                let q = t.c.get_market(m).unwrap().quote;
                let at = q.map(|q| if side == Side::Long { q.buy_e2.0 } else { q.sell_e2.0 }).unwrap_or(1);
                let limit = match rng.below(12) {
                    0 => 0,
                    1 => at,
                    2 if side == Side::Long => at.saturating_sub(at / 50).max(1),
                    2 => at + at / 50,
                    3 if side == Side::Long => at + at / 100,
                    3 => at.saturating_sub(at / 100).max(1),
                    _ if side == Side::Long => ANY_LONG,
                    _ => ANY_SHORT,
                };
                t.try_call(&who, |c| c.open(m, side, leverage, u(stake), U64(limit)));
            }
            25..=44 => {
                t.now += 240 + rng.below(121);
                let now = t.now;
                let mut batch = Vec::new();
                for f in feeds.iter_mut().filter(|f| f.live) {
                    let pct = match rng.below(100) {
                        0 => -50,
                        1 => 100,
                        _ => rng.below(17) as i64 - 8,
                    };
                    f.score = ((f.score as i64 * (100 + pct)) / 100).clamp(2_000, 2_000_000) as u64;
                    let spread = match rng.below(100) {
                        0 => 100,
                        1..=10 => 40,
                        11..=30 => 12,
                        _ => 4,
                    };
                    f.reading = if spread == 100 {
                        0
                    } else {
                        (f.score as i64 * (100 - spread + rng.below(2 * spread as u64 + 1) as i64) / 100) as u64
                    };
                    let id = t.next_print;
                    t.next_print += 1;
                    batch.push(qin(f.id, f.score, f.reading, id, now - rng.below(60), now));
                }
                if !batch.is_empty() {
                    let r = t.try_call(&keeper(), |c| c.push_quotes(batch, commitment())).expect("a push never fails");
                    assert_eq!(r.skipped, 0, "every entry is valid");
                }
            }
            45..=49 => {
                t.now += 1 + rng.below(30);
                let f = rng.pick(&feeds);
                if f.live {
                    let id = f.id;
                    t.reread(id);
                }
            }
            50..=67 => {
                let all = t.active_ids();
                let k = rng.below(MAX_CRANK_IDS as u64 + 4);
                let mut ids: Vec<U64> = (0..k).filter(|_| !all.is_empty()).map(|_| U64(*rng.pick(&all))).collect();
                if rng.below(10) == 0 {
                    ids.push(U64(9_999_999));
                }
                let who = rng.pick(&callers).clone();
                let out = t.try_call(&who, |c| c.crank(ids)).expect("crank never fails");
                tally(&out, &mut actions);
            }
            68..=79 => {
                let who = rng.pick(&traders).clone();
                let open: Vec<PositionView> =
                    t.c.positions_of(who.clone()).into_iter().filter(|p| p.state == PositionState::Open).collect();
                if open.is_empty() {
                    continue;
                }
                let p = rng.pick(&open);
                let (id, side, market) = (p.id, p.side, p.market);
                let q = t.c.get_market(market).unwrap().quote.unwrap();
                let at = if side == Side::Long { q.sell_e2.0 } else { q.buy_e2.0 };
                let limit = match (rng.below(3), side) {
                    (0, Side::Long) => (at - at / 100).max(1),
                    (0, Side::Short) => at + at / 100,
                    (_, Side::Long) => ANY_SHORT,
                    (_, Side::Short) => ANY_LONG,
                };
                t.try_call(&who, |c| c.close(id, U64(limit)));
            }
            80..=81 => {
                let who = rng.pick(&traders).clone();
                if let Some(p) = t.c.positions_of(who.clone()).into_iter().find(|p| p.state == PositionState::Pending) {
                    t.try_call(&who, |c| c.cancel(p.id));
                }
            }
            82..=84 => {
                let who = rng.pick(&traders).clone();
                let b = t.bal(&who);
                if b > 0 {
                    let amount = 1 + rng.below(b);
                    let ok = rng.below(4) != 0;
                    t.withdraw(&who, amount, ok);
                }
            }
            85..=88 => {
                let who = if rng.below(2) == 0 { treasury() } else { rng.pick(&traders).clone() };
                match rng.below(4) {
                    0 => {
                        if who == treasury() {
                            t.transfer_call(&token(), &treasury(), 20_000 * USDG, "");
                        }
                        let amount = 1 + rng.below(t.bal(&who).max(1));
                        t.try_call(&who, |c| c.lp_deposit(u(amount)));
                    }
                    1 => {
                        let held = t.c.lp_of(who.clone()).shares.0;
                        let s = 1 + (rng.next() as u128 * rng.next() as u128) % held.max(1);
                        t.try_call(&who, |c| c.lp_request_withdraw(U128(s)));
                    }
                    _ => {
                        if t.try_call(&who, |c| c.lp_withdraw()).is_some_and(|v| v.0 > 0) {
                            lp_exits += 1;
                        }
                    }
                }
            }
            89 => t.now += 3_600 * (1 + rng.below(6)),
            90 => {
                let live: Vec<u32> = feeds.iter().filter(|f| f.live).map(|f| f.id).collect();
                if live.len() > 1 && rng.below(3) == 0 {
                    let id = *rng.pick(&live);
                    if let Some(f) = feeds.iter_mut().find(|f| f.id == id) {
                        f.live = false;
                    }
                    if rng.below(2) == 0 {
                        t.try_call(&keeper(), |c| c.set_market(id, Some(MarketStatus::CloseOnly), None));
                    }
                    list(&mut t, &mut feeds, &mut rng);
                }
            }
            91 => {
                for id in 0..t.c.list_markets(None, Some(100)).len() as u32 {
                    t.try_call(&carol(), |c| c.settle_stale(id));
                }
            }
            92 => {
                let paused = rng.below(10) == 0;
                t.try_call(&keeper(), |c| c.set_paused(paused));
            }
            93..=96 => {
                let who = rng.pick(&traders).clone();
                let amount = 1 + rng.below(3_000 * USDG);
                t.try_call(&who, |c| c.faucet(u(amount)));
            }
            _ => t.now += rng.below(60),
        }
    }

    // Wind down: two days with no reads, then every market settles and
    // every position ends.
    t.call(&keeper(), |c| c.set_paused(false));
    t.now += 2 * DAY;
    let markets = t.c.list_markets(None, Some(100));
    for m in &markets {
        if m.status != MarketStatus::Settled {
            t.call(&carol(), |c| c.settle_stale(m.id));
        }
    }
    for _ in 0..100 {
        let ids: Vec<u64> = t.active_ids().into_iter().take(MAX_CRANK_IDS).collect();
        if ids.is_empty() {
            break;
        }
        let out = t.crank(&keeper(), &ids);
        assert!(out.iter().all(|a| a == "closed" || a == "refunded"), "{out:?}");
        tally(&out, &mut actions);
    }
    let v = t.vault();
    assert_eq!((t.c.active_count(), v.margin.0, v.reserved.0), (0, 0, 0));
    assert_eq!(t.token_held, v.ledger_total.0 + v.assets.0 + v.faucet_pool.0);

    println!("markets: {}, vault exits: {lp_exits}, crank actions: {actions:?}, endings: {reasons:?}", markets.len());
    if !coverage {
        return;
    }
    assert!(lp_exits >= 3, "vault exits: {lp_exits}");
    for (what, at_least) in [("filled", 300), ("refunded", 150), ("liquidated", 50), ("closed", 200), ("close_missed", 10)] {
        assert!(actions.get(what).copied().unwrap_or(0) >= at_least, "{what}: {actions:?}");
    }
    for (what, at_least) in [
        ("close", 100),
        ("cap", 10),
        ("liquidation", 50),
        ("expiry", 10),
        ("settled", 20),
        ("limit", 50),
        ("market_full", 10),
        ("spread", 20),
        ("rolled_out", 5),
        ("expired", 10),
    ] {
        assert!(reasons.get(what).copied().unwrap_or(0) >= at_least, "{what}: {reasons:?}");
    }
}

#[test]
fn a_random_sequence_keeps_every_invariant() {
    random_run(0x4855_5345_2026_1110, true);
}

#[test]
fn a_second_random_sequence_keeps_every_invariant() {
    random_run(0x0bad_5eed_0000_0002, false);
}
