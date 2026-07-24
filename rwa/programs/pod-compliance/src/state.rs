use anchor_lang::prelude::*;
use pod_rwa_common::{
    EligibilityStatus, TransferPolicyMode, ACCOUNT_SCHEMA_V1, RESERVED_ACCOUNT_BYTES,
};

pub const COMPLIANCE_CONFIG_SEED: &[u8] = b"compliance-config";
pub const PROVIDER_SEED: &[u8] = b"provider";
pub const INVESTOR_SEED: &[u8] = b"investor";
pub const WALLET_BINDING_SEED: &[u8] = b"wallet-binding";
pub const SERIES_PERMISSION_SEED: &[u8] = b"series-permission";
pub const TRANSFER_POLICY_SEED: &[u8] = b"transfer-policy";
pub const RECOVERY_ORDER_SEED: &[u8] = b"recovery-order";
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

pub const TRANSFER_HOOK_EXTRA_ACCOUNT_COUNT: usize = 8;
pub const MIN_RECOVERY_DELAY_SECONDS: i64 = 60;
pub const MAX_RECOVERY_DELAY_SECONDS: i64 = 30 * 24 * 60 * 60;

#[account]
pub struct ComplianceConfig {
    pub schema_version: u16,
    pub governance: Pubkey,
    pub pending_governance: Pubkey,
    pub has_pending_governance: bool,
    pub recovery_authority: Pubkey,
    pub paused: bool,
    pub min_recovery_delay_seconds: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl ComplianceConfig {
    pub const SPACE: usize = 8 + 2 + 32 + 32 + 1 + 32 + 1 + 8 + 8 + 8 + 1 + RESERVED_ACCOUNT_BYTES;
}

#[account]
pub struct ProviderRecord {
    pub schema_version: u16,
    pub config: Pubkey,
    pub authority: Pubkey,
    pub can_issue: bool,
    pub can_revoke: bool,
    pub active: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl ProviderRecord {
    pub const SPACE: usize = 8 + 2 + 32 + 32 + 1 + 1 + 1 + 8 + 8 + 1 + RESERVED_ACCOUNT_BYTES;
}

#[account]
pub struct InvestorRecord {
    pub schema_version: u16,
    pub opaque_id: [u8; 32],
    pub config: Pubkey,
    pub provider_record: Pubkey,
    pub current_wallet: Pubkey,
    pub has_wallet: bool,
    pub status: EligibilityStatus,
    pub issued_at: i64,
    pub updated_at: i64,
    pub expires_at: i64,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl InvestorRecord {
    pub const SPACE: usize =
        8 + 2 + 32 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 8 + 1 + RESERVED_ACCOUNT_BYTES;
}

/// The opaque id deliberately starts at account-data byte 10 (after the
/// discriminator and schema version). The Token-2022 extra-account resolver
/// uses that stable offset to derive the corresponding InvestorRecord PDA.
#[account]
pub struct WalletBinding {
    pub schema_version: u16,
    pub opaque_id: [u8; 32],
    pub config: Pubkey,
    pub investor_record: Pubkey,
    pub wallet: Pubkey,
    pub active: bool,
    /// True only between recovery preparation and finalization. This lets the
    /// transfer hook distinguish a governed permanent-delegate transfer from
    /// an ordinary holder transfer without adding an optional hook account.
    pub pending_recovery: bool,
    pub recovery_order: Pubkey,
    pub recovery_source_wallet: Pubkey,
    pub recovery_series: Pubkey,
    pub recovery_expires_at: i64,
    pub bound_at: i64,
    pub unbound_at: i64,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl WalletBinding {
    pub const OPAQUE_ID_DATA_OFFSET: u8 = 10;
    pub const SPACE: usize =
        8 + 2 + 32 + 32 + 32 + 32 + 1 + 1 + 32 + 32 + 32 + 8 + 8 + 8 + 1 + RESERVED_ACCOUNT_BYTES;
}

#[account]
pub struct SeriesPermission {
    pub schema_version: u16,
    pub config: Pubkey,
    pub series: Pubkey,
    pub investor_record: Pubkey,
    pub wallet: Pubkey,
    pub provider_record: Pubkey,
    pub status: EligibilityStatus,
    pub accepted_terms_hash: [u8; 32],
    pub max_investment: u64,
    pub issued_at: i64,
    pub updated_at: i64,
    pub expires_at: i64,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl SeriesPermission {
    pub const SPACE: usize =
        8 + 2 + 32 + 32 + 32 + 32 + 32 + 1 + 32 + 8 + 8 + 8 + 8 + 1 + RESERVED_ACCOUNT_BYTES;
}

#[account]
pub struct TransferPolicy {
    pub schema_version: u16,
    pub config: Pubkey,
    pub series: Pubkey,
    pub issuer: Pubkey,
    /// The pod-vault Series PDA permitted to request controlled burns.
    pub burn_caller: Pubkey,
    pub mode: TransferPolicyMode,
    pub active: bool,
    pub updated_at: i64,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl TransferPolicy {
    pub const SPACE: usize = 8 + 2 + 32 + 32 + 32 + 32 + 1 + 1 + 8 + 1 + RESERVED_ACCOUNT_BYTES;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum RecoveryStatus {
    #[default]
    Proposed,
    Prepared,
    Executed,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum BurnPurpose {
    #[default]
    Refund,
    Redemption,
    RestrictedRedemption,
}

#[account]
pub struct RecoveryOrder {
    pub schema_version: u16,
    pub config: Pubkey,
    pub series: Pubkey,
    pub opaque_id: [u8; 32],
    pub investor_record: Pubkey,
    pub old_wallet: Pubkey,
    pub new_wallet: Pubkey,
    pub initiated_by: Pubkey,
    pub permanent_delegate: Pubkey,
    pub order_id: [u8; 32],
    pub expected_receipt_amount: u64,
    pub execute_after: i64,
    pub expires_at: i64,
    pub created_at: i64,
    pub prepared_at: i64,
    pub executed_at: i64,
    pub status: RecoveryStatus,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl RecoveryOrder {
    pub const SPACE: usize = 8
        + 2
        + 32
        + 32
        + 32
        + 32
        + 32
        + 32
        + 32
        + 32
        + 32
        + 8
        + 8
        + 8
        + 8
        + 8
        + 8
        + 1
        + 1
        + RESERVED_ACCOUNT_BYTES;
}

pub fn is_currently_active(status: EligibilityStatus, expires_at: i64, now: i64) -> bool {
    status == EligibilityStatus::Active && expires_at > now
}

pub fn initialize_reserved() -> [u8; RESERVED_ACCOUNT_BYTES] {
    [0; RESERVED_ACCOUNT_BYTES]
}

pub fn schema_v1() -> u16 {
    ACCOUNT_SCHEMA_V1
}
