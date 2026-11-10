//! The house's price arithmetic: the two prices of a print, the open guard,
//! a position's profit and loss, its liquidation and cap levels, the fee
//! split, the score clip and the vault's share conversions. Integers only.
//!
//! Prices are VI values in hundredths (`_e2`); amounts are 6-decimal USDG
//! units. Every rounding favours the vault:
//! - the gap, lambda and the lead's distance from the score all round up,
//!   so the buy price rounds up and the sell price rounds down;
//! - the open guard's spread rounds up, so a borderline order is refused;
//! - profit and loss round down (towards minus infinity), so no payout is
//!   above its exact value;
//! - the fee rounds up and the finder's part of it rounds down, as in rounds;
//! - the maximum profit and the liquidation reward round down;
//! - share conversions round down both ways.
//!
//! No function divides by a score, an entry price or a share count that can
//! be zero: a score of 0 counts as an infinite gap, an entry of 0 is never
//! stored (fills at a price of 0 are refused) and the vault always holds its
//! dead shares.

use crate::Side;

pub const BPS: u64 = 10_000;

/// The two prices quoted from one print, with the lead they come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Prices {
    pub score: u64,
    pub lead: u64,
    /// max(score, lead): longs open here, shorts close here.
    pub buy: u64,
    /// min(score, lead): shorts open here, longs close here.
    pub sell: u64,
}

impl Prices {
    pub fn open(&self, side: Side) -> u64 {
        match side {
            Side::Long => self.buy,
            Side::Short => self.sell,
        }
    }

    pub fn close(&self, side: Side) -> u64 {
        match side {
            Side::Long => self.sell,
            Side::Short => self.buy,
        }
    }
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a.div_ceil(b)
}

fn sat_u64(v: u128) -> u64 {
    u64::try_from(v).unwrap_or(u64::MAX)
}

/// |R − S| / S in basis points, rounded up. A score of 0 with a non-zero
/// reading is an infinite gap (u64::MAX).
pub fn gap_bps(score: u64, reading: u64) -> u64 {
    let d = score.abs_diff(reading) as u128;
    if d == 0 {
        return 0;
    }
    if score == 0 {
        return u64::MAX;
    }
    sat_u64(ceil_div(d * BPS as u128, score as u128))
}

/// How far the lead moves from the score towards the reading, in basis
/// points: `lead_min_bps` at no gap, rising in a straight line to 10,000
/// (all the way to the reading) at a gap of `lead_full_gap_bps` and beyond.
/// Rounded up.
pub fn lambda_bps(gap_bps: u64, lead_min_bps: u64, lead_full_gap_bps: u64) -> u64 {
    let min = lead_min_bps.min(BPS);
    if lead_full_gap_bps == 0 || gap_bps >= lead_full_gap_bps {
        return BPS;
    }
    let rise = ceil_div((BPS - min) as u128 * gap_bps as u128, lead_full_gap_bps as u128);
    sat_u64(min as u128 + rise).min(BPS)
}

/// The two prices of a print with score `score` and reading `reading`:
/// lead = S moved lambda of the way to R; buy = max(S, lead), sell =
/// min(S, lead). The lead's distance from S rounds up, and it never passes
/// R, so the lead stays between S and R (and at or above 0).
pub fn prices(score: u64, reading: u64, lead_min_bps: u64, lead_full_gap_bps: u64) -> Prices {
    let d = score.abs_diff(reading);
    let lambda = lambda_bps(gap_bps(score, reading), lead_min_bps, lead_full_gap_bps);
    let moved = sat_u64(ceil_div(d as u128 * lambda as u128, BPS as u128)).min(d);
    let lead = if reading >= score { score + moved } else { score - moved };
    Prices { score, lead, buy: score.max(lead), sell: score.min(lead) }
}

/// How far apart the two prices are, (buy − sell) / S in basis points,
/// rounded up: the open guard. Two different prices at a score of 0 are
/// infinitely far apart.
pub fn spread_bps(p: &Prices) -> u64 {
    let d = (p.buy - p.sell) as u128;
    if d == 0 {
        return 0;
    }
    if p.score == 0 {
        return u64::MAX;
    }
    sat_u64(ceil_div(d * BPS as u128, p.score as u128))
}

/// The fee on a stake, charged on top of it: fee_bps of the stake, rounded up.
pub fn fee_of(stake: u64, fee_bps: u64) -> u64 {
    sat_u64(ceil_div(stake as u128 * fee_bps as u128, BPS as u128))
}

/// A fee's split: the finder's part (finder_bps of the fee, rounded down)
/// only when the market has a finder, the rest to the treasury.
/// Returns (finder, treasury).
pub fn split_fee(fee: u64, finder_bps: u64, has_finder: bool) -> (u64, u64) {
    let finder = if has_finder { sat_u64(fee as u128 * finder_bps.min(BPS) as u128 / BPS as u128) } else { 0 };
    (finder, fee - finder)
}

/// `fee_of` and `split_fee` together: (fee, finder, treasury).
pub fn fee_split(stake: u64, fee_bps: u64, finder_bps: u64, has_finder: bool) -> (u64, u64, u64) {
    let fee = fee_of(stake, fee_bps);
    let (finder, treasury) = split_fee(fee, finder_bps, has_finder);
    (fee, finder, treasury)
}

/// The most a position can win, which the vault reserves when it fills:
/// max_profit_bps of the stake for a long; for a short the same, but never
/// more than leverage × stake, which a short reaches when the price is 0.
pub fn max_profit(side: Side, leverage: u8, stake: u64, max_profit_bps: u64) -> u64 {
    let cap = sat_u64(stake as u128 * max_profit_bps as u128 / BPS as u128);
    match side {
        Side::Long => cap,
        Side::Short => cap.min(stake.saturating_mul(leverage as u64)),
    }
}

/// Profit or loss of `stake` at `leverage` from `entry` to `exit`, before
/// the floor and the cap, rounded down:
/// long: stake × leverage × (exit / entry − 1);
/// short: stake × leverage × (1 − exit / entry).
/// An entry of 0 is never stored; it gives 0 rather than a division by zero.
pub fn pnl(side: Side, leverage: u8, stake: u64, entry: u64, exit: u64) -> i128 {
    if entry == 0 {
        return 0;
    }
    let notional = stake as i128 * leverage as i128;
    let diff = match side {
        Side::Long => exit as i128 - entry as i128,
        Side::Short => entry as i128 - exit as i128,
    };
    // Saturates far outside any stake the settings allow (views may ask).
    match notional.checked_mul(diff) {
        Some(x) => x.div_euclid(entry as i128),
        None if diff > 0 => i128::MAX,
        None => i128::MIN,
    }
}

/// What a position pays back: stake + PnL, floored at 0 (the loss is at most
/// the stake) and capped at stake + max_profit (the reserve).
pub fn payout(stake: u64, pnl: i128, max_profit: u64) -> u64 {
    let v = stake as i128 + pnl;
    v.clamp(0, stake as i128 + max_profit as i128) as u64
}

/// The leverage an order may take: 1x (the stake itself), 2x or 3x.
pub const MAX_LEVERAGE: u8 = 3;

pub fn leverage_ok(leverage: u8) -> bool {
    (1..=MAX_LEVERAGE).contains(&leverage)
}

/// Liquidation, compared exactly (no rounding): a long when the buy price is
/// at or below entry × (1 − 1/leverage), so both the score and the lead are
/// there; a short when the sell price is at or above entry × (1 + 1/leverage).
/// At 1x a long's level is 0, so no price above zero liquidates it, and a
/// short's is twice its entry.
pub fn liquidatable(side: Side, leverage: u8, entry: u64, p: &Prices) -> bool {
    let lev = leverage.max(1) as u128;
    let e = entry as u128;
    match side {
        Side::Long => p.buy as u128 * lev <= e * (lev - 1),
        Side::Short => p.sell as u128 * lev >= e * (lev + 1),
    }
}

/// The liquidation level as a price: the highest buy price that liquidates
/// a long (0 at 1x), the lowest sell price that liquidates a short.
pub fn liquidation_e2(side: Side, leverage: u8, entry: u64) -> u64 {
    let lev = leverage.max(1) as u128;
    let e = entry as u128;
    match side {
        Side::Long => sat_u64(e * (lev - 1) / lev),
        Side::Short => sat_u64(ceil_div(e * (lev + 1), lev)),
    }
}

/// True once the close-side price gives a PnL of at least the maximum profit.
pub fn capped(side: Side, leverage: u8, stake: u64, entry: u64, max_profit: u64, p: &Prices) -> bool {
    pnl(side, leverage, stake, entry, p.close(side)) >= max_profit as i128
}

/// The cap level as a price: the lowest sell price that caps a long, the
/// highest buy price that caps a short (0 when the cap is the whole notional).
pub fn cap_e2(side: Side, leverage: u8, stake: u64, entry: u64, max_profit: u64) -> u64 {
    let notional = stake as u128 * leverage as u128;
    if notional == 0 {
        return 0;
    }
    let move_e2 = ceil_div(max_profit as u128 * entry as u128, notional);
    match side {
        Side::Long => sat_u64(entry as u128 + move_e2),
        Side::Short => sat_u64((entry as u128).saturating_sub(move_e2)),
    }
}

/// The score of a new print is limited by the print's own time: real time
/// sets the speed, however many prints are pushed.
pub const STEP_SECS: u64 = 300;

/// The score a new print may take, `elapsed_secs` after the stored print:
/// within max_step_bps × elapsed / 300 of the stored score (and at least one
/// hundredth, so a small score can still move), rounded towards the stored
/// score. From a stored score of 0 the pushed score is taken as it is: no
/// share of 0 would let it move.
pub fn clip_score(stored: u64, pushed: u64, max_step_bps: u64, elapsed_secs: u64) -> u64 {
    if stored == 0 {
        return pushed;
    }
    let allowance = max_step_bps as u128 * elapsed_secs as u128 / STEP_SECS as u128;
    let step = sat_u64((stored as u128).saturating_mul(allowance) / BPS as u128).max(1);
    pushed.clamp(stored.saturating_sub(step), stored.saturating_add(step))
}

/// Shares minted for `amount` in a vault holding `assets` against `shares`
/// (dead shares included, so never 0): amount × shares / (assets + 1),
/// rounded down. The one virtual unit of assets keeps the price defined at
/// zero assets.
pub fn to_shares(amount: u64, assets: u64, shares: u128) -> u128 {
    (amount as u128).saturating_mul(shares) / (assets as u128 + 1)
}

/// Assets that `s` shares are worth: s × (assets + 1) / shares, rounded
/// down. Any number of shares short of the total is worth at most `assets`.
pub fn to_assets(s: u128, assets: u64, shares: u128) -> u64 {
    if shares == 0 {
        return 0;
    }
    sat_u64(s.saturating_mul(assets as u128 + 1) / shares)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 3_000;
    const FULL: u64 = 2_500;

    fn p(s: u64, r: u64) -> Prices {
        prices(s, r, MIN, FULL)
    }

    #[test]
    fn no_gap_gives_one_price() {
        let q = p(40_000, 40_000);
        assert_eq!((q.lead, q.buy, q.sell), (40_000, 40_000, 40_000));
        assert_eq!(gap_bps(40_000, 40_000), 0);
        assert_eq!(lambda_bps(0, MIN, FULL), MIN);
        assert_eq!(spread_bps(&q), 0);
    }

    #[test]
    fn a_small_gap_moves_the_lead_part_of_the_way() {
        // S 400, R 420: a 5 % gap, lambda 0.44, lead 408.80.
        assert_eq!(gap_bps(40_000, 42_000), 500);
        assert_eq!(lambda_bps(500, MIN, FULL), 4_400);
        let q = p(40_000, 42_000);
        assert_eq!((q.lead, q.buy, q.sell), (40_880, 40_880, 40_000));
        assert_eq!(spread_bps(&q), 220);
        // A 4 % gap: lambda 0.412, the lead 1.648 % from the score.
        let q = p(100_000, 104_000);
        assert_eq!((q.lead, spread_bps(&q)), (101_648, 165));
    }

    #[test]
    fn the_full_gap_and_beyond_lead_to_the_reading() {
        assert_eq!(gap_bps(40_000, 50_000), FULL);
        assert_eq!(lambda_bps(FULL, MIN, FULL), BPS);
        let q = p(40_000, 50_000);
        assert_eq!((q.lead, q.buy, q.sell), (50_000, 50_000, 40_000));
        // 2,499.75 bps rounds up to the full gap.
        assert_eq!(gap_bps(40_000, 49_999), FULL);
        assert_eq!(p(40_000, 49_999).lead, 49_999);
        // Beyond it, still the reading.
        let q = p(40_000, 80_000);
        assert_eq!((q.lead, q.buy, q.sell), (80_000, 80_000, 40_000));
        assert_eq!(lambda_bps(u64::MAX, MIN, FULL), BPS);
    }

    #[test]
    fn a_reading_below_the_score_moves_the_sell_price() {
        // S 480, R 470: gap 208.33 → 209 bps, lambda 3,586, distance 358.6 → 359.
        assert_eq!(gap_bps(48_000, 47_000), 209);
        assert_eq!(lambda_bps(209, MIN, FULL), 3_586);
        let q = p(48_000, 47_000);
        assert_eq!((q.lead, q.buy, q.sell), (47_641, 48_000, 47_641));
    }

    #[test]
    fn a_reading_of_zero_gives_a_sell_price_of_zero() {
        let q = p(10_173, 0);
        assert_eq!(gap_bps(10_173, 0), BPS);
        assert_eq!((q.lead, q.buy, q.sell), (0, 10_173, 0));
        assert_eq!(spread_bps(&q), BPS);
    }

    #[test]
    fn a_score_of_zero_divides_by_nothing() {
        assert_eq!(gap_bps(0, 5_000), u64::MAX);
        let q = p(0, 5_000);
        assert_eq!((q.lead, q.buy, q.sell), (5_000, 5_000, 0));
        assert_eq!(spread_bps(&q), u64::MAX);
        let z = p(0, 0);
        assert_eq!((z.lead, z.buy, z.sell, spread_bps(&z)), (0, 0, 0, 0));
        // And huge values do not overflow.
        let h = p(1, u64::MAX);
        assert_eq!((h.buy, h.sell), (u64::MAX, 1));
        let h = p(u64::MAX, 0);
        assert_eq!((h.buy, h.sell), (u64::MAX, 0));
    }

    #[test]
    fn lambda_one_is_a_setting() {
        // lead_min at 10,000: the lead is the reading at every gap.
        let q = prices(40_000, 40_400, BPS, FULL);
        assert_eq!(q.lead, 40_400);
    }

    #[test]
    fn pnl_rounds_down_and_payout_is_floored_and_capped() {
        // The worked example: 3x long of 100 at 408.80, closed at 476.41.
        let s = 100_000_000;
        assert_eq!(pnl(Side::Long, 3, s, 40_880, 47_641), 49_615_949);
        assert_eq!(pnl(Side::Long, 3, s, 40_880, 40_879), -7_339); // −7,338.55 → −7,339
        assert_eq!(pnl(Side::Short, 3, s, 40_000, 48_000), -60_000_000);
        assert_eq!(payout(s, -60_000_000, 300_000_000), 40_000_000);
        assert_eq!(payout(s, -150_000_000, 300_000_000), 0);
        assert_eq!(payout(s, 2_000_000_000, 900_000_000), 1_000_000_000);
        assert_eq!(pnl(Side::Long, 3, s, 0, 100), 0);
        assert_eq!(pnl(Side::Long, 3, u64::MAX, 1, u64::MAX), i128::MAX);
        assert_eq!(payout(u64::MAX, pnl(Side::Short, 3, u64::MAX, 1, u64::MAX), 7), 0);
    }

    #[test]
    fn levels() {
        // Entry 408.80 at 3x: liquidation at 272.53, cap at 1,635.20.
        assert_eq!(liquidation_e2(Side::Long, 3, 40_880), 27_253);
        assert_eq!(cap_e2(Side::Long, 3, 100_000_000, 40_880, 900_000_000), 163_520);
        assert_eq!(liquidation_e2(Side::Long, 2, 40_880), 20_440);
        assert_eq!(cap_e2(Side::Long, 2, 100_000_000, 40_880, 900_000_000), 224_840);
        // A short at 476.41: liquidated at 635.22 (3x) or 714.62 (2x); capped at 0.
        assert_eq!(liquidation_e2(Side::Short, 3, 47_641), 63_522);
        assert_eq!(liquidation_e2(Side::Short, 2, 47_641), 71_462);
        assert_eq!(cap_e2(Side::Short, 3, 100_000_000, 47_641, 300_000_000), 0);
        // The level and the exact test agree on both sides of it.
        let at = |b: u64, s: u64| Prices { score: b, lead: s, buy: b, sell: s };
        assert!(liquidatable(Side::Long, 3, 40_880, &at(27_253, 27_000)));
        assert!(!liquidatable(Side::Long, 3, 40_880, &at(27_254, 27_000)));
        assert!(liquidatable(Side::Short, 3, 47_641, &at(70_000, 63_522)));
        assert!(!liquidatable(Side::Short, 3, 47_641, &at(70_000, 63_521)));
        assert!(capped(Side::Long, 3, 100_000_000, 40_880, 900_000_000, &at(200_000, 163_520)));
        assert!(!capped(Side::Long, 3, 100_000_000, 40_880, 900_000_000, &at(200_000, 163_519)));
    }

    #[test]
    fn fees_and_caps() {
        assert_eq!(fee_split(100_000_000, 100, 5_000, true), (1_000_000, 500_000, 500_000));
        assert_eq!(fee_split(100_000_000, 100, 5_000, false), (1_000_000, 0, 1_000_000));
        assert_eq!(fee_split(10_000_001, 100, 5_000, true), (100_001, 50_000, 50_001));
        assert_eq!(max_profit(Side::Long, 3, 250_000_000, 90_000), 2_250_000_000);
        assert_eq!(max_profit(Side::Short, 3, 250_000_000, 90_000), 750_000_000);
        assert_eq!(max_profit(Side::Short, 2, 250_000_000, 90_000), 500_000_000);
        assert_eq!(max_profit(Side::Short, 3, 250_000_000, 20_000), 500_000_000);
    }

    #[test]
    fn the_clip_follows_the_print_time_and_never_sticks() {
        // Five minutes: 15 %.
        assert_eq!(clip_score(10_000, 20_000, 1_500, 300), 11_500);
        assert_eq!(clip_score(10_000, 1_000, 1_500, 300), 8_500);
        assert_eq!(clip_score(10_000, 10_700, 1_500, 300), 10_700);
        // Two and a half minutes: 7.5 %; ten minutes: 30 %.
        assert_eq!(clip_score(10_000, 20_000, 1_500, 150), 10_750);
        assert_eq!(clip_score(10_000, 20_000, 1_500, 600), 13_000);
        // One second: 5 bps; a tenth of that rate compounds no faster.
        assert_eq!(clip_score(100_000, 200_000, 1_500, 1), 100_050);
        assert_eq!(clip_score(100_000, 200_000, 1_500, 0), 100_001, "no time: the one-hundredth minimum");
        // 300 prints a second apart move the score less than e^0.15 − 1 ≈ 16.2 %.
        let mut s = 100_000u64;
        for _ in 0..300 {
            s = clip_score(s, u64::MAX, 1_500, 1);
        }
        assert!(s < 116_183, "{s}");
        // From 0, the pushed score; near 0, at least one hundredth either way.
        assert_eq!(clip_score(0, 50_000, 1_500, 300), 50_000);
        assert_eq!(clip_score(0, 50_000, 1_500, 1), 50_000);
        assert_eq!(clip_score(1, 0, 1_500, 300), 0);
        assert_eq!(clip_score(6, 100, 1_500, 300), 7);
        // No overflow at the extremes.
        assert_eq!(clip_score(u64::MAX, 0, 10_000, u64::MAX), 0);
    }

    #[test]
    fn shares_round_down_and_never_exceed_the_assets() {
        let dead = 1_000u128;
        // An empty vault: one unit buys `dead` shares.
        assert_eq!(to_shares(10_000_000, 0, dead), 10_000_000_000);
        let shares = dead + 10_000_000_000;
        assert_eq!(to_assets(10_000_000_000, 10_000_000, shares), 10_000_000);
        assert_eq!(to_assets(shares, 10_000_000, shares), 10_000_001);
        // Everything but the dead shares is worth at most the assets.
        for assets in [0u64, 1, 7, 999, 10_000_000, 1_000_000_000_000_000] {
            for total in [dead, dead + 1, dead * 7 + 3, 10u128.pow(20)] {
                assert!(to_assets(total - dead, assets, total) <= assets);
            }
        }
    }
}
