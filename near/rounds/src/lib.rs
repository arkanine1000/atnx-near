//! Rolling rounds on the ATNX Virality Index (VI), on NEAR.
//!
//! A port of `programs/vi_rounds` (Anchor, Solana devnet). The mechanics are
//! those in docs/rounds.md and the build spec is near/SPEC.md; everything not
//! named there follows `programs/vi_rounds/src/lib.rs`: the state machine,
//! the checks and their order, the rounding, the fee split, the payout and
//! rollover rules. `math.rs` is a verbatim copy of the Solana file.
//!
//! One `Series` per subject. While round N trades, round N+1 takes presale
//! commits. A round asks one question: will the subject's VI, averaged over
//! the round's final window, be at or above the VI at the round's open.
//!
//! Engine: Pennock's dynamic pari-mutuel market (2004), variant I with price
//! function I. Presale commits clear at one price per side, the pot share:
//! with pots U and D the round opens with M1 = U, M2 = D and N1 = N2 = U + D.
//! A live buy of `m` on a side with money M and the other side's shares N
//! buys `N · ln(1 + m/M)` shares. At settlement a winner gets their net
//! stake back plus `shares · M_lose / N_win`. There is no selling.
//!
//! What NEAR changes:
//! - Money is an internal ledger (`balances`). An account funds it once,
//!   with `ft_transfer_call` on the USDG token or with `faucet`, and every
//!   commit, buy, claim, rollover and fee withdrawal then moves balances
//!   inside this contract with no deposit attached, so a function-call key
//!   or a NEP-366 relayer can sign them. `withdraw` sends USDG back out.
//! - Only `faucet` and `withdraw` make cross-contract calls. `faucet` credits
//!   in its callback once the mint has succeeded; `withdraw` debits first and
//!   re-credits in its callback if the transfer failed.
//! - Accounts are `AccountId`s, the series reference and the settle
//!   commitment are 64-character lowercase hex strings, sides are the JSON
//!   strings "Up" and "Down", and times are unix seconds from the block
//!   timestamp.
//! - The contract pays its own storage (testnet); a claimed position is
//!   removed.

use near_sdk::json_types::U128;
use near_sdk::serde_json;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    env, ext_contract, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

pub mod math;
use math::{fee_split, payout, presale_shares, shares_for_spend, MathError};

#[cfg(test)]
mod tests;

pub const MAX_FEE_BPS: u16 = 500;
pub const MAX_FAUCET: u64 = 10_000_000_000; // 10,000 USDG at 6 decimals
pub const MIN_ROUND_SECS: u32 = 20;

const GAS_FOR_MINT: Gas = Gas::from_tgas(10);
const GAS_FOR_ON_FAUCET: Gas = Gas::from_tgas(5);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FOR_ON_WITHDRAW: Gas = Gas::from_tgas(5);

const EVENT_STANDARD: &str = "atnx_rounds";
const EVENT_VERSION: &str = "1.0.0";
const ZERO_COMMITMENT: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const LIST_LIMIT_DEFAULT: u32 = 50;
const LIST_LIMIT_MAX: u32 = 100;

/// The two calls this contract makes on the USDG token.
#[ext_contract(ext_usdg)]
#[allow(dead_code)]
trait Usdg {
    fn mint(&mut self, receiver_id: AccountId, amount: U128);
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

// ---------------------------------------------------------------- state

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Up,
    Down,
}

impl Side {
    fn as_str(self) -> &'static str {
        match self {
            Side::Up => "Up",
            Side::Down => "Down",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoundState {
    Presale,
    Live,
    Settled,
    Void,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub owner: AccountId,
    pub keeper: AccountId,
    pub treasury: AccountId,
    /// The USDG token (NEP-141).
    pub token: AccountId,
    pub fee_bps: u16,
    pub finder_bps: u16,
    pub series_count: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Series {
    pub finder: AccountId,
    /// 64 lowercase hex characters: the ATNX market uuid plus flags (docs/rounds.md, Series).
    pub reference: String,
    /// The series id, 1 for the first series.
    pub index: u32,
    pub round_secs: u32,
    pub settle_window_secs: u32,
    pub fee_bps: u16,
    pub finder_bps: u16,
    pub ante: u64,
    pub paused: bool,
    pub live_round: u32,    // 0 = none
    pub presale_round: u32, // 0 = none (series ended)
    pub finder_fees: u64,
    pub platform_fees: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Round {
    pub series: u32,
    pub index: u32,
    pub state: RoundState,
    /// Set when the round settles.
    pub winner: Option<Side>,
    pub presale_up: u64,   // net commits, fixed at open (U)
    pub presale_down: u64, // D
    pub m_up: u64,
    pub m_down: u64,
    pub n_up: u64,
    pub n_down: u64,
    pub opened_at: u64,
    pub close_at: u64,
    pub trade_until: u64,
    pub target_e2: u64,
    pub settle_e2: u64,
    /// 64 lowercase hex characters, reserved for a hash of the oracle inputs.
    pub commitment: String,
    pub paid_out: u64,
}

impl Round {
    fn presale(series: u32, index: u32) -> Self {
        Self {
            series,
            index,
            state: RoundState::Presale,
            winner: None,
            presale_up: 0,
            presale_down: 0,
            m_up: 0,
            m_down: 0,
            n_up: 0,
            n_down: 0,
            opened_at: 0,
            close_at: 0,
            trade_until: 0,
            target_e2: 0,
            settle_e2: 0,
            commitment: ZERO_COMMITMENT.to_string(),
            paid_out: 0,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Position {
    pub holder: AccountId,
    pub series: u32,
    pub round: u32,
    pub presale_up: u64,
    pub presale_down: u64,
    pub stake_up: u64,
    pub stake_down: u64,
    pub shares_up: u64,
    pub shares_down: u64,
}

impl Position {
    fn new(holder: AccountId, series: u32, round: u32) -> Self {
        Self {
            holder,
            series,
            round,
            presale_up: 0,
            presale_down: 0,
            stake_up: 0,
            stake_down: 0,
            shares_up: 0,
            shares_down: 0,
        }
    }
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Balances,
    Series,
    SeriesByReference,
    Rounds,
    Positions,
    AccountPositions,
    AccountPositionSet { account_hash: Vec<u8> },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    config: Config,
    balances: LookupMap<AccountId, u64>,
    series: LookupMap<u32, Series>,
    series_by_reference: LookupMap<String, u32>,
    rounds: LookupMap<(u32, u32), Round>,
    positions: LookupMap<(u32, u32, AccountId), Position>,
    account_positions: LookupMap<AccountId, IterableSet<(u32, u32)>>,
}

// ---------------------------------------------------------------- views

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeriesView {
    pub id: u32,
    pub finder: AccountId,
    pub reference: String,
    pub round_secs: u32,
    pub settle_window_secs: u32,
    pub fee_bps: u16,
    pub finder_bps: u16,
    pub ante: U128,
    pub paused: bool,
    pub live_round: u32,
    pub presale_round: u32,
    pub finder_fees: U128,
    pub platform_fees: U128,
}

impl From<&Series> for SeriesView {
    fn from(s: &Series) -> Self {
        Self {
            id: s.index,
            finder: s.finder.clone(),
            reference: s.reference.clone(),
            round_secs: s.round_secs,
            settle_window_secs: s.settle_window_secs,
            fee_bps: s.fee_bps,
            finder_bps: s.finder_bps,
            ante: u(s.ante),
            paused: s.paused,
            live_round: s.live_round,
            presale_round: s.presale_round,
            finder_fees: u(s.finder_fees),
            platform_fees: u(s.platform_fees),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundView {
    pub series_id: u32,
    pub index: u32,
    pub state: RoundState,
    pub winner: Option<Side>,
    pub presale_up: U128,
    pub presale_down: U128,
    pub m_up: U128,
    pub m_down: U128,
    pub n_up: U128,
    pub n_down: U128,
    pub opened_at: u64,
    pub close_at: u64,
    pub trade_until: u64,
    pub target_e2: u64,
    pub settle_e2: u64,
    pub commitment: String,
    pub paid_out: U128,
}

impl From<&Round> for RoundView {
    fn from(r: &Round) -> Self {
        Self {
            series_id: r.series,
            index: r.index,
            state: r.state,
            winner: r.winner,
            presale_up: u(r.presale_up),
            presale_down: u(r.presale_down),
            m_up: u(r.m_up),
            m_down: u(r.m_down),
            n_up: u(r.n_up),
            n_down: u(r.n_down),
            opened_at: r.opened_at,
            close_at: r.close_at,
            trade_until: r.trade_until,
            target_e2: r.target_e2,
            settle_e2: r.settle_e2,
            commitment: r.commitment.clone(),
            paid_out: u(r.paid_out),
        }
    }
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionView {
    pub series_id: u32,
    pub round_index: u32,
    pub account_id: AccountId,
    pub presale_up: U128,
    pub presale_down: U128,
    pub stake_up: U128,
    pub stake_down: U128,
    pub shares_up: U128,
    pub shares_down: U128,
}

impl From<&Position> for PositionView {
    fn from(p: &Position) -> Self {
        Self {
            series_id: p.series,
            round_index: p.round,
            account_id: p.holder.clone(),
            presale_up: u(p.presale_up),
            presale_down: u(p.presale_down),
            stake_up: u(p.stake_up),
            stake_down: u(p.stake_down),
            shares_up: u(p.shares_up),
            shares_down: u(p.shares_down),
        }
    }
}

/// What `buy` would do with `amount`: the shares it buys, the fee, the
/// finder's part of the fee and the net spend.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuyQuote {
    pub shares: U128,
    pub fee: U128,
    pub finder_fee: U128,
    pub net: U128,
}

// --------------------------------------------------------------- errors

/// The lib.rs error codes with their messages, plus the few that NEAR needs
/// where Anchor's account constraints did the checking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoundsError {
    FeeTooHigh,
    MintTooLarge,
    ZeroAmount,
    BadWindow,
    BadRound,
    NotPresale,
    NotLive,
    NotSettled,
    TradingClosed,
    TooEarly,
    Paused,
    NotPaused,
    LiveRoundExists,
    EmptySide,
    Slippage,
    RatioTooLarge,
    Overflow,
    NothingToClaim,
    Unauthorized,
    // NEAR only.
    NotOwner,
    NotKeeper,
    NoSeries,
    NoRound,
    NoPosition,
    BadReference,
    BadCommitment,
    SeriesExists,
    InsufficientBalance,
}

impl RoundsError {
    pub const fn msg(self) -> &'static str {
        match self {
            RoundsError::FeeTooHigh => "fee above the cap",
            RoundsError::MintTooLarge => "mint above the per-call cap",
            RoundsError::ZeroAmount => "amount is zero",
            RoundsError::BadWindow => {
                "settlement window must be shorter than the round, round at least 20 s"
            }
            RoundsError::BadRound => "round index or state does not fit this call",
            RoundsError::NotPresale => "round is not the series' presale round",
            RoundsError::NotLive => "round is not the series' live round",
            RoundsError::NotSettled => "round is not settled",
            RoundsError::TradingClosed => "trading closed for the settlement window",
            RoundsError::TooEarly => "round has not reached its close",
            RoundsError::Paused => "series is paused",
            RoundsError::NotPaused => "series is not paused",
            RoundsError::LiveRoundExists => "a live round already exists",
            RoundsError::EmptySide => "both sides need money before a round can open",
            RoundsError::Slippage => "fewer shares than the minimum you set",
            RoundsError::RatioTooLarge => "a single buy may not exceed 1000x the money on its side",
            RoundsError::Overflow => "arithmetic overflow",
            RoundsError::NothingToClaim => "nothing to claim",
            RoundsError::Unauthorized => "not the authority or the keeper",
            RoundsError::NotOwner => "not the owner",
            RoundsError::NotKeeper => "not the keeper",
            RoundsError::NoSeries => "no such series",
            RoundsError::NoRound => "no such round",
            RoundsError::NoPosition => "no position in this round",
            RoundsError::BadReference => "reference must be 64 lowercase hex characters",
            RoundsError::BadCommitment => "commitment must be 64 lowercase hex characters",
            RoundsError::SeriesExists => "a series with this reference already exists",
            RoundsError::InsufficientBalance => "balance too low",
        }
    }
}

impl From<MathError> for RoundsError {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Overflow => RoundsError::Overflow,
            MathError::RatioTooLarge => RoundsError::RatioTooLarge,
            MathError::ZeroPool => RoundsError::EmptySide,
        }
    }
}

fn fail(e: RoundsError) -> ! {
    env::panic_str(e.msg())
}

fn check(ok: bool, e: RoundsError) {
    if !ok {
        fail(e)
    }
}

fn add(a: u64, b: u64) -> u64 {
    a.checked_add(b).unwrap_or_else(|| fail(RoundsError::Overflow))
}

fn to_u64(v: U128) -> u64 {
    u64::try_from(v.0).unwrap_or_else(|_| fail(RoundsError::Overflow))
}

fn u(v: u64) -> U128 {
    U128(v as u128)
}

fn now_secs() -> u64 {
    env::block_timestamp_ms() / 1000
}

fn is_hex32(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// NEP-297: `EVENT_JSON:{"standard":"atnx_rounds","version":"1.0.0","event":…,"data":[{…}]}`,
/// every data value a string.
fn emit(event: &str, data: &[(&str, String)]) {
    let mut out = String::with_capacity(96 + data.len() * 40);
    out.push_str("EVENT_JSON:{\"standard\":\"");
    out.push_str(EVENT_STANDARD);
    out.push_str("\",\"version\":\"");
    out.push_str(EVENT_VERSION);
    out.push_str("\",\"event\":");
    out.push_str(&serde_json::to_string(event).unwrap_or_default());
    out.push_str(",\"data\":[{");
    for (i, (k, v)) in data.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(k).unwrap_or_default());
        out.push(':');
        out.push_str(&serde_json::to_string(v).unwrap_or_default());
    }
    out.push_str("}]}");
    env::log_str(&out);
}

/// The checks and the arithmetic of a live buy, shared by `buy` and
/// `quote_buy`, in lib.rs's order.
struct Priced {
    fee: u64,
    finder: u64,
    platform: u64,
    net: u64,
    shares: u64,
}

fn price_buy(s: &Series, r: Option<&Round>, side: Side, amount: u64, now: u64) -> Priced {
    check(amount > 0, RoundsError::ZeroAmount);
    check(!s.paused, RoundsError::Paused);
    let r = match r {
        Some(r) if r.state == RoundState::Live && r.index == s.live_round => r,
        _ => fail(RoundsError::NotLive),
    };
    check(now < r.trade_until, RoundsError::TradingClosed);
    let (fee, finder, platform, net) = fee_split(amount, s.fee_bps, s.finder_bps);
    check(net > 0, RoundsError::ZeroAmount);
    let (m_side, n_other) = match side {
        Side::Up => (r.m_up, r.n_down),
        Side::Down => (r.m_down, r.n_up),
    };
    let shares = shares_for_spend(n_other, m_side, net).unwrap_or_else(|e| fail(e.into()));
    check(shares > 0, RoundsError::ZeroAmount);
    Priced { fee, finder, platform, net, shares }
}

/// What a position is owed once its round is settled or void.
fn due(r: &Round, p: &Position) -> u64 {
    check(p.series == r.series && p.round == r.index, RoundsError::BadRound);
    let total_presale = add(r.presale_up, r.presale_down);
    if r.state == RoundState::Void {
        let refund = p.presale_up as u128 + p.presale_down as u128 + p.stake_up as u128 + p.stake_down as u128;
        return u64::try_from(refund).unwrap_or_else(|_| fail(RoundsError::Overflow));
    }
    check(r.state == RoundState::Settled, RoundsError::NotSettled);
    let (stake, shares, m_lose, n_win) = if r.winner == Some(Side::Up) {
        (
            p.presale_up.checked_add(p.stake_up),
            presale_shares(p.presale_up, r.presale_up, total_presale).checked_add(p.shares_up),
            r.m_down,
            r.n_up,
        )
    } else {
        (
            p.presale_down.checked_add(p.stake_down),
            presale_shares(p.presale_down, r.presale_down, total_presale).checked_add(p.shares_down),
            r.m_up,
            r.n_down,
        )
    };
    let stake = stake.unwrap_or_else(|| fail(RoundsError::Overflow));
    let shares = shares.unwrap_or_else(|| fail(RoundsError::Overflow));
    payout(stake, shares, m_lose, n_win).unwrap_or_else(|e| fail(e.into()))
}

// -------------------------------------------------------------- methods

#[near]
impl Contract {
    /// One-time setup. `token` is the USDG contract, whose minter must be
    /// this contract for `faucet` to work.
    #[init]
    pub fn new(
        owner: AccountId,
        keeper: AccountId,
        treasury: AccountId,
        token: AccountId,
        fee_bps: u16,
        finder_bps: u16,
    ) -> Self {
        check(fee_bps <= MAX_FEE_BPS, RoundsError::FeeTooHigh);
        check(finder_bps as u128 <= math::BPS, RoundsError::FeeTooHigh);
        Self {
            config: Config { owner, keeper, treasury, token, fee_bps, finder_bps, series_count: 0 },
            balances: LookupMap::new(StorageKey::Balances),
            series: LookupMap::new(StorageKey::Series),
            series_by_reference: LookupMap::new(StorageKey::SeriesByReference),
            rounds: LookupMap::new(StorageKey::Rounds),
            positions: LookupMap::new(StorageKey::Positions),
            account_positions: LookupMap::new(StorageKey::AccountPositions),
        }
    }

    /// Owner only. New fee terms apply to series created afterwards.
    pub fn set_config(
        &mut self,
        keeper: Option<AccountId>,
        treasury: Option<AccountId>,
        fee_bps: Option<u16>,
        finder_bps: Option<u16>,
    ) {
        self.assert_owner();
        let c = &mut self.config;
        if let Some(k) = keeper {
            c.keeper = k;
        }
        if let Some(t) = treasury {
            c.treasury = t;
        }
        if let Some(b) = fee_bps {
            check(b <= MAX_FEE_BPS, RoundsError::FeeTooHigh);
            c.fee_bps = b;
        }
        if let Some(b) = finder_bps {
            check(b as u128 <= math::BPS, RoundsError::FeeTooHigh);
            c.finder_bps = b;
        }
    }

    // ------------------------------------------------- money in and out

    /// Mints up to 10,000 USDG to this contract and credits the caller's
    /// balance once the mint has succeeded. Testnet only. The promise
    /// resolves to the amount credited (0 if the mint failed).
    pub fn faucet(&mut self, amount: U128) -> Promise {
        check(amount.0 <= MAX_FAUCET as u128, RoundsError::MintTooLarge);
        let caller = env::predecessor_account_id();
        ext_usdg::ext(self.config.token.clone())
            .with_static_gas(GAS_FOR_MINT)
            .mint(env::current_account_id(), amount)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_FAUCET)
                    .on_faucet(caller, amount),
            )
    }

    #[private]
    pub fn on_faucet(
        &mut self,
        account_id: AccountId,
        amount: U128,
        #[callback_result] minted: Result<(), PromiseError>,
    ) -> U128 {
        if minted.is_err() {
            env::log_str("faucet: the mint failed, nothing credited");
            return U128(0);
        }
        let amount = to_u64(amount);
        self.credit(&account_id, amount);
        emit("faucet", &[("account", account_id.to_string()), ("amount", amount.to_string())]);
        u(amount)
    }

    /// NEP-141 receiver: a USDG `ft_transfer_call` to this contract credits
    /// the sender's balance. Any other token is refused (the full amount is
    /// returned to the sender). `msg` is ignored.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let _ = msg;
        if env::predecessor_account_id() != self.config.token {
            return amount;
        }
        let a = to_u64(amount);
        self.credit(&sender_id, a);
        emit("deposit", &[("account", sender_id.to_string()), ("amount", a.to_string())]);
        U128(0)
    }

    /// Sends `amount` of the caller's balance to the caller as USDG. The
    /// balance is debited first and re-credited if the transfer fails. The
    /// promise resolves to the amount sent (0 if it was refunded).
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let a = to_u64(amount);
        check(a > 0, RoundsError::ZeroAmount);
        let caller = env::predecessor_account_id();
        self.debit(&caller, a);
        ext_usdg::ext(self.config.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(caller.clone(), amount, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_WITHDRAW)
                    .on_withdraw(caller, amount),
            )
    }

    #[private]
    pub fn on_withdraw(
        &mut self,
        account_id: AccountId,
        amount: U128,
        #[callback_result] sent: Result<(), PromiseError>,
    ) -> U128 {
        let a = to_u64(amount);
        if sent.is_err() {
            self.credit(&account_id, a);
            env::log_str("withdraw: the transfer failed, balance re-credited");
            return U128(0);
        }
        emit("withdraw", &[("account", account_id.to_string()), ("amount", a.to_string())]);
        u(a)
    }

    // ------------------------------------------------------------ series

    /// Starts a series and its round 1 in presale. Keeper only: the keeper
    /// creates it on the finder's behalf. The fee terms are copied from the
    /// config so a later config change does not move the goalposts.
    pub fn create_series(
        &mut self,
        reference: String,
        round_secs: u32,
        settle_window_secs: u32,
        ante: U128,
        finder: AccountId,
    ) -> u32 {
        self.assert_keeper();
        check(is_hex32(&reference), RoundsError::BadReference);
        check(!self.series_by_reference.contains_key(&reference), RoundsError::SeriesExists);
        check(round_secs >= MIN_ROUND_SECS, RoundsError::BadWindow);
        check(settle_window_secs < round_secs, RoundsError::BadWindow);
        let ante = to_u64(ante);
        let id = self.config.series_count.checked_add(1).unwrap_or_else(|| fail(RoundsError::Overflow));
        self.config.series_count = id;
        let s = Series {
            finder: finder.clone(),
            reference: reference.clone(),
            index: id,
            round_secs,
            settle_window_secs,
            fee_bps: self.config.fee_bps,
            finder_bps: self.config.finder_bps,
            ante,
            paused: false,
            live_round: 0,
            presale_round: 1,
            finder_fees: 0,
            platform_fees: 0,
        };
        self.series.insert(id, s);
        self.series_by_reference.insert(reference.clone(), id);
        self.rounds.insert((id, 1), Round::presale(id, 1));
        emit(
            "series_created",
            &[
                ("series_id", id.to_string()),
                ("round_index", "1".to_string()),
                ("reference", reference),
                ("finder", finder.to_string()),
                ("round_secs", round_secs.to_string()),
                ("settle_window_secs", settle_window_secs.to_string()),
                ("ante", ante.to_string()),
            ],
        );
        id
    }

    /// Pauses or resumes a series, moves the finder, or changes the ante.
    /// The owner or the keeper.
    pub fn set_series(
        &mut self,
        series_id: u32,
        paused: Option<bool>,
        finder: Option<AccountId>,
        ante: Option<U128>,
    ) {
        let caller = env::predecessor_account_id();
        check(caller == self.config.owner || caller == self.config.keeper, RoundsError::Unauthorized);
        let mut s = self.series_or_fail(series_id);
        if let Some(p) = paused {
            s.paused = p;
        }
        if let Some(f) = finder {
            s.finder = f;
        }
        if let Some(a) = ante {
            s.ante = to_u64(a);
        }
        self.series.insert(series_id, s);
    }

    // ------------------------------------------------------------ trading

    /// Presale: lock `amount` of the caller's balance on UP or DOWN in round
    /// `round_index`, which must be the series' current presale round. A
    /// commit aimed at a round the keeper has just opened fails instead of
    /// landing in the next one.
    pub fn commit(&mut self, series_id: u32, round_index: u32, side: Side, amount: U128) {
        let amount = to_u64(amount);
        let holder = env::predecessor_account_id();
        let mut s = self.series_or_fail(series_id);
        check(amount > 0, RoundsError::ZeroAmount);
        check(!s.paused, RoundsError::Paused);
        let ri = round_index;
        let mut r = self.rounds.get(&(series_id, ri)).cloned().unwrap_or_else(|| fail(RoundsError::NotPresale));
        check(r.state == RoundState::Presale && r.index == s.presale_round, RoundsError::NotPresale);
        let (fee, finder, platform, net) = fee_split(amount, s.fee_bps, s.finder_bps);
        check(net > 0, RoundsError::ZeroAmount);

        self.debit(&holder, amount);
        s.finder_fees = add(s.finder_fees, finder);
        s.platform_fees = add(s.platform_fees, platform);
        let mut p = self.position_or_new(series_id, ri, &holder);
        match side {
            Side::Up => {
                r.presale_up = add(r.presale_up, net);
                p.presale_up = add(p.presale_up, net);
            }
            Side::Down => {
                r.presale_down = add(r.presale_down, net);
                p.presale_down = add(p.presale_down, net);
            }
        }
        emit(
            "commit",
            &[
                ("series_id", series_id.to_string()),
                ("round_index", ri.to_string()),
                ("account", holder.to_string()),
                ("side", side.as_str().to_string()),
                ("amount", amount.to_string()),
                ("fee", fee.to_string()),
                ("net", net.to_string()),
                ("presale_up", r.presale_up.to_string()),
                ("presale_down", r.presale_down.to_string()),
            ],
        );
        self.series.insert(series_id, s);
        self.rounds.insert((series_id, ri), r);
        self.save_position(p);
    }

    /// Opens the presale round for trading at the current VI and creates
    /// the next round's presale. Keeper only. Both pots must hold money;
    /// the keeper antes an empty side with an ordinary `commit` first.
    pub fn open_round(&mut self, series_id: u32, target_e2: u64) {
        self.assert_keeper();
        let mut s = self.series_or_fail(series_id);
        check(!s.paused, RoundsError::Paused);
        check(s.live_round == 0, RoundsError::LiveRoundExists);
        let ri = s.presale_round;
        let mut r = self.rounds.get(&(series_id, ri)).cloned().unwrap_or_else(|| fail(RoundsError::NotPresale));
        check(r.state == RoundState::Presale && r.index == s.presale_round, RoundsError::NotPresale);
        let next_index = r.index.checked_add(1).unwrap_or_else(|| fail(RoundsError::Overflow));
        check(!self.rounds.contains_key(&(series_id, next_index)), RoundsError::BadRound);
        check(r.presale_up > 0 && r.presale_down > 0, RoundsError::EmptySide);
        check(target_e2 > 0, RoundsError::ZeroAmount);
        let now = now_secs();
        let total = add(r.presale_up, r.presale_down);
        r.m_up = r.presale_up;
        r.m_down = r.presale_down;
        r.n_up = total;
        r.n_down = total;
        r.target_e2 = target_e2;
        r.opened_at = now;
        r.close_at = add(now, s.round_secs as u64);
        r.trade_until = r.close_at - s.settle_window_secs as u64;
        r.state = RoundState::Live;
        s.live_round = r.index;
        s.presale_round = next_index;
        emit(
            "round_opened",
            &[
                ("series_id", series_id.to_string()),
                ("round_index", ri.to_string()),
                ("target_e2", target_e2.to_string()),
                ("m_up", r.m_up.to_string()),
                ("m_down", r.m_down.to_string()),
                ("shares", total.to_string()),
                ("opened_at", r.opened_at.to_string()),
                ("close_at", r.close_at.to_string()),
                ("trade_until", r.trade_until.to_string()),
                ("next_round_index", next_index.to_string()),
            ],
        );
        self.rounds.insert((series_id, ri), r);
        self.rounds.insert((series_id, next_index), Round::presale(series_id, next_index));
        self.series.insert(series_id, s);
    }

    /// Live trading: spend `amount` of the caller's balance on a side in
    /// round `round_index`, which must be the series' live round. Shares
    /// come from the pari-mutuel curve; `min_shares` guards against a worse
    /// fill.
    pub fn buy(&mut self, series_id: u32, round_index: u32, side: Side, amount: U128, min_shares: U128) {
        let amount = to_u64(amount);
        let holder = env::predecessor_account_id();
        let mut s = self.series_or_fail(series_id);
        let ri = round_index;
        let r = self.rounds.get(&(series_id, ri)).cloned();
        let q = price_buy(&s, r.as_ref(), side, amount, now_secs());
        check(q.shares as u128 >= min_shares.0, RoundsError::Slippage);
        let mut r = r.unwrap_or_else(|| fail(RoundsError::NotLive));

        self.debit(&holder, amount);
        s.finder_fees = add(s.finder_fees, q.finder);
        s.platform_fees = add(s.platform_fees, q.platform);
        let mut p = self.position_or_new(series_id, ri, &holder);
        match side {
            Side::Up => {
                r.m_up = add(r.m_up, q.net);
                r.n_up = add(r.n_up, q.shares);
                p.stake_up = add(p.stake_up, q.net);
                p.shares_up = add(p.shares_up, q.shares);
            }
            Side::Down => {
                r.m_down = add(r.m_down, q.net);
                r.n_down = add(r.n_down, q.shares);
                p.stake_down = add(p.stake_down, q.net);
                p.shares_down = add(p.shares_down, q.shares);
            }
        }
        emit(
            "buy",
            &[
                ("series_id", series_id.to_string()),
                ("round_index", ri.to_string()),
                ("account", holder.to_string()),
                ("side", side.as_str().to_string()),
                ("amount", amount.to_string()),
                ("fee", q.fee.to_string()),
                ("net", q.net.to_string()),
                ("shares", q.shares.to_string()),
                ("m_up", r.m_up.to_string()),
                ("m_down", r.m_down.to_string()),
                ("n_up", r.n_up.to_string()),
                ("n_down", r.n_down.to_string()),
            ],
        );
        self.rounds.insert((series_id, ri), r);
        self.series.insert(series_id, s);
        self.save_position(p);
    }

    /// Settles the live round from the VI averaged over the final window.
    /// Keeper only. UP wins if the reading is at or above the target.
    /// `commitment` is reserved for a hash of the oracle inputs (zeros
    /// until that ships).
    pub fn settle(&mut self, series_id: u32, settle_e2: u64, commitment: String) {
        self.assert_keeper();
        check(is_hex32(&commitment), RoundsError::BadCommitment);
        let mut s = self.series_or_fail(series_id);
        let ri = s.live_round;
        let mut r = self.rounds.get(&(series_id, ri)).cloned().unwrap_or_else(|| fail(RoundsError::NotLive));
        check(r.state == RoundState::Live && r.index == s.live_round, RoundsError::NotLive);
        check(now_secs() >= r.close_at, RoundsError::TooEarly);
        let winner = if settle_e2 >= r.target_e2 { Side::Up } else { Side::Down };
        r.state = RoundState::Settled;
        r.winner = Some(winner);
        r.settle_e2 = settle_e2;
        r.commitment = commitment.clone();
        s.live_round = 0;
        emit(
            "round_settled",
            &[
                ("series_id", series_id.to_string()),
                ("round_index", ri.to_string()),
                ("winner", winner.as_str().to_string()),
                ("settle_e2", settle_e2.to_string()),
                ("target_e2", r.target_e2.to_string()),
                ("commitment", commitment),
            ],
        );
        self.rounds.insert((series_id, ri), r);
        self.series.insert(series_id, s);
    }

    /// Voids a round. Keeper only. A live round past its close with no VI
    /// prints to settle on: everyone gets their net stakes back and the
    /// series goes on. A presale round while the series is paused: refunds,
    /// and the series ends (no presale round remains).
    pub fn void_round(&mut self, series_id: u32, round_index: u32) {
        self.assert_keeper();
        let mut s = self.series_or_fail(series_id);
        let mut r = self.round_or_fail(series_id, round_index);
        let now = now_secs();
        match r.state {
            RoundState::Live => {
                check(r.index == s.live_round, RoundsError::BadRound);
                check(now >= r.close_at, RoundsError::TooEarly);
                s.live_round = 0;
            }
            RoundState::Presale => {
                check(r.index == s.presale_round, RoundsError::BadRound);
                check(s.paused, RoundsError::NotPaused);
                s.presale_round = 0;
            }
            _ => fail(RoundsError::BadRound),
        }
        r.state = RoundState::Void;
        emit("round_voided", &[("series_id", series_id.to_string()), ("round_index", round_index.to_string())]);
        self.rounds.insert((series_id, round_index), r);
        self.series.insert(series_id, s);
    }

    // ------------------------------------------------------------- claims

    /// Credits a settled round's payout (or a void round's refund) to the
    /// caller's balance and removes the position. A losing position is
    /// paid nothing and still removed. Returns the amount credited.
    pub fn claim(&mut self, series_id: u32, round_index: u32) -> U128 {
        let holder = env::predecessor_account_id();
        self.series_or_fail(series_id);
        let mut r = self.round_or_fail(series_id, round_index);
        let p = self.position_or_fail(series_id, round_index, &holder);
        let amount = due(&r, &p);
        if amount > 0 {
            r.paid_out = add(r.paid_out, amount);
            self.credit(&holder, amount);
        }
        emit(
            "claim",
            &[
                ("series_id", series_id.to_string()),
                ("round_index", round_index.to_string()),
                ("account", holder.to_string()),
                ("amount", amount.to_string()),
            ],
        );
        self.rounds.insert((series_id, round_index), r);
        self.remove_position(series_id, round_index, &holder);
        u(amount)
    }

    /// Like `claim`, but the payout stays in the contract as a presale
    /// commit on the winning side of the series' current presale round, and
    /// pays the fee on the whole amount. Returns the net amount committed.
    pub fn claim_rollover(&mut self, series_id: u32, round_index: u32) -> U128 {
        let holder = env::predecessor_account_id();
        let mut s = self.series_or_fail(series_id);
        let mut r = self.round_or_fail(series_id, round_index);
        let p = self.position_or_fail(series_id, round_index, &holder);
        check(r.state == RoundState::Settled, RoundsError::NotSettled);
        check(!s.paused, RoundsError::Paused);
        let ni = s.presale_round;
        let mut next = self.rounds.get(&(series_id, ni)).cloned().unwrap_or_else(|| fail(RoundsError::NotPresale));
        check(next.state == RoundState::Presale && next.index == s.presale_round, RoundsError::NotPresale);
        let amount = due(&r, &p);
        check(amount > 0, RoundsError::NothingToClaim);
        let (fee, finder, platform, net) = fee_split(amount, s.fee_bps, s.finder_bps);
        check(net > 0, RoundsError::ZeroAmount);
        let side = r.winner.unwrap_or_else(|| fail(RoundsError::NotSettled));
        r.paid_out = add(r.paid_out, amount);
        s.finder_fees = add(s.finder_fees, finder);
        s.platform_fees = add(s.platform_fees, platform);
        let mut np = self.position_or_new(series_id, ni, &holder);
        match side {
            Side::Up => {
                next.presale_up = add(next.presale_up, net);
                np.presale_up = add(np.presale_up, net);
            }
            Side::Down => {
                next.presale_down = add(next.presale_down, net);
                np.presale_down = add(np.presale_down, net);
            }
        }
        emit(
            "rollover",
            &[
                ("series_id", series_id.to_string()),
                ("round_index", round_index.to_string()),
                ("next_round_index", ni.to_string()),
                ("account", holder.to_string()),
                ("side", side.as_str().to_string()),
                ("amount", amount.to_string()),
                ("fee", fee.to_string()),
                ("net", net.to_string()),
            ],
        );
        emit(
            "commit",
            &[
                ("series_id", series_id.to_string()),
                ("round_index", ni.to_string()),
                ("account", holder.to_string()),
                ("side", side.as_str().to_string()),
                ("amount", amount.to_string()),
                ("fee", fee.to_string()),
                ("net", net.to_string()),
                ("presale_up", next.presale_up.to_string()),
                ("presale_down", next.presale_down.to_string()),
            ],
        );
        self.rounds.insert((series_id, round_index), r);
        self.rounds.insert((series_id, ni), next);
        self.series.insert(series_id, s);
        self.save_position(np);
        self.remove_position(series_id, round_index, &holder);
        u(net)
    }

    /// Pays accrued fees: the finder's counter to the finder's balance and
    /// the platform's to the treasury's. Anyone may call it.
    pub fn withdraw_fees(&mut self, series_id: u32) {
        let mut s = self.series_or_fail(series_id);
        let finder = std::mem::take(&mut s.finder_fees);
        let platform = std::mem::take(&mut s.platform_fees);
        check(finder > 0 || platform > 0, RoundsError::NothingToClaim);
        let treasury = self.config.treasury.clone();
        self.credit(&s.finder, finder);
        self.credit(&treasury, platform);
        emit(
            "fees_withdrawn",
            &[
                ("series_id", series_id.to_string()),
                ("finder", s.finder.to_string()),
                ("finder_amount", finder.to_string()),
                ("treasury", treasury.to_string()),
                ("platform_amount", platform.to_string()),
            ],
        );
        self.series.insert(series_id, s);
    }

    // -------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_series(&self, series_id: u32) -> Option<SeriesView> {
        self.series.get(&series_id).map(SeriesView::from)
    }

    pub fn get_series_by_reference(&self, reference: String) -> Option<SeriesView> {
        self.series_by_reference.get(&reference).and_then(|id| self.get_series(*id))
    }

    /// Series in id order. `from_index` is an offset (0 = the first series,
    /// id 1); `limit` defaults to 50, at most 100.
    pub fn list_series(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<SeriesView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(LIST_LIMIT_DEFAULT).min(LIST_LIMIT_MAX);
        (from.saturating_add(1)..=self.config.series_count)
            .take(limit as usize)
            .filter_map(|id| self.get_series(id))
            .collect()
    }

    pub fn get_round(&self, series_id: u32, round_index: u32) -> Option<RoundView> {
        self.rounds.get(&(series_id, round_index)).map(RoundView::from)
    }

    pub fn get_position(&self, series_id: u32, round_index: u32, account_id: AccountId) -> Option<PositionView> {
        self.positions.get(&(series_id, round_index, account_id)).map(PositionView::from)
    }

    /// Every open position of an account, oldest first.
    pub fn positions_of(&self, account_id: AccountId) -> Vec<PositionView> {
        let Some(set) = self.account_positions.get(&account_id) else {
            return Vec::new();
        };
        set.iter()
            .filter_map(|(sid, ri)| self.positions.get(&(*sid, *ri, account_id.clone())))
            .map(PositionView::from)
            .collect()
    }

    pub fn balance_of(&self, account_id: AccountId) -> U128 {
        u(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    /// What `buy` would give for `amount` on `side` in round `round_index`
    /// now, with the same checks and arithmetic (balance and `min_shares`
    /// aside): the round must be the series' live round.
    pub fn quote_buy(&self, series_id: u32, round_index: u32, side: Side, amount: U128) -> BuyQuote {
        let s = self.series_or_fail(series_id);
        let r = self.rounds.get(&(series_id, round_index));
        let q = price_buy(&s, r, side, to_u64(amount), now_secs());
        BuyQuote { shares: u(q.shares), fee: u(q.fee), finder_fee: u(q.finder), net: u(q.net) }
    }
}

// ------------------------------------------------------------- internals

impl Contract {
    fn assert_owner(&self) {
        check(env::predecessor_account_id() == self.config.owner, RoundsError::NotOwner);
    }

    fn assert_keeper(&self) {
        check(env::predecessor_account_id() == self.config.keeper, RoundsError::NotKeeper);
    }

    fn series_or_fail(&self, series_id: u32) -> Series {
        self.series.get(&series_id).cloned().unwrap_or_else(|| fail(RoundsError::NoSeries))
    }

    fn round_or_fail(&self, series_id: u32, round_index: u32) -> Round {
        self.rounds.get(&(series_id, round_index)).cloned().unwrap_or_else(|| fail(RoundsError::NoRound))
    }

    fn position_or_fail(&self, series_id: u32, round_index: u32, holder: &AccountId) -> Position {
        self.positions
            .get(&(series_id, round_index, holder.clone()))
            .cloned()
            .unwrap_or_else(|| fail(RoundsError::NoPosition))
    }

    fn position_or_new(&self, series_id: u32, round_index: u32, holder: &AccountId) -> Position {
        self.positions
            .get(&(series_id, round_index, holder.clone()))
            .cloned()
            .unwrap_or_else(|| Position::new(holder.clone(), series_id, round_index))
    }

    fn save_position(&mut self, p: Position) {
        let key = (p.series, p.round);
        let holder = p.holder.clone();
        self.positions.insert((p.series, p.round, holder.clone()), p);
        if let Some(set) = self.account_positions.get_mut(&holder) {
            set.insert(key);
            return;
        }
        let mut set = IterableSet::new(StorageKey::AccountPositionSet {
            account_hash: env::sha256(holder.as_bytes()),
        });
        set.insert(key);
        self.account_positions.insert(holder, set);
    }

    fn remove_position(&mut self, series_id: u32, round_index: u32, holder: &AccountId) {
        self.positions.remove(&(series_id, round_index, holder.clone()));
        let empty = match self.account_positions.get_mut(holder) {
            Some(set) => {
                set.remove(&(series_id, round_index));
                set.is_empty()
            }
            None => false,
        };
        if empty {
            self.account_positions.remove(holder);
        }
    }

    fn credit(&mut self, account: &AccountId, amount: u64) {
        if amount == 0 {
            return;
        }
        let b = self.balances.get(account).copied().unwrap_or(0);
        self.balances.insert(account.clone(), add(b, amount));
    }

    fn debit(&mut self, account: &AccountId, amount: u64) {
        let b = self.balances.get(account).copied().unwrap_or(0);
        check(b >= amount, RoundsError::InsufficientBalance);
        let left = b - amount;
        if left == 0 {
            self.balances.remove(account);
        } else {
            self.balances.insert(account.clone(), left);
        }
    }
}
