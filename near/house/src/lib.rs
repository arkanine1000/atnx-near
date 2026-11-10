//! A house market on the ATNX Virality Index (VI), on NEAR.
//!
//! Anyone goes long or short a market's VI at 1x, 2x or 3x against a vault. The
//! most a position can lose is its stake; the most it can win is set by
//! `max_profit_bps` (nine times the stake for a long by default, leverage ×
//! stake for a short) and is reserved in the vault when the order fills, so
//! the vault can always pay every open position in full.
//!
//! Two prices. Each print carries the score S (the number on the chart) and
//! the reading R (the latest raw result the score is smoothing towards).
//! The contract quotes S and a lead that sits between S and R, and derives
//! both from the two numbers itself (`quote.rs`): longs open at the buy
//! price max(S, lead) and close at the sell price min(S, lead); shorts the
//! other way round.
//!
//! Fills at a fresh price. `open` and `close` only place a request. A
//! request fills at the earliest quote in the market's ring of recent
//! quotes that the keeper read at least `min_fill_delay_secs` after it, so
//! the price never depends on who calls `crank` or when. Every request names
//! the worst price it accepts.
//!
//! Money is an internal ledger (`balances`), as in the rounds contract: the
//! treasury funds it with `ft_transfer_call`, users get test USDG from the
//! faucet pool, and every trading call moves balances inside this contract
//! with no deposit attached, so a function-call key or a relayer can sign
//! it. Only `withdraw` makes a cross-contract call.
//!
//! Two invariants hold after every call (the unit tests check both after
//! each one): the USDG this contract holds is at least the sum of all ledger
//! balances, the vault's assets, the margin held for positions and the
//! faucet pool; and the vault's reserve never exceeds its assets.
//!
//! Conventions: amounts are `U128` strings at the interface and `u64` inside,
//! in 6-decimal USDG units; prices and scores are hundredths of a VI point
//! (`_e2`), `U64` strings at the interface; times are unix seconds from the
//! block timestamp, plain numbers. No method takes a deposit. Failures panic
//! with fixed messages (`HouseError`), so clients can match on the text.

use near_sdk::borsh;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json;
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{
    env, ext_contract, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

pub mod quote;
use quote::{
    cap_e2, capped, fee_of, leverage_ok, liquidatable, liquidation_e2, max_profit, payout, pnl, prices, spread_bps,
    split_fee,
    to_assets, to_shares, Prices, BPS,
};

#[cfg(test)]
mod tests;

/// The layout of `Contract`. `migrate` reads it from the first four bytes of
/// the stored state, so `state_version` must stay the struct's first field.
pub const STATE_VERSION: u32 = 1;
/// Quotes kept per market.
pub const RING: usize = 8;
/// Closed positions and refunded orders kept per account.
pub const HISTORY_LEN: usize = 20;
/// Ids `crank` processes per call; it ignores any beyond. Each id writes at
/// most one event of at most about 500 bytes, so a full batch stays well
/// inside the 16 KB and 100-log limits of a call.
pub const MAX_CRANK_IDS: usize = 20;
/// Quotes per `push_quotes` call.
pub const MAX_QUOTES_PER_PUSH: usize = 200;
/// How far a print's time may be after the block time. `print_at` comes
/// from the index's database clock, `read_at` and the block time from the
/// chain's, and the two clocks can differ by a second or two.
pub const PRINT_CLOCK_SLACK_SECS: u64 = 30;
/// Shares minted to nobody at init, so the share price is always defined.
/// Shares have 9 decimals; at this count one share starts at one USDG.
pub const DEAD_SHARES: u128 = 1_000;
/// One share, in share units.
pub const SHARE: u128 = 1_000_000_000;
pub const USDG: u64 = 1_000_000;
const DAY: u64 = 86_400;
const NEAR_YOCTO: u128 = 1_000_000_000_000_000_000_000_000;

const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FOR_ON_WITHDRAW: Gas = Gas::from_tgas(5);

const EVENT_STANDARD: &str = "atnx_house";
const EVENT_VERSION: &str = "1.0.0";
const LIST_LIMIT_DEFAULT: u32 = 50;
const LIST_LIMIT_MAX: u32 = 100;

/// The one call this contract makes on the USDG token.
#[ext_contract(ext_usdg)]
#[allow(dead_code)]
trait Usdg {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

// ---------------------------------------------------------------- state

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Long,
    Short,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Long => "Long",
            Side::Short => "Short",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketStatus {
    /// Opens, closes and liquidations.
    Open,
    /// Closes and liquidations only. Final: a market never reopens.
    CloseOnly,
    /// Every position closes at `final_e2`. Final.
    Settled,
}

impl MarketStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            MarketStatus::Open => "Open",
            MarketStatus::CloseOnly => "CloseOnly",
            MarketStatus::Settled => "Settled",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PositionState {
    /// An order waiting for a quote read after it; holds stake + fee.
    Pending,
    Open,
    /// A close waiting for a quote read after the request.
    Closing,
}

impl PositionState {
    pub fn as_str(self) -> &'static str {
        match self {
            PositionState::Pending => "Pending",
            PositionState::Open => "Open",
            PositionState::Closing => "Closing",
        }
    }
}

/// Every setting. `set_config` changes them inside the ranges in
/// `validate_config`, which are fixed in the code.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub owner: AccountId,
    pub keeper: AccountId,
    pub treasury: AccountId,
    /// The USDG token (NEP-141).
    pub token: AccountId,
    /// Fee on the stake, charged on top of it at the fill.
    pub fee_bps: u32,
    /// The market finder's part of the fee; the rest goes to the treasury.
    pub finder_bps: u32,
    /// How far the lead moves towards the reading at no gap.
    pub lead_min_bps: u32,
    /// The gap from which the lead is the reading.
    pub lead_full_gap_bps: u32,
    /// Orders are refused, and refunded at the fill, when the two prices are
    /// further apart than this, as a share of the score.
    pub max_open_gap_bps: u32,
    /// The most a long can win, as a share of the stake (a short: at most
    /// leverage × stake).
    pub max_profit_bps: u32,
    pub min_score_e2: U64,
    /// A market opens this long after it went live.
    pub cooloff_secs: U64,
    /// Reserve per market and side, as a share of the vault's assets.
    pub market_cap_bps: u32,
    /// Total reserve, as a share of the vault's assets.
    pub utilisation_cap_bps: u32,
    pub min_stake: U128,
    pub max_stake: U128,
    /// Pending, open and closing positions per account.
    pub max_positions_per_account: u32,
    pub min_fill_delay_secs: U64,
    pub order_ttl_secs: U64,
    pub max_quote_age_secs: U64,
    pub emergency_secs: U64,
    pub max_position_secs: U64,
    pub lp_exit_delay_secs: U64,
    pub lp_exit_window_secs: U64,
    /// The most a new print's score may move from the stored score per 300 s
    /// of print time.
    pub max_step_bps: u32,
    /// Paid to whoever liquidates a position, out of its stake.
    pub liq_reward_bps: u32,
    pub faucet_per_account: U128,
    /// In yoctoNEAR: calls that add state fail when the contract's free NEAR
    /// is under this.
    pub storage_floor: U128,
    pub opens_paused: bool,
    /// When false, only the treasury may deposit into the vault.
    pub lp_open: bool,
}

impl Config {
    fn defaults(owner: AccountId, keeper: AccountId, treasury: AccountId, token: AccountId) -> Self {
        Self {
            owner,
            keeper,
            treasury,
            token,
            fee_bps: 100,
            finder_bps: 5_000,
            lead_min_bps: 3_000,
            lead_full_gap_bps: 2_500,
            max_open_gap_bps: 1_000,
            max_profit_bps: 90_000,
            min_score_e2: U64(10_000),
            cooloff_secs: U64(2 * DAY),
            market_cap_bps: 200,
            utilisation_cap_bps: 8_000,
            min_stake: U128(10 * USDG as u128),
            max_stake: U128(250 * USDG as u128),
            max_positions_per_account: 10,
            min_fill_delay_secs: U64(5),
            order_ttl_secs: U64(900),
            max_quote_age_secs: U64(900),
            emergency_secs: U64(DAY),
            max_position_secs: U64(14 * DAY),
            lp_exit_delay_secs: U64(DAY),
            lp_exit_window_secs: U64(3_600),
            max_step_bps: 1_500,
            liq_reward_bps: 100,
            faucet_per_account: U128(10_000 * USDG as u128),
            storage_floor: U128(3 * NEAR_YOCTO),
            opens_paused: false,
            lp_open: false,
        }
    }
}

/// `set_config`'s argument: every field optional, unknown fields refused.
/// `owner`, `token` and `opens_paused` (see `set_paused`) are not here.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ConfigPatch {
    pub keeper: Option<AccountId>,
    pub treasury: Option<AccountId>,
    pub fee_bps: Option<u32>,
    pub finder_bps: Option<u32>,
    pub lead_min_bps: Option<u32>,
    pub lead_full_gap_bps: Option<u32>,
    pub max_open_gap_bps: Option<u32>,
    pub max_profit_bps: Option<u32>,
    pub min_score_e2: Option<U64>,
    pub cooloff_secs: Option<U64>,
    pub market_cap_bps: Option<u32>,
    pub utilisation_cap_bps: Option<u32>,
    pub min_stake: Option<U128>,
    pub max_stake: Option<U128>,
    pub max_positions_per_account: Option<u32>,
    pub min_fill_delay_secs: Option<U64>,
    pub order_ttl_secs: Option<U64>,
    pub max_quote_age_secs: Option<U64>,
    pub emergency_secs: Option<U64>,
    pub max_position_secs: Option<U64>,
    pub lp_exit_delay_secs: Option<U64>,
    pub lp_exit_window_secs: Option<U64>,
    pub max_step_bps: Option<u32>,
    pub liq_reward_bps: Option<u32>,
    pub faucet_per_account: Option<U128>,
    pub storage_floor: Option<U128>,
    pub lp_open: Option<bool>,
}

/// One print as the keeper read it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    /// The score used for prices: the pushed score, clipped from the previous
    /// print's by `max_step_bps` per 300 s of print time.
    pub score_e2: u64,
    /// The score as pushed, which a later push of the same print must repeat.
    pub pushed_score_e2: u64,
    pub reading_e2: u64,
    pub print_id: u64,
    pub print_at: u64,
    /// When the keeper first and last read this print as the market's newest.
    pub first_read_at: u64,
    pub last_read_at: u64,
}

/// Filled positions on one side of a market.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Book {
    pub stake: u64,
    pub notional: u64,
    pub reserved: u64,
    pub count: u32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Market {
    /// The ATNX market uuid as 32 lowercase hex characters.
    pub reference: String,
    pub finder: Option<AccountId>,
    /// When the market went live on atnx.app.
    pub live_since: u64,
    pub listed_at: u64,
    pub status: MarketStatus,
    /// The last `RING` quotes, oldest first.
    pub quotes: Vec<Quote>,
    /// `last_read_at` of the newest quote that has left the ring (0 if none):
    /// a request whose first quote has left can tell.
    pub dropped_read_at: u64,
    pub final_e2: Option<u64>,
    pub settled_at: Option<u64>,
    pub long: Book,
    pub short: Book,
}

impl Market {
    fn newest(&self) -> Option<&Quote> {
        self.quotes.last()
    }

    fn book_mut(&mut self, side: Side) -> &mut Book {
        match side {
            Side::Long => &mut self.long,
            Side::Short => &mut self.short,
        }
    }

    fn book(&self, side: Side) -> &Book {
        match side {
            Side::Long => &self.long,
            Side::Short => &self.short,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Position {
    pub account: AccountId,
    pub market: u32,
    pub side: Side,
    pub leverage: u8,
    pub stake: u64,
    pub fee: u64,
    /// The maximum profit, reserved in the vault from the fill.
    pub reserved: u64,
    pub state: PositionState,
    pub placed_at: u64,
    /// Long: the highest entry accepted. Short: the lowest.
    pub limit_e2: u64,
    pub entry_e2: u64,
    /// When the fill quote was read after the order.
    pub opened_at: u64,
    /// opened_at + max_position_secs, fixed at the fill.
    pub expires_at: u64,
    pub fill_print_id: u64,
    pub close_requested_at: u64,
    /// Long: the lowest exit accepted. Short: the highest. 0 for an expiry
    /// close, which has no limit.
    pub close_limit_e2: u64,
}

/// A closed position, kept in its account's history. Refunded orders are
/// not history: their events say why.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Closed {
    pub id: u64,
    pub market: u32,
    pub side: Side,
    pub leverage: u8,
    pub stake: u64,
    pub entry_e2: u64,
    pub exit_e2: u64,
    /// What the account was credited.
    pub payout: u64,
    /// close, cap, liquidation, expiry or settled.
    pub reason: String,
    pub opened_at: u64,
    pub closed_at: u64,
}

/// The vault. `assets` counts realised results only; `margin` is what open
/// positions and pending orders hold; `reserved` is the open positions'
/// maximum profit, set aside out of `assets`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default)]
pub struct Vault {
    pub assets: u64,
    pub reserved: u64,
    pub margin: u64,
    /// Dead shares included.
    pub shares: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct LpRequest {
    pub shares: u128,
    pub ready_at: u64,
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Balances,
    FaucetClaimed,
    Markets,
    MarketByReference,
    Positions,
    Active,
    AccountPositions,
    AccountPositionSet { account_hash: Vec<u8> },
    History,
    LpShares,
    LpRequests,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// Must stay first: `migrate` reads it from the raw state.
    state_version: u32,
    config: Config,
    balances: LookupMap<AccountId, u64>,
    /// The sum of all `balances`.
    ledger_total: u64,
    faucet_pool: u64,
    faucet_claimed: LookupMap<AccountId, u64>,
    markets: Vector<Market>,
    market_by_reference: LookupMap<String, u32>,
    positions: LookupMap<u64, Position>,
    next_position_id: u64,
    /// Every pending, open or closing position.
    active: IterableSet<u64>,
    account_positions: LookupMap<AccountId, IterableSet<u64>>,
    history: LookupMap<AccountId, Vec<Closed>>,
    vault: Vault,
    lp_shares: LookupMap<AccountId, u128>,
    lp_requests: LookupMap<AccountId, LpRequest>,
}

/// One print for `push_quotes`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct QuoteIn {
    pub market: u32,
    pub score_e2: U64,
    pub reading_e2: U64,
    /// The print's id (`vi_history.id`): a newer print has a larger id.
    pub print_id: U64,
    /// When the print was recorded.
    pub print_at: U64,
    /// The block time just before the keeper read it as the market's newest
    /// print.
    pub read_at: U64,
}

/// What `push_quotes` did with a batch.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushResult {
    pub count: u32,
    pub accepted: u32,
    pub skipped: u32,
}

// ---------------------------------------------------------------- views

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuoteView {
    pub score_e2: U64,
    pub pushed_score_e2: U64,
    pub reading_e2: U64,
    pub lead_e2: U64,
    pub buy_e2: U64,
    pub sell_e2: U64,
    /// (buy − sell) / score, in basis points.
    pub spread_bps: U64,
    pub print_id: U64,
    pub print_at: U64,
    pub first_read_at: U64,
    pub last_read_at: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookView {
    pub stake: U128,
    pub notional: U128,
    pub reserved: U128,
    pub count: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarketView {
    pub id: u32,
    pub reference: String,
    pub finder: Option<AccountId>,
    pub live_since: U64,
    pub listed_at: U64,
    pub status: MarketStatus,
    pub final_e2: Option<U64>,
    pub settled_at: Option<U64>,
    /// The newest quote with its two prices.
    pub quote: Option<QuoteView>,
    /// The ring, oldest first.
    pub quotes: Vec<QuoteView>,
    pub long: BookView,
    pub short: BookView,
    /// The reserve each side may hold now.
    pub side_cap: U128,
    /// Whether `open` would accept an order on this market now (stake and
    /// account aside), and if not, why.
    pub opens: bool,
    pub reason: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionView {
    pub id: U64,
    pub account: AccountId,
    pub market: u32,
    pub side: Side,
    pub leverage: u8,
    pub stake: U128,
    pub fee: U128,
    /// The maximum profit, reserved in the vault from the fill (0 while
    /// pending).
    pub reserved: U128,
    pub state: PositionState,
    pub placed_at: U64,
    pub limit_e2: U64,
    /// Null until the fill.
    pub entry_e2: Option<U64>,
    /// Null until the fill.
    pub opened_at: Option<U64>,
    /// Null until a close is requested, or the position has reached its end.
    pub close_requested_at: Option<U64>,
    /// Null until a close is requested; null for the end-of-life close,
    /// which has no limit.
    pub close_limit_e2: Option<U64>,
    /// When the position ends (null until the fill).
    pub expires_at: Option<U64>,
    pub fill_print_id: Option<U64>,
    pub liquidation_e2: Option<U64>,
    pub cap_e2: Option<U64>,
    /// What closing would pay at the newest quote's close-side price (the
    /// final price on a settled market); null while pending.
    pub value: Option<U128>,
    /// Worth nothing at the close-side price, but not liquidated.
    pub at_risk: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClosedView {
    pub id: U64,
    pub market: u32,
    pub side: Side,
    pub leverage: u8,
    pub stake: U128,
    pub entry_e2: U64,
    pub exit_e2: U64,
    /// What the account was credited: the profit is payout − stake.
    pub payout: U128,
    /// close, cap, liquidation, expiry or settled.
    pub reason: String,
    pub opened_at: U64,
    pub closed_at: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultView {
    pub assets: U128,
    pub reserved: U128,
    /// assets − reserved: what share holders can take out.
    pub free: U128,
    pub margin: U128,
    pub shares: U128,
    pub dead_shares: U128,
    /// What one share (10^9 share units) is worth, in USDG units.
    pub share_price: U128,
    /// The sum of every ledger balance.
    pub ledger_total: U128,
    pub faucet_pool: U128,
    pub lp_open: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LpRequestView {
    pub shares: U128,
    pub value: U128,
    pub ready_at: U64,
    /// The end of the window; after it the request lapses.
    pub closes_at: U64,
    /// waiting, ready or lapsed.
    pub state: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LpView {
    pub shares: U128,
    pub value: U128,
    pub request: Option<LpRequestView>,
}

/// What `open` would do now, from the same checks and arithmetic.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenQuote {
    /// Whether `open` would accept the order now.
    pub allowed: bool,
    pub reason: Option<String>,
    pub score_e2: U64,
    pub reading_e2: U64,
    pub lead_e2: U64,
    pub buy_e2: U64,
    pub sell_e2: U64,
    pub spread_bps: U64,
    pub print_id: U64,
    pub print_at: U64,
    /// The entry if the order filled at the newest quote.
    pub entry_e2: U64,
    pub fee: U128,
    pub finder_fee: U128,
    /// stake + fee: what `open` debits.
    pub cost: U128,
    pub max_profit: U128,
    pub liquidation_e2: U64,
    pub cap_e2: U64,
    /// What the position would be worth the moment it filled at the newest
    /// quote: its payout at that quote's close-side price.
    pub value_on_fill: U128,
    /// Whether a fill at the newest quote would pass the fill-time checks
    /// (limit aside), including the caps, and if not, the refund reason.
    pub would_fill: bool,
    pub fill_reason: Option<String>,
}

// --------------------------------------------------------------- errors

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HouseError {
    NotOwner,
    NotKeeper,
    NotOwnerOrKeeper,
    ZeroAmount,
    Overflow,
    InsufficientBalance,
    NoMarket,
    AlreadyListed,
    BadReference,
    BadCommitment,
    LiveSinceInFuture,
    BadStatus,
    MarketNotOpen,
    OpensPaused,
    CoolOff,
    NoQuote,
    StaleQuote,
    ScoreTooLow,
    SpreadTooWide,
    ZeroPrice,
    BadLeverage,
    StakeTooSmall,
    StakeTooLarge,
    LimitRequired,
    TooManyPositions,
    StorageFloor,
    NoPosition,
    NotYours,
    NotOpen,
    NotPending,
    PositionExpired,
    CancelTooEarly,
    HasQuote,
    NotStale,
    AlreadySettled,
    FaucetCap,
    FaucetEmpty,
    LpClosed,
    NoShares,
    ZeroShares,
    RequestPending,
    NoRequest,
    RequestNotReady,
    NotEnoughFree,
    NoState,
    UnknownStateVersion,
}

impl HouseError {
    pub const fn msg(self) -> &'static str {
        match self {
            HouseError::NotOwner => "not the owner",
            HouseError::NotKeeper => "not the keeper",
            HouseError::NotOwnerOrKeeper => "not the owner or the keeper",
            HouseError::ZeroAmount => "amount is zero",
            HouseError::Overflow => "arithmetic overflow",
            HouseError::InsufficientBalance => "balance too low",
            HouseError::NoMarket => "no such market",
            HouseError::AlreadyListed => "already listed",
            HouseError::BadReference => "reference must be 32 lowercase hex characters",
            HouseError::BadCommitment => "commitment must be 64 lowercase hex characters",
            HouseError::LiveSinceInFuture => "live_since is after the block time",
            HouseError::BadStatus => "a market can only move from Open to CloseOnly",
            HouseError::MarketNotOpen => "market is not open",
            HouseError::OpensPaused => "new orders are paused",
            HouseError::CoolOff => "market is inside its cool-off",
            HouseError::NoQuote => "market has no quote",
            HouseError::StaleQuote => "the market's newest quote is too old",
            HouseError::ScoreTooLow => "score is under the minimum to open",
            HouseError::SpreadTooWide => "the two prices are too far apart",
            HouseError::ZeroPrice => "the price is zero",
            HouseError::BadLeverage => "leverage must be 1, 2 or 3",
            HouseError::StakeTooSmall => "stake below the minimum",
            HouseError::StakeTooLarge => "stake above the maximum",
            HouseError::LimitRequired => "a limit price is required",
            HouseError::TooManyPositions => "position limit reached for this account",
            HouseError::StorageFloor => "the contract is under its storage floor",
            HouseError::NoPosition => "no such position",
            HouseError::NotYours => "not your position",
            HouseError::NotOpen => "position is not open",
            HouseError::NotPending => "order is not pending",
            HouseError::PositionExpired => "position has reached its end and is closing",
            HouseError::CancelTooEarly => "an order can be cancelled only once its time to live has passed",
            HouseError::HasQuote => "order has a quote to fill at",
            HouseError::NotStale => "market has had a quote within the emergency period",
            HouseError::AlreadySettled => "market is already settled",
            HouseError::FaucetCap => "faucet limit reached for this account",
            HouseError::FaucetEmpty => "faucet pool too low",
            HouseError::LpClosed => "vault deposits are open to the treasury only",
            HouseError::NoShares => "not enough shares",
            HouseError::ZeroShares => "deposit too small to mint a share",
            HouseError::RequestPending => "a withdrawal request is already pending",
            HouseError::NoRequest => "no withdrawal request",
            HouseError::RequestNotReady => "withdrawal request is not ready yet",
            HouseError::NotEnoughFree => "not enough unreserved assets in the vault",
            HouseError::NoState => "no contract state to migrate",
            HouseError::UnknownStateVersion => "unknown state version",
        }
    }
}

/// Why an order was refunded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refund {
    /// The fill price was past the order's limit.
    Limit,
    /// The fill price was zero.
    ZeroPrice,
    /// The two prices were further apart than `max_open_gap_bps`.
    Spread,
    /// The score was under `min_score_e2`.
    Score,
    /// The market was no longer open.
    MarketClosed,
    /// The reserve would break a cap.
    MarketFull,
    /// No quote was read within `order_ttl_secs` of the order.
    Expired,
    /// The order's quote left the ring before anyone cranked it.
    RolledOut,
    /// Cancelled by the trader after `order_ttl_secs`.
    Cancelled,
}

impl Refund {
    pub fn as_str(self) -> &'static str {
        match self {
            Refund::Limit => "limit",
            Refund::ZeroPrice => "zero_price",
            Refund::Spread => "spread",
            Refund::Score => "score",
            Refund::MarketClosed => "market_closed",
            Refund::MarketFull => "market_full",
            Refund::Expired => "expired",
            Refund::RolledOut => "rolled_out",
            Refund::Cancelled => "cancelled",
        }
    }
}

fn fail(e: HouseError) -> ! {
    env::panic_str(e.msg())
}

fn check(ok: bool, e: HouseError) {
    if !ok {
        fail(e)
    }
}

fn fail_config(field: &str) -> ! {
    env::panic_str(&format!("config value out of range: {field}"))
}

fn add(a: u64, b: u64) -> u64 {
    a.checked_add(b).unwrap_or_else(|| fail(HouseError::Overflow))
}

fn sub(a: u64, b: u64) -> u64 {
    a.checked_sub(b).unwrap_or_else(|| fail(HouseError::Overflow))
}

fn to_u64(v: U128) -> u64 {
    u64::try_from(v.0).unwrap_or_else(|_| fail(HouseError::Overflow))
}

fn u(v: u64) -> U128 {
    U128(v as u128)
}

fn now_secs() -> u64 {
    env::block_timestamp_ms() / 1000
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// NEP-297: `EVENT_JSON:{"standard":"atnx_house","version":"1.0.0","event":…,"data":[{…}]}`,
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

/// Each number inside a range fixed here, so no setting can trap funds:
/// fees, delays and windows are bounded, the reserve can never reach the
/// whole vault, and every timer stays finite.
fn validate_config(c: &Config) {
    let r = |ok: bool, field: &str| {
        if !ok {
            fail_config(field)
        }
    };
    let bps = BPS as u32;
    r(c.fee_bps <= 500, "fee_bps");
    r(c.finder_bps <= bps, "finder_bps");
    r(c.lead_min_bps <= bps, "lead_min_bps");
    r((1..=bps).contains(&c.lead_full_gap_bps), "lead_full_gap_bps");
    r((100..=100_000).contains(&c.max_open_gap_bps), "max_open_gap_bps");
    r((1_000..=90_000).contains(&c.max_profit_bps), "max_profit_bps");
    r((1..=1_000_000).contains(&c.min_score_e2.0), "min_score_e2");
    r(c.cooloff_secs.0 <= 30 * DAY, "cooloff_secs");
    r((1..=bps).contains(&c.market_cap_bps), "market_cap_bps");
    r((1..=9_000).contains(&c.utilisation_cap_bps), "utilisation_cap_bps");
    r(c.min_stake.0 >= USDG as u128, "min_stake");
    r(c.max_stake.0 >= c.min_stake.0 && c.max_stake.0 <= 100_000 * USDG as u128, "max_stake");
    r((1..=50).contains(&c.max_positions_per_account), "max_positions_per_account");
    r(c.min_fill_delay_secs.0 <= 600, "min_fill_delay_secs");
    r((60..=DAY).contains(&c.order_ttl_secs.0) && c.order_ttl_secs.0 > c.min_fill_delay_secs.0, "order_ttl_secs");
    r((60..=DAY).contains(&c.max_quote_age_secs.0), "max_quote_age_secs");
    r((3_600..=7 * DAY).contains(&c.emergency_secs.0) && c.emergency_secs.0 >= c.max_quote_age_secs.0, "emergency_secs");
    r((DAY..=90 * DAY).contains(&c.max_position_secs.0), "max_position_secs");
    r(c.lp_exit_delay_secs.0 <= 7 * DAY, "lp_exit_delay_secs");
    r((600..=7 * DAY).contains(&c.lp_exit_window_secs.0), "lp_exit_window_secs");
    r((1..=bps).contains(&c.max_step_bps), "max_step_bps");
    r(c.liq_reward_bps <= 1_000, "liq_reward_bps");
    r(c.faucet_per_account.0 <= 1_000_000 * USDG as u128, "faucet_per_account");
    r(c.storage_floor.0 <= 1_000 * NEAR_YOCTO, "storage_floor");
}

/// Applies one pushed print to its market (see `push_quotes`). Returns false,
/// with the market unchanged, when the entry breaks a rule.
fn apply_quote(m: &mut Market, qi: &QuoteIn, now: u64, max_step_bps: u64) -> bool {
    let (score, reading, print_id) = (qi.score_e2.0, qi.reading_e2.0, qi.print_id.0);
    let (print_at, read_at) = (qi.print_at.0, qi.read_at.0);
    if m.status == MarketStatus::Settled || print_at > now.saturating_add(PRINT_CLOCK_SLACK_SECS) || read_at > now {
        return false;
    }
    let Some(s) = m.quotes.last().cloned() else {
        Contract::push_ring(m, score, score, reading, print_id, print_at, read_at);
        return true;
    };
    if read_at < s.last_read_at {
        return false;
    }
    if print_id == s.print_id {
        if s.pushed_score_e2 != score || s.reading_e2 != reading || s.print_at != print_at {
            return false;
        }
        if let Some(n) = m.quotes.last_mut() {
            n.last_read_at = read_at;
        }
        return true;
    }
    if print_id < s.print_id || print_at <= s.print_at {
        return false;
    }
    let clipped = quote::clip_score(s.score_e2, score, max_step_bps, print_at - s.print_at);
    Contract::push_ring(m, clipped, score, reading, print_id, print_at, read_at);
    true
}

/// Where the earliest quote read at or after a time sits in a ring.
enum Lookup {
    Found(usize),
    /// It existed but has left the ring.
    RolledOut,
    NotYet,
}

/// The earliest quote with `last_read_at >= at`. Read intervals in a ring
/// never overlap and only the newest quote's `last_read_at` moves, so this
/// is the first quote read at or after `at`, and it stays the same however
/// late anyone looks, until it leaves the ring.
fn find_quote(m: &Market, at: u64) -> Lookup {
    match m.quotes.iter().position(|q| q.last_read_at >= at) {
        Some(0) if m.dropped_read_at >= at => Lookup::RolledOut,
        Some(i) => Lookup::Found(i),
        None => Lookup::NotYet,
    }
}

/// What a pending order is due.
enum FillDue {
    At(usize),
    RolledOut,
    /// No quote was read within the order's time to live.
    Expired,
    Waiting,
}

/// What a close (or an expiry) is due.
enum CloseDue {
    At(usize),
    /// The close's quote is past its limit or at zero: back to Open.
    Missed(usize),
    Waiting,
}

/// The terms of a fill that passed every fill-time check.
struct Fill {
    entry: u64,
    reserved: u64,
}

// -------------------------------------------------------------- methods

#[near]
impl Contract {
    /// One-time setup with the default settings (see `Config::defaults`).
    #[init]
    pub fn new(owner: AccountId, keeper: AccountId, treasury: AccountId, token: AccountId) -> Self {
        let config = Config::defaults(owner, keeper, treasury, token);
        validate_config(&config);
        Self {
            state_version: STATE_VERSION,
            config,
            balances: LookupMap::new(StorageKey::Balances),
            ledger_total: 0,
            faucet_pool: 0,
            faucet_claimed: LookupMap::new(StorageKey::FaucetClaimed),
            markets: Vector::new(StorageKey::Markets),
            market_by_reference: LookupMap::new(StorageKey::MarketByReference),
            positions: LookupMap::new(StorageKey::Positions),
            next_position_id: 1,
            active: IterableSet::new(StorageKey::Active),
            account_positions: LookupMap::new(StorageKey::AccountPositions),
            history: LookupMap::new(StorageKey::History),
            vault: Vault { assets: 0, reserved: 0, margin: 0, shares: DEAD_SHARES },
            lp_shares: LookupMap::new(StorageKey::LpShares),
            lp_requests: LookupMap::new(StorageKey::LpRequests),
        }
    }

    /// Re-reads the stored state after a code upgrade, converting it from
    /// the layout named by its `state_version`. The owner or the contract
    /// account itself (in the deploy transaction). Version 1 is the only
    /// layout so far; a later layout keeps a copy of this one to convert from.
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| fail(HouseError::NoState));
        let version = raw.get(..4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])).unwrap_or(0);
        let state: Contract = match version {
            STATE_VERSION => borsh::from_slice(&raw).unwrap_or_else(|_| fail(HouseError::UnknownStateVersion)),
            _ => fail(HouseError::UnknownStateVersion),
        };
        let caller = env::predecessor_account_id();
        check(caller == state.config.owner || caller == env::current_account_id(), HouseError::NotOwner);
        emit("migrated", &[("state_version", STATE_VERSION.to_string())]);
        state
    }

    /// Owner only. Every number must stay inside its fixed range. The quote
    /// rule (`lead_min_bps`, `lead_full_gap_bps`) applies to the exits of
    /// open positions as well as to new orders.
    pub fn set_config(&mut self, patch: ConfigPatch) {
        self.assert_owner();
        let mut c = self.config.clone();
        let mut changed: Vec<&str> = Vec::new();
        macro_rules! apply {
            ($($f:ident),* $(,)?) => {
                $(
                    if let Some(v) = patch.$f.clone() {
                        c.$f = v;
                        changed.push(stringify!($f));
                    }
                )*
            };
        }
        apply!(
            keeper,
            treasury,
            fee_bps,
            finder_bps,
            lead_min_bps,
            lead_full_gap_bps,
            max_open_gap_bps,
            max_profit_bps,
            min_score_e2,
            cooloff_secs,
            market_cap_bps,
            utilisation_cap_bps,
            min_stake,
            max_stake,
            max_positions_per_account,
            min_fill_delay_secs,
            order_ttl_secs,
            max_quote_age_secs,
            emergency_secs,
            max_position_secs,
            lp_exit_delay_secs,
            lp_exit_window_secs,
            max_step_bps,
            liq_reward_bps,
            faucet_per_account,
            storage_floor,
            lp_open,
        );
        validate_config(&c);
        self.config = c;
        emit("config_set", &[("fields", changed.join(","))]);
    }

    /// Pauses or resumes new orders: the owner or the keeper. Nothing else
    /// stops: fills of orders already placed, closes, liquidations, the
    /// vault and withdrawals all go on.
    pub fn set_paused(&mut self, opens: bool) {
        self.assert_owner_or_keeper();
        self.config.opens_paused = opens;
        emit(
            "opens_paused",
            &[("paused", opens.to_string()), ("by", env::predecessor_account_id().to_string())],
        );
    }

    // ------------------------------------------------- money in and out

    /// Credits the caller from the faucet pool: at most `faucet_per_account`
    /// in total per account. Returns the amount credited.
    pub fn faucet(&mut self, amount: U128) -> U128 {
        let a = to_u64(amount);
        check(a > 0, HouseError::ZeroAmount);
        let caller = env::predecessor_account_id();
        let claimed = self.faucet_claimed.get(&caller).copied().unwrap_or(0);
        let total = add(claimed, a);
        check(total as u128 <= self.config.faucet_per_account.0, HouseError::FaucetCap);
        check(self.faucet_pool >= a, HouseError::FaucetEmpty);
        self.check_storage_floor();
        self.faucet_pool -= a;
        self.faucet_claimed.insert(caller.clone(), total);
        self.credit(&caller, a);
        emit(
            "faucet",
            &[("account", caller.to_string()), ("amount", a.to_string()), ("claimed", total.to_string())],
        );
        u(a)
    }

    /// NEP-141 receiver. Accepts the configured token from the treasury
    /// only: `msg == "faucet"` adds to the faucet pool, anything else credits
    /// the treasury's balance. Every other transfer is returned in full, as is
    /// one that would add a ledger entry while the contract is under its
    /// storage floor.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        if env::predecessor_account_id() != self.config.token || sender_id != self.config.treasury {
            return amount;
        }
        let Ok(a) = u64::try_from(amount.0) else {
            return amount;
        };
        if a == 0 {
            return amount;
        }
        let to_pool = msg == "faucet";
        if to_pool {
            let Some(pool) = self.faucet_pool.checked_add(a) else {
                return amount;
            };
            self.faucet_pool = pool;
        } else {
            if self.ledger_total.checked_add(a).is_none() {
                return amount;
            }
            if !self.balances.contains_key(&sender_id) && !self.above_storage_floor() {
                return amount;
            }
            self.credit(&sender_id, a);
        }
        emit(
            "deposit",
            &[
                ("account", sender_id.to_string()),
                ("amount", a.to_string()),
                ("to", if to_pool { "faucet_pool" } else { "balance" }.to_string()),
            ],
        );
        U128(0)
    }

    /// Sends `amount` of the caller's balance to the caller as USDG. The
    /// balance is debited first and re-credited if the transfer fails. The
    /// promise resolves to the amount sent (0 if it was refunded).
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let a = to_u64(amount);
        check(a > 0, HouseError::ZeroAmount);
        let caller = env::predecessor_account_id();
        self.debit(&caller, a);
        ext_usdg::ext(self.config.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(caller.clone(), amount, None)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_ON_WITHDRAW).on_withdraw(caller, amount))
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

    // ------------------------------------------------------------ markets

    /// Lists a market. Keeper only. `reference` is the ATNX market uuid as
    /// 32 lowercase hex characters; `live_since` is when it went live on
    /// atnx.app, and opens start `cooloff_secs` after it. A reference whose
    /// market is settled is listed again as a new market, and the reference
    /// then points to the new one; any other listed reference fails. Returns
    /// the id (0 for the first market).
    pub fn list_market(&mut self, reference: String, finder: Option<AccountId>, live_since: U64) -> u32 {
        self.assert_keeper();
        check(is_hex(&reference, 32), HouseError::BadReference);
        let replaces = self.market_by_reference.get(&reference).copied();
        if let Some(old) = replaces {
            let settled = self.markets.get(old).map(|m| m.status == MarketStatus::Settled).unwrap_or(false);
            check(settled, HouseError::AlreadyListed);
        }
        let live_since = live_since.0;
        let now = now_secs();
        check(live_since <= now, HouseError::LiveSinceInFuture);
        self.check_storage_floor();
        let id = self.markets.len();
        self.markets.push(Market {
            reference: reference.clone(),
            finder: finder.clone(),
            live_since,
            listed_at: now,
            status: MarketStatus::Open,
            quotes: Vec::new(),
            dropped_read_at: 0,
            final_e2: None,
            settled_at: None,
            long: Book::default(),
            short: Book::default(),
        });
        self.market_by_reference.insert(reference.clone(), id);
        emit(
            "market_listed",
            &[
                ("market", id.to_string()),
                ("reference", reference),
                ("finder", finder.map(|f| f.to_string()).unwrap_or_default()),
                ("live_since", live_since.to_string()),
                ("replaces", replaces.map(|r| r.to_string()).unwrap_or_default()),
            ],
        );
        id
    }

    /// The owner or the keeper: move a market from Open to CloseOnly (and
    /// never back), and/or name its finder, who gets the finder's part of the
    /// fee on later fills. Neither can settle a market: see `settle_stale`.
    pub fn set_market(&mut self, market: u32, status: Option<MarketStatus>, finder: Option<AccountId>) {
        self.assert_owner_or_keeper();
        let mut m = self.market_or_fail(market);
        if let Some(s) = status {
            check(s == MarketStatus::CloseOnly && m.status != MarketStatus::Settled, HouseError::BadStatus);
            m.status = MarketStatus::CloseOnly;
        }
        if let Some(f) = finder {
            m.finder = Some(f);
        }
        emit(
            "market_status",
            &[
                ("market", market.to_string()),
                ("status", m.status.as_str().to_string()),
                ("finder", m.finder.as_ref().map(|f| f.to_string()).unwrap_or_default()),
                ("by", env::predecessor_account_id().to_string()),
            ],
        );
        self.markets.set(market, m);
    }

    /// Anyone, once a market's newest quote was last read `emergency_secs`
    /// ago (or, with no quote, it was listed that long ago): the market is
    /// settled at its last score.
    /// Every position on it then closes at that one price, and pending
    /// orders are refunded. Final: a market that comes back is listed again.
    pub fn settle_stale(&mut self, market: u32) {
        let mut m = self.market_or_fail(market);
        check(m.status != MarketStatus::Settled, HouseError::AlreadySettled);
        let now = now_secs();
        let last = m.newest().map(|q| q.last_read_at).unwrap_or(m.listed_at);
        check(now >= last.saturating_add(self.config.emergency_secs.0), HouseError::NotStale);
        let final_e2 = m.newest().map(|q| q.score_e2).unwrap_or(0);
        m.status = MarketStatus::Settled;
        m.final_e2 = Some(final_e2);
        m.settled_at = Some(now);
        emit(
            "market_status",
            &[
                ("market", market.to_string()),
                ("status", m.status.as_str().to_string()),
                ("final_e2", final_e2.to_string()),
                ("by", env::predecessor_account_id().to_string()),
            ],
        );
        self.markets.set(market, m);
    }

    /// Keeper only: the 5-minute batch, or one market on demand. The contract
    /// derives both prices from the score and the reading itself.
    ///
    /// Per entry:
    /// - the stored print again (same `print_id`) must repeat the numbers as
    ///   they were pushed, and moves its `last_read_at` forward;
    /// - a new print needs a larger `print_id` and a later `print_at`, and
    ///   its score may move from the stored score at most
    ///   `max_step_bps × (print_at − stored print_at) / 300` (never less than
    ///   one hundredth); a larger move is clipped and catches up on later
    ///   prints;
    /// - `print_at` is at most `PRINT_CLOCK_SLACK_SECS` after the block time
    ///   (it is the index's clock); `read_at` is never after the block time
    ///   nor before the stored `last_read_at`.
    ///
    /// An entry that breaks a rule, names an unknown or settled market, or
    /// comes after the first `MAX_QUOTES_PER_PUSH`, is skipped and counted; it
    /// never fails the call. Returns the counts, which the `quotes_pushed`
    /// event also carries. `commitment` is the sha256 of the canonical batch
    /// of public rows.
    pub fn push_quotes(&mut self, quotes: Vec<QuoteIn>, commitment: String) -> PushResult {
        self.assert_keeper();
        check(is_hex(&commitment, 64), HouseError::BadCommitment);
        let now = now_secs();
        let step = self.config.max_step_bps as u64;
        let (mut accepted, mut skipped) = (0u32, 0u32);
        let (mut first, mut last): (Option<u64>, Option<u64>) = (None, None);
        // Markets an entry changed, written once at the end.
        let mut staged: std::collections::BTreeMap<u32, Market> = std::collections::BTreeMap::new();
        for (i, qi) in quotes.iter().enumerate() {
            let print_id = qi.print_id.0;
            first = Some(first.map_or(print_id, |f| f.min(print_id)));
            last = Some(last.map_or(print_id, |l| l.max(print_id)));
            if i >= MAX_QUOTES_PER_PUSH {
                skipped += 1;
                continue;
            }
            let mut m = match staged.remove(&qi.market) {
                Some(m) => m,
                None => match self.markets.get(qi.market) {
                    Some(m) => m.clone(),
                    None => {
                        skipped += 1;
                        continue;
                    }
                },
            };
            if apply_quote(&mut m, qi, now, step) {
                accepted += 1;
            } else {
                skipped += 1;
            }
            staged.insert(qi.market, m);
        }
        for (id, m) in staged {
            self.markets.set(id, m);
        }
        let id_str = |v: Option<u64>| v.map(|v| v.to_string()).unwrap_or_default();
        emit(
            "quotes_pushed",
            &[
                ("count", quotes.len().to_string()),
                ("accepted", accepted.to_string()),
                ("skipped", skipped.to_string()),
                ("first_print_id", id_str(first)),
                ("last_print_id", id_str(last)),
                ("commitment", commitment),
            ],
        );
        PushResult { count: quotes.len() as u32, accepted, skipped }
    }

    // ------------------------------------------------------------ trading

    /// Places an order for a position: `stake` at `leverage` (1, 2 or 3) on
    /// `side`, filling no worse than `limit_e2` (long: the highest entry
    /// accepted; short: the lowest). Debits stake + fee into the vault's
    /// margin; the order fills at the first quote read after it (see
    /// `crank`), where the reserve and the caps are taken. Returns the
    /// position id. Nothing is debited when any check fails.
    pub fn open(&mut self, market: u32, side: Side, leverage: u8, stake: U128, limit_e2: U64) -> U64 {
        let account = env::predecessor_account_id();
        let now = now_secs();
        let stake = to_u64(stake);
        check(limit_e2.0 > 0, HouseError::LimitRequired);
        let m = self.market_or_fail(market);
        if let Err(e) = self.open_checks(Some(&account), &m, side, leverage, stake, now) {
            fail(e)
        }
        let fee = fee_of(stake, self.config.fee_bps as u64);
        let total = add(stake, fee);
        self.debit(&account, total);
        self.vault.margin = add(self.vault.margin, total);
        let id = self.next_position_id;
        self.next_position_id = add(id, 1);
        let p = Position {
            account: account.clone(),
            market,
            side,
            leverage,
            stake,
            fee,
            reserved: 0,
            state: PositionState::Pending,
            placed_at: now,
            limit_e2: limit_e2.0,
            entry_e2: 0,
            opened_at: 0,
            expires_at: 0,
            fill_print_id: 0,
            close_requested_at: 0,
            close_limit_e2: 0,
        };
        self.insert_position(id, p);
        emit(
            "order_placed",
            &[
                ("id", id.to_string()),
                ("account", account.to_string()),
                ("market", market.to_string()),
                ("side", side.as_str().to_string()),
                ("leverage", leverage.to_string()),
                ("stake", stake.to_string()),
                ("fee", fee.to_string()),
                ("limit_e2", limit_e2.0.to_string()),
                ("placed_at", now.to_string()),
            ],
        );
        U64(id)
    }

    /// Asks to close an open position, no worse than `limit_e2` (long: the
    /// lowest exit accepted; short: the highest). It settles at the first
    /// quote read after the request; past the limit, the position goes back
    /// to Open and the trader asks again. A close can't be withdrawn.
    pub fn close(&mut self, position_id: U64, limit_e2: U64) {
        let caller = env::predecessor_account_id();
        let id = position_id.0;
        let mut p = self.position_or_fail(id);
        check(p.account == caller, HouseError::NotYours);
        check(p.state == PositionState::Open, HouseError::NotOpen);
        check(limit_e2.0 > 0, HouseError::LimitRequired);
        let now = now_secs();
        check(now < p.expires_at, HouseError::PositionExpired);
        p.state = PositionState::Closing;
        p.close_requested_at = now;
        p.close_limit_e2 = limit_e2.0;
        emit(
            "close_requested",
            &[
                ("id", id.to_string()),
                ("account", caller.to_string()),
                ("limit_e2", limit_e2.0.to_string()),
                ("requested_at", now.to_string()),
                ("by", "trader".to_string()),
            ],
        );
        self.positions.insert(id, p);
    }

    /// Refunds a pending order in full, once `order_ttl_secs` have passed
    /// with no quote to fill at. An order with a quote to fill at fills or
    /// is refunded by `crank` instead.
    pub fn cancel(&mut self, position_id: U64) {
        let caller = env::predecessor_account_id();
        let id = position_id.0;
        let p = self.position_or_fail(id);
        check(p.account == caller, HouseError::NotYours);
        check(p.state == PositionState::Pending, HouseError::NotPending);
        let now = now_secs();
        check(now >= p.placed_at.saturating_add(self.config.order_ttl_secs.0), HouseError::CancelTooEarly);
        let m = self.market_or_fail(p.market);
        check(!matches!(self.fill_due(&m, &p, now), FillDue::At(_)), HouseError::HasQuote);
        self.refund(id, p, Refund::Cancelled);
    }

    /// Anyone. For each id, does the one thing that is due and returns what
    /// it did; an id that is unknown or has nothing due is skipped, so one
    /// bad id never fails the batch. The first `MAX_CRANK_IDS` ids are
    /// processed and any beyond are returned as "ignored".
    ///
    /// A pending order: on a market that is no longer open, refunded. Else at
    /// the earliest quote read at least `min_fill_delay_secs` after it (and
    /// within `order_ttl_secs`): refunded if the price is zero or past the
    /// limit, the two prices are too far apart or the score is under the
    /// minimum, refunded as "market full" if the reserve would break a cap,
    /// filled otherwise. Refunded if that quote has left the ring or no
    /// quote came within the time to live.
    ///
    /// An open or closing position, in this order:
    /// 1. a close (or, past `expires_at`, the end-of-life close, which has
    ///    no limit) settles at the earliest quote read at least
    ///    `min_fill_delay_secs` after the request (the oldest quote in the
    ///    ring if that one has left it); past the limit or at zero, a close
    ///    goes back to Open; the end-of-life close skips prints at zero or
    ///    with the two prices more than `max_open_gap_bps` apart, and waits
    ///    (still open to liquidation and the cap) for one that is neither;
    /// 2. on a settled market, it closes at the final price;
    /// 3. at the newest quote, liquidated if at the liquidation level, the
    ///    caller taking `liq_reward_bps` of the stake;
    /// 4. at the newest quote, closed at the cap if its PnL has reached the
    ///    maximum profit;
    /// 5. past `expires_at`, it becomes Closing as of that moment.
    pub fn crank(&mut self, position_ids: Vec<U64>) -> Vec<String> {
        let caller = env::predecessor_account_id();
        let now = now_secs();
        position_ids
            .iter()
            .enumerate()
            .map(|(i, id)| if i < MAX_CRANK_IDS { self.crank_one(id.0, &caller, now) } else { "ignored" }.to_string())
            .collect()
    }

    // -------------------------------------------------------------- vault

    /// Moves `amount` of the caller's balance into the vault and mints
    /// shares at the current share price. Only the treasury, unless
    /// `lp_open`. Returns the shares minted.
    pub fn lp_deposit(&mut self, amount: U128) -> U128 {
        let caller = env::predecessor_account_id();
        check(self.config.lp_open || caller == self.config.treasury, HouseError::LpClosed);
        let a = to_u64(amount);
        check(a > 0, HouseError::ZeroAmount);
        let minted = to_shares(a, self.vault.assets, self.vault.shares);
        check(minted > 0, HouseError::ZeroShares);
        let held = self.lp_shares.get(&caller).copied().unwrap_or(0);
        let held_after = held.checked_add(minted).unwrap_or_else(|| fail(HouseError::Overflow));
        let shares_after = self.vault.shares.checked_add(minted).unwrap_or_else(|| fail(HouseError::Overflow));
        self.check_storage_floor();
        self.debit(&caller, a);
        self.vault.assets = add(self.vault.assets, a);
        self.vault.shares = shares_after;
        self.lp_shares.insert(caller.clone(), held_after);
        emit(
            "lp_deposit",
            &[("account", caller.to_string()), ("amount", a.to_string()), ("shares", minted.to_string())],
        );
        U128(minted)
    }

    /// Gives notice to withdraw `shares`: from `lp_exit_delay_secs` later,
    /// for `lp_exit_window_secs`, `lp_withdraw` redeems them. One request per
    /// account at a time; a lapsed request is replaced.
    pub fn lp_request_withdraw(&mut self, shares: U128) {
        let caller = env::predecessor_account_id();
        let s = shares.0;
        check(s > 0, HouseError::ZeroAmount);
        let held = self.lp_shares.get(&caller).copied().unwrap_or(0);
        check(s <= held, HouseError::NoShares);
        let now = now_secs();
        if let Some(r) = self.lp_requests.get(&caller) {
            check(now > r.ready_at.saturating_add(self.config.lp_exit_window_secs.0), HouseError::RequestPending);
        }
        let ready_at = now.saturating_add(self.config.lp_exit_delay_secs.0);
        self.lp_requests.insert(caller.clone(), LpRequest { shares: s, ready_at });
        emit(
            "lp_withdraw_requested",
            &[
                ("account", caller.to_string()),
                ("shares", s.to_string()),
                ("ready_at", ready_at.to_string()),
                ("closes_at", ready_at.saturating_add(self.config.lp_exit_window_secs.0).to_string()),
            ],
        );
    }

    /// Inside the request's window: burns its shares at the share price of
    /// this moment and credits their value to the caller's balance. Fails if
    /// the value is more than the vault's unreserved assets. After the
    /// window the request lapses: it is removed and 0 is returned.
    pub fn lp_withdraw(&mut self) -> U128 {
        let caller = env::predecessor_account_id();
        let r = self.lp_requests.get(&caller).cloned().unwrap_or_else(|| fail(HouseError::NoRequest));
        let now = now_secs();
        check(now >= r.ready_at, HouseError::RequestNotReady);
        if now > r.ready_at.saturating_add(self.config.lp_exit_window_secs.0) {
            self.lp_requests.remove(&caller);
            emit("lp_withdraw_lapsed", &[("account", caller.to_string()), ("shares", r.shares.to_string())]);
            return U128(0);
        }
        let held = self.lp_shares.get(&caller).copied().unwrap_or(0);
        check(r.shares <= held, HouseError::NoShares);
        let value = to_assets(r.shares, self.vault.assets, self.vault.shares);
        check(value <= self.vault.assets - self.vault.reserved, HouseError::NotEnoughFree);
        self.vault.assets -= value;
        self.vault.shares -= r.shares;
        if held == r.shares {
            self.lp_shares.remove(&caller);
        } else {
            self.lp_shares.insert(caller.clone(), held - r.shares);
        }
        self.lp_requests.remove(&caller);
        self.credit(&caller, value);
        emit(
            "lp_withdraw",
            &[("account", caller.to_string()), ("shares", r.shares.to_string()), ("amount", value.to_string())],
        );
        u(value)
    }

    // -------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_vault(&self) -> VaultView {
        let v = &self.vault;
        VaultView {
            assets: u(v.assets),
            reserved: u(v.reserved),
            free: u(v.assets - v.reserved),
            margin: u(v.margin),
            shares: U128(v.shares),
            dead_shares: U128(DEAD_SHARES),
            share_price: u(to_assets(SHARE, v.assets, v.shares)),
            ledger_total: u(self.ledger_total),
            faucet_pool: u(self.faucet_pool),
            lp_open: self.config.lp_open,
        }
    }

    /// NEP-621-style: the vault's realised assets.
    pub fn total_assets(&self) -> U128 {
        u(self.vault.assets)
    }

    /// NEP-621-style: shares `lp_deposit` would mint for `assets` now.
    pub fn convert_to_shares(&self, assets: U128) -> U128 {
        U128(to_shares(to_u64(assets), self.vault.assets, self.vault.shares))
    }

    /// NEP-621-style: what `shares` are worth now.
    pub fn convert_to_assets(&self, shares: U128) -> U128 {
        u(to_assets(shares.0, self.vault.assets, self.vault.shares))
    }

    /// NEP-621-style: what `lp_withdraw` would pay `owner_id` now (0 outside
    /// a request's window, or when its value is more than the unreserved
    /// assets).
    pub fn max_withdraw(&self, owner_id: AccountId) -> U128 {
        let Some(r) = self.lp_requests.get(&owner_id) else {
            return U128(0);
        };
        let now = now_secs();
        if now < r.ready_at || now > r.ready_at.saturating_add(self.config.lp_exit_window_secs.0) {
            return U128(0);
        }
        let value = to_assets(r.shares, self.vault.assets, self.vault.shares);
        if value > self.vault.assets - self.vault.reserved {
            return U128(0);
        }
        u(value)
    }

    pub fn get_market(&self, market: u32) -> Option<MarketView> {
        self.markets.get(market).map(|m| self.market_view(market, m))
    }

    pub fn get_market_by_reference(&self, reference: String) -> Option<MarketView> {
        self.market_by_reference.get(&reference).and_then(|id| self.get_market(*id))
    }

    /// Markets in id order from offset `from` (0 = the first market);
    /// `limit` defaults to 50, at most 100.
    pub fn list_markets(&self, from: Option<u32>, limit: Option<u32>) -> Vec<MarketView> {
        let from = from.unwrap_or(0);
        let limit = limit.unwrap_or(LIST_LIMIT_DEFAULT).min(LIST_LIMIT_MAX);
        (from..self.markets.len()).take(limit as usize).filter_map(|id| self.get_market(id)).collect()
    }

    pub fn get_position(&self, id: U64) -> Option<PositionView> {
        self.positions.get(&id.0).map(|p| self.position_view(id.0, p))
    }

    /// An account's pending, open and closing positions.
    pub fn positions_of(&self, account: AccountId) -> Vec<PositionView> {
        let Some(set) = self.account_positions.get(&account) else {
            return Vec::new();
        };
        set.iter().filter_map(|id| self.positions.get(id).map(|p| self.position_view(*id, p))).collect()
    }

    /// An account's last `HISTORY_LEN` closed positions, newest first.
    pub fn history_of(&self, account: AccountId) -> Vec<ClosedView> {
        let Some(h) = self.history.get(&account) else {
            return Vec::new();
        };
        h.iter().rev().map(closed_view).collect()
    }

    /// Every pending, open and closing position, from offset `from`; `limit`
    /// defaults to 50, at most 100. The set reorders as positions end, so a
    /// keeper pages it twice.
    pub fn list_active(&self, from: Option<u32>, limit: Option<u32>) -> Vec<PositionView> {
        let from = from.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(LIST_LIMIT_DEFAULT).min(LIST_LIMIT_MAX) as usize;
        self.active
            .iter()
            .skip(from)
            .take(limit)
            .filter_map(|id| self.positions.get(id).map(|p| self.position_view(*id, p)))
            .collect()
    }

    /// How many positions are active.
    pub fn active_count(&self) -> u32 {
        self.active.len()
    }

    pub fn balance_of(&self, account: AccountId) -> U128 {
        u(self.balances.get(&account).copied().unwrap_or(0))
    }

    /// How much of the faucet an account has claimed.
    pub fn faucet_claimed(&self, account: AccountId) -> U128 {
        u(self.faucet_claimed.get(&account).copied().unwrap_or(0))
    }

    /// An account's vault shares, their value now, and its pending request.
    pub fn lp_of(&self, account: AccountId) -> LpView {
        let shares = self.lp_shares.get(&account).copied().unwrap_or(0);
        let now = now_secs();
        let request = self.lp_requests.get(&account).map(|r| {
            let closes_at = r.ready_at.saturating_add(self.config.lp_exit_window_secs.0);
            let state = if now < r.ready_at {
                "waiting"
            } else if now <= closes_at {
                "ready"
            } else {
                "lapsed"
            };
            LpRequestView {
                shares: U128(r.shares),
                value: u(to_assets(r.shares, self.vault.assets, self.vault.shares)),
                ready_at: U64(r.ready_at),
                closes_at: U64(closes_at),
                state: state.to_string(),
            }
        });
        LpView { shares: U128(shares), value: u(to_assets(shares, self.vault.assets, self.vault.shares)), request }
    }

    /// What `open` would do with these terms now, with the same checks and
    /// arithmetic: both prices, the entry, the fee, the levels, the maximum
    /// profit, the value on fill at the newest quote, and either `allowed` or
    /// the reason `open` would fail. It never panics. With `account_id`, the account's
    /// position limit and balance are checked too. `would_fill` runs the
    /// fill-time checks (the caps included, the limit aside) at the newest
    /// quote.
    pub fn quote_open(
        &self,
        market: u32,
        side: Side,
        leverage: u8,
        stake: U128,
        account: Option<AccountId>,
    ) -> OpenQuote {
        let now = now_secs();
        let stake = u64::try_from(stake.0).unwrap_or(u64::MAX);
        let m = self.markets.get(market);
        let verdict = match m {
            Some(m) => self.open_checks(account.as_ref(), m, side, leverage, stake, now),
            None => Err(HouseError::NoMarket),
        };
        let q = m.and_then(|m| m.newest());
        let px = q.map(|q| self.prices_of(q)).unwrap_or(Prices { score: 0, lead: 0, buy: 0, sell: 0 });
        let has_finder = m.map(|m| m.finder.is_some()).unwrap_or(false);
        let fee = fee_of(stake, self.config.fee_bps as u64);
        let (finder_fee, _) = split_fee(fee, self.config.finder_bps as u64, has_finder);
        let entry = px.open(side);
        let lev_ok = leverage_ok(leverage);
        let mp = if lev_ok { max_profit(side, leverage, stake, self.config.max_profit_bps as u64) } else { 0 };
        let (liq, cap, value) = if lev_ok && entry > 0 {
            (
                liquidation_e2(side, leverage, entry),
                cap_e2(side, leverage, stake, entry, mp),
                payout(stake, pnl(side, leverage, stake, entry, px.close(side)), mp),
            )
        } else {
            (0, 0, 0)
        };
        // The refund reason a fill at the newest quote would meet, if any.
        let fill: Result<(), &str> = match (m, q) {
            (Some(m), Some(q)) if lev_ok => {
                self.fill_terms(m, q, side, leverage, stake, None).map(|_| ()).map_err(|r| r.as_str())
            }
            (Some(_), Some(_)) => Err("leverage"),
            _ => Err("no_quote"),
        };
        OpenQuote {
            allowed: verdict.is_ok(),
            reason: verdict.err().map(|e| e.msg().to_string()),
            score_e2: U64(px.score),
            reading_e2: U64(q.map(|q| q.reading_e2).unwrap_or(0)),
            lead_e2: U64(px.lead),
            buy_e2: U64(px.buy),
            sell_e2: U64(px.sell),
            spread_bps: U64(spread_bps(&px)),
            print_id: U64(q.map(|q| q.print_id).unwrap_or(0)),
            print_at: U64(q.map(|q| q.print_at).unwrap_or(0)),
            entry_e2: U64(entry),
            fee: u(fee),
            finder_fee: u(finder_fee),
            cost: U128(stake as u128 + fee as u128),
            max_profit: u(mp),
            liquidation_e2: U64(liq),
            cap_e2: U64(cap),
            value_on_fill: u(value),
            would_fill: fill.is_ok(),
            fill_reason: fill.err().map(|r| r.to_string()),
        }
    }
}

// ------------------------------------------------------------- internals

fn closed_view(c: &Closed) -> ClosedView {
    ClosedView {
        id: U64(c.id),
        market: c.market,
        side: c.side,
        leverage: c.leverage,
        stake: u(c.stake),
        entry_e2: U64(c.entry_e2),
        exit_e2: U64(c.exit_e2),
        payout: u(c.payout),
        reason: c.reason.clone(),
        opened_at: U64(c.opened_at),
        closed_at: U64(c.closed_at),
    }
}

fn book_view(b: &Book) -> BookView {
    BookView { stake: u(b.stake), notional: u(b.notional), reserved: u(b.reserved), count: b.count }
}

impl Contract {
    fn assert_owner(&self) {
        check(env::predecessor_account_id() == self.config.owner, HouseError::NotOwner);
    }

    fn assert_keeper(&self) {
        check(env::predecessor_account_id() == self.config.keeper, HouseError::NotKeeper);
    }

    fn assert_owner_or_keeper(&self) {
        let c = env::predecessor_account_id();
        check(c == self.config.owner || c == self.config.keeper, HouseError::NotOwnerOrKeeper);
    }

    /// The contract's NEAR balance minus what its storage locks.
    fn free_near(&self) -> u128 {
        let locked = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        env::account_balance().as_yoctonear().saturating_sub(locked)
    }

    fn above_storage_floor(&self) -> bool {
        self.free_near() >= self.config.storage_floor.0
    }

    fn check_storage_floor(&self) {
        check(self.above_storage_floor(), HouseError::StorageFloor);
    }

    fn market_or_fail(&self, id: u32) -> Market {
        self.markets.get(id).cloned().unwrap_or_else(|| fail(HouseError::NoMarket))
    }

    fn position_or_fail(&self, id: u64) -> Position {
        self.positions.get(&id).cloned().unwrap_or_else(|| fail(HouseError::NoPosition))
    }

    fn prices_of(&self, q: &Quote) -> Prices {
        prices(q.score_e2, q.reading_e2, self.config.lead_min_bps as u64, self.config.lead_full_gap_bps as u64)
    }

    #[allow(clippy::too_many_arguments)]
    fn push_ring(m: &mut Market, score: u64, pushed: u64, reading: u64, print_id: u64, print_at: u64, read_at: u64) {
        if m.quotes.len() >= RING {
            let dropped = m.quotes.remove(0);
            m.dropped_read_at = dropped.last_read_at;
        }
        m.quotes.push(Quote {
            score_e2: score,
            pushed_score_e2: pushed,
            reading_e2: reading,
            print_id,
            print_at,
            first_read_at: read_at,
            last_read_at: read_at,
        });
    }

    /// The checks `open` makes, in order, shared with `quote_open` and the
    /// market view. With `account`, its position count and balance as well.
    fn open_checks(
        &self,
        account: Option<&AccountId>,
        m: &Market,
        side: Side,
        leverage: u8,
        stake: u64,
        now: u64,
    ) -> Result<(), HouseError> {
        let c = &self.config;
        let ok = |cond: bool, e: HouseError| if cond { Ok(()) } else { Err(e) };
        ok(leverage_ok(leverage), HouseError::BadLeverage)?;
        ok(stake as u128 >= c.min_stake.0, HouseError::StakeTooSmall)?;
        ok(stake as u128 <= c.max_stake.0, HouseError::StakeTooLarge)?;
        ok(!c.opens_paused, HouseError::OpensPaused)?;
        ok(m.status == MarketStatus::Open, HouseError::MarketNotOpen)?;
        ok(now >= m.live_since.saturating_add(c.cooloff_secs.0), HouseError::CoolOff)?;
        let q = m.newest().ok_or(HouseError::NoQuote)?;
        ok(now <= q.last_read_at.saturating_add(c.max_quote_age_secs.0), HouseError::StaleQuote)?;
        ok(q.score_e2 >= c.min_score_e2.0, HouseError::ScoreTooLow)?;
        let px = self.prices_of(q);
        ok(spread_bps(&px) <= c.max_open_gap_bps as u64, HouseError::SpreadTooWide)?;
        ok(px.open(side) > 0, HouseError::ZeroPrice)?;
        if let Some(a) = account {
            let count = self.account_positions.get(a).map(|s| s.len()).unwrap_or(0);
            ok(count < c.max_positions_per_account, HouseError::TooManyPositions)?;
        }
        ok(self.above_storage_floor(), HouseError::StorageFloor)?;
        if let Some(a) = account {
            let need = stake as u128 + fee_of(stake, c.fee_bps as u64) as u128;
            let have = self.balances.get(a).copied().unwrap_or(0) as u128;
            ok(have >= need, HouseError::InsufficientBalance)?;
        }
        Ok(())
    }

    /// The checks a fill makes at its quote, shared with `quote_open`:
    /// the market still open, a non-zero price inside the limit, the two
    /// prices close enough, the score at the minimum, then the caps.
    fn fill_terms(
        &self,
        m: &Market,
        q: &Quote,
        side: Side,
        leverage: u8,
        stake: u64,
        limit: Option<u64>,
    ) -> Result<Fill, Refund> {
        let c = &self.config;
        if m.status != MarketStatus::Open {
            return Err(Refund::MarketClosed);
        }
        let px = self.prices_of(q);
        let entry = px.open(side);
        if entry == 0 {
            return Err(Refund::ZeroPrice);
        }
        if let Some(l) = limit {
            let past = match side {
                Side::Long => entry > l,
                Side::Short => entry < l,
            };
            if past {
                return Err(Refund::Limit);
            }
        }
        if spread_bps(&px) > c.max_open_gap_bps as u64 {
            return Err(Refund::Spread);
        }
        if q.score_e2 < c.min_score_e2.0 {
            return Err(Refund::Score);
        }
        let reserved = max_profit(side, leverage, stake, c.max_profit_bps as u64);
        let assets = self.vault.assets as u128;
        let side_cap = assets * c.market_cap_bps as u128 / BPS as u128;
        let total_cap = assets * c.utilisation_cap_bps as u128 / BPS as u128;
        if m.book(side).reserved as u128 + reserved as u128 > side_cap
            || self.vault.reserved as u128 + reserved as u128 > total_cap
        {
            return Err(Refund::MarketFull);
        }
        Ok(Fill { entry, reserved })
    }

    /// The quote a pending order is due to fill at, if any. The first quote
    /// read after the order counts only if it was read within the order's
    /// time to live, so a quote that arrives later refunds the order however
    /// late anyone cranks it.
    fn fill_due(&self, m: &Market, p: &Position, now: u64) -> FillDue {
        let from = p.placed_at.saturating_add(self.config.min_fill_delay_secs.0);
        let deadline = p.placed_at.saturating_add(self.config.order_ttl_secs.0);
        match find_quote(m, from) {
            Lookup::Found(i) => {
                if m.quotes[i].first_read_at.max(from) <= deadline {
                    FillDue::At(i)
                } else {
                    FillDue::Expired
                }
            }
            Lookup::RolledOut => FillDue::RolledOut,
            Lookup::NotYet if now >= deadline => FillDue::Expired,
            Lookup::NotYet => FillDue::Waiting,
        }
    }

    /// The quote a close requested at `at` is due to settle at. `limit` 0 is
    /// the end-of-life close: it has no limit, so it skips every print whose
    /// close-side price is 0 or whose two prices are more than
    /// `max_open_gap_bps` apart, and waits for the first that is neither.
    fn close_due(&self, m: &Market, side: Side, at: u64, limit: u64) -> CloseDue {
        let from = at.saturating_add(self.config.min_fill_delay_secs.0);
        let start = match find_quote(m, from) {
            Lookup::Found(i) => i,
            Lookup::RolledOut => 0,
            Lookup::NotYet => return CloseDue::Waiting,
        };
        if limit == 0 {
            let narrow = |j: &usize| {
                let px = self.prices_of(&m.quotes[*j]);
                px.close(side) > 0 && spread_bps(&px) <= self.config.max_open_gap_bps as u64
            };
            return match (start..m.quotes.len()).find(narrow) {
                Some(j) => CloseDue::At(j),
                None => CloseDue::Waiting,
            };
        }
        let price = self.prices_of(&m.quotes[start]).close(side);
        let past = match side {
            Side::Long => price < limit,
            Side::Short => price > limit,
        };
        if price == 0 || past {
            CloseDue::Missed(start)
        } else {
            CloseDue::At(start)
        }
    }

    fn crank_one(&mut self, id: u64, caller: &AccountId, now: u64) -> &'static str {
        let Some(p) = self.positions.get(&id).cloned() else {
            return "unknown";
        };
        let Some(mut m) = self.markets.get(p.market).cloned() else {
            return "unknown";
        };
        let market = p.market;
        let action = match p.state {
            PositionState::Pending => self.crank_pending(id, p, &mut m, now),
            PositionState::Open | PositionState::Closing => self.crank_live(id, p, &mut m, caller, now),
        };
        if action != "waiting" {
            self.markets.set(market, m);
        }
        action
    }

    fn crank_pending(&mut self, id: u64, p: Position, m: &mut Market, now: u64) -> &'static str {
        if m.status != MarketStatus::Open {
            self.refund(id, p, Refund::MarketClosed);
            return "refunded";
        }
        match self.fill_due(m, &p, now) {
            FillDue::At(i) => {
                let q = m.quotes[i].clone();
                match self.fill_terms(m, &q, p.side, p.leverage, p.stake, Some(p.limit_e2)) {
                    Ok(f) => {
                        self.fill(id, p, m, &q, f);
                        "filled"
                    }
                    Err(r) => {
                        self.refund(id, p, r);
                        "refunded"
                    }
                }
            }
            FillDue::RolledOut => {
                self.refund(id, p, Refund::RolledOut);
                "refunded"
            }
            FillDue::Expired => {
                self.refund(id, p, Refund::Expired);
                "refunded"
            }
            FillDue::Waiting => "waiting",
        }
    }

    fn crank_live(&mut self, id: u64, mut p: Position, m: &mut Market, caller: &AccountId, now: u64) -> &'static str {
        // 1. A requested close, or the expiry close, at its own quote.
        let request = match p.state {
            PositionState::Closing => Some((p.close_requested_at, p.close_limit_e2)),
            _ if now >= p.expires_at => Some((p.expires_at, 0)),
            _ => None,
        };
        if let Some((at, limit)) = request {
            match self.close_due(m, p.side, at, limit) {
                CloseDue::At(i) => {
                    let q = m.quotes[i].clone();
                    let exit = self.prices_of(&q).close(p.side);
                    let reason = if limit == 0 { "expiry" } else { "close" };
                    self.settle(id, p, m, exit, Some(q.print_id), reason, now);
                    return "closed";
                }
                CloseDue::Missed(i) => {
                    let q = &m.quotes[i];
                    let price = self.prices_of(q).close(p.side);
                    let reason = if price == 0 { "zero_price" } else { "limit" };
                    emit(
                        "close_missed",
                        &[
                            ("id", id.to_string()),
                            ("account", p.account.to_string()),
                            ("print_id", q.print_id.to_string()),
                            ("price_e2", price.to_string()),
                            ("limit_e2", p.close_limit_e2.to_string()),
                            ("reason", reason.to_string()),
                        ],
                    );
                    p.state = PositionState::Open;
                    p.close_requested_at = 0;
                    p.close_limit_e2 = 0;
                    self.positions.insert(id, p);
                    return "close_missed";
                }
                CloseDue::Waiting => {}
            }
        }
        // 2. A settled market closes everything at its final price.
        if m.status == MarketStatus::Settled {
            let exit = m.final_e2.unwrap_or(0);
            self.settle(id, p, m, exit, None, "settled", now);
            return "closed";
        }
        let Some(q) = m.newest().cloned() else {
            return "waiting";
        };
        let px = self.prices_of(&q);
        // 3. Liquidation: both prices at or past the level.
        if liquidatable(p.side, p.leverage, p.entry_e2, &px) {
            self.liquidate(id, p, m, &q, caller, now);
            return "liquidated";
        }
        // 4. The profit cap at the close-side price.
        if capped(p.side, p.leverage, p.stake, p.entry_e2, p.reserved, &px) {
            let exit = px.close(p.side);
            self.settle(id, p, m, exit, Some(q.print_id), "cap", now);
            return "closed";
        }
        // 5. The end of its life: Closing as of `expires_at`, settled by 1.
        if p.state == PositionState::Open && now >= p.expires_at {
            p.state = PositionState::Closing;
            p.close_requested_at = p.expires_at;
            p.close_limit_e2 = 0;
            emit(
                "close_requested",
                &[
                    ("id", id.to_string()),
                    ("account", p.account.to_string()),
                    ("limit_e2", "0".to_string()),
                    ("requested_at", p.expires_at.to_string()),
                    ("by", "expiry".to_string()),
                ],
            );
            self.positions.insert(id, p);
            return "closing";
        }
        "waiting"
    }

    /// Fills a pending order at quote `q`: the fee leaves the margin for the
    /// finder and the treasury, the maximum profit is reserved.
    fn fill(&mut self, id: u64, mut p: Position, m: &mut Market, q: &Quote, f: Fill) {
        let c = &self.config;
        let (finder_fee, treasury_fee) = split_fee(p.fee, c.finder_bps as u64, m.finder.is_some());
        let opened_at = q.first_read_at.max(p.placed_at.saturating_add(c.min_fill_delay_secs.0));
        let expires_at = opened_at.saturating_add(c.max_position_secs.0);
        let treasury = c.treasury.clone();
        self.vault.margin = sub(self.vault.margin, p.fee);
        if let Some(finder) = m.finder.clone() {
            self.credit(&finder, finder_fee);
        }
        self.credit(&treasury, treasury_fee);
        self.vault.reserved = add(self.vault.reserved, f.reserved);
        let notional = p.stake.saturating_mul(p.leverage as u64);
        let b = m.book_mut(p.side);
        b.stake = add(b.stake, p.stake);
        b.notional = add(b.notional, notional);
        b.reserved = add(b.reserved, f.reserved);
        b.count += 1;
        p.state = PositionState::Open;
        p.entry_e2 = f.entry;
        p.reserved = f.reserved;
        p.opened_at = opened_at;
        p.expires_at = expires_at;
        p.fill_print_id = q.print_id;
        emit(
            "order_filled",
            &[
                ("id", id.to_string()),
                ("account", p.account.to_string()),
                ("market", p.market.to_string()),
                ("side", p.side.as_str().to_string()),
                ("leverage", p.leverage.to_string()),
                ("stake", p.stake.to_string()),
                ("fee", p.fee.to_string()),
                ("finder_fee", finder_fee.to_string()),
                ("entry_e2", f.entry.to_string()),
                ("max_profit", f.reserved.to_string()),
                ("print_id", q.print_id.to_string()),
                ("opened_at", opened_at.to_string()),
            ],
        );
        self.positions.insert(id, p);
    }

    /// Returns a pending order's stake and fee in full.
    fn refund(&mut self, id: u64, p: Position, reason: Refund) {
        let amount = add(p.stake, p.fee);
        self.vault.margin = sub(self.vault.margin, amount);
        self.credit(&p.account, amount);
        emit(
            "order_refunded",
            &[
                ("id", id.to_string()),
                ("account", p.account.to_string()),
                ("market", p.market.to_string()),
                ("amount", amount.to_string()),
                ("reason", reason.as_str().to_string()),
            ],
        );
        self.remove_position(id, &p.account);
    }

    /// Closes an open position at `exit_e2`: pays stake + PnL, floored at 0
    /// and capped at the reserve. The vault takes a loss into its assets or
    /// pays a win out of them (never more than this position's own reserve),
    /// and the reserve is released.
    #[allow(clippy::too_many_arguments)]
    fn settle(
        &mut self,
        id: u64,
        p: Position,
        m: &mut Market,
        exit_e2: u64,
        print_id: Option<u64>,
        reason: &'static str,
        now: u64,
    ) {
        let raw = pnl(p.side, p.leverage, p.stake, p.entry_e2, exit_e2);
        let paid = payout(p.stake, raw, p.reserved);
        self.vault.margin = sub(self.vault.margin, p.stake);
        self.vault.reserved = sub(self.vault.reserved, p.reserved);
        if paid >= p.stake {
            self.vault.assets = sub(self.vault.assets, paid - p.stake);
        } else {
            self.vault.assets = add(self.vault.assets, p.stake - paid);
        }
        self.release_book(m, &p);
        self.credit(&p.account, paid);
        emit(
            "position_closed",
            &[
                ("id", id.to_string()),
                ("account", p.account.to_string()),
                ("market", p.market.to_string()),
                ("side", p.side.as_str().to_string()),
                ("leverage", p.leverage.to_string()),
                ("stake", p.stake.to_string()),
                ("entry_e2", p.entry_e2.to_string()),
                ("exit_e2", exit_e2.to_string()),
                ("payout", paid.to_string()),
                ("pnl", (paid as i128 - p.stake as i128).to_string()),
                ("reason", reason.to_string()),
                ("print_id", print_id.map(|i| i.to_string()).unwrap_or_default()),
            ],
        );
        self.record(&p, id, exit_e2, paid, reason, now);
        self.remove_position(id, &p.account);
    }

    /// Liquidates an open position at quote `q`: the stake goes to the vault,
    /// less `liq_reward_bps` of it to the caller; the reserve is released.
    fn liquidate(&mut self, id: u64, p: Position, m: &mut Market, q: &Quote, caller: &AccountId, now: u64) {
        let reward = sat_mul_bps(p.stake, self.config.liq_reward_bps as u64);
        let exit = self.prices_of(q).close(p.side);
        self.vault.margin = sub(self.vault.margin, p.stake);
        self.vault.reserved = sub(self.vault.reserved, p.reserved);
        self.vault.assets = add(self.vault.assets, p.stake - reward);
        self.release_book(m, &p);
        self.credit(caller, reward);
        emit(
            "position_closed",
            &[
                ("id", id.to_string()),
                ("account", p.account.to_string()),
                ("market", p.market.to_string()),
                ("side", p.side.as_str().to_string()),
                ("leverage", p.leverage.to_string()),
                ("stake", p.stake.to_string()),
                ("entry_e2", p.entry_e2.to_string()),
                ("exit_e2", exit.to_string()),
                ("payout", "0".to_string()),
                ("pnl", (-(p.stake as i128)).to_string()),
                ("reason", "liquidation".to_string()),
                ("print_id", q.print_id.to_string()),
                ("reward", reward.to_string()),
                ("caller", caller.to_string()),
            ],
        );
        self.record(&p, id, exit, 0, "liquidation", now);
        self.remove_position(id, &p.account);
    }

    fn release_book(&mut self, m: &mut Market, p: &Position) {
        let b = m.book_mut(p.side);
        b.stake = sub(b.stake, p.stake);
        b.notional = sub(b.notional, p.stake.saturating_mul(p.leverage as u64));
        b.reserved = sub(b.reserved, p.reserved);
        b.count = b.count.checked_sub(1).unwrap_or_else(|| fail(HouseError::Overflow));
    }

    fn record(&mut self, p: &Position, id: u64, exit_e2: u64, payout: u64, reason: &str, now: u64) {
        let c = Closed {
            id,
            market: p.market,
            side: p.side,
            leverage: p.leverage,
            stake: p.stake,
            entry_e2: p.entry_e2,
            exit_e2,
            payout,
            reason: reason.to_string(),
            opened_at: p.opened_at,
            closed_at: now,
        };
        match self.history.get_mut(&p.account) {
            Some(h) => {
                if h.len() >= HISTORY_LEN {
                    h.remove(0);
                }
                h.push(c);
            }
            None => {
                self.history.insert(p.account.clone(), vec![c]);
            }
        }
    }

    fn insert_position(&mut self, id: u64, p: Position) {
        let account = p.account.clone();
        self.positions.insert(id, p);
        self.active.insert(id);
        if let Some(set) = self.account_positions.get_mut(&account) {
            set.insert(id);
            return;
        }
        let mut set = IterableSet::new(StorageKey::AccountPositionSet { account_hash: env::sha256(account.as_bytes()) });
        set.insert(id);
        self.account_positions.insert(account, set);
    }

    fn remove_position(&mut self, id: u64, account: &AccountId) {
        self.positions.remove(&id);
        self.active.remove(&id);
        let empty = match self.account_positions.get_mut(account) {
            Some(set) => {
                set.remove(&id);
                set.is_empty()
            }
            None => false,
        };
        if empty {
            self.account_positions.remove(account);
        }
    }

    fn credit(&mut self, account: &AccountId, amount: u64) {
        if amount == 0 {
            return;
        }
        let b = self.balances.get(account).copied().unwrap_or(0);
        self.ledger_total = add(self.ledger_total, amount);
        self.balances.insert(account.clone(), add(b, amount));
    }

    fn debit(&mut self, account: &AccountId, amount: u64) {
        let b = self.balances.get(account).copied().unwrap_or(0);
        check(b >= amount, HouseError::InsufficientBalance);
        let left = b - amount;
        self.ledger_total = sub(self.ledger_total, amount);
        if left == 0 {
            self.balances.remove(account);
        } else {
            self.balances.insert(account.clone(), left);
        }
    }

    fn market_view(&self, id: u32, m: &Market) -> MarketView {
        let qv = |q: &Quote| {
            let px = self.prices_of(q);
            QuoteView {
                score_e2: U64(q.score_e2),
                pushed_score_e2: U64(q.pushed_score_e2),
                reading_e2: U64(q.reading_e2),
                lead_e2: U64(px.lead),
                buy_e2: U64(px.buy),
                sell_e2: U64(px.sell),
                spread_bps: U64(spread_bps(&px)),
                print_id: U64(q.print_id),
                print_at: U64(q.print_at),
                first_read_at: U64(q.first_read_at),
                last_read_at: U64(q.last_read_at),
            }
        };
        let stake = self.config.min_stake.0 as u64;
        let opens = self.open_checks(None, m, Side::Long, 2, stake, now_secs());
        MarketView {
            id,
            reference: m.reference.clone(),
            finder: m.finder.clone(),
            live_since: U64(m.live_since),
            listed_at: U64(m.listed_at),
            status: m.status,
            final_e2: m.final_e2.map(U64),
            settled_at: m.settled_at.map(U64),
            quote: m.newest().map(qv),
            quotes: m.quotes.iter().map(qv).collect(),
            long: book_view(&m.long),
            short: book_view(&m.short),
            side_cap: U128(self.vault.assets as u128 * self.config.market_cap_bps as u128 / BPS as u128),
            opens: opens.is_ok(),
            reason: opens.err().map(|e| e.msg().to_string()),
        }
    }

    fn position_view(&self, id: u64, p: &Position) -> PositionView {
        let filled = p.state != PositionState::Pending;
        let when = |cond: bool, v: u64| if cond { Some(U64(v)) } else { None };
        let closing = p.state == PositionState::Closing;
        let value = if filled {
            self.markets.get(p.market).and_then(|m| {
                let exit = match m.status {
                    MarketStatus::Settled => m.final_e2,
                    _ => m.newest().map(|q| self.prices_of(q).close(p.side)),
                }?;
                Some(payout(p.stake, pnl(p.side, p.leverage, p.stake, p.entry_e2, exit), p.reserved))
            })
        } else {
            None
        };
        PositionView {
            id: U64(id),
            account: p.account.clone(),
            market: p.market,
            side: p.side,
            leverage: p.leverage,
            stake: u(p.stake),
            fee: u(p.fee),
            reserved: u(p.reserved),
            state: p.state,
            placed_at: U64(p.placed_at),
            limit_e2: U64(p.limit_e2),
            entry_e2: when(filled, p.entry_e2),
            opened_at: when(filled, p.opened_at),
            close_requested_at: when(closing, p.close_requested_at),
            close_limit_e2: when(closing && p.close_limit_e2 > 0, p.close_limit_e2),
            expires_at: when(filled, p.expires_at),
            fill_print_id: when(filled, p.fill_print_id),
            liquidation_e2: when(filled, liquidation_e2(p.side, p.leverage, p.entry_e2)),
            cap_e2: when(filled, cap_e2(p.side, p.leverage, p.stake, p.entry_e2, p.reserved)),
            value: value.map(u),
            at_risk: value == Some(0),
        }
    }
}

fn sat_mul_bps(amount: u64, bps: u64) -> u64 {
    u64::try_from(amount as u128 * bps as u128 / BPS as u128).unwrap_or(u64::MAX)
}
