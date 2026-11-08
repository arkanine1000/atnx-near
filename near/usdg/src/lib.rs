//! USDG, "ATNX test USD": a NEP-141 test token for the rounds contract.
//!
//! The standard NEP-141 (fungible token), NEP-145 (storage management) and
//! NEP-148 (metadata) methods come from near-contract-standards. On top:
//!
//! - `mint(receiver_id, amount)`, callable only by the minter (the rounds
//!   contract, whose `faucet` mints through it);
//! - `ft_transfer` and `ft_transfer_call` register an unregistered receiver
//!   at this contract's expense instead of panicking, so nobody has to call
//!   `storage_deposit` first. An account registered that way unregisters
//!   without a storage refund, since it never paid one.
//!
//! This is a test token on testnet: the contract pays for every sponsored
//! registration from its own NEAR balance.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::store::{LazyOption, LookupSet};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Accounts,
    Metadata,
    Sponsored,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    minter_id: AccountId,
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    /// Accounts registered at this contract's expense.
    sponsored: LookupSet<AccountId>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, minter_id: AccountId) -> Self {
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "ATNX test USD".to_string(),
            symbol: "USDG".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        };
        metadata.assert_valid();
        Self {
            owner_id,
            minter_id,
            token: FungibleToken::new(StorageKey::Accounts),
            metadata: LazyOption::new(StorageKey::Metadata, Some(metadata)),
            sponsored: LookupSet::new(StorageKey::Sponsored),
        }
    }

    /// Mints `amount` to `receiver_id`, registering it if needed. Minter only.
    pub fn mint(&mut self, receiver_id: AccountId, amount: U128) {
        require!(env::predecessor_account_id() == self.minter_id, "only the minter may mint");
        require!(amount.0 > 0, "The amount should be a positive number");
        self.register_if_needed(&receiver_id);
        self.token.internal_deposit(&receiver_id, amount.0);
        FtMint { owner_id: &receiver_id, amount, memo: None }.emit();
    }

    /// Owner only.
    pub fn set_minter(&mut self, minter_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner_id, "only the owner may set the minter");
        self.minter_id = minter_id;
    }
}

impl Contract {
    fn register_if_needed(&mut self, account_id: &AccountId) {
        if !self.token.accounts.contains_key(account_id) {
            self.token.internal_register_account(account_id);
            self.sponsored.insert(account_id.clone());
        }
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        self.register_if_needed(&receiver_id);
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        self.register_if_needed(&receiver_id);
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    /// As NEP-145, except that an account this contract registered for free
    /// gets no storage refund.
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        let account_id = env::predecessor_account_id();
        if !self.sponsored.contains(&account_id) {
            return match self.token.internal_storage_unregister(force) {
                Some((account_id, balance)) => {
                    if balance > 0 {
                        FtBurn { owner_id: &account_id, amount: U128(balance), memo: None }.emit();
                    }
                    true
                }
                None => false,
            };
        }
        assert_one_yocto();
        let Some(balance) = self.token.accounts.get(&account_id) else {
            return false;
        };
        if balance > 0 && !force.unwrap_or(false) {
            env::panic_str("Can't unregister the account with the positive balance without force");
        }
        self.token.accounts.remove(&account_id);
        self.token.total_supply -= balance;
        self.sponsored.remove(&account_id);
        if balance > 0 {
            FtBurn { owner_id: &account_id, amount: U128(balance), memo: None }.emit();
        }
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().clone().expect("metadata is set at init")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(predecessor: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(acc("usdg.near"))
            .predecessor_account_id(acc(predecessor))
            .signer_account_id(acc(predecessor))
            .attached_deposit(deposit)
            .build());
    }

    fn none() -> NearToken {
        NearToken::from_yoctonear(0)
    }

    fn yocto() -> NearToken {
        NearToken::from_yoctonear(1)
    }

    fn expect_err(msg: &str, f: impl FnOnce()) {
        let err = catch_unwind(AssertUnwindSafe(f)).expect_err(&format!("expected a panic with {msg:?}"));
        let text = err
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(text.contains(msg), "expected {msg:?}, got {text:?}");
    }

    fn setup() -> Contract {
        ctx("owner.near", none());
        Contract::new(acc("owner.near"), acc("rounds.near"))
    }

    #[test]
    fn metadata_and_an_empty_supply() {
        let c = setup();
        let m = c.ft_metadata();
        assert_eq!((m.name.as_str(), m.symbol.as_str(), m.decimals, m.spec.as_str()), ("ATNX test USD", "USDG", 6, "ft-1.0.0"));
        assert_eq!(c.ft_total_supply(), U128(0));
    }

    #[test]
    fn only_the_minter_mints_and_the_receiver_is_registered() {
        let mut c = setup();
        ctx("rounds.near", none());
        c.mint(acc("rounds.near"), U128(5_000_000));
        assert_eq!(
            get_logs(),
            vec![r#"EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_mint","data":[{"owner_id":"rounds.near","amount":"5000000"}]}"#]
        );
        assert_eq!(c.ft_balance_of(acc("rounds.near")), U128(5_000_000));
        assert_eq!(c.ft_total_supply(), U128(5_000_000));
        assert!(c.storage_balance_of(acc("rounds.near")).is_some());
        ctx("alice.near", none());
        expect_err("only the minter may mint", || c.mint(acc("alice.near"), U128(1)));
        ctx("rounds.near", none());
        expect_err("The amount should be a positive number", || c.mint(acc("alice.near"), U128(0)));
    }

    #[test]
    fn transfers_register_the_receiver_for_free() {
        let mut c = setup();
        ctx("rounds.near", none());
        c.mint(acc("alice.near"), U128(10));
        assert!(c.storage_balance_of(acc("bob.near")).is_none());
        ctx("alice.near", yocto());
        c.ft_transfer(acc("bob.near"), U128(4), None);
        assert_eq!((c.ft_balance_of(acc("alice.near")), c.ft_balance_of(acc("bob.near"))), (U128(6), U128(4)));
        assert!(c.storage_balance_of(acc("bob.near")).is_some());
        ctx("alice.near", none());
        expect_err("Requires attached deposit of exactly 1 yoctoNEAR", || c.ft_transfer(acc("carol.near"), U128(1), None));
        ctx("alice.near", yocto());
        let _ = c.ft_transfer_call(acc("rounds.near"), U128(6), None, String::new());
        assert_eq!(c.ft_balance_of(acc("rounds.near")), U128(6));
    }

    #[test]
    fn the_owner_sets_the_minter() {
        let mut c = setup();
        ctx("alice.near", none());
        expect_err("only the owner may set the minter", || c.set_minter(acc("alice.near")));
        ctx("owner.near", none());
        c.set_minter(acc("alice.near"));
        ctx("alice.near", none());
        c.mint(acc("alice.near"), U128(1));
        ctx("rounds.near", none());
        expect_err("only the minter may mint", || c.mint(acc("rounds.near"), U128(1)));
    }

    #[test]
    fn a_sponsored_account_unregisters_without_a_refund() {
        let mut c = setup();
        ctx("rounds.near", none());
        c.mint(acc("alice.near"), U128(3));
        ctx("alice.near", yocto());
        expect_err("positive balance without force", || {
            c.storage_unregister(None);
        });
        ctx("alice.near", yocto());
        assert!(c.storage_unregister(Some(true)));
        assert!(get_created_receipts().is_empty(), "no NEAR goes back");
        assert!(get_logs()[0].contains(r#""event":"ft_burn""#));
        assert_eq!(c.ft_total_supply(), U128(0));
        assert!(c.storage_balance_of(acc("alice.near")).is_none());

        // An account that paid for its storage gets it back.
        let min = c.storage_balance_bounds().min;
        ctx("bob.near", min);
        c.storage_deposit(None, None);
        ctx("bob.near", yocto());
        assert!(c.storage_unregister(None));
        assert_eq!(get_created_receipts().len(), 1, "the storage refund");
    }
}
