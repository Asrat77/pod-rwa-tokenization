use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

pub const ACCOUNT_SCHEMA_V1: u16 = 1;
pub const BPS_DENOMINATOR: u16 = 10_000;
pub const USDC_DECIMALS: u8 = 6;
pub const MAX_RELEASE_MILESTONES: usize = 8;
pub const RESERVED_ACCOUNT_BYTES: usize = 64;

pub const RESULT_HASH_DOMAIN: &[u8] = b"POD:RWA:RESULT:V1";
pub const TERMS_HASH_DOMAIN: &[u8] = b"POD:RWA:TERMS:V1";
pub const TREASURY_EVIDENCE_HASH_DOMAIN: &[u8] = b"POD:RWA:TREASURY:V1";

#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
)]
pub enum Decision {
    #[default]
    Inconclusive,
    Pass,
    Fail,
}

#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
)]
pub enum OracleProduct {
    #[default]
    T1Plow,
    T2Health,
    T3Yield,
}

#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
)]
pub enum ValuationKind {
    #[default]
    CommodityPrice,
    FxRate,
}

#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
)]
pub enum ReleaseGateKind {
    #[default]
    CapitalClose,
    T1Pass,
    T2Pass,
    T3Pass,
}

#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
)]
pub enum DealState {
    #[default]
    Draft,
    SubscriptionOpen,
    Funded,
    Active,
    Repaid,
    DefaultRecovery,
    Redeemable,
    CancelledRefundable,
    Settled,
}

#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
)]
pub enum EligibilityStatus {
    #[default]
    Active,
    Suspended,
    Expired,
    Revoked,
    SanctionsHold,
}

#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
)]
pub enum TransferPolicyMode {
    #[default]
    IssuerRestricted,
    EligiblePeer,
}

#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
)]
pub enum TreasuryMovementStatus {
    #[default]
    Proposed,
    Approved,
    UsdcReleased,
    Converted,
    SwiftSent,
    BankConfirmed,
    Reconciled,
    Failed,
    Returned,
}

/// Distinguishes how a deal's terms-locked MSE beneficiary receives the released
/// stablecoin. The platform's own MSE takes custody in a Squads vault and forwards
/// USD over SWIFT off-chain (the full evidence chain); a third-party MSE receives
/// USDC directly into its registered wallet and has no conversion or SWIFT leg.
#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
)]
pub enum MseRailKind {
    #[default]
    SquadsFiatForward,
    DirectUsdc,
}

#[derive(
    AnchorSerialize,
    AnchorDeserialize,
    Clone,
    Copy,
    Debug,
    Default,
    Eq,
    PartialEq,
)]
pub enum MseBeneficiaryStatus {
    #[default]
    Active,
    Suspended,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ContentRef {
    pub address: Pubkey,
    pub revision: u32,
    pub content_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TokenAmount {
    pub amount: u64,
    pub decimals: u8,
}

pub fn checked_bps(amount: u64, bps: u16) -> Option<u64> {
    if bps > BPS_DENOMINATOR {
        return None;
    }

    let value = u128::from(amount)
        .checked_mul(u128::from(bps))?
        .checked_div(u128::from(BPS_DENOMINATOR))?;

    u64::try_from(value).ok()
}

pub fn checked_pro_rata(holder_amount: u64, pool: u64, supply: u64) -> Option<u64> {
    if supply == 0 {
        return None;
    }

    let value = u128::from(holder_amount)
        .checked_mul(u128::from(pool))?
        .checked_div(u128::from(supply))?;

    u64::try_from(value).ok()
}

pub fn checked_coupon(principal: u64, coupon_bps: u16) -> Option<u64> {
    principal.checked_add(checked_bps(principal, coupon_bps)?)
}

pub fn domain_hash(domain: &[u8], content: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(content);
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basis_points_use_checked_integer_math() {
        assert_eq!(checked_bps(30_000_000, 3_000), Some(9_000_000));
        assert_eq!(checked_bps(30_000_000, 10_001), None);
        assert_eq!(checked_bps(u64::MAX, 10_000), Some(u64::MAX));
    }

    #[test]
    fn pro_rata_matches_the_pilot_terms() {
        assert_eq!(
            checked_pro_rata(15_000_000, 33_000_000, 30_000_000),
            Some(16_500_000)
        );
        assert_eq!(
            checked_pro_rata(15_000_000, 24_000_000, 30_000_000),
            Some(12_000_000)
        );
        assert_eq!(checked_pro_rata(1, 1, 0), None);
    }

    #[test]
    fn coupon_target_is_principal_plus_return() {
        assert_eq!(checked_coupon(30_000_000, 1_000), Some(33_000_000));
    }

    #[test]
    fn domain_hashes_do_not_collide_across_record_types() {
        let payload = b"same payload";
        assert_ne!(
            domain_hash(RESULT_HASH_DOMAIN, payload),
            domain_hash(TERMS_HASH_DOMAIN, payload)
        );
    }

    #[test]
    fn mse_enums_keep_stable_discriminants() {
        fn encoded<T: AnchorSerialize>(value: T) -> Vec<u8> {
            let mut bytes = Vec::new();
            value.serialize(&mut bytes).unwrap();
            bytes
        }

        assert_eq!(encoded(MseRailKind::SquadsFiatForward), vec![0]);
        assert_eq!(encoded(MseRailKind::DirectUsdc), vec![1]);
        assert_eq!(encoded(MseBeneficiaryStatus::Active), vec![0]);
        assert_eq!(encoded(MseBeneficiaryStatus::Suspended), vec![1]);
    }
}
