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

fn ctx(who: &AccountId, now: u64, balance: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(house())
        .predecessor_account_id(who.clone())
        .signer_account_id(who.clone())
        .block_timestamp(now * 1_000_000_000)
        .account_balance(balance)
        .build());
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
    assert_eq!(h.paid.0, 149_615_949);
    assert_eq!(h.paid.0 / 10_000, 14_961, "149.61");
    assert_eq!(h.pnl, "49615949");
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
    (entry, h.exit_e2.0, h.paid.0 as u64, fees.0, fees.1)
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
    assert_eq!(t.last_closed(&alice()).detail, "expired");
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
    assert_eq!(t.last_closed(&alice()).detail, "rolled_out");
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
    let h = t.c.history_of(alice());
    assert_eq!((h[0].reason.as_str(), h[0].detail.as_str(), h[0].pnl.as_str()), ("refunded", "limit", "0"));
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
    assert_eq!(t.last_closed(&bob()).detail, "market_full");
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
    assert_eq!(t.last_closed(&alice()).detail, "market_full");
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
    assert_eq!(t.last_closed(&alice()).detail, "spread");
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
    assert!(missed[0].contains(r#""price_e2":"47641","limit_e2":"49000""#), "{}", missed[0]);
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
    assert_eq!(t.last_closed(&alice()).detail, "cancelled");

    // An order with a quote to fill at can't be cancelled; crank decides it.
    t.next(m, 50_000, 50_000);
    let placed = t.now;
    let o = t.open(&alice(), m, Side::Long, 3, STAKE, 1);
    t.now += 10;
    t.reread(m);
    t.now = placed + 1_000;
    t.fails(&alice(), "order has a quote to fill at", |c| c.cancel(U64(o)));
    assert_eq!(t.crank(&alice(), &[o]), ["refunded"]);
    assert_eq!(t.last_closed(&alice()).detail, "limit");
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
    assert_eq!((h.reason.as_str(), h.paid.0, h.pnl.as_str()), ("liquidation", 0, "-100000000"));
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
