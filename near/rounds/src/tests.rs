//! Unit tests on the mocked blockchain (`near-sdk` `unit-testing`).
//!
//! Expected numbers come from docs/rounds.md (the worked example) and from
//! `atnx-web/lib/bm/dpm.ts`, the TypeScript mirror the Solana e2e checked
//! every on-chain result against (`npm run rounds:sol -- e2e`).

use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;
use std::panic::{catch_unwind, AssertUnwindSafe};

const USDG: u64 = 1_000_000;
const DAY: u32 = 86_400;
const WINDOW: u32 = 1_800;
const T0: u64 = 1_760_000_000;
const TARGET: u64 = 14_300;
const REF_A: &str = "0123456789abcdef0123456789abcdef00000000000000000000000068e1a2b3";
const REF_B: &str = "fedcba9876543210fedcba9876543210010000000000000000000000690aa000";
const REF_C: &str = "00112233445566778899aabbccddeeff00000000000000000000000069100000";
const ZEROS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

// Gross amounts that net exactly 600, 400, 100, 540 and 60 USDG at 1 %
// (fee = ceil(gross / 100)); each is the only gross that does.
const G600: u64 = 606_060_607;
const G400: u64 = 404_040_405;
const G100: u64 = 101_010_102;
const G540: u64 = 545_454_546;
const G60: u64 = 60_606_061;

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
fn rounds() -> AccountId {
    acc("rounds.near")
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

fn ctx(predecessor: &AccountId, now: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(rounds())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor.clone())
        .block_timestamp(now * 1_000_000_000)
        .build());
}

/// Runs `f`, which must panic with a message containing `msg`.
fn expect_err(msg: &str, f: impl FnOnce()) {
    let err = catch_unwind(AssertUnwindSafe(f)).expect_err(&format!("expected a panic with {msg:?}"));
    let text = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(text.contains(msg), "expected {msg:?}, got {text:?}");
}

struct T {
    c: Contract,
    now: u64,
}

impl T {
    fn new() -> Self {
        ctx(&owner(), T0);
        let c = Contract::new(owner(), keeper(), treasury(), token(), 100, 2000);
        T { c, now: T0 }
    }

    /// The contract as seen by a call from `who` at the current time.
    fn by(&mut self, who: &AccountId) -> &mut Contract {
        ctx(who, self.now);
        &mut self.c
    }

    fn fund(&mut self, who: &AccountId, amount: u64) {
        let left = self.by(&token()).ft_on_transfer(who.clone(), U128(amount as u128), String::new());
        assert_eq!(left, U128(0));
    }

    fn series(&mut self, reference: &str, round_secs: u32, window: u32) -> u32 {
        self.by(&keeper()).create_series(reference.to_string(), round_secs, window, U128(10 * USDG as u128), finder())
    }

    fn commit(&mut self, who: &AccountId, sid: u32, ri: u32, side: Side, amount: u64) {
        self.by(who).commit(sid, ri, side, U128(amount as u128));
    }

    fn buy(&mut self, who: &AccountId, sid: u32, ri: u32, side: Side, amount: u64) -> BuyQuote {
        let q = self.by(who).quote_buy(sid, ri, side, U128(amount as u128));
        self.by(who).buy(sid, ri, side, U128(amount as u128), q.shares);
        q
    }

    fn open(&mut self, sid: u32, target: u64) {
        self.by(&keeper()).open_round(sid, target);
    }

    fn settle(&mut self, sid: u32, settle_e2: u64) {
        self.by(&keeper()).settle(sid, settle_e2, ZEROS.to_string());
    }

    fn claim(&mut self, who: &AccountId, sid: u32, ri: u32) -> u64 {
        self.by(who).claim(sid, ri).0 as u64
    }

    fn bal(&self, who: &AccountId) -> u64 {
        self.c.balance_of(who.clone()).0 as u64
    }

    fn round(&self, sid: u32, ri: u32) -> RoundView {
        self.c.get_round(sid, ri).expect("round exists")
    }

    fn ser(&self, sid: u32) -> SeriesView {
        self.c.get_series(sid).expect("series exists")
    }

    fn pos(&self, sid: u32, ri: u32, who: &AccountId) -> Option<PositionView> {
        self.c.get_position(sid, ri, who.clone())
    }
}

fn n(v: U128) -> u64 {
    v.0 as u64
}

/// The worked example's presale with the fee on: `ups` commit UP (gross
/// amounts), bob commits 400 net on DOWN, the round opens.
fn worked_example_setup(ups: &[(AccountId, u64)]) -> (T, u32) {
    let mut t = T::new();
    let sid = t.series(REF_A, DAY, WINDOW);
    for (who, gross) in ups {
        t.fund(who, *gross);
        t.commit(who, sid, 1, Side::Up, *gross);
    }
    t.fund(&bob(), G400);
    t.commit(&bob(), sid, 1, Side::Down, G400);
    let r = t.round(sid, 1);
    assert_eq!((n(r.presale_up), n(r.presale_down)), (600 * USDG, 400 * USDG), "U = 600, D = 400 net");
    t.now = T0 + 3_600;
    t.open(sid, TARGET);
    (t, sid)
}

#[test]
fn gross_amounts_net_the_round_figures() {
    for (gross, net) in [(G600, 600), (G400, 400), (G100, 100), (G540, 540), (G60, 60)] {
        assert_eq!(fee_split(gross, 100, 2000).3, net * USDG);
        assert_eq!(fee_split(gross - 1, 100, 2000).3, net * USDG - 1);
        assert_eq!(fee_split(gross + 1, 100, 2000).3, net * USDG + 1);
    }
}

// ------------------------------------------------- the worked example

#[test]
fn worked_example_with_the_fee_on() {
    let (mut t, sid) = worked_example_setup(&[(alice(), G600)]);
    let r = t.round(sid, 1);
    assert_eq!(r.state, RoundState::Live);
    assert_eq!([n(r.m_up), n(r.m_down), n(r.n_up), n(r.n_down)], [600 * USDG, 400 * USDG, 1_000 * USDG, 1_000 * USDG]);
    assert_eq!(r.close_at, T0 + 3_600 + DAY as u64);
    assert_eq!(r.trade_until, r.close_at - WINDOW as u64);
    assert_eq!(t.round(sid, 2).state, RoundState::Presale);

    // A live buy of UP netting exactly 100.
    t.fund(&carol(), G100);
    let q = t.buy(&carol(), sid, 1, Side::Up, G100);
    assert_eq!(q, BuyQuote { shares: U128(154_150_679), fee: U128(1_010_102), finder_fee: U128(202_020), net: U128(100_000_000) });
    let r = t.round(sid, 1);
    assert_eq!([n(r.m_up), n(r.n_up), n(r.m_down), n(r.n_down)], [700 * USDG, 1_154_150_679, 400 * USDG, 1_000 * USDG]);
    let (m1, n1, m2, n2) = (n(r.m_up) as f64, n(r.n_up) as f64, n(r.m_down) as f64, n(r.n_down) as f64);
    let mpr = m1 * n1 / (m1 * n1 + m2 * n2);
    assert!((mpr - 0.669).abs() < 5e-4, "MPr(UP) {mpr}");
    let p = t.pos(sid, 1, &carol()).unwrap();
    assert_eq!((n(p.stake_up), n(p.shares_up)), (100 * USDG, 154_150_679));
    assert_eq!(t.bal(&carol()), 0);

    // UP wins.
    t.now = r.close_at;
    t.settle(sid, TARGET + 700);
    assert_eq!(t.round(sid, 1).winner, Some(Side::Up));
    assert_eq!(t.claim(&carol(), sid, 1), 153_424_802, "the live buyer");
    assert_eq!(t.claim(&alice(), sid, 1), 946_575_197, "600 net of presale: 1,000 shares");
    assert_eq!(t.claim(&bob(), sid, 1), 0, "DOWN lost");
    let r = t.round(sid, 1);
    let pots = n(r.m_up) + n(r.m_down);
    assert_eq!(pots, 1_100 * USDG, "M1 + M2 = 600 + 100 + 400");
    assert_eq!(n(r.paid_out), 1_099_999_999, "every UP holder together, less one unit of dust");
    assert_eq!((t.bal(&alice()), t.bal(&bob()), t.bal(&carol())), (946_575_197, 0, 153_424_802));
    for who in [alice(), bob(), carol()] {
        assert!(t.pos(sid, 1, &who).is_none());
        assert!(t.c.positions_of(who).is_empty());
    }
    // Fees: 1 % rounded up on each gross amount, the finder's 20 % rounded down.
    let s = t.ser(sid);
    assert_eq!((n(s.finder_fees), n(s.platform_fees)), (1_212_121 + 808_081 + 202_020, 4_848_486 + 3_232_324 + 808_082));
}

#[test]
fn worked_example_presale_commit_of_60() {
    let (mut t, sid) = worked_example_setup(&[(alice(), G540), (dave(), G60)]);
    let p = t.pos(sid, 1, &dave()).unwrap();
    assert_eq!(n(p.presale_up), 60 * USDG);
    t.fund(&carol(), G100);
    assert_eq!(n(t.buy(&carol(), sid, 1, Side::Up, G100).shares), 154_150_679);
    t.now = t.round(sid, 1).close_at;
    t.settle(sid, TARGET + 1);
    // 60 · 1,000/600 = 100 shares; paid 60 + 100 · 400/1,154.150679.
    assert_eq!(t.claim(&dave(), sid, 1), 94_657_519);
    assert_eq!(t.claim(&carol(), sid, 1), 153_424_802);
    assert_eq!(t.claim(&alice(), sid, 1), 851_917_678);
    assert_eq!(t.claim(&bob(), sid, 1), 0);
    let r = t.round(sid, 1);
    assert!(n(r.paid_out) <= n(r.m_up) + n(r.m_down));
    assert_eq!(n(r.m_up) + n(r.m_down) - n(r.paid_out), 1, "dust");
}

// ------------------------------------------ the Solana e2e, replayed

/// `atnx-web/scripts/rounds-sol.ts e2e`, step by step, with every number
/// checked against `dpm.ts`: gross commits of 600 and 400, alice's buy of
/// 101.010102 (net 100), bob's buy of 50, a rollover, the keeper's ante,
/// a second round won by DOWN, pause and void, fee withdrawals and zero
/// dust.
#[test]
fn solana_e2e_replay() {
    let mut t = T::new();
    for who in [alice(), bob(), finder()] {
        t.fund(&who, 2_000 * USDG);
    }
    t.fund(&keeper(), 100 * USDG);
    let funded = 6_100 * USDG;

    let sid = t.series(REF_A, 30, 10);
    let s = t.ser(sid);
    assert_eq!(
        (s.round_secs, s.settle_window_secs, s.fee_bps, s.finder_bps, n(s.ante), s.live_round, s.presale_round, s.paused),
        (30, 10, 100, 2000, 10 * USDG, 0, 1, false)
    );
    assert_eq!((s.finder.clone(), s.reference.as_str()), (finder(), REF_A));
    assert_eq!(t.round(sid, 1).state, RoundState::Presale);

    // Round 1 presale.
    t.commit(&alice(), sid, 1, Side::Up, 600 * USDG);
    t.commit(&bob(), sid, 1, Side::Down, 400 * USDG);
    let r1 = t.round(sid, 1);
    assert_eq!((n(r1.presale_up), n(r1.presale_down)), (594 * USDG, 396 * USDG));
    let s = t.ser(sid);
    assert_eq!((n(s.finder_fees), n(s.platform_fees)), (2 * USDG, 8 * USDG));

    // Open round 1.
    t.now += 60;
    t.open(sid, 10_000);
    let r1 = t.round(sid, 1);
    assert_eq!([n(r1.m_up), n(r1.m_down), n(r1.n_up), n(r1.n_down)], [594 * USDG, 396 * USDG, 990 * USDG, 990 * USDG]);
    assert_eq!((r1.target_e2, r1.close_at - r1.opened_at, r1.trade_until), (10_000, 30, r1.close_at - 10));
    assert_eq!(t.round(sid, 2).state, RoundState::Presale);
    let s = t.ser(sid);
    assert_eq!((s.live_round, s.presale_round), (1, 2));

    // Live buys, each equal to the dpm.ts quote.
    let qa = t.buy(&alice(), sid, 1, Side::Up, 101_010_102);
    assert_eq!((n(qa.fee), n(qa.net), n(qa.shares)), (1_010_102, 100 * USDG, 154_036_714));
    let qb = t.buy(&bob(), sid, 1, Side::Down, 50 * USDG);
    assert_eq!((n(qb.fee), n(qb.net), n(qb.shares)), (500_000, 49_500_000, 134_748_117));
    let r1 = t.round(sid, 1);
    assert_eq!([n(r1.m_up), n(r1.m_down), n(r1.n_up), n(r1.n_down)], [694_000_000, 445_500_000, 1_144_036_714, 1_124_748_117]);
    t.commit(&bob(), sid, 2, Side::Up, 20 * USDG); // round 2

    // Negatives.
    expect_err("round has not reached its close", || t.settle(sid, 10_000));
    expect_err("not the keeper", || {
        t.by(&bob()).settle(sid, 10_000, ZEROS.to_string());
    });
    t.now = r1.trade_until;
    expect_err("trading closed for the settlement window", || {
        t.by(&alice()).buy(sid, 1, Side::Up, U128(USDG as u128), U128(0));
    });

    // Settle round 1 on a tie: UP.
    t.now = r1.close_at;
    t.settle(sid, 10_000);
    let r1 = t.round(sid, 1);
    assert_eq!((r1.state, r1.winner, r1.settle_e2), (RoundState::Settled, Some(Side::Up), 10_000));
    let s = t.ser(sid);
    assert_eq!((s.live_round, s.presale_round), (0, 2));

    // Alice rolls over (payout 1,139.5, fee 11.395), bob claims 0.
    let alice_before = t.bal(&alice());
    let rolled = t.by(&alice()).claim_rollover(sid, 1);
    assert_eq!(n(rolled), 1_128_105_000);
    let p2 = t.pos(sid, 2, &alice()).unwrap();
    assert_eq!((n(p2.presale_up), n(p2.presale_down)), (1_128_105_000, 0));
    assert!(t.pos(sid, 1, &alice()).is_none());
    assert_eq!(t.bal(&alice()), alice_before, "a rollover moves no balance");
    let bob_before = t.bal(&bob());
    assert_eq!(t.claim(&bob(), sid, 1), 0);
    assert_eq!(t.bal(&bob()), bob_before);
    assert!(t.pos(sid, 1, &bob()).is_none());
    let r1 = t.round(sid, 1);
    assert_eq!(n(r1.paid_out), 1_139_500_000);
    let dust1 = n(r1.m_up) + n(r1.m_down) - n(r1.paid_out);
    assert_eq!(dust1, 0);

    // Round 2: one-sided, so the keeper antes DOWN; open, then DOWN wins.
    let r2 = t.round(sid, 2);
    assert_eq!((n(r2.presale_up), n(r2.presale_down)), (19_800_000 + 1_128_105_000, 0));
    let ante = n(t.ser(sid).ante);
    t.commit(&keeper(), sid, 2, Side::Down, ante);
    t.open(sid, 10_000);
    let r2 = t.round(sid, 2);
    assert_eq!((r2.state, n(r2.presale_up), n(r2.presale_down)), (RoundState::Live, 1_147_905_000, 9_900_000));
    assert_eq!(t.round(sid, 3).state, RoundState::Presale);
    let s = t.ser(sid);
    assert_eq!((s.live_round, s.presale_round), (2, 3));
    t.now = r2.close_at;
    t.settle(sid, 9_000);
    let r2 = t.round(sid, 2);
    assert_eq!((r2.state, r2.winner), (RoundState::Settled, Some(Side::Down)));
    assert_eq!(t.claim(&bob(), sid, 2), 0);
    assert_eq!(t.claim(&alice(), sid, 2), 0);
    assert_eq!(t.claim(&keeper(), sid, 2), 1_157_805_000);
    let r2 = t.round(sid, 2);
    let dust2 = n(r2.m_up) + n(r2.m_down) - n(r2.paid_out);
    assert_eq!(dust2, 0);

    // Pause and void round 3: the series ends.
    t.by(&keeper()).set_series(sid, Some(true), None, None);
    assert!(t.ser(sid).paused);
    t.by(&keeper()).void_round(sid, 3);
    assert_eq!(t.round(sid, 3).state, RoundState::Void);
    assert_eq!(t.ser(sid).presale_round, 0);

    // Fees out: anyone may call it.
    let s = t.ser(sid);
    assert_eq!((n(s.finder_fees), n(s.platform_fees)), (4_641_020, 18_564_082));
    let finder_before = t.bal(&finder());
    t.by(&carol()).withdraw_fees(sid);
    assert_eq!(t.bal(&finder()) - finder_before, 4_641_020);
    assert_eq!(t.bal(&treasury()), 18_564_082);
    let s = t.ser(sid);
    assert_eq!((n(s.finder_fees), n(s.platform_fees)), (0, 0));

    // Conservation: every unit funded is in a balance or is dust.
    let held: u64 = [alice(), bob(), finder(), keeper(), treasury()].iter().map(|a| t.bal(a)).sum();
    assert_eq!(held + dust1 + dust2, funded);
    assert_eq!(t.bal(&keeper()), 100 * USDG - ante + 1_157_805_000);
}

// --------------------------------------------- settle, void, rollover

/// alice 100 UP, bob 100 DOWN (gross), open; carol buys 50 on `carol_side`.
fn simple_round(carol_side: Side) -> (T, u32) {
    let mut t = T::new();
    let sid = t.series(REF_A, DAY, WINDOW);
    for who in [alice(), bob(), carol()] {
        t.fund(&who, 1_000 * USDG);
    }
    t.commit(&alice(), sid, 1, Side::Up, 100 * USDG);
    t.commit(&bob(), sid, 1, Side::Down, 100 * USDG);
    t.open(sid, TARGET);
    t.buy(&carol(), sid, 1, carol_side, 50 * USDG);
    (t, sid)
}

#[test]
fn settle_down_pays_the_down_side() {
    let (mut t, sid) = simple_round(Side::Down);
    let r = t.round(sid, 1);
    t.now = r.close_at;
    t.settle(sid, TARGET - 1);
    let r = t.round(sid, 1);
    assert_eq!(r.winner, Some(Side::Down));
    let bob_paid = t.claim(&bob(), sid, 1);
    let carol_paid = t.claim(&carol(), sid, 1);
    assert_eq!(t.claim(&alice(), sid, 1), 0);
    // DOWN holders get their net stakes back plus all of M_up between them.
    assert!(bob_paid > 99 * USDG && carol_paid > 49_500_000);
    let pots = n(r.m_up) + n(r.m_down);
    assert!(bob_paid + carol_paid <= pots && pots - (bob_paid + carol_paid) <= 2);
}

#[test]
fn a_tie_goes_up() {
    let (mut t, sid) = simple_round(Side::Down);
    t.now = t.round(sid, 1).close_at;
    t.settle(sid, TARGET);
    assert_eq!(t.round(sid, 1).winner, Some(Side::Up));
    assert!(t.claim(&alice(), sid, 1) > 99 * USDG);
    assert_eq!(t.claim(&carol(), sid, 1), 0);
}

#[test]
fn void_refunds_net_stakes_and_keeps_the_fees() {
    let (mut t, sid) = simple_round(Side::Up);
    let r = t.round(sid, 1);
    expect_err("round has not reached its close", || t.by(&keeper()).void_round(sid, 1));
    expect_err("not the keeper", || t.by(&alice()).void_round(sid, 1));
    expect_err("series is not paused", || t.by(&keeper()).void_round(sid, 2));
    expect_err("no such round", || t.by(&keeper()).void_round(sid, 7));
    let fees_before = t.ser(sid);
    t.now = r.close_at + 1_800;
    t.by(&keeper()).void_round(sid, 1);
    assert_eq!(
        get_logs(),
        vec![r#"EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":"round_voided","data":[{"series_id":"1","round_index":"1"}]}"#]
    );
    assert_eq!(t.round(sid, 1).state, RoundState::Void);
    let s = t.ser(sid);
    assert_eq!((s.live_round, s.presale_round), (0, 2), "the series goes on");
    expect_err("round index or state does not fit this call", || t.by(&keeper()).void_round(sid, 1));
    expect_err("round is not the series' live round", || t.settle(sid, TARGET));

    assert_eq!(t.claim(&alice(), sid, 1), 99 * USDG);
    assert_eq!(t.claim(&bob(), sid, 1), 99 * USDG);
    assert_eq!(t.claim(&carol(), sid, 1), 49_500_000, "presale and live stakes alike: net of the fee");
    let s = t.ser(sid);
    assert_eq!((s.finder_fees, s.platform_fees), (fees_before.finder_fees, fees_before.platform_fees));
    assert_eq!(n(t.round(sid, 1).paid_out), 99 * USDG * 2 + 49_500_000);
    assert_eq!(t.bal(&carol()), 950 * USDG + 49_500_000);
    // Round 2 can still open once both sides have money.
    t.commit(&alice(), sid, 2, Side::Up, USDG);
    t.commit(&bob(), sid, 2, Side::Down, USDG);
    t.open(sid, TARGET);
    assert_eq!(t.ser(sid).live_round, 2);
}

#[test]
fn a_rollover_lands_in_round_n_plus_2() {
    let (mut t, sid) = simple_round(Side::Up);
    t.commit(&bob(), sid, 2, Side::Up, 10 * USDG); // round 2 presale
    t.commit(&carol(), sid, 2, Side::Down, 10 * USDG);
    // The keeper settles round 1 and opens round 2 in the same tick.
    let r1 = t.round(sid, 1);
    t.now = r1.close_at + 300;
    t.settle(sid, TARGET + 50);
    t.open(sid, TARGET + 50);
    let s = t.ser(sid);
    assert_eq!((s.live_round, s.presale_round), (2, 3));

    let fees_before = t.ser(sid);
    let due = {
        let r = t.round(sid, 1);
        let p = t.pos(sid, 1, &alice()).unwrap();
        let total = n(r.presale_up) + n(r.presale_down);
        payout(n(p.presale_up), presale_shares(n(p.presale_up), n(r.presale_up), total), n(r.m_down), n(r.n_up)).unwrap()
    };
    let (fee, fin, plat, net) = fee_split(due, 100, 2000);
    assert_eq!(n(t.by(&alice()).claim_rollover(sid, 1)), net);
    assert_eq!(fee, fin + plat);
    let logs = get_logs();
    assert!(logs[0].contains(r#""event":"rollover""#) && logs[0].contains(r#""next_round_index":"3""#));
    assert!(logs[1].contains(r#""event":"commit""#) && logs[1].contains(r#""round_index":"3""#));

    let r3 = t.round(sid, 3);
    assert_eq!((n(r3.presale_up), n(r3.presale_down)), (net, 0), "on the winning side of round N+2");
    assert_eq!(n(t.pos(sid, 3, &alice()).unwrap().presale_up), net);
    assert!(t.pos(sid, 2, &alice()).is_none(), "nothing lands in the live round N+1");
    assert!(t.pos(sid, 1, &alice()).is_none());
    let mine: Vec<(u32, u32)> = t.c.positions_of(alice()).iter().map(|p| (p.series_id, p.round_index)).collect();
    assert_eq!(mine, vec![(1, 3)]);
    let s = t.ser(sid);
    assert_eq!(n(s.finder_fees) - n(fees_before.finder_fees), fin, "the fee is on the whole rolled amount");
    assert_eq!(n(s.platform_fees) - n(fees_before.platform_fees), plat);
    assert_eq!(n(t.round(sid, 1).paid_out), due);

    // A losing position has nothing to roll; a claimed one is gone.
    expect_err("nothing to claim", || {
        t.by(&bob()).claim_rollover(sid, 1);
    });
    expect_err("no position in this round", || {
        t.by(&alice()).claim_rollover(sid, 1);
    });
    // The live round cannot be rolled.
    expect_err("round is not settled", || {
        t.by(&bob()).claim_rollover(sid, 2);
    });
}

#[test]
fn pause_voids_the_presale_round_and_stops_trading() {
    let (mut t, sid) = simple_round(Side::Up);
    t.commit(&alice(), sid, 2, Side::Down, 5 * USDG); // round 2 presale
    expect_err("not the authority or the keeper", || t.by(&alice()).set_series(sid, Some(true), None, None));
    t.by(&owner()).set_series(sid, Some(true), None, None);
    assert!(t.ser(sid).paused);

    expect_err("series is paused", || t.commit(&bob(), sid, 2, Side::Up, USDG));
    expect_err("series is paused", || {
        t.by(&bob()).buy(sid, 1, Side::Up, U128(USDG as u128), U128(0));
    });
    expect_err("series is paused", || {
        t.by(&bob()).quote_buy(sid, 1, Side::Up, U128(USDG as u128));
    });

    // The presale round is voided; its commits are refunded.
    t.by(&keeper()).void_round(sid, 2);
    assert_eq!(t.round(sid, 2).state, RoundState::Void);
    assert_eq!(t.ser(sid).presale_round, 0);
    assert_eq!(t.claim(&alice(), sid, 2), 4_950_000);

    // The live round still settles and pays; rollovers are refused.
    let r1 = t.round(sid, 1);
    t.now = r1.close_at;
    t.settle(sid, TARGET + 1);
    expect_err("series is paused", || {
        t.by(&alice()).claim_rollover(sid, 1);
    });
    assert!(t.claim(&alice(), sid, 1) > 99 * USDG);
    assert!(t.claim(&carol(), sid, 1) > 49 * USDG);

    // Resuming does not bring back a presale round: the series has ended.
    t.by(&keeper()).set_series(sid, Some(false), None, None);
    expect_err("round is not the series' presale round", || t.commit(&bob(), sid, 2, Side::Up, USDG));
    expect_err("round is not the series' presale round", || t.commit(&bob(), sid, 3, Side::Up, USDG));
    expect_err("round is not the series' presale round", || t.open(sid, TARGET));
}

#[test]
fn fees_go_to_the_finder_and_the_treasury() {
    let mut t = T::new();
    let sid = t.series(REF_A, DAY, WINDOW);
    expect_err("nothing to claim", || t.by(&alice()).withdraw_fees(sid));
    t.fund(&alice(), 1_000 * USDG);
    t.commit(&alice(), sid, 1, Side::Up, 50 * USDG);
    // docs/rounds.md: a commit of 50 puts 49.50 in the pot, 0.10 to the finder, 0.40 to the platform.
    assert_eq!(n(t.round(sid, 1).presale_up), 49_500_000);
    let s = t.ser(sid);
    assert_eq!((n(s.finder_fees), n(s.platform_fees)), (100_000, 400_000));

    // The finder at withdrawal time is paid.
    t.by(&keeper()).set_series(sid, None, Some(dave()), None);
    t.by(&bob()).withdraw_fees(sid);
    assert_eq!((t.bal(&dave()), t.bal(&treasury()), t.bal(&finder())), (100_000, 400_000, 0));
    assert_eq!(
        get_logs(),
        vec![r#"EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":"fees_withdrawn","data":[{"series_id":"1","finder":"dave.near","finder_amount":"100000","treasury":"treasury.near","platform_amount":"400000"}]}"#]
    );
    let s = t.ser(sid);
    assert_eq!((n(s.finder_fees), n(s.platform_fees)), (0, 0));
    expect_err("nothing to claim", || t.by(&bob()).withdraw_fees(sid));

    // A config change does not touch a running series.
    t.by(&owner()).set_config(None, None, Some(200), Some(5000));
    t.commit(&alice(), sid, 1, Side::Up, 100 * USDG);
    let s = t.ser(sid);
    assert_eq!((s.fee_bps, s.finder_bps, n(s.finder_fees), n(s.platform_fees)), (100, 2000, 200_000, 800_000));
    let sid2 = t.series(REF_B, DAY, WINDOW);
    let s2 = t.ser(sid2);
    assert_eq!((s2.fee_bps, s2.finder_bps), (200, 5000));
    t.commit(&alice(), sid2, 1, Side::Up, 100 * USDG);
    let s2 = t.ser(sid2);
    assert_eq!((n(s2.finder_fees), n(s2.platform_fees)), (1_000_000, 1_000_000));
}

// ---------------------------------------------------------- errors

#[test]
fn slippage_and_the_ratio_cap() {
    let (mut t, sid) = simple_round(Side::Up);
    let q = t.by(&carol()).quote_buy(sid, 1, Side::Down, U128(10 * USDG as u128));
    expect_err("fewer shares than the minimum you set", || {
        t.by(&carol()).buy(sid, 1, Side::Down, U128(10 * USDG as u128), U128(q.shares.0 + 1));
    });
    t.by(&carol()).buy(sid, 1, Side::Down, U128(10 * USDG as u128), q.shares);

    // Thin pots: 0.99 a side. A net spend above 1,000 × 0.99 is refused.
    let mut t = T::new();
    let sid = t.series(REF_A, DAY, WINDOW);
    t.fund(&alice(), 5_000 * USDG);
    t.commit(&alice(), sid, 1, Side::Up, USDG);
    t.commit(&alice(), sid, 1, Side::Down, USDG);
    t.open(sid, TARGET);
    let cap = "a single buy may not exceed 1000x the money on its side";
    expect_err(cap, || {
        t.by(&alice()).quote_buy(sid, 1, Side::Up, U128(1_001 * USDG as u128));
    });
    expect_err(cap, || {
        t.by(&alice()).buy(sid, 1, Side::Up, U128(1_001 * USDG as u128), U128(0));
    });
    // 1,000 gross nets 990 = 1,000 × 0.99: allowed.
    t.by(&alice()).buy(sid, 1, Side::Up, U128(1_000 * USDG as u128), U128(0));
}

/// The race the required `round_index` closes: a commit aimed at round N
/// reaches the contract after the keeper has opened N. It fails, and
/// nothing moves, instead of landing in round N+1.
#[test]
fn a_commit_naming_a_round_the_keeper_has_opened_fails() {
    let mut t = T::new();
    let sid = t.series(REF_A, DAY, WINDOW);
    for who in [alice(), bob(), carol()] {
        t.fund(&who, 100 * USDG);
    }
    t.commit(&alice(), sid, 1, Side::Up, 10 * USDG);
    t.commit(&bob(), sid, 1, Side::Down, 10 * USDG);
    t.open(sid, TARGET); // round 1 live, round 2 in presale
    let fees = t.ser(sid);
    let not_presale = "round is not the series' presale round";
    expect_err(not_presale, || t.commit(&carol(), sid, 1, Side::Up, 10 * USDG));
    assert_eq!(t.bal(&carol()), 100 * USDG, "no balance moved");
    let r2 = t.round(sid, 2);
    assert_eq!((n(r2.presale_up), n(r2.presale_down)), (0, 0), "nothing landed in round 2");
    let r1 = t.round(sid, 1);
    assert_eq!((n(r1.presale_up), n(r1.presale_down)), (9_900_000, 9_900_000));
    assert!(t.pos(sid, 1, &carol()).is_none() && t.pos(sid, 2, &carol()).is_none());
    let s = t.ser(sid);
    assert_eq!((s.finder_fees, s.platform_fees), (fees.finder_fees, fees.platform_fees));
    // Rounds that do not exist are not the presale round either.
    expect_err(not_presale, || t.commit(&carol(), sid, 0, Side::Up, 10 * USDG));
    expect_err(not_presale, || t.commit(&carol(), sid, 3, Side::Up, 10 * USDG));
    // Naming round 2 commits to round 2.
    t.commit(&carol(), sid, 2, Side::Up, 10 * USDG);
    assert_eq!(n(t.round(sid, 2).presale_up), 9_900_000);
    assert_eq!(n(t.pos(sid, 2, &carol()).unwrap().presale_up), 9_900_000);
}

/// The same guard on `buy` and `quote_buy`: only the live round, by name.
#[test]
fn a_buy_or_quote_must_name_the_live_round() {
    let (mut t, sid) = simple_round(Side::Up);
    t.commit(&bob(), sid, 2, Side::Up, 10 * USDG);
    t.commit(&alice(), sid, 2, Side::Down, 10 * USDG);
    let not_live = "round is not the series' live round";
    for ri in [0, 2, 3] {
        expect_err(not_live, || {
            t.by(&carol()).quote_buy(sid, ri, Side::Up, U128(USDG as u128));
        });
        expect_err(not_live, || {
            t.by(&carol()).buy(sid, ri, Side::Up, U128(USDG as u128), U128(0));
        });
    }
    // The keeper settles round 1 and opens round 2 in one tick. A buy still
    // naming round 1 fails instead of filling in round 2 at its prices.
    t.now = t.round(sid, 1).close_at;
    t.settle(sid, TARGET);
    t.open(sid, TARGET);
    let carol_before = t.bal(&carol());
    let r2 = t.round(sid, 2);
    expect_err(not_live, || {
        t.by(&carol()).buy(sid, 1, Side::Up, U128(USDG as u128), U128(0));
    });
    expect_err(not_live, || {
        t.by(&carol()).quote_buy(sid, 1, Side::Up, U128(USDG as u128));
    });
    assert_eq!(t.bal(&carol()), carol_before);
    assert_eq!(t.round(sid, 2), r2, "round 2 untouched");
    t.buy(&carol(), sid, 2, Side::Up, USDG);
    assert!(n(t.pos(sid, 2, &carol()).unwrap().shares_up) > 0);
}

#[test]
fn trading_and_settling_follow_the_clock() {
    let (mut t, sid) = simple_round(Side::Up);
    let r = t.round(sid, 1);
    t.now = r.trade_until - 1;
    t.buy(&carol(), sid, 1, Side::Up, USDG);
    t.now = r.trade_until;
    expect_err("trading closed for the settlement window", || {
        t.by(&carol()).quote_buy(sid, 1, Side::Up, U128(USDG as u128));
    });
    t.now = r.close_at - 1;
    expect_err("round has not reached its close", || t.settle(sid, TARGET));
    t.now = r.close_at;
    t.settle(sid, TARGET);
    expect_err("round is not the series' live round", || {
        t.by(&carol()).buy(sid, 1, Side::Up, U128(USDG as u128), U128(0));
    });
}

#[test]
fn opening_needs_both_sides_and_no_live_round() {
    let mut t = T::new();
    let sid = t.series(REF_A, DAY, WINDOW);
    t.fund(&alice(), 100 * USDG);
    t.fund(&keeper(), 10 * USDG);
    expect_err("both sides need money before a round can open", || t.open(sid, TARGET));
    t.commit(&alice(), sid, 1, Side::Up, 10 * USDG);
    expect_err("both sides need money before a round can open", || t.open(sid, TARGET));
    t.commit(&keeper(), sid, 1, Side::Down, 10 * USDG); // the ante
    expect_err("not the keeper", || t.by(&alice()).open_round(sid, TARGET));
    expect_err("amount is zero", || t.open(sid, 0));
    t.open(sid, TARGET);
    t.commit(&alice(), sid, 2, Side::Up, 10 * USDG);
    t.commit(&alice(), sid, 2, Side::Down, 10 * USDG);
    expect_err("a live round already exists", || t.open(sid, TARGET));
    expect_err("no such series", || t.open(9, TARGET));
}

#[test]
fn amounts_and_balances_are_checked() {
    let mut t = T::new();
    let sid = t.series(REF_A, DAY, WINDOW);
    t.fund(&alice(), 10 * USDG);
    expect_err("amount is zero", || t.commit(&alice(), sid, 1, Side::Up, 0));
    // 1 unit: the fee rounds up to 1, nothing is left for the pot.
    expect_err("amount is zero", || t.commit(&alice(), sid, 1, Side::Up, 1));
    expect_err("balance too low", || t.commit(&alice(), sid, 1, Side::Up, 10 * USDG + 1));
    expect_err("balance too low", || t.commit(&bob(), sid, 1, Side::Up, USDG));
    expect_err("arithmetic overflow", || {
        t.by(&alice()).commit(sid, 1, Side::Up, U128(u64::MAX as u128 + 1));
    });
    t.commit(&alice(), sid, 1, Side::Up, 10 * USDG);
    assert_eq!(t.bal(&alice()), 0);
    expect_err("round is not settled", || {
        t.by(&alice()).claim(sid, 1);
    });
    expect_err("no position in this round", || {
        t.by(&bob()).claim(sid, 1);
    });
    expect_err("no such round", || {
        t.by(&alice()).claim(sid, 4);
    });
}

#[test]
fn keeper_and_owner_methods_are_guarded() {
    let mut t = T::new();
    let sid = t.series(REF_A, DAY, WINDOW);
    expect_err("not the keeper", || {
        t.by(&alice()).create_series(REF_B.to_string(), DAY, WINDOW, U128(0), alice());
    });
    expect_err("not the keeper", || {
        t.by(&owner()).create_series(REF_B.to_string(), DAY, WINDOW, U128(0), alice());
    });
    expect_err("not the keeper", || t.by(&owner()).open_round(sid, TARGET));
    expect_err("not the keeper", || t.by(&owner()).settle(sid, TARGET, ZEROS.to_string()));
    expect_err("not the keeper", || t.by(&treasury()).void_round(sid, 1));
    expect_err("not the owner", || t.by(&keeper()).set_config(Some(alice()), None, None, None));
    expect_err("not the authority or the keeper", || t.by(&finder()).set_series(sid, None, Some(alice()), None));
    expect_err("fee above the cap", || t.by(&owner()).set_config(None, None, Some(501), None));
    expect_err("fee above the cap", || t.by(&owner()).set_config(None, None, None, Some(10_001)));

    // The owner hands the keeper role on.
    t.by(&owner()).set_config(Some(carol()), Some(dave()), None, None);
    let c = t.c.get_config();
    assert_eq!((c.keeper, c.treasury, c.series_count), (carol(), dave(), 1));
    expect_err("not the keeper", || {
        t.by(&keeper()).create_series(REF_B.to_string(), DAY, WINDOW, U128(0), alice());
    });
    t.by(&carol()).create_series(REF_B.to_string(), DAY, WINDOW, U128(0), alice());

    expect_err("fee above the cap", || {
        ctx(&owner(), T0);
        Contract::new(owner(), keeper(), treasury(), token(), 501, 2000);
    });
}

#[test]
fn series_creation_is_validated() {
    let mut t = T::new();
    let k = keeper();
    let bad_window = "settlement window must be shorter than the round, round at least 20 s";
    expect_err(bad_window, || {
        t.by(&k).create_series(REF_A.to_string(), 19, 5, U128(0), finder());
    });
    expect_err(bad_window, || {
        t.by(&k).create_series(REF_A.to_string(), 60, 60, U128(0), finder());
    });
    let bad_ref = "reference must be 64 lowercase hex characters";
    expect_err(bad_ref, || {
        t.by(&k).create_series(REF_A[..62].to_string(), DAY, WINDOW, U128(0), finder());
    });
    expect_err(bad_ref, || {
        t.by(&k).create_series(REF_A.to_uppercase(), DAY, WINDOW, U128(0), finder());
    });
    assert_eq!(t.by(&k).create_series(REF_A.to_string(), 20, 19, U128(0), finder()), 1);
    assert_eq!(
        get_logs(),
        vec![format!(
            r#"EVENT_JSON:{{"standard":"atnx_rounds","version":"1.0.0","event":"series_created","data":[{{"series_id":"1","round_index":"1","reference":"{REF_A}","finder":"finder.near","round_secs":"20","settle_window_secs":"19","ante":"0"}}]}}"#
        )]
    );
    expect_err("a series with this reference already exists", || {
        t.by(&k).create_series(REF_A.to_string(), DAY, WINDOW, U128(0), finder());
    });
    expect_err("commitment must be 64 lowercase hex characters", || t.by(&k).settle(1, TARGET, "00".to_string()));
}

#[test]
fn ft_on_transfer_takes_usdg_only() {
    let mut t = T::new();
    let left = t.by(&acc("other-token.near")).ft_on_transfer(alice(), U128(5 * USDG as u128), String::new());
    assert_eq!(left, U128(5 * USDG as u128), "the full amount goes back");
    assert_eq!(t.bal(&alice()), 0);
    assert!(get_logs().is_empty());
    // A user calling it directly is just another wrong token.
    assert_eq!(t.by(&alice()).ft_on_transfer(alice(), U128(7), String::new()), U128(7));
    assert_eq!(t.bal(&alice()), 0);

    let left = t.by(&token()).ft_on_transfer(alice(), U128(5 * USDG as u128), "ignored".to_string());
    assert_eq!(left, U128(0));
    assert_eq!(t.bal(&alice()), 5 * USDG);
    assert_eq!(
        get_logs(),
        vec![r#"EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":"deposit","data":[{"account":"alice.near","amount":"5000000"}]}"#]
    );
}

#[test]
fn faucet_caps_and_credits_after_the_mint() {
    let mut t = T::new();
    expect_err("mint above the per-call cap", || {
        let _ = t.by(&alice()).faucet(U128(MAX_FAUCET as u128 + 1));
    });
    let _ = t.by(&alice()).faucet(U128(MAX_FAUCET as u128));
    assert_eq!(t.bal(&alice()), 0, "nothing is credited before the mint");

    let got = t.by(&rounds()).on_faucet(alice(), U128(MAX_FAUCET as u128), Err(PromiseError::Failed));
    assert_eq!((got, t.bal(&alice())), (U128(0), 0));
    let got = t.by(&rounds()).on_faucet(alice(), U128(MAX_FAUCET as u128), Ok(()));
    assert_eq!((got, t.bal(&alice())), (U128(MAX_FAUCET as u128), MAX_FAUCET));
    assert_eq!(
        get_logs(),
        vec![r#"EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":"faucet","data":[{"account":"alice.near","amount":"10000000000"}]}"#]
    );
}

#[test]
fn withdraw_debits_first_and_refunds_a_failed_transfer() {
    let mut t = T::new();
    t.fund(&alice(), 30 * USDG);
    expect_err("amount is zero", || {
        let _ = t.by(&alice()).withdraw(U128(0));
    });
    expect_err("balance too low", || {
        let _ = t.by(&alice()).withdraw(U128(30 * USDG as u128 + 1));
    });
    let _ = t.by(&alice()).withdraw(U128(20 * USDG as u128));
    assert_eq!(t.bal(&alice()), 10 * USDG, "debited before the transfer");

    let got = t.by(&rounds()).on_withdraw(alice(), U128(20 * USDG as u128), Err(PromiseError::Failed));
    assert_eq!((got, t.bal(&alice())), (U128(0), 30 * USDG), "re-credited");

    let _ = t.by(&alice()).withdraw(U128(30 * USDG as u128));
    assert_eq!(t.bal(&alice()), 0);
    let got = t.by(&rounds()).on_withdraw(alice(), U128(30 * USDG as u128), Ok(()));
    assert_eq!((got, t.bal(&alice())), (U128(30 * USDG as u128), 0));
    assert_eq!(
        get_logs(),
        vec![r#"EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":"withdraw","data":[{"account":"alice.near","amount":"30000000"}]}"#]
    );
}

// --------------------------------------------------- conservation

/// 12 holders, random presale commits and 200 random buys through the
/// contract; then everyone claims. Paid out never exceeds the pots, the
/// dust is at most two units per holder, and no winner gets back less
/// than their net stake.
fn conservation_run(up_wins: bool) {
    let mut seed = 0x9E37_79B9_7F4A_7C15u64 ^ up_wins as u64;
    let mut rnd = |max: u64| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) % max + 1
    };
    let holders: Vec<AccountId> = (0..12).map(|i| acc(&format!("h{i}.near"))).collect();
    let mut t = T::new();
    let sid = t.series(REF_C, DAY, WINDOW);
    for h in &holders {
        t.fund(h, 10_000 * USDG);
        t.commit(h, sid, 1, Side::Up, rnd(50 * USDG) + 1);
        t.commit(h, sid, 1, Side::Down, rnd(50 * USDG) + 1);
    }
    t.open(sid, TARGET);
    for _ in 0..200 {
        let h = holders[rnd(holders.len() as u64) as usize - 1].clone();
        let side = if rnd(2) == 1 { Side::Up } else { Side::Down };
        t.buy(&h, sid, 1, side, rnd(20 * USDG) + 1);
    }
    t.now = t.round(sid, 1).close_at;
    t.settle(sid, if up_wins { TARGET + 10 } else { TARGET - 10 });
    let r = t.round(sid, 1);
    let mut paid = 0u64;
    for h in &holders {
        let p = t.pos(sid, 1, h).unwrap();
        let stake = if up_wins { n(p.presale_up) + n(p.stake_up) } else { n(p.presale_down) + n(p.stake_down) };
        let got = t.claim(h, sid, 1);
        assert!(got >= stake, "a correct bet never gets back less than its net stake");
        paid += got;
    }
    let pots = n(r.m_up) + n(r.m_down);
    assert!(paid <= pots, "paid {paid} of {pots}");
    assert!(pots - paid <= 2 * holders.len() as u64, "dust {}", pots - paid);
    assert_eq!(n(t.round(sid, 1).paid_out), paid);
}

#[test]
fn payouts_never_exceed_the_pots_up() {
    conservation_run(true);
}

#[test]
fn payouts_never_exceed_the_pots_down() {
    conservation_run(false);
}

// ------------------------------------------------------------ views

#[test]
fn views_and_events() {
    let mut t = T::new();
    for (i, r) in [REF_A, REF_B, REF_C].iter().enumerate() {
        assert_eq!(t.series(r, DAY, WINDOW), i as u32 + 1);
    }
    assert_eq!(t.c.get_series_by_reference(REF_B.to_string()).unwrap().id, 2);
    assert!(t.c.get_series_by_reference(ZEROS.to_string()).is_none());
    let ids = |v: Vec<SeriesView>| v.iter().map(|s| s.id).collect::<Vec<_>>();
    assert_eq!(ids(t.c.list_series(None, None)), vec![1, 2, 3]);
    assert_eq!(ids(t.c.list_series(Some(1), Some(1))), vec![2]);
    assert_eq!(ids(t.c.list_series(Some(3), None)), Vec::<u32>::new());
    assert!(t.c.get_series(4).is_none());
    assert!(t.c.get_round(1, 2).is_none());
    assert_eq!(t.c.get_round(1, 1).unwrap().commitment, ZEROS);

    t.fund(&alice(), 100 * USDG);
    t.commit(&alice(), 1, 1, Side::Up, 50 * USDG);
    assert_eq!(
        get_logs(),
        vec![r#"EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":"commit","data":[{"series_id":"1","round_index":"1","account":"alice.near","side":"Up","amount":"50000000","fee":"500000","net":"49500000","presale_up":"49500000","presale_down":"0"}]}"#]
    );
    t.commit(&alice(), 3, 1, Side::Down, 10 * USDG);
    t.commit(&alice(), 1, 1, Side::Down, 10 * USDG);
    let mine: Vec<(u32, u32, u64, u64)> =
        t.c.positions_of(alice()).iter().map(|p| (p.series_id, p.round_index, n(p.presale_up), n(p.presale_down))).collect();
    assert_eq!(mine, vec![(1, 1, 49_500_000, 9_900_000), (3, 1, 0, 9_900_000)]);
    assert!(t.c.positions_of(bob()).is_empty());

    // JSON shapes at the interface.
    let v = serde_json::to_value(t.c.get_round(1, 1).unwrap()).unwrap();
    assert_eq!(v["state"], "Presale");
    assert_eq!(v["presale_up"], "49500000");
    assert_eq!(v["winner"], serde_json::Value::Null);
    let v = serde_json::to_value(t.c.get_series(1).unwrap()).unwrap();
    assert_eq!(v["ante"], "10000000");
    assert_eq!(serde_json::to_value(Side::Down).unwrap(), "Down");

    t.by(&keeper()).open_round(1, TARGET);
    let logs = get_logs();
    assert!(logs[0].starts_with(
        r#"EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":"round_opened","data":[{"series_id":"1","round_index":"1","target_e2":"14300""#
    ));
    t.fund(&bob(), 10 * USDG);
    t.buy(&bob(), 1, 1, Side::Up, 10 * USDG);
    let logs = get_logs();
    assert!(logs[0].contains(r#""event":"buy""#));
    assert!(logs[0].contains(r#""account":"bob.near","side":"Up","amount":"10000000","fee":"100000","net":"9900000""#));
    t.now = t.round(1, 1).close_at;
    t.by(&keeper()).settle(1, TARGET - 1, "ab".repeat(32));
    let logs = get_logs();
    assert!(logs[0].contains(r#""event":"round_settled""#) && logs[0].contains(r#""winner":"Down""#));
    assert_eq!(t.round(1, 1).commitment, "ab".repeat(32));
    t.claim(&alice(), 1, 1);
    let logs = get_logs();
    assert!(logs[0].starts_with(
        r#"EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":"claim","data":[{"series_id":"1","round_index":"1","account":"alice.near","amount":""#
    ));
    let mine: Vec<(u32, u32)> = t.c.positions_of(alice()).iter().map(|p| (p.series_id, p.round_index)).collect();
    assert_eq!(mine, vec![(3, 1)], "a claimed position is removed");
}
