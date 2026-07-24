use anchor_lang::prelude::*;
use pod_rwa_common::{
    DealState, EligibilityStatus, MseBeneficiaryStatus, MseRailKind, ReleaseGateKind,
    TreasuryMovementStatus, ACCOUNT_SCHEMA_V1, RESERVED_ACCOUNT_BYTES,
};

pub const PROTOCOL_CONFIG_SPACE: usize = 8 + 512;
pub const SETTLEMENT_ASSET_SPACE: usize = 8 + 256;
pub const MSE_BENEFICIARY_SPACE: usize = 8 + 256;
pub const DEAL_TERMS_SPACE: usize = 8 + 1_536;
pub const DEAL_STATE_SPACE: usize = 8 + 768;
pub const SERIES_SPACE: usize = 8 + 512;
pub const MILESTONE_SPACE: usize = 8 + 640;
pub const POSITION_SPACE: usize = 8 + 640;
pub const RECEIPT_SPACE: usize = 8 + 512;
pub const SETTLEMENT_SPACE: usize = 8 + 640;
pub const TREASURY_MOVEMENT_SPACE: usize = 8 + 896;

#[account]
pub struct ProtocolConfig {
    pub schema_version: u16,
    pub governance: Pubkey,
    pub guardian: Pubkey,
    pub compliance_authority: Pubkey,
    pub platform_treasury_authority: Pubkey,
    pub oracle_program: Pubkey,
    pub compliance_program: Pubkey,
    pub pause_subscriptions: bool,
    pub pause_releases: bool,
    pub pause_transfers: bool,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl ProtocolConfig {
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        &mut self,
        governance: Pubkey,
        guardian: Pubkey,
        compliance_authority: Pubkey,
        platform_treasury_authority: Pubkey,
        oracle_program: Pubkey,
        compliance_program: Pubkey,
        bump: u8,
    ) {
        self.schema_version = ACCOUNT_SCHEMA_V1;
        self.governance = governance;
        self.guardian = guardian;
        self.compliance_authority = compliance_authority;
        self.platform_treasury_authority = platform_treasury_authority;
        self.oracle_program = oracle_program;
        self.compliance_program = compliance_program;
        self.pause_subscriptions = false;
        self.pause_releases = false;
        self.pause_transfers = false;
        self.bump = bump;
        self.reserved = [0; RESERVED_ACCOUNT_BYTES];
    }
}

#[account]
pub struct SettlementAssetConfig {
    pub schema_version: u16,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub enabled: bool,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

/// Governance-registered destination for released stablecoin. Each deal pins exactly
/// one active beneficiary at terms lock; the platform maintains many. The `rail_kind`
/// determines whether releases feed a Squads vault (with an off-chain USD/SWIFT
/// forward) or land directly in a third-party MSE wallet.
#[account]
pub struct MseBeneficiary {
    pub schema_version: u16,
    pub entity_hash: [u8; 32],
    pub wallet_owner: Pubkey,
    pub usdc_ata: Pubkey,
    pub rail_kind: MseRailKind,
    pub status: MseBeneficiaryStatus,
    pub registered_at_slot: u64,
    pub updated_at_slot: u64,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

#[account]
pub struct DealTerms {
    pub schema_version: u16,
    pub deal_id: [u8; 32],
    pub issuer_entity_hash: [u8; 32],
    pub beneficiary_entity_hash: [u8; 32],
    pub servicer_entity_hash: [u8; 32],
    pub asset_set_hash: [u8; 32],
    pub source_contract_hash: [u8; 32],
    pub document_bundle_hash: [u8; 32],
    pub bank_route_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub oracle_policy_hash: [u8; 32],
    pub compliance_policy_hash: [u8; 32],
    pub commodity_valuation: Pubkey,
    pub fx_valuation: Pubkey,
    pub settlement_asset: Pubkey,
    pub settlement_mint: Pubkey,
    pub settlement_token_program: Pubkey,
    pub settlement_decimals: u8,
    pub receipt_mint: Pubkey,
    pub receipt_token_program: Pubkey,
    pub subscription_vault: Pubkey,
    pub repayment_vault: Pubkey,
    pub mse_wallet_owner: Pubkey,
    pub mse_usdc_ata: Pubkey,
    pub mse_rail_kind: MseRailKind,
    pub servicer_authority: Pubkey,
    pub risk_authority: Pubkey,
    pub compliance_escrow_ata: Pubkey,
    pub subscription_open_at: i64,
    pub subscription_close_at: i64,
    pub maturity_at: i64,
    pub recovery_cutoff_at: i64,
    pub claim_deadline_at: i64,
    pub minimum_raise: u64,
    pub hard_cap: u64,
    pub coupon_bps: u16,
    pub fee_bps: u16,
    pub release_delay_seconds: u32,
    pub milestone_count: u8,
    pub locked: bool,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

#[account]
pub struct DealStateAccount {
    pub schema_version: u16,
    pub deal_id: [u8; 32],
    pub state: DealState,
    pub gross_subscriptions: u64,
    pub refunded_principal: u64,
    pub net_deployable: u64,
    pub total_released: u64,
    pub accounted_repayments: u64,
    pub unallocated_surplus: u64,
    pub investor_pool: u64,
    pub fee_pool: u64,
    pub issuer_residual: u64,
    pub redeemed_total: u64,
    pub receipt_supply_snapshot: u64,
    pub repayment_target: u64,
    pub milestone_bps_total: u16,
    pub configured_milestones: u8,
    pub next_milestone_index: u8,
    pub executed_milestones: u8,
    pub mint_authority_revoked: bool,
    pub settlement_finalized: bool,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

#[account]
pub struct Series {
    pub schema_version: u16,
    pub deal_id: [u8; 32],
    pub series_index: u8,
    pub receipt_mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub extension_set_hash: [u8; 32],
    pub issued_supply: u64,
    pub burned_supply: u64,
    pub minting_closed: bool,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

#[account]
pub struct ReleaseMilestone {
    pub schema_version: u16,
    pub deal_id: [u8; 32],
    pub index: u8,
    pub gate_kind: ReleaseGateKind,
    pub allocation_bps: u16,
    pub amount: u64,
    pub gate_address: Pubkey,
    pub gate_revision: u32,
    pub gate_content_hash: [u8; 32],
    pub risk_approver: Pubkey,
    pub scheduled_at: i64,
    pub execute_after: i64,
    pub expires_at: i64,
    pub cancelled: bool,
    pub executed: bool,
    pub executed_at: i64,
    pub release_signature_hash: [u8; 32],
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

#[account]
pub struct InvestorDealPosition {
    pub schema_version: u16,
    pub deal_id: [u8; 32],
    pub investor_id: [u8; 32],
    pub wallet: Pubkey,
    pub eligibility_status: EligibilityStatus,
    pub eligibility_expires_at: i64,
    pub accepted_terms_hash: [u8; 32],
    pub contribution_cap: u64,
    pub contributed: u64,
    pub receipts_issued: u64,
    pub receipts_burned: u64,
    pub refunded: u64,
    pub redeemed: u64,
    pub restricted_claim: bool,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

#[account]
pub struct OperationReceipt {
    pub schema_version: u16,
    pub deal_id: [u8; 32],
    pub actor: Pubkey,
    pub investor_id: [u8; 32],
    pub nonce: u64,
    pub operation: ReceiptOperation,
    pub amount: u64,
    pub payload_hash: [u8; 32],
    pub created_at: i64,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ReceiptOperation {
    #[default]
    Subscription,
    Refund,
    Repayment,
    Redemption,
    RestrictedRedemption,
}

#[account]
pub struct SettlementSnapshot {
    pub schema_version: u16,
    pub deal_id: [u8; 32],
    pub finalized_at: i64,
    pub claim_deadline_at: i64,
    pub supply_snapshot: u64,
    pub actual_repayment_balance: u64,
    pub investor_principal_target: u64,
    pub investor_return_target: u64,
    pub investor_pool: u64,
    pub fee_pool: u64,
    pub issuer_residual: u64,
    pub claimed_investor_pool: u64,
    pub restricted_escrow_total: u64,
    pub dust_total: u64,
    pub issuer_distribution_amount: u64,
    pub issuer_distribution_withdrawn: bool,
    pub defaulted: bool,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

#[account]
pub struct TreasuryMovement {
    pub schema_version: u16,
    pub deal_id: [u8; 32],
    pub milestone_index: u8,
    pub status: TreasuryMovementStatus,
    pub rail_kind: MseRailKind,
    pub released_usdc: u64,
    pub release_record: Pubkey,
    pub release_signature_hash: [u8; 32],
    pub conversion_provider_hash: [u8; 32],
    pub gross_usd_minor: u64,
    pub net_usd_minor: u64,
    pub conversion_rate_e8: u64,
    pub provider_fees_usd_minor: u64,
    pub bank_fees_usd_minor: u64,
    pub beneficiary_entity_hash: [u8; 32],
    pub bank_route_hash: [u8; 32],
    pub swift_uetr_hash: [u8; 32],
    pub bank_confirmation_hash: [u8; 32],
    pub treasury_approver: Pubkey,
    pub risk_approver: Pubkey,
    pub proposed_at: i64,
    pub approved_at: i64,
    pub converted_at: i64,
    pub swift_sent_at: i64,
    pub bank_confirmed_at: i64,
    pub reconciled_at: i64,
    pub bump: u8,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}
