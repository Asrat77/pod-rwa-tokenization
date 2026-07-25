use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_2022;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        default_account_state::DefaultAccountState, metadata_pointer::MetadataPointer,
        permanent_delegate::PermanentDelegate, transfer_hook::TransferHook,
    },
    state::AccountState as TokenAccountState,
};
use anchor_spl::token_interface::{
    self, get_mint_extension_data, Mint, MintTo, SetAuthority, TokenAccount, TokenInterface,
    TransferChecked,
};
use pod_compliance::BurnPurpose;
use pod_rwa_common::{
    checked_bps, checked_coupon, checked_pro_rata, domain_hash, DealState, EligibilityStatus,
    MseBeneficiaryStatus, MseRailKind, ReleaseGateKind, TransferPolicyMode,
    TreasuryMovementStatus, ACCOUNT_SCHEMA_V1, BPS_DENOMINATOR,
};

pub mod errors;
pub mod state;

use errors::VaultError;
use state::*;

declare_id!("GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn");

const RECEIPT_EXTENSION_HASH_DOMAIN: &[u8] = b"POD:RWA:RECEIPT_EXTENSIONS:V1";
const TOKEN_2022_MINT_TLV_OFFSET: usize = 166;
const EXTENSION_DEFAULT_ACCOUNT_STATE: u16 = 6;
const EXTENSION_PERMANENT_DELEGATE: u16 = 12;
const EXTENSION_TRANSFER_HOOK: u16 = 14;
const EXTENSION_METADATA_POINTER: u16 = 18;
// Token-2022 interface v3 / program v11 appends PermissionedBurn after
// PausableAccount. Anchor SPL 1.1.2 does not expose the type yet.
const EXTENSION_PERMISSIONED_BURN: u16 = 28;

#[program]
pub mod pod_vault {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        args: InitializeProtocolArgs,
    ) -> Result<()> {
        require!(
            args.governance != args.guardian
                && args.governance != args.compliance_authority
                && args.guardian != args.compliance_authority
                && args.governance != args.platform_treasury_authority
                && args.guardian != args.platform_treasury_authority
                && args.compliance_authority != args.platform_treasury_authority
                && args.oracle_program == pod_oracle::ID
                && args.compliance_program == pod_compliance::ID,
            VaultError::AuthorityCollision
        );
        require!(
            args.governance != Pubkey::default()
                && args.guardian != Pubkey::default()
                && args.compliance_authority != Pubkey::default()
                && args.platform_treasury_authority != Pubkey::default(),
            VaultError::InvalidTerms
        );

        ctx.accounts.protocol_config.initialize(
            args.governance,
            args.guardian,
            args.compliance_authority,
            args.platform_treasury_authority,
            args.oracle_program,
            args.compliance_program,
            ctx.bumps.protocol_config,
        );

        emit!(ProtocolInitialized {
            governance: args.governance,
            guardian: args.guardian,
            oracle_program: args.oracle_program,
            compliance_program: args.compliance_program,
        });
        Ok(())
    }

    pub fn set_pause_flags(ctx: Context<GovernProtocol>, args: SetPauseFlagsArgs) -> Result<()> {
        let config = &mut ctx.accounts.protocol_config;
        require!(
            ctx.accounts.authority.key() == config.governance
                || ctx.accounts.authority.key() == config.guardian,
            VaultError::Unauthorized
        );

        if ctx.accounts.authority.key() == config.guardian {
            require!(
                (!config.pause_subscriptions || args.pause_subscriptions)
                    && (!config.pause_releases || args.pause_releases)
                    && (!config.pause_transfers || args.pause_transfers),
                VaultError::Unauthorized
            );
        }

        config.pause_subscriptions = args.pause_subscriptions;
        config.pause_releases = args.pause_releases;
        config.pause_transfers = args.pause_transfers;
        emit!(PauseFlagsChanged {
            subscriptions: args.pause_subscriptions,
            releases: args.pause_releases,
            transfers: args.pause_transfers,
            authority: ctx.accounts.authority.key(),
        });
        Ok(())
    }

    pub fn register_settlement_asset(
        ctx: Context<RegisterSettlementAsset>,
        enabled: bool,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.governance.key(),
            ctx.accounts.protocol_config.governance,
            VaultError::Unauthorized
        );
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            ctx.accounts.token_program.key(),
            VaultError::InvalidSettlementAsset
        );

        let asset = &mut ctx.accounts.settlement_asset;
        asset.schema_version = ACCOUNT_SCHEMA_V1;
        asset.mint = ctx.accounts.mint.key();
        asset.token_program = ctx.accounts.token_program.key();
        asset.decimals = ctx.accounts.mint.decimals;
        asset.enabled = enabled;
        asset.bump = ctx.bumps.settlement_asset;
        asset.reserved = [0; pod_rwa_common::RESERVED_ACCOUNT_BYTES];

        emit!(SettlementAssetRegistered {
            mint: asset.mint,
            token_program: asset.token_program,
            decimals: asset.decimals,
            enabled,
        });
        Ok(())
    }

    pub fn register_mse_beneficiary(
        ctx: Context<RegisterMseBeneficiary>,
        args: RegisterMseBeneficiaryArgs,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.governance.key(),
            ctx.accounts.protocol_config.governance,
            VaultError::Unauthorized
        );
        require!(
            args.entity_hash != [0u8; 32]
                && args.wallet_owner != Pubkey::default()
                && args.usdc_ata != Pubkey::default(),
            VaultError::InvalidTerms
        );

        let slot = Clock::get()?.slot;
        let beneficiary = &mut ctx.accounts.mse_beneficiary;
        beneficiary.schema_version = ACCOUNT_SCHEMA_V1;
        beneficiary.entity_hash = args.entity_hash;
        beneficiary.wallet_owner = args.wallet_owner;
        beneficiary.usdc_ata = args.usdc_ata;
        beneficiary.rail_kind = args.rail_kind;
        beneficiary.status = MseBeneficiaryStatus::Active;
        beneficiary.registered_at_slot = slot;
        beneficiary.updated_at_slot = slot;
        beneficiary.bump = ctx.bumps.mse_beneficiary;
        beneficiary.reserved = [0; pod_rwa_common::RESERVED_ACCOUNT_BYTES];

        emit!(MseBeneficiaryRegistered {
            entity_hash: args.entity_hash,
            wallet_owner: args.wallet_owner,
            usdc_ata: args.usdc_ata,
            rail_kind: args.rail_kind,
        });
        Ok(())
    }

    pub fn set_mse_beneficiary_status(
        ctx: Context<SetMseBeneficiaryStatus>,
        status: MseBeneficiaryStatus,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.governance.key(),
            ctx.accounts.protocol_config.governance,
            VaultError::Unauthorized
        );

        let beneficiary = &mut ctx.accounts.mse_beneficiary;
        beneficiary.status = status;
        beneficiary.updated_at_slot = Clock::get()?.slot;

        emit!(MseBeneficiaryStatusChanged {
            entity_hash: beneficiary.entity_hash,
            status,
        });
        Ok(())
    }

    pub fn create_deal(ctx: Context<CreateDeal>, args: CreateDealArgs) -> Result<()> {
        validate_create_deal(&ctx, &args)?;

        let terms = &mut ctx.accounts.deal_terms;
        terms.schema_version = ACCOUNT_SCHEMA_V1;
        terms.deal_id = args.deal_id;
        terms.issuer_entity_hash = args.issuer_entity_hash;
        terms.beneficiary_entity_hash = ctx.accounts.mse_beneficiary.entity_hash;
        terms.servicer_entity_hash = args.servicer_entity_hash;
        terms.asset_set_hash = args.asset_set_hash;
        terms.source_contract_hash = args.source_contract_hash;
        terms.document_bundle_hash = args.document_bundle_hash;
        terms.bank_route_hash = args.bank_route_hash;
        terms.terms_hash = args.terms_hash;
        terms.oracle_policy_hash = args.oracle_policy_hash;
        terms.compliance_policy_hash = args.compliance_policy_hash;
        terms.commodity_valuation = args.commodity_valuation;
        terms.fx_valuation = args.fx_valuation;
        terms.settlement_asset = ctx.accounts.settlement_asset.key();
        terms.settlement_mint = ctx.accounts.settlement_mint.key();
        terms.settlement_token_program = ctx.accounts.settlement_token_program.key();
        terms.settlement_decimals = ctx.accounts.settlement_mint.decimals;
        terms.receipt_mint = ctx.accounts.receipt_mint.key();
        terms.receipt_token_program = ctx.accounts.receipt_token_program.key();
        terms.subscription_vault = ctx.accounts.subscription_vault.key();
        terms.repayment_vault = ctx.accounts.repayment_vault.key();
        terms.mse_wallet_owner = ctx.accounts.mse_beneficiary.wallet_owner;
        terms.mse_usdc_ata = ctx.accounts.mse_usdc_ata.key();
        terms.mse_rail_kind = ctx.accounts.mse_beneficiary.rail_kind;
        terms.servicer_authority = args.servicer_authority;
        terms.risk_authority = args.risk_authority;
        terms.compliance_escrow_ata = ctx.accounts.compliance_escrow_ata.key();
        terms.subscription_open_at = args.subscription_open_at;
        terms.subscription_close_at = args.subscription_close_at;
        terms.maturity_at = args.maturity_at;
        terms.recovery_cutoff_at = args.recovery_cutoff_at;
        terms.claim_deadline_at = args.claim_deadline_at;
        terms.minimum_raise = args.minimum_raise;
        terms.hard_cap = args.hard_cap;
        terms.coupon_bps = args.coupon_bps;
        terms.fee_bps = args.fee_bps;
        terms.release_delay_seconds = args.release_delay_seconds;
        terms.milestone_count = args.milestone_count;
        terms.locked = false;
        terms.bump = ctx.bumps.deal_terms;
        terms.reserved = [0; pod_rwa_common::RESERVED_ACCOUNT_BYTES];

        let state = &mut ctx.accounts.deal_state;
        state.schema_version = ACCOUNT_SCHEMA_V1;
        state.deal_id = args.deal_id;
        state.state = DealState::Draft;
        state.gross_subscriptions = 0;
        state.refunded_principal = 0;
        state.net_deployable = 0;
        state.total_released = 0;
        state.accounted_repayments = 0;
        state.unallocated_surplus = 0;
        state.investor_pool = 0;
        state.fee_pool = 0;
        state.issuer_residual = 0;
        state.redeemed_total = 0;
        state.receipt_supply_snapshot = 0;
        state.repayment_target = 0;
        state.milestone_bps_total = 0;
        state.configured_milestones = 0;
        state.next_milestone_index = 0;
        state.executed_milestones = 0;
        state.mint_authority_revoked = false;
        state.settlement_finalized = false;
        state.bump = ctx.bumps.deal_state;
        state.reserved = [0; pod_rwa_common::RESERVED_ACCOUNT_BYTES];

        let series = &mut ctx.accounts.series;
        series.schema_version = ACCOUNT_SCHEMA_V1;
        series.deal_id = args.deal_id;
        series.series_index = 0;
        series.receipt_mint = ctx.accounts.receipt_mint.key();
        series.token_program = ctx.accounts.receipt_token_program.key();
        series.decimals = ctx.accounts.receipt_mint.decimals;
        series.extension_set_hash = args.receipt_extension_set_hash;
        series.issued_supply = 0;
        series.burned_supply = 0;
        series.minting_closed = false;
        series.bump = ctx.bumps.series;
        series.reserved = [0; pod_rwa_common::RESERVED_ACCOUNT_BYTES];

        emit!(DealCreated {
            deal_id: args.deal_id,
            issuer_entity_hash: args.issuer_entity_hash,
            beneficiary_entity_hash: ctx.accounts.mse_beneficiary.entity_hash,
            settlement_mint: ctx.accounts.settlement_mint.key(),
            receipt_mint: ctx.accounts.receipt_mint.key(),
        });
        Ok(())
    }

    pub fn configure_milestone(
        ctx: Context<ConfigureMilestone>,
        args: ConfigureMilestoneArgs,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.governance.key(),
            ctx.accounts.protocol_config.governance,
            VaultError::Unauthorized
        );
        require!(
            ctx.accounts.deal_state.state == DealState::Draft
                && !ctx.accounts.deal_terms.locked,
            VaultError::InvalidDealState
        );
        require!(
            args.index == ctx.accounts.deal_state.configured_milestones
                && args.index < ctx.accounts.deal_terms.milestone_count
                && args.allocation_bps > 0,
            VaultError::InvalidMilestone
        );

        let next_total = ctx
            .accounts
            .deal_state
            .milestone_bps_total
            .checked_add(args.allocation_bps)
            .ok_or(VaultError::MathOverflow)?;
        require!(
            next_total <= BPS_DENOMINATOR,
            VaultError::InvalidMilestone
        );

        let milestone = &mut ctx.accounts.milestone;
        milestone.schema_version = ACCOUNT_SCHEMA_V1;
        milestone.deal_id = ctx.accounts.deal_terms.deal_id;
        milestone.index = args.index;
        milestone.gate_kind = args.gate_kind;
        milestone.allocation_bps = args.allocation_bps;
        milestone.amount = 0;
        milestone.gate_address = Pubkey::default();
        milestone.gate_revision = 0;
        milestone.gate_content_hash = [0; 32];
        milestone.risk_approver = Pubkey::default();
        milestone.scheduled_at = 0;
        milestone.execute_after = 0;
        milestone.expires_at = 0;
        milestone.cancelled = false;
        milestone.executed = false;
        milestone.executed_at = 0;
        milestone.release_signature_hash = [0; 32];
        milestone.bump = ctx.bumps.milestone;
        milestone.reserved = [0; pod_rwa_common::RESERVED_ACCOUNT_BYTES];

        ctx.accounts.deal_state.milestone_bps_total = next_total;
        ctx.accounts.deal_state.configured_milestones = ctx
            .accounts
            .deal_state
            .configured_milestones
            .checked_add(1)
            .ok_or(VaultError::MathOverflow)?;

        emit!(MilestoneConfigured {
            deal_id: milestone.deal_id,
            index: milestone.index,
            gate_kind: milestone.gate_kind,
            allocation_bps: milestone.allocation_bps,
        });
        Ok(())
    }

    pub fn open_subscription(ctx: Context<OpenSubscription>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.governance.key(),
            ctx.accounts.protocol_config.governance,
            VaultError::Unauthorized
        );
        require!(
            !ctx.accounts.protocol_config.pause_subscriptions,
            VaultError::Paused
        );
        require!(
            ctx.accounts.deal_state.state == DealState::Draft,
            VaultError::InvalidDealState
        );
        require!(
            ctx.accounts.deal_state.configured_milestones
                == ctx.accounts.deal_terms.milestone_count
                && ctx.accounts.deal_state.milestone_bps_total == BPS_DENOMINATOR,
            VaultError::MilestoneAllocationMismatch
        );
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.deal_terms.subscription_open_at
                && now < ctx.accounts.deal_terms.subscription_close_at,
            VaultError::SubscriptionWindowClosed
        );

        ctx.accounts.deal_terms.locked = true;
        ctx.accounts.deal_state.state = DealState::SubscriptionOpen;
        emit!(DealStateChanged {
            deal_id: ctx.accounts.deal_terms.deal_id,
            state: DealState::SubscriptionOpen,
        });
        Ok(())
    }

    pub fn approve_investor(
        ctx: Context<ApproveInvestor>,
        args: ApproveInvestorArgs,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.compliance_authority.key(),
            ctx.accounts.protocol_config.compliance_authority,
            VaultError::Unauthorized
        );
        require!(
            matches!(
                ctx.accounts.deal_state.state,
                DealState::Draft | DealState::SubscriptionOpen
            ),
            VaultError::InvalidDealState
        );
        require!(
            args.contribution_cap > 0
                && args.contribution_cap <= ctx.accounts.deal_terms.hard_cap
                && args.eligibility_expires_at > Clock::get()?.unix_timestamp,
            VaultError::InvestorNotEligible
        );
        require!(
            args.accepted_terms_hash == ctx.accounts.deal_terms.terms_hash,
            VaultError::TermsNotAccepted
        );

        let position = &mut ctx.accounts.position;
        position.schema_version = ACCOUNT_SCHEMA_V1;
        position.deal_id = ctx.accounts.deal_terms.deal_id;
        position.investor_id = args.investor_id;
        position.wallet = args.wallet;
        position.eligibility_status = EligibilityStatus::Active;
        position.eligibility_expires_at = args.eligibility_expires_at;
        position.accepted_terms_hash = args.accepted_terms_hash;
        position.contribution_cap = args.contribution_cap;
        position.contributed = 0;
        position.receipts_issued = 0;
        position.receipts_burned = 0;
        position.refunded = 0;
        position.redeemed = 0;
        position.restricted_claim = false;
        position.bump = ctx.bumps.position;
        position.reserved = [0; pod_rwa_common::RESERVED_ACCOUNT_BYTES];

        emit!(InvestorApproved {
            deal_id: position.deal_id,
            investor_id: position.investor_id,
            wallet: position.wallet,
            contribution_cap: position.contribution_cap,
        });
        Ok(())
    }

    pub fn update_investor_status(
        ctx: Context<UpdateInvestorStatus>,
        status: EligibilityStatus,
        expires_at: i64,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.compliance_authority.key(),
            ctx.accounts.protocol_config.compliance_authority,
            VaultError::Unauthorized
        );
        let position = &mut ctx.accounts.position;
        position.eligibility_status = status;
        position.eligibility_expires_at = expires_at;
        position.restricted_claim = status == EligibilityStatus::SanctionsHold;
        emit!(InvestorStatusChanged {
            deal_id: position.deal_id,
            investor_id: position.investor_id,
            status,
            expires_at,
        });
        Ok(())
    }

    pub fn subscribe(ctx: Context<Subscribe>, args: AmountWithNonceArgs) -> Result<()> {
        if is_replayed_receipt(
            &ctx.accounts.operation_receipt,
            ReceiptOperation::Subscription,
            args.amount,
            args.payload_hash,
        )? {
            return Ok(());
        }

        validate_subscription(&ctx, &args)?;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.settlement_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.investor_usdc.to_account_info(),
                    mint: ctx.accounts.settlement_mint.to_account_info(),
                    to: ctx.accounts.subscription_vault.to_account_info(),
                    authority: ctx.accounts.investor.to_account_info(),
                },
            ),
            args.amount,
            ctx.accounts.deal_terms.settlement_decimals,
        )?;

        let series_seeds: &[&[u8]] = &[
            b"series",
            ctx.accounts.deal_terms.deal_id.as_ref(),
            &[0],
            &[ctx.accounts.series.bump],
        ];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.receipt_token_program.key(),
                MintTo {
                    mint: ctx.accounts.receipt_mint.to_account_info(),
                    to: ctx.accounts.investor_receipt.to_account_info(),
                    authority: ctx.accounts.series.to_account_info(),
                },
                &[series_seeds],
            ),
            args.amount,
        )?;

        ctx.accounts.position.contributed = checked_add(
            ctx.accounts.position.contributed,
            args.amount,
        )?;
        ctx.accounts.position.receipts_issued = checked_add(
            ctx.accounts.position.receipts_issued,
            args.amount,
        )?;
        ctx.accounts.deal_state.gross_subscriptions = checked_add(
            ctx.accounts.deal_state.gross_subscriptions,
            args.amount,
        )?;
        ctx.accounts.series.issued_supply =
            checked_add(ctx.accounts.series.issued_supply, args.amount)?;

        initialize_receipt(
            &mut ctx.accounts.operation_receipt,
            ctx.accounts.deal_terms.deal_id,
            ctx.accounts.investor.key(),
            ctx.accounts.position.investor_id,
            args.nonce,
            ReceiptOperation::Subscription,
            args.amount,
            args.payload_hash,
            ctx.bumps.operation_receipt,
        )?;

        emit!(Subscribed {
            deal_id: ctx.accounts.deal_terms.deal_id,
            investor_id: ctx.accounts.position.investor_id,
            wallet: ctx.accounts.investor.key(),
            amount: args.amount,
            nonce: args.nonce,
        });
        Ok(())
    }

    pub fn finalize_subscription(ctx: Context<FinalizeSubscription>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let terms = &ctx.accounts.deal_terms;
        validate_receipt_series_accounts(
            terms,
            &ctx.accounts.series,
            &ctx.accounts.receipt_mint,
            &ctx.accounts.receipt_token_program,
            true,
        )?;
        let state = &mut ctx.accounts.deal_state;
        require!(
            state.state == DealState::SubscriptionOpen,
            VaultError::InvalidDealState
        );
        require!(
            now >= terms.subscription_close_at
                || state.gross_subscriptions == terms.hard_cap,
            VaultError::RaiseNotFinalizable
        );

        if state.gross_subscriptions < terms.minimum_raise {
            require!(
                now >= terms.subscription_close_at,
                VaultError::RaiseNotFinalizable
            );
            revoke_receipt_mint_authority(
                ctx.accounts.receipt_token_program.to_account_info(),
                ctx.accounts.receipt_mint.to_account_info(),
                ctx.accounts.series.to_account_info(),
                terms.deal_id,
                ctx.accounts.series.bump,
            )?;
            ctx.accounts.series.minting_closed = true;
            state.mint_authority_revoked = true;
            state.state = DealState::CancelledRefundable;
            emit!(DealStateChanged {
                deal_id: terms.deal_id,
                state: state.state,
            });
            return Ok(());
        }

        require!(
            state.milestone_bps_total == BPS_DENOMINATOR,
            VaultError::MilestoneAllocationMismatch
        );
        require!(
            ctx.accounts.series.issued_supply == state.gross_subscriptions
                && ctx.accounts.receipt_mint.supply == state.gross_subscriptions,
            VaultError::InvalidTerms
        );

        let upfront_fee = checked_bps(state.gross_subscriptions, terms.fee_bps)
            .ok_or(VaultError::MathOverflow)?;
        state.net_deployable = state
            .gross_subscriptions
            .checked_sub(upfront_fee)
            .ok_or(VaultError::MathOverflow)?;
        state.repayment_target = checked_coupon(state.gross_subscriptions, terms.coupon_bps)
            .ok_or(VaultError::MathOverflow)?;
        state.receipt_supply_snapshot = state.gross_subscriptions;
        state.state = DealState::Funded;

        revoke_receipt_mint_authority(
            ctx.accounts.receipt_token_program.to_account_info(),
            ctx.accounts.receipt_mint.to_account_info(),
            ctx.accounts.series.to_account_info(),
            terms.deal_id,
            ctx.accounts.series.bump,
        )?;
        ctx.accounts.series.minting_closed = true;
        state.mint_authority_revoked = true;

        emit!(SubscriptionFinalized {
            deal_id: terms.deal_id,
            funded_principal: state.gross_subscriptions,
            net_deployable: state.net_deployable,
            repayment_target: state.repayment_target,
        });
        Ok(())
    }

    pub fn claim_refund(ctx: Context<ClaimRefund>, args: AmountWithNonceArgs) -> Result<()> {
        if is_replayed_receipt(
            &ctx.accounts.operation_receipt,
            ReceiptOperation::Refund,
            args.amount,
            args.payload_hash,
        )? {
            return Ok(());
        }
        require!(
            ctx.accounts.deal_state.state == DealState::CancelledRefundable,
            VaultError::RefundUnavailable
        );
        require_keys_eq!(
            ctx.accounts.position.wallet,
            ctx.accounts.investor.key(),
            VaultError::Unauthorized
        );
        let live_receipts = ctx
            .accounts
            .position
            .receipts_issued
            .checked_sub(ctx.accounts.position.receipts_burned)
            .ok_or(VaultError::MathOverflow)?;
        require!(
            args.amount == live_receipts
                && ctx.accounts.investor_receipt.amount == live_receipts,
            VaultError::FullRedemptionRequired
        );
        validate_receipt_series_accounts(
            &ctx.accounts.deal_terms,
            &ctx.accounts.series,
            &ctx.accounts.receipt_mint,
            &ctx.accounts.receipt_token_program,
            false,
        )?;
        validate_settlement_asset_accounts(
            &ctx.accounts.deal_terms,
            &ctx.accounts.settlement_mint,
            &ctx.accounts.settlement_token_program,
        )?;
        require_keys_eq!(
            ctx.accounts.subscription_vault.key(),
            ctx.accounts.deal_terms.subscription_vault,
            VaultError::InvalidTokenAccount
        );
        validate_token_account(
            &ctx.accounts.subscription_vault,
            ctx.accounts.settlement_mint.key(),
            ctx.accounts.deal_state.key(),
        )?;
        validate_token_account(
            &ctx.accounts.investor_usdc,
            ctx.accounts.settlement_mint.key(),
            ctx.accounts.investor.key(),
        )?;

        permissioned_burn_receipts(
            ctx.accounts.compliance_program.key(),
            ctx.accounts.compliance_config.to_account_info(),
            ctx.accounts.transfer_policy.to_account_info(),
            ctx.accounts.source_binding.to_account_info(),
            ctx.accounts.source_permission.to_account_info(),
            ctx.accounts.source_investor.to_account_info(),
            ctx.accounts.receipt_token_program.to_account_info(),
            ctx.accounts.investor_receipt.to_account_info(),
            ctx.accounts.receipt_mint.to_account_info(),
            ctx.accounts.series.to_account_info(),
            ctx.accounts.investor.to_account_info(),
            ctx.accounts.deal_terms.deal_id,
            ctx.accounts.series.bump,
            args.amount,
            ctx.accounts.series.decimals,
            BurnPurpose::Refund,
        )?;
        transfer_from_vault(
            ctx.accounts.settlement_token_program.to_account_info(),
            ctx.accounts.subscription_vault.to_account_info(),
            ctx.accounts.settlement_mint.to_account_info(),
            ctx.accounts.investor_usdc.to_account_info(),
            ctx.accounts.deal_state.to_account_info(),
            ctx.accounts.deal_terms.deal_id,
            ctx.accounts.deal_state.bump,
            args.amount,
            ctx.accounts.deal_terms.settlement_decimals,
        )?;

        ctx.accounts.position.receipts_burned =
            checked_add(ctx.accounts.position.receipts_burned, args.amount)?;
        ctx.accounts.position.refunded =
            checked_add(ctx.accounts.position.refunded, args.amount)?;
        ctx.accounts.series.burned_supply =
            checked_add(ctx.accounts.series.burned_supply, args.amount)?;
        ctx.accounts.deal_state.refunded_principal =
            checked_add(ctx.accounts.deal_state.refunded_principal, args.amount)?;

        initialize_receipt(
            &mut ctx.accounts.operation_receipt,
            ctx.accounts.deal_terms.deal_id,
            ctx.accounts.investor.key(),
            ctx.accounts.position.investor_id,
            args.nonce,
            ReceiptOperation::Refund,
            args.amount,
            args.payload_hash,
            ctx.bumps.operation_receipt,
        )?;

        if ctx.accounts.series.burned_supply == ctx.accounts.series.issued_supply {
            ctx.accounts.deal_state.state = DealState::Settled;
        }
        emit!(RefundClaimed {
            deal_id: ctx.accounts.deal_terms.deal_id,
            investor_id: ctx.accounts.position.investor_id,
            amount: args.amount,
        });
        Ok(())
    }

    pub fn schedule_release(
        ctx: Context<ScheduleRelease>,
        args: ScheduleReleaseArgs,
    ) -> Result<()> {
        validate_release_schedule(&ctx, &args)?;
        let now = Clock::get()?.unix_timestamp;
        let state = &ctx.accounts.deal_state;
        let milestone = &mut ctx.accounts.milestone;

        let amount = if milestone.index + 1 == ctx.accounts.deal_terms.milestone_count {
            state
                .net_deployable
                .checked_sub(state.total_released)
                .ok_or(VaultError::MathOverflow)?
        } else {
            checked_bps(state.net_deployable, milestone.allocation_bps)
                .ok_or(VaultError::MathOverflow)?
        };
        require!(amount > 0, VaultError::InvalidMilestone);

        milestone.amount = amount;
        milestone.gate_address = args.gate_address;
        milestone.gate_revision = args.gate_revision;
        milestone.gate_content_hash = args.gate_content_hash;
        milestone.risk_approver = ctx.accounts.risk_authority.key();
        milestone.scheduled_at = now;
        milestone.execute_after = now
            .checked_add(i64::from(ctx.accounts.deal_terms.release_delay_seconds))
            .ok_or(VaultError::MathOverflow)?;
        milestone.expires_at = args.expires_at;
        milestone.cancelled = false;

        let movement = &mut ctx.accounts.treasury_movement;
        movement.schema_version = ACCOUNT_SCHEMA_V1;
        movement.deal_id = ctx.accounts.deal_terms.deal_id;
        movement.milestone_index = milestone.index;
        movement.status = TreasuryMovementStatus::Approved;
        movement.rail_kind = ctx.accounts.deal_terms.mse_rail_kind;
        movement.released_usdc = amount;
        movement.release_record = milestone.key();
        movement.release_signature_hash = [0; 32];
        movement.conversion_provider_hash = [0; 32];
        movement.gross_usd_minor = 0;
        movement.net_usd_minor = 0;
        movement.conversion_rate_e8 = 0;
        movement.provider_fees_usd_minor = 0;
        movement.bank_fees_usd_minor = 0;
        movement.beneficiary_entity_hash = ctx.accounts.deal_terms.beneficiary_entity_hash;
        movement.bank_route_hash = ctx.accounts.deal_terms.bank_route_hash;
        movement.swift_uetr_hash = [0; 32];
        movement.bank_confirmation_hash = [0; 32];
        movement.treasury_approver = ctx.accounts.treasury_authority.key();
        movement.risk_approver = ctx.accounts.risk_authority.key();
        movement.proposed_at = now;
        movement.approved_at = now;
        movement.converted_at = 0;
        movement.swift_sent_at = 0;
        movement.bank_confirmed_at = 0;
        movement.reconciled_at = 0;
        movement.bump = ctx.bumps.treasury_movement;
        movement.reserved = [0; pod_rwa_common::RESERVED_ACCOUNT_BYTES];

        emit!(ReleaseScheduled {
            deal_id: milestone.deal_id,
            milestone_index: milestone.index,
            amount,
            gate_address: milestone.gate_address,
            execute_after: milestone.execute_after,
        });
        Ok(())
    }

    pub fn cancel_release(ctx: Context<CancelRelease>) -> Result<()> {
        require!(
            ctx.accounts.guardian.key() == ctx.accounts.protocol_config.guardian
                || ctx.accounts.guardian.key() == ctx.accounts.protocol_config.governance,
            VaultError::Unauthorized
        );
        require!(
            !ctx.accounts.milestone.executed && ctx.accounts.milestone.scheduled_at > 0,
            VaultError::ReleaseUnavailable
        );
        ctx.accounts.milestone.cancelled = true;
        ctx.accounts.milestone.scheduled_at = 0;
        ctx.accounts.treasury_movement.status = TreasuryMovementStatus::Failed;
        emit!(ReleaseCancelled {
            deal_id: ctx.accounts.milestone.deal_id,
            milestone_index: ctx.accounts.milestone.index,
            authority: ctx.accounts.guardian.key(),
        });
        Ok(())
    }

    pub fn execute_release(
        ctx: Context<ExecuteRelease>,
        release_signature_hash: [u8; 32],
    ) -> Result<()> {
        require!(
            !ctx.accounts.protocol_config.pause_releases,
            VaultError::Paused
        );
        let now = Clock::get()?.unix_timestamp;
        let milestone = &ctx.accounts.milestone;
        require!(
            milestone.scheduled_at > 0 && !milestone.cancelled && !milestone.executed,
            VaultError::ReleaseUnavailable
        );
        require!(now >= milestone.execute_after, VaultError::ReleaseDelayActive);
        require!(
            milestone.expires_at == 0 || now <= milestone.expires_at,
            VaultError::ReleaseExpired
        );
        require!(
            milestone.index == ctx.accounts.deal_state.next_milestone_index,
            VaultError::MilestoneOutOfSequence
        );
        require!(
            ctx.accounts.treasury_movement.status == TreasuryMovementStatus::Approved,
            VaultError::InvalidTreasuryTransition
        );
        require!(
            release_signature_hash != [0; 32],
            VaultError::EvidenceMismatch
        );
        if milestone.gate_kind != ReleaseGateKind::CapitalClose {
            validate_live_oracle_gate(
                &ctx.accounts.oracle_gate_head.to_account_info(),
                &ctx.accounts.oracle_gate_revision.to_account_info(),
                ctx.accounts.protocol_config.oracle_program,
                ctx.accounts.deal_terms.key(),
                ctx.accounts.deal_terms.asset_set_hash,
                ctx.accounts.deal_terms.oracle_policy_hash,
                milestone.index,
                milestone.gate_kind,
                milestone.gate_address,
                milestone.gate_revision,
                milestone.gate_content_hash,
                now,
            )?;
        }
        validate_locked_token_accounts_for_release(&ctx)?;

        transfer_from_vault(
            ctx.accounts.settlement_token_program.to_account_info(),
            ctx.accounts.subscription_vault.to_account_info(),
            ctx.accounts.settlement_mint.to_account_info(),
            ctx.accounts.mse_usdc_ata.to_account_info(),
            ctx.accounts.deal_state.to_account_info(),
            ctx.accounts.deal_terms.deal_id,
            ctx.accounts.deal_state.bump,
            milestone.amount,
            ctx.accounts.deal_terms.settlement_decimals,
        )?;

        let milestone = &mut ctx.accounts.milestone;
        milestone.executed = true;
        milestone.executed_at = now;
        milestone.release_signature_hash = release_signature_hash;
        ctx.accounts.deal_state.total_released =
            checked_add(ctx.accounts.deal_state.total_released, milestone.amount)?;
        ctx.accounts.deal_state.executed_milestones = ctx
            .accounts
            .deal_state
            .executed_milestones
            .checked_add(1)
            .ok_or(VaultError::MathOverflow)?;
        ctx.accounts.deal_state.next_milestone_index = ctx
            .accounts
            .deal_state
            .next_milestone_index
            .checked_add(1)
            .ok_or(VaultError::MathOverflow)?;
        ctx.accounts.deal_state.state = DealState::Active;
        ctx.accounts.treasury_movement.status = TreasuryMovementStatus::UsdcReleased;
        ctx.accounts.treasury_movement.release_signature_hash = release_signature_hash;

        emit!(ReleaseExecuted {
            deal_id: milestone.deal_id,
            milestone_index: milestone.index,
            amount: milestone.amount,
            mse_usdc_ata: ctx.accounts.mse_usdc_ata.key(),
        });
        Ok(())
    }

    pub fn record_conversion(
        ctx: Context<UpdateTreasuryMovement>,
        args: RecordConversionArgs,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.protocol_config.platform_treasury_authority,
            VaultError::Unauthorized
        );
        require!(
            requires_squads_fiat_forward(ctx.accounts.treasury_movement.rail_kind),
            VaultError::InvalidTreasuryTransition
        );
        require!(
            ctx.accounts.treasury_movement.status == TreasuryMovementStatus::UsdcReleased,
            VaultError::InvalidTreasuryTransition
        );
        require!(
            args.net_usd_minor
                .checked_add(args.provider_fees_usd_minor)
                .and_then(|subtotal| subtotal.checked_add(args.bank_fees_usd_minor))
                == Some(args.gross_usd_minor)
                && args.gross_usd_minor > 0
                && args.conversion_rate_e8 > 0
                && args.conversion_provider_hash != [0; 32],
            VaultError::EvidenceMismatch
        );

        let movement = &mut ctx.accounts.treasury_movement;
        movement.conversion_provider_hash = args.conversion_provider_hash;
        movement.gross_usd_minor = args.gross_usd_minor;
        movement.net_usd_minor = args.net_usd_minor;
        movement.conversion_rate_e8 = args.conversion_rate_e8;
        movement.provider_fees_usd_minor = args.provider_fees_usd_minor;
        movement.bank_fees_usd_minor = args.bank_fees_usd_minor;
        movement.converted_at = Clock::get()?.unix_timestamp;
        movement.status = TreasuryMovementStatus::Converted;
        emit!(TreasuryMovementChanged {
            deal_id: movement.deal_id,
            milestone_index: movement.milestone_index,
            status: movement.status,
        });
        Ok(())
    }

    pub fn record_swift_sent(
        ctx: Context<UpdateTreasuryMovement>,
        swift_uetr_hash: [u8; 32],
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.protocol_config.platform_treasury_authority,
            VaultError::Unauthorized
        );
        require!(
            requires_squads_fiat_forward(ctx.accounts.treasury_movement.rail_kind),
            VaultError::InvalidTreasuryTransition
        );
        require!(
            ctx.accounts.treasury_movement.status == TreasuryMovementStatus::Converted
                && swift_uetr_hash != [0; 32],
            VaultError::InvalidTreasuryTransition
        );
        let movement = &mut ctx.accounts.treasury_movement;
        movement.swift_uetr_hash = swift_uetr_hash;
        movement.swift_sent_at = Clock::get()?.unix_timestamp;
        movement.status = TreasuryMovementStatus::SwiftSent;
        emit!(TreasuryMovementChanged {
            deal_id: movement.deal_id,
            milestone_index: movement.milestone_index,
            status: movement.status,
        });
        Ok(())
    }

    pub fn record_bank_confirmation(
        ctx: Context<UpdateTreasuryMovement>,
        bank_confirmation_hash: [u8; 32],
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.protocol_config.governance,
            VaultError::Unauthorized
        );
        require!(
            requires_squads_fiat_forward(ctx.accounts.treasury_movement.rail_kind),
            VaultError::InvalidTreasuryTransition
        );
        require!(
            ctx.accounts.treasury_movement.status == TreasuryMovementStatus::SwiftSent
                && bank_confirmation_hash != [0; 32],
            VaultError::InvalidTreasuryTransition
        );
        let movement = &mut ctx.accounts.treasury_movement;
        movement.bank_confirmation_hash = bank_confirmation_hash;
        movement.bank_confirmed_at = Clock::get()?.unix_timestamp;
        movement.status = TreasuryMovementStatus::BankConfirmed;
        emit!(TreasuryMovementChanged {
            deal_id: movement.deal_id,
            milestone_index: movement.milestone_index,
            status: movement.status,
        });
        Ok(())
    }

    pub fn reconcile_treasury_movement(ctx: Context<UpdateTreasuryMovement>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.protocol_config.governance,
            VaultError::Unauthorized
        );
        require!(
            ctx.accounts.treasury_movement.status
                == reconcile_precondition(ctx.accounts.treasury_movement.rail_kind),
            VaultError::InvalidTreasuryTransition
        );
        let movement = &mut ctx.accounts.treasury_movement;
        movement.reconciled_at = Clock::get()?.unix_timestamp;
        movement.status = TreasuryMovementStatus::Reconciled;
        emit!(TreasuryMovementChanged {
            deal_id: movement.deal_id,
            milestone_index: movement.milestone_index,
            status: movement.status,
        });
        Ok(())
    }

    pub fn deposit_repayment(
        ctx: Context<DepositRepayment>,
        args: AmountWithNonceArgs,
    ) -> Result<()> {
        if is_replayed_receipt(
            &ctx.accounts.operation_receipt,
            ReceiptOperation::Repayment,
            args.amount,
            args.payload_hash,
        )? {
            return Ok(());
        }
        require_keys_eq!(
            ctx.accounts.payer.key(),
            ctx.accounts.deal_terms.servicer_authority,
            VaultError::InvalidRepaymentSource
        );
        require!(
            matches!(
                ctx.accounts.deal_state.state,
                DealState::Active | DealState::DefaultRecovery
            ),
            VaultError::InvalidDealState
        );
        require!(args.amount > 0, VaultError::InvalidTerms);
        validate_settlement_asset_accounts(
            &ctx.accounts.deal_terms,
            &ctx.accounts.settlement_mint,
            &ctx.accounts.settlement_token_program,
        )?;
        require_keys_eq!(
            ctx.accounts.repayment_vault.key(),
            ctx.accounts.deal_terms.repayment_vault,
            VaultError::InvalidTokenAccount
        );
        validate_token_account(
            &ctx.accounts.payer_usdc,
            ctx.accounts.settlement_mint.key(),
            ctx.accounts.payer.key(),
        )?;
        validate_token_account(
            &ctx.accounts.repayment_vault,
            ctx.accounts.settlement_mint.key(),
            ctx.accounts.deal_state.key(),
        )?;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.settlement_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.payer_usdc.to_account_info(),
                    mint: ctx.accounts.settlement_mint.to_account_info(),
                    to: ctx.accounts.repayment_vault.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            args.amount,
            ctx.accounts.deal_terms.settlement_decimals,
        )?;
        ctx.accounts.deal_state.accounted_repayments =
            checked_add(ctx.accounts.deal_state.accounted_repayments, args.amount)?;
        if ctx.accounts.deal_state.accounted_repayments
            >= ctx.accounts.deal_state.repayment_target
        {
            ctx.accounts.deal_state.state = DealState::Repaid;
        }

        initialize_receipt(
            &mut ctx.accounts.operation_receipt,
            ctx.accounts.deal_terms.deal_id,
            ctx.accounts.payer.key(),
            [0; 32],
            args.nonce,
            ReceiptOperation::Repayment,
            args.amount,
            args.payload_hash,
            ctx.bumps.operation_receipt,
        )?;
        emit!(RepaymentDeposited {
            deal_id: ctx.accounts.deal_terms.deal_id,
            payer: ctx.accounts.payer.key(),
            amount: args.amount,
            accounted_total: ctx.accounts.deal_state.accounted_repayments,
        });
        Ok(())
    }

    pub fn sync_repayment_surplus(ctx: Context<SyncRepaymentSurplus>) -> Result<()> {
        require!(
            ctx.accounts.repayment_vault.key() == ctx.accounts.deal_terms.repayment_vault
                && ctx.accounts.repayment_vault.mint
                    == ctx.accounts.deal_terms.settlement_mint
                && ctx.accounts.repayment_vault.owner == ctx.accounts.deal_state.key(),
            VaultError::InvalidTokenAccount
        );
        let actual = ctx.accounts.repayment_vault.amount;
        require!(
            actual >= ctx.accounts.deal_state.accounted_repayments,
            VaultError::AccountingDeficit
        );
        ctx.accounts.deal_state.unallocated_surplus = actual
            .checked_sub(ctx.accounts.deal_state.accounted_repayments)
            .ok_or(VaultError::MathOverflow)?;
        emit!(RepaymentSurplusSynced {
            deal_id: ctx.accounts.deal_terms.deal_id,
            accounted: ctx.accounts.deal_state.accounted_repayments,
            actual,
            surplus: ctx.accounts.deal_state.unallocated_surplus,
        });
        Ok(())
    }

    pub fn allocate_repayment_surplus(
        ctx: Context<AllocateRepaymentSurplus>,
        amount: u64,
        evidence_hash: [u8; 32],
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.governance.key(),
            ctx.accounts.protocol_config.governance,
            VaultError::Unauthorized
        );
        require!(evidence_hash != [0; 32], VaultError::EvidenceMismatch);
        require!(
            amount <= ctx.accounts.deal_state.unallocated_surplus,
            VaultError::AccountingDeficit
        );
        ctx.accounts.deal_state.unallocated_surplus = ctx
            .accounts
            .deal_state
            .unallocated_surplus
            .checked_sub(amount)
            .ok_or(VaultError::MathOverflow)?;
        ctx.accounts.deal_state.accounted_repayments =
            checked_add(ctx.accounts.deal_state.accounted_repayments, amount)?;
        if ctx.accounts.deal_state.accounted_repayments
            >= ctx.accounts.deal_state.repayment_target
        {
            ctx.accounts.deal_state.state = DealState::Repaid;
        }
        emit!(SurplusAllocated {
            deal_id: ctx.accounts.deal_terms.deal_id,
            amount,
            evidence_hash,
        });
        Ok(())
    }

    pub fn enter_default_recovery(ctx: Context<EnterDefaultRecovery>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.risk_authority.key(),
            ctx.accounts.deal_terms.risk_authority,
            VaultError::Unauthorized
        );
        require!(
            matches!(
                ctx.accounts.deal_state.state,
                DealState::Funded | DealState::Active
            )
                && Clock::get()?.unix_timestamp >= ctx.accounts.deal_terms.maturity_at,
            VaultError::SettlementNotReady
        );
        ctx.accounts.deal_state.state = DealState::DefaultRecovery;
        emit!(DealStateChanged {
            deal_id: ctx.accounts.deal_terms.deal_id,
            state: DealState::DefaultRecovery,
        });
        Ok(())
    }

    pub fn finalize_settlement(ctx: Context<FinalizeSettlement>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            !ctx.accounts.deal_state.settlement_finalized
                && (ctx.accounts.deal_state.state == DealState::Repaid
                    || (ctx.accounts.deal_state.state == DealState::DefaultRecovery
                        && now >= ctx.accounts.deal_terms.recovery_cutoff_at)),
            VaultError::SettlementNotReady
        );
        validate_token_account(
            &ctx.accounts.subscription_vault,
            ctx.accounts.settlement_mint.key(),
            ctx.accounts.deal_state.key(),
        )?;
        validate_token_account(
            &ctx.accounts.repayment_vault,
            ctx.accounts.settlement_mint.key(),
            ctx.accounts.deal_state.key(),
        )?;
        require!(
            ctx.accounts.repayment_vault.amount
                >= ctx.accounts.deal_state.accounted_repayments,
            VaultError::AccountingDeficit
        );
        let available = checked_add(
            ctx.accounts.repayment_vault.amount,
            ctx.accounts.subscription_vault.amount,
        )?;
        if ctx.accounts.subscription_vault.amount > 0 {
            transfer_from_vault(
                ctx.accounts.settlement_token_program.to_account_info(),
                ctx.accounts.subscription_vault.to_account_info(),
                ctx.accounts.settlement_mint.to_account_info(),
                ctx.accounts.repayment_vault.to_account_info(),
                ctx.accounts.deal_state.to_account_info(),
                ctx.accounts.deal_terms.deal_id,
                ctx.accounts.deal_state.bump,
                ctx.accounts.subscription_vault.amount,
                ctx.accounts.deal_terms.settlement_decimals,
            )?;
        }

        let state = &mut ctx.accounts.deal_state;
        let investor_pool = available.min(state.repayment_target);
        let remaining = available
            .checked_sub(investor_pool)
            .ok_or(VaultError::MathOverflow)?;
        let fee_target = checked_bps(state.gross_subscriptions, ctx.accounts.deal_terms.fee_bps)
            .ok_or(VaultError::MathOverflow)?;
        let fee_pool = remaining.min(fee_target);
        let issuer_residual = remaining
            .checked_sub(fee_pool)
            .ok_or(VaultError::MathOverflow)?;

        let snapshot = &mut ctx.accounts.settlement;
        snapshot.schema_version = ACCOUNT_SCHEMA_V1;
        snapshot.deal_id = ctx.accounts.deal_terms.deal_id;
        snapshot.finalized_at = now;
        snapshot.claim_deadline_at = ctx.accounts.deal_terms.claim_deadline_at;
        snapshot.supply_snapshot = ctx.accounts.series.issued_supply;
        snapshot.actual_repayment_balance = available;
        snapshot.investor_principal_target = state.gross_subscriptions;
        snapshot.investor_return_target = state.repayment_target;
        snapshot.investor_pool = investor_pool;
        snapshot.fee_pool = fee_pool;
        snapshot.issuer_residual = issuer_residual;
        snapshot.claimed_investor_pool = 0;
        snapshot.restricted_escrow_total = 0;
        snapshot.dust_total = 0;
        snapshot.issuer_distribution_amount = checked_add(fee_pool, issuer_residual)?;
        snapshot.issuer_distribution_withdrawn = false;
        snapshot.defaulted = investor_pool < state.repayment_target;
        snapshot.bump = ctx.bumps.settlement;
        snapshot.reserved = [0; pod_rwa_common::RESERVED_ACCOUNT_BYTES];

        state.investor_pool = investor_pool;
        state.fee_pool = fee_pool;
        state.issuer_residual = issuer_residual;
        state.accounted_repayments = available;
        state.unallocated_surplus = 0;
        state.settlement_finalized = true;
        state.state = DealState::Redeemable;
        emit!(SettlementFinalized {
            deal_id: snapshot.deal_id,
            investor_pool,
            supply: snapshot.supply_snapshot,
            defaulted: snapshot.defaulted,
        });
        Ok(())
    }

    pub fn redeem(ctx: Context<Redeem>, args: RedeemArgs) -> Result<()> {
        redeem_internal(ctx, args, false)
    }

    pub fn restricted_redeem(ctx: Context<Redeem>, args: RedeemArgs) -> Result<()> {
        redeem_internal(ctx, args, true)
    }

    pub fn withdraw_issuer_distribution(
        ctx: Context<WithdrawIssuerDistribution>,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.mse_treasury.key(),
            ctx.accounts.deal_terms.mse_wallet_owner,
            VaultError::Unauthorized
        );
        require!(
            ctx.accounts.deal_state.state == DealState::Settled
                && ctx.accounts.series.burned_supply == ctx.accounts.series.issued_supply,
            VaultError::SettlementNotReady
        );
        require!(
            !ctx.accounts.settlement.issuer_distribution_withdrawn,
            VaultError::IssuerDistributionAlreadyWithdrawn
        );
        validate_token_account(
            &ctx.accounts.repayment_vault,
            ctx.accounts.settlement_mint.key(),
            ctx.accounts.deal_state.key(),
        )?;
        validate_token_account(
            &ctx.accounts.mse_usdc_ata,
            ctx.accounts.settlement_mint.key(),
            ctx.accounts.mse_treasury.key(),
        )?;
        require_keys_eq!(
            ctx.accounts.mse_usdc_ata.key(),
            ctx.accounts.deal_terms.mse_usdc_ata,
            VaultError::InvalidTokenAccount
        );

        let amount = ctx.accounts.settlement.issuer_distribution_amount;
        if amount > 0 {
            transfer_from_vault(
                ctx.accounts.settlement_token_program.to_account_info(),
                ctx.accounts.repayment_vault.to_account_info(),
                ctx.accounts.settlement_mint.to_account_info(),
                ctx.accounts.mse_usdc_ata.to_account_info(),
                ctx.accounts.deal_state.to_account_info(),
                ctx.accounts.deal_terms.deal_id,
                ctx.accounts.deal_state.bump,
                amount,
                ctx.accounts.deal_terms.settlement_decimals,
            )?;
        }
        ctx.accounts.settlement.issuer_distribution_withdrawn = true;
        emit!(IssuerDistributionWithdrawn {
            deal_id: ctx.accounts.deal_terms.deal_id,
            amount,
            mse_usdc_ata: ctx.accounts.mse_usdc_ata.key(),
            dust_retained: ctx.accounts.settlement.dust_total,
        });
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeProtocolArgs {
    pub governance: Pubkey,
    pub guardian: Pubkey,
    pub compliance_authority: Pubkey,
    pub platform_treasury_authority: Pubkey,
    pub oracle_program: Pubkey,
    pub compliance_program: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SetPauseFlagsArgs {
    pub pause_subscriptions: bool,
    pub pause_releases: bool,
    pub pause_transfers: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RegisterMseBeneficiaryArgs {
    pub entity_hash: [u8; 32],
    pub wallet_owner: Pubkey,
    pub usdc_ata: Pubkey,
    pub rail_kind: MseRailKind,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateDealArgs {
    pub deal_id: [u8; 32],
    pub issuer_entity_hash: [u8; 32],
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
    pub servicer_authority: Pubkey,
    pub risk_authority: Pubkey,
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
    pub receipt_extension_set_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ConfigureMilestoneArgs {
    pub index: u8,
    pub gate_kind: ReleaseGateKind,
    pub allocation_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ApproveInvestorArgs {
    pub investor_id: [u8; 32],
    pub wallet: Pubkey,
    pub contribution_cap: u64,
    pub accepted_terms_hash: [u8; 32],
    pub eligibility_expires_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct AmountWithNonceArgs {
    pub amount: u64,
    pub nonce: u64,
    pub payload_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScheduleReleaseArgs {
    pub gate_address: Pubkey,
    pub gate_revision: u32,
    pub gate_content_hash: [u8; 32],
    pub expires_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RecordConversionArgs {
    pub conversion_provider_hash: [u8; 32],
    pub gross_usd_minor: u64,
    pub net_usd_minor: u64,
    pub conversion_rate_e8: u64,
    pub provider_fees_usd_minor: u64,
    pub bank_fees_usd_minor: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RedeemArgs {
    pub nonce: u64,
    pub payload_hash: [u8; 32],
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = payer,
        space = PROTOCOL_CONFIG_SPACE,
        seeds = [b"protocol"],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GovernProtocol<'info> {
    #[account(mut, seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RegisterSettlementAsset<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        init_if_needed,
        payer = governance,
        space = SETTLEMENT_ASSET_SPACE,
        seeds = [b"asset", mint.key().as_ref()],
        bump
    )]
    pub settlement_asset: Account<'info, SettlementAssetConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut)]
    pub governance: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: RegisterMseBeneficiaryArgs)]
pub struct RegisterMseBeneficiary<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        init_if_needed,
        payer = governance,
        space = MSE_BENEFICIARY_SPACE,
        seeds = [b"mse-beneficiary", args.entity_hash.as_ref()],
        bump
    )]
    pub mse_beneficiary: Account<'info, MseBeneficiary>,
    #[account(mut)]
    pub governance: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMseBeneficiaryStatus<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"mse-beneficiary", mse_beneficiary.entity_hash.as_ref()],
        bump = mse_beneficiary.bump
    )]
    pub mse_beneficiary: Account<'info, MseBeneficiary>,
    pub governance: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: CreateDealArgs)]
pub struct CreateDeal<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        seeds = [b"asset", settlement_mint.key().as_ref()],
        bump = settlement_asset.bump
    )]
    pub settlement_asset: Account<'info, SettlementAssetConfig>,
    #[account(
        init,
        payer = governance,
        space = DEAL_TERMS_SPACE,
        seeds = [b"deal_terms", args.deal_id.as_ref()],
        bump
    )]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(
        init,
        payer = governance,
        space = DEAL_STATE_SPACE,
        seeds = [b"deal_state", args.deal_id.as_ref()],
        bump
    )]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(
        init,
        payer = governance,
        space = SERIES_SPACE,
        seeds = [b"series", args.deal_id.as_ref(), &[0]],
        bump
    )]
    pub series: Account<'info, Series>,
    #[account(
        seeds = [b"mse-beneficiary", mse_beneficiary.entity_hash.as_ref()],
        bump = mse_beneficiary.bump
    )]
    pub mse_beneficiary: Account<'info, MseBeneficiary>,
    pub settlement_mint: InterfaceAccount<'info, Mint>,
    pub receipt_mint: InterfaceAccount<'info, Mint>,
    pub compliance_config: Account<'info, pod_compliance::ComplianceConfig>,
    pub transfer_policy: Account<'info, pod_compliance::TransferPolicy>,
    #[account(mut)]
    pub subscription_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub repayment_vault: InterfaceAccount<'info, TokenAccount>,
    pub mse_usdc_ata: InterfaceAccount<'info, TokenAccount>,
    pub compliance_escrow_ata: InterfaceAccount<'info, TokenAccount>,
    pub settlement_token_program: Interface<'info, TokenInterface>,
    pub receipt_token_program: Interface<'info, TokenInterface>,
    #[account(mut)]
    pub governance: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ConfigureMilestoneArgs)]
pub struct ConfigureMilestone<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(
        init,
        payer = governance,
        space = MILESTONE_SPACE,
        seeds = [b"milestone", deal_terms.deal_id.as_ref(), &[args.index]],
        bump
    )]
    pub milestone: Account<'info, ReleaseMilestone>,
    #[account(mut)]
    pub governance: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenSubscription<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    pub governance: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: ApproveInvestorArgs)]
pub struct ApproveInvestor<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(
        init,
        payer = compliance_authority,
        space = POSITION_SPACE,
        seeds = [b"position", deal_terms.deal_id.as_ref(), args.investor_id.as_ref()],
        bump
    )]
    pub position: Account<'info, InvestorDealPosition>,
    #[account(mut)]
    pub compliance_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateInvestorStatus<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(
        mut,
        seeds = [b"position", deal_terms.deal_id.as_ref(), position.investor_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, InvestorDealPosition>,
    pub compliance_authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: AmountWithNonceArgs)]
pub struct Subscribe<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(mut, seeds = [b"series", deal_terms.deal_id.as_ref(), &[0]], bump = series.bump)]
    pub series: Account<'info, Series>,
    #[account(
        mut,
        seeds = [b"position", deal_terms.deal_id.as_ref(), position.investor_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, InvestorDealPosition>,
    pub compliance_config: Account<'info, pod_compliance::ComplianceConfig>,
    pub transfer_policy: Account<'info, pod_compliance::TransferPolicy>,
    pub investor_record: Account<'info, pod_compliance::InvestorRecord>,
    pub wallet_binding: Account<'info, pod_compliance::WalletBinding>,
    pub series_permission: Account<'info, pod_compliance::SeriesPermission>,
    #[account(
        init_if_needed,
        payer = investor,
        space = RECEIPT_SPACE,
        seeds = [
            b"subscription_receipt",
            deal_terms.deal_id.as_ref(),
            position.investor_id.as_ref(),
            args.nonce.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub operation_receipt: Account<'info, OperationReceipt>,
    #[account(mut)]
    pub investor_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub subscription_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub investor_receipt: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub settlement_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub receipt_mint: InterfaceAccount<'info, Mint>,
    pub settlement_token_program: Interface<'info, TokenInterface>,
    pub receipt_token_program: Interface<'info, TokenInterface>,
    #[account(mut)]
    pub investor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeSubscription<'info> {
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(mut, seeds = [b"series", deal_terms.deal_id.as_ref(), &[0]], bump = series.bump)]
    pub series: Account<'info, Series>,
    #[account(mut)]
    pub receipt_mint: InterfaceAccount<'info, Mint>,
    pub receipt_token_program: Interface<'info, TokenInterface>,
    pub finalizer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: AmountWithNonceArgs)]
pub struct ClaimRefund<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(mut, seeds = [b"series", deal_terms.deal_id.as_ref(), &[0]], bump = series.bump)]
    pub series: Account<'info, Series>,
    #[account(
        mut,
        seeds = [b"position", deal_terms.deal_id.as_ref(), position.investor_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, InvestorDealPosition>,
    #[account(
        init_if_needed,
        payer = investor,
        space = RECEIPT_SPACE,
        seeds = [
            b"refund_receipt",
            deal_terms.deal_id.as_ref(),
            position.investor_id.as_ref(),
            args.nonce.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub operation_receipt: Account<'info, OperationReceipt>,
    #[account(mut)]
    pub investor_receipt: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub receipt_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub subscription_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub investor_usdc: InterfaceAccount<'info, TokenAccount>,
    pub settlement_mint: InterfaceAccount<'info, Mint>,
    pub receipt_token_program: Interface<'info, TokenInterface>,
    pub settlement_token_program: Interface<'info, TokenInterface>,
    /// CHECK: pod_compliance validates the config discriminator, owner, and links.
    pub compliance_config: UncheckedAccount<'info>,
    /// CHECK: pod_compliance validates the policy PDA, series, and configured burn caller.
    pub transfer_policy: UncheckedAccount<'info>,
    /// CHECK: pod_compliance validates this wallet-binding PDA.
    pub source_binding: UncheckedAccount<'info>,
    /// CHECK: pod_compliance validates this series-permission PDA.
    pub source_permission: UncheckedAccount<'info>,
    /// CHECK: pod_compliance validates this opaque investor-record PDA.
    pub source_investor: UncheckedAccount<'info>,
    #[account(address = protocol_config.compliance_program)]
    pub compliance_program: Program<'info, pod_compliance::program::PodCompliance>,
    #[account(mut)]
    pub investor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ScheduleRelease<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(
        mut,
        seeds = [b"milestone", deal_terms.deal_id.as_ref(), &[milestone.index]],
        bump = milestone.bump
    )]
    pub milestone: Account<'info, ReleaseMilestone>,
    /// CHECK: owner, discriminator, identity, revision, decision and freshness are validated.
    pub oracle_gate_head: UncheckedAccount<'info>,
    /// CHECK: owner, discriminator, head link, exact hash and exact revision are validated.
    pub oracle_gate_revision: UncheckedAccount<'info>,
    pub previous_treasury_movement: Option<Account<'info, TreasuryMovement>>,
    #[account(
        init,
        payer = treasury_authority,
        space = TREASURY_MOVEMENT_SPACE,
        seeds = [b"treasury_movement", deal_terms.deal_id.as_ref(), &[milestone.index]],
        bump
    )]
    pub treasury_movement: Account<'info, TreasuryMovement>,
    pub risk_authority: Signer<'info>,
    #[account(mut)]
    pub treasury_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelRelease<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut)]
    pub milestone: Account<'info, ReleaseMilestone>,
    #[account(mut)]
    pub treasury_movement: Account<'info, TreasuryMovement>,
    pub guardian: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteRelease<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(mut)]
    pub milestone: Account<'info, ReleaseMilestone>,
    #[account(mut)]
    pub treasury_movement: Account<'info, TreasuryMovement>,
    #[account(mut)]
    pub subscription_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub mse_usdc_ata: InterfaceAccount<'info, TokenAccount>,
    pub settlement_mint: InterfaceAccount<'info, Mint>,
    pub settlement_token_program: Interface<'info, TokenInterface>,
    /// CHECK: revalidated immediately before transfer to reject superseding corrections.
    pub oracle_gate_head: UncheckedAccount<'info>,
    /// CHECK: revalidated immediately before transfer to reject stale or failed revisions.
    pub oracle_gate_revision: UncheckedAccount<'info>,
    pub executor: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateTreasuryMovement<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(
        mut,
        seeds = [
            b"treasury_movement",
            deal_terms.deal_id.as_ref(),
            &[treasury_movement.milestone_index]
        ],
        bump = treasury_movement.bump
    )]
    pub treasury_movement: Account<'info, TreasuryMovement>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: AmountWithNonceArgs)]
pub struct DepositRepayment<'info> {
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(
        init_if_needed,
        payer = payer,
        space = RECEIPT_SPACE,
        seeds = [
            b"repayment_receipt",
            deal_terms.deal_id.as_ref(),
            payer.key().as_ref(),
            args.nonce.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub operation_receipt: Account<'info, OperationReceipt>,
    #[account(mut)]
    pub payer_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub repayment_vault: InterfaceAccount<'info, TokenAccount>,
    pub settlement_mint: InterfaceAccount<'info, Mint>,
    pub settlement_token_program: Interface<'info, TokenInterface>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SyncRepaymentSurplus<'info> {
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(mut)]
    pub repayment_vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct AllocateRepaymentSurplus<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    pub governance: Signer<'info>,
}

#[derive(Accounts)]
pub struct EnterDefaultRecovery<'info> {
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    pub risk_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeSettlement<'info> {
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(seeds = [b"series", deal_terms.deal_id.as_ref(), &[0]], bump = series.bump)]
    pub series: Account<'info, Series>,
    #[account(
        init,
        payer = finalizer,
        space = SETTLEMENT_SPACE,
        seeds = [b"settlement", deal_terms.deal_id.as_ref()],
        bump
    )]
    pub settlement: Account<'info, SettlementSnapshot>,
    #[account(mut)]
    pub subscription_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub repayment_vault: InterfaceAccount<'info, TokenAccount>,
    pub settlement_mint: InterfaceAccount<'info, Mint>,
    pub settlement_token_program: Interface<'info, TokenInterface>,
    #[account(mut)]
    pub finalizer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: RedeemArgs)]
pub struct Redeem<'info> {
    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(mut, seeds = [b"series", deal_terms.deal_id.as_ref(), &[0]], bump = series.bump)]
    pub series: Account<'info, Series>,
    #[account(mut, seeds = [b"settlement", deal_terms.deal_id.as_ref()], bump = settlement.bump)]
    pub settlement: Account<'info, SettlementSnapshot>,
    #[account(
        mut,
        seeds = [b"position", deal_terms.deal_id.as_ref(), position.investor_id.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, InvestorDealPosition>,
    #[account(
        init_if_needed,
        payer = investor,
        space = RECEIPT_SPACE,
        seeds = [
            b"redemption_receipt",
            deal_terms.deal_id.as_ref(),
            position.investor_id.as_ref(),
            args.nonce.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub operation_receipt: Account<'info, OperationReceipt>,
    #[account(mut)]
    pub investor_receipt: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub receipt_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub repayment_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub investor_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub compliance_escrow_ata: InterfaceAccount<'info, TokenAccount>,
    pub settlement_mint: InterfaceAccount<'info, Mint>,
    pub receipt_token_program: Interface<'info, TokenInterface>,
    pub settlement_token_program: Interface<'info, TokenInterface>,
    /// CHECK: pod_compliance validates the config discriminator, owner, and links.
    pub compliance_config: UncheckedAccount<'info>,
    /// CHECK: pod_compliance validates the policy PDA, series, and configured burn caller.
    pub transfer_policy: UncheckedAccount<'info>,
    /// CHECK: pod_compliance validates this wallet-binding PDA.
    pub source_binding: UncheckedAccount<'info>,
    /// CHECK: pod_compliance validates this series-permission PDA.
    pub source_permission: UncheckedAccount<'info>,
    /// CHECK: pod_compliance validates this opaque investor-record PDA.
    pub source_investor: UncheckedAccount<'info>,
    #[account(address = protocol_config.compliance_program)]
    pub compliance_program: Program<'info, pod_compliance::program::PodCompliance>,
    #[account(mut)]
    pub investor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawIssuerDistribution<'info> {
    #[account(seeds = [b"deal_terms", deal_terms.deal_id.as_ref()], bump = deal_terms.bump)]
    pub deal_terms: Account<'info, DealTerms>,
    #[account(mut, seeds = [b"deal_state", deal_terms.deal_id.as_ref()], bump = deal_state.bump)]
    pub deal_state: Account<'info, DealStateAccount>,
    #[account(seeds = [b"series", deal_terms.deal_id.as_ref(), &[0]], bump = series.bump)]
    pub series: Account<'info, Series>,
    #[account(mut, seeds = [b"settlement", deal_terms.deal_id.as_ref()], bump = settlement.bump)]
    pub settlement: Account<'info, SettlementSnapshot>,
    #[account(mut)]
    pub repayment_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub mse_usdc_ata: InterfaceAccount<'info, TokenAccount>,
    pub settlement_mint: InterfaceAccount<'info, Mint>,
    pub settlement_token_program: Interface<'info, TokenInterface>,
    pub mse_treasury: Signer<'info>,
}

fn validate_create_deal(ctx: &Context<CreateDeal>, args: &CreateDealArgs) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.governance.key(),
        ctx.accounts.protocol_config.governance,
        VaultError::Unauthorized
    );
    require!(
        ctx.accounts.settlement_asset.enabled
            && ctx.accounts.settlement_asset.mint == ctx.accounts.settlement_mint.key()
            && ctx.accounts.settlement_asset.token_program
                == ctx.accounts.settlement_token_program.key()
            && ctx.accounts.settlement_asset.decimals == ctx.accounts.settlement_mint.decimals,
        VaultError::InvalidSettlementAsset
    );
    require_keys_eq!(
        *ctx.accounts.settlement_mint.to_account_info().owner,
        ctx.accounts.settlement_token_program.key(),
        VaultError::InvalidSettlementAsset
    );
    require_keys_eq!(
        *ctx.accounts.receipt_mint.to_account_info().owner,
        token_2022::ID,
        VaultError::InvalidReceiptMint
    );
    require_keys_eq!(
        ctx.accounts.receipt_token_program.key(),
        token_2022::ID,
        VaultError::InvalidReceiptMint
    );
    require!(
        ctx.accounts.receipt_mint.decimals == ctx.accounts.settlement_mint.decimals,
        VaultError::InvalidReceiptMint
    );
    require!(
        ctx.accounts.receipt_mint.supply == 0
            && ctx.accounts.receipt_mint.mint_authority
                == COption::Some(ctx.accounts.series.key())
            && ctx.accounts.receipt_mint.freeze_authority
                == COption::Some(ctx.accounts.compliance_config.key()),
        VaultError::InvalidReceiptMint
    );
    validate_compliance_series_setup(ctx)?;
    let receipt_extension_set_hash = validate_receipt_mint_extensions(
        &ctx.accounts.receipt_mint.to_account_info(),
        ctx.accounts.protocol_config.compliance_program,
        ctx.accounts.compliance_config.recovery_authority,
        ctx.accounts.transfer_policy.key(),
    )?;
    require!(
        args.receipt_extension_set_hash == receipt_extension_set_hash,
        VaultError::InvalidReceiptExtension
    );
    require!(
        ctx.accounts.mse_beneficiary.status == MseBeneficiaryStatus::Active,
        VaultError::InactiveMseBeneficiary
    );
    require!(
        args.issuer_entity_hash != ctx.accounts.mse_beneficiary.entity_hash,
        VaultError::IssuerBeneficiaryCollision
    );
    require!(
        ctx.accounts.mse_beneficiary.wallet_owner != args.risk_authority
            && ctx.accounts.mse_beneficiary.wallet_owner
                != ctx.accounts.protocol_config.governance
            && args.risk_authority != ctx.accounts.protocol_config.governance,
        VaultError::AuthorityCollision
    );
    require!(
        args.subscription_open_at < args.subscription_close_at
            && args.subscription_close_at < args.maturity_at
            && args.maturity_at <= args.recovery_cutoff_at
            && args.recovery_cutoff_at <= args.claim_deadline_at
            && args.minimum_raise > 0
            && args.minimum_raise <= args.hard_cap
            && args.coupon_bps <= BPS_DENOMINATOR
            && args.fee_bps <= BPS_DENOMINATOR
            && args.milestone_count > 0
            && usize::from(args.milestone_count) <= pod_rwa_common::MAX_RELEASE_MILESTONES
            && args.terms_hash != [0; 32]
            && args.document_bundle_hash != [0; 32],
        VaultError::InvalidTerms
    );
    // A SWIFT/bank route is only meaningful for the Squads fiat-forward rail; a
    // direct-USDC MSE has no off-chain bank leg, so its bank route may be empty.
    require!(
        ctx.accounts.mse_beneficiary.rail_kind != MseRailKind::SquadsFiatForward
            || args.bank_route_hash != [0; 32],
        VaultError::InvalidTerms
    );
    require!(
        ctx.accounts.subscription_vault.key() != ctx.accounts.repayment_vault.key(),
        VaultError::InvalidTokenAccount
    );
    validate_token_account(
        &ctx.accounts.subscription_vault,
        ctx.accounts.settlement_mint.key(),
        ctx.accounts.deal_state.key(),
    )?;
    validate_token_account(
        &ctx.accounts.repayment_vault,
        ctx.accounts.settlement_mint.key(),
        ctx.accounts.deal_state.key(),
    )?;
    require_keys_eq!(
        ctx.accounts.mse_usdc_ata.key(),
        ctx.accounts.mse_beneficiary.usdc_ata,
        VaultError::InvalidTokenAccount
    );
    validate_token_account(
        &ctx.accounts.mse_usdc_ata,
        ctx.accounts.settlement_mint.key(),
        ctx.accounts.mse_beneficiary.wallet_owner,
    )?;
    require_keys_eq!(
        ctx.accounts.compliance_escrow_ata.mint,
        ctx.accounts.settlement_mint.key(),
        VaultError::InvalidTokenAccount
    );
    require_keys_eq!(
        ctx.accounts.compliance_escrow_ata.owner,
        ctx.accounts.compliance_config.key(),
        VaultError::InvalidTokenAccount
    );
    Ok(())
}

fn validate_compliance_series_setup(ctx: &Context<CreateDeal>) -> Result<()> {
    let compliance_program = ctx.accounts.protocol_config.compliance_program;
    require_keys_eq!(
        compliance_program,
        pod_compliance::ID,
        VaultError::InvalidComplianceState
    );
    let (expected_config, _) = Pubkey::find_program_address(
        &[pod_compliance::COMPLIANCE_CONFIG_SEED],
        &compliance_program,
    );
    let (expected_policy, _) = Pubkey::find_program_address(
        &[
            pod_compliance::TRANSFER_POLICY_SEED,
            ctx.accounts.receipt_mint.key().as_ref(),
        ],
        &compliance_program,
    );
    require_keys_eq!(
        ctx.accounts.compliance_config.key(),
        expected_config,
        VaultError::InvalidComplianceState
    );
    require_keys_eq!(
        ctx.accounts.transfer_policy.key(),
        expected_policy,
        VaultError::InvalidComplianceState
    );
    require!(
        ctx.accounts.compliance_config.schema_version == ACCOUNT_SCHEMA_V1
            && !ctx.accounts.compliance_config.paused
            && ctx.accounts.transfer_policy.schema_version == ACCOUNT_SCHEMA_V1
            && ctx.accounts.transfer_policy.config == expected_config
            && ctx.accounts.transfer_policy.series == ctx.accounts.receipt_mint.key()
            && ctx.accounts.transfer_policy.issuer
                == ctx.accounts.protocol_config.platform_treasury_authority
            && ctx.accounts.transfer_policy.burn_caller == ctx.accounts.series.key()
            && ctx.accounts.transfer_policy.mode == TransferPolicyMode::IssuerRestricted
            && ctx.accounts.transfer_policy.active,
        VaultError::InvalidComplianceState
    );
    Ok(())
}

fn validate_receipt_mint_extensions(
    mint_info: &AccountInfo,
    compliance_program: Pubkey,
    recovery_authority: Pubkey,
    permissioned_burn_authority: Pubkey,
) -> Result<[u8; 32]> {
    let default_state = get_mint_extension_data::<DefaultAccountState>(mint_info)
        .map_err(|_| error!(VaultError::InvalidReceiptExtension))?;
    require!(
        default_state.state == TokenAccountState::Frozen as u8,
        VaultError::InvalidReceiptExtension
    );

    let permanent_delegate = get_mint_extension_data::<PermanentDelegate>(mint_info)
        .map_err(|_| error!(VaultError::InvalidReceiptExtension))?;
    require!(
        Option::<Pubkey>::from(permanent_delegate.delegate) == Some(recovery_authority),
        VaultError::InvalidReceiptExtension
    );

    let transfer_hook = get_mint_extension_data::<TransferHook>(mint_info)
        .map_err(|_| error!(VaultError::InvalidReceiptExtension))?;
    require!(
        Option::<Pubkey>::from(transfer_hook.authority).is_none()
            && Option::<Pubkey>::from(transfer_hook.program_id) == Some(compliance_program),
        VaultError::InvalidReceiptExtension
    );

    let metadata_pointer = get_mint_extension_data::<MetadataPointer>(mint_info)
        .map_err(|_| error!(VaultError::InvalidReceiptExtension))?;
    require!(
        Option::<Pubkey>::from(metadata_pointer.authority).is_none()
            && Option::<Pubkey>::from(metadata_pointer.metadata_address).is_some(),
        VaultError::InvalidReceiptExtension
    );

    let data = mint_info.try_borrow_data()?;
    let extensions = parse_mint_tlv_extensions(&data)?;
    let expected_types = [
        EXTENSION_DEFAULT_ACCOUNT_STATE,
        EXTENSION_PERMANENT_DELEGATE,
        EXTENSION_TRANSFER_HOOK,
        EXTENSION_METADATA_POINTER,
        EXTENSION_PERMISSIONED_BURN,
    ];
    require!(
        extensions.len() == expected_types.len()
            && expected_types
                .iter()
                .all(|expected| extensions.iter().any(|(kind, _)| kind == expected)),
        VaultError::InvalidReceiptExtension
    );
    let permissioned_burn = extensions
        .iter()
        .find(|(kind, _)| *kind == EXTENSION_PERMISSIONED_BURN)
        .map(|(_, value)| value)
        .ok_or(VaultError::InvalidReceiptExtension)?;
    require!(
        permissioned_burn.as_slice() == permissioned_burn_authority.as_ref(),
        VaultError::InvalidReceiptExtension
    );

    let mut canonical = Vec::new();
    for expected in expected_types {
        let value = extensions
            .iter()
            .find(|(kind, _)| *kind == expected)
            .map(|(_, value)| value)
            .ok_or(VaultError::InvalidReceiptExtension)?;
        canonical.extend_from_slice(&expected.to_le_bytes());
        canonical.extend_from_slice(&(value.len() as u16).to_le_bytes());
        canonical.extend_from_slice(value);
    }
    Ok(domain_hash(RECEIPT_EXTENSION_HASH_DOMAIN, &canonical))
}

fn parse_mint_tlv_extensions(data: &[u8]) -> Result<Vec<(u16, Vec<u8>)>> {
    require!(
        data.len() >= TOKEN_2022_MINT_TLV_OFFSET && data[165] == 1,
        VaultError::InvalidReceiptExtension
    );
    let mut cursor = TOKEN_2022_MINT_TLV_OFFSET;
    let mut extensions = Vec::new();
    while cursor + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[cursor], data[cursor + 1]]);
        let length = u16::from_le_bytes([data[cursor + 2], data[cursor + 3]]) as usize;
        if kind == 0 {
            require!(
                length == 0 && data[cursor..].iter().all(|byte| *byte == 0),
                VaultError::InvalidReceiptExtension
            );
            break;
        }
        let value_start = cursor
            .checked_add(4)
            .ok_or(VaultError::InvalidReceiptExtension)?;
        let value_end = value_start
            .checked_add(length)
            .ok_or(VaultError::InvalidReceiptExtension)?;
        require!(
            value_end <= data.len()
                && !extensions.iter().any(|(existing, _)| *existing == kind),
            VaultError::InvalidReceiptExtension
        );
        extensions.push((kind, data[value_start..value_end].to_vec()));
        cursor = value_end;
    }
    Ok(extensions)
}

fn validate_token_account(
    account: &InterfaceAccount<TokenAccount>,
    mint: Pubkey,
    owner: Pubkey,
) -> Result<()> {
    require!(
        account.mint == mint && account.owner == owner,
        VaultError::InvalidTokenAccount
    );
    Ok(())
}

fn validate_settlement_asset_accounts(
    terms: &Account<DealTerms>,
    mint: &InterfaceAccount<Mint>,
    token_program: &Interface<TokenInterface>,
) -> Result<()> {
    require!(
        mint.key() == terms.settlement_mint
            && token_program.key() == terms.settlement_token_program
            && mint.decimals == terms.settlement_decimals
            && *mint.to_account_info().owner == token_program.key(),
        VaultError::InvalidSettlementAsset
    );
    Ok(())
}

fn validate_receipt_series_accounts(
    terms: &Account<DealTerms>,
    series: &Account<Series>,
    mint: &InterfaceAccount<Mint>,
    token_program: &Interface<TokenInterface>,
    mint_authority_open: bool,
) -> Result<()> {
    require!(
        mint.key() == terms.receipt_mint
            && series.receipt_mint == terms.receipt_mint
            && series.token_program == terms.receipt_token_program
            && token_program.key() == terms.receipt_token_program
            && token_program.key() == token_2022::ID
            && *mint.to_account_info().owner == token_2022::ID
            && mint.decimals == series.decimals,
        VaultError::InvalidReceiptMint
    );
    let expected_authority = if mint_authority_open {
        COption::Some(series.key())
    } else {
        COption::None
    };
    require!(
        mint.mint_authority == expected_authority,
        VaultError::InvalidReceiptMint
    );
    Ok(())
}

fn revoke_receipt_mint_authority<'info>(
    token_program: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    series: AccountInfo<'info>,
    deal_id: [u8; 32],
    series_bump: u8,
) -> Result<()> {
    let series_seeds: &[&[u8]] = &[b"series", deal_id.as_ref(), &[0], &[series_bump]];
    token_2022::set_authority(
        CpiContext::new_with_signer(
            *token_program.key,
            SetAuthority {
                current_authority: series,
                account_or_mint: mint,
            },
            &[series_seeds],
        ),
        token_2022::spl_token_2022::instruction::AuthorityType::MintTokens,
        None,
    )
}

fn validate_subscription(ctx: &Context<Subscribe>, args: &AmountWithNonceArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        !ctx.accounts.protocol_config.pause_subscriptions,
        VaultError::Paused
    );
    require!(
        ctx.accounts.deal_state.state == DealState::SubscriptionOpen
            && now >= ctx.accounts.deal_terms.subscription_open_at
            && now < ctx.accounts.deal_terms.subscription_close_at,
        VaultError::SubscriptionWindowClosed
    );
    require_keys_eq!(
        ctx.accounts.position.wallet,
        ctx.accounts.investor.key(),
        VaultError::Unauthorized
    );
    require!(
        ctx.accounts.position.eligibility_status == EligibilityStatus::Active
            && ctx.accounts.position.eligibility_expires_at > now,
        VaultError::InvestorNotEligible
    );
    require!(
        ctx.accounts.position.accepted_terms_hash == ctx.accounts.deal_terms.terms_hash,
        VaultError::TermsNotAccepted
    );
    require!(args.amount > 0, VaultError::InvalidTerms);
    require!(
        checked_add(ctx.accounts.position.contributed, args.amount)?
            <= ctx.accounts.position.contribution_cap
            && checked_add(ctx.accounts.deal_state.gross_subscriptions, args.amount)?
                <= ctx.accounts.deal_terms.hard_cap,
        VaultError::SubscriptionCapExceeded
    );
    validate_compliance_subscription(ctx, now, args.amount)?;
    validate_settlement_asset_accounts(
        &ctx.accounts.deal_terms,
        &ctx.accounts.settlement_mint,
        &ctx.accounts.settlement_token_program,
    )?;
    validate_receipt_series_accounts(
        &ctx.accounts.deal_terms,
        &ctx.accounts.series,
        &ctx.accounts.receipt_mint,
        &ctx.accounts.receipt_token_program,
        true,
    )?;
    validate_token_account(
        &ctx.accounts.investor_usdc,
        ctx.accounts.settlement_mint.key(),
        ctx.accounts.investor.key(),
    )?;
    validate_token_account(
        &ctx.accounts.subscription_vault,
        ctx.accounts.settlement_mint.key(),
        ctx.accounts.deal_state.key(),
    )?;
    require_keys_eq!(
        ctx.accounts.subscription_vault.key(),
        ctx.accounts.deal_terms.subscription_vault,
        VaultError::InvalidTokenAccount
    );
    validate_token_account(
        &ctx.accounts.investor_receipt,
        ctx.accounts.receipt_mint.key(),
        ctx.accounts.investor.key(),
    )?;
    let canonical_receipt = get_associated_token_address_with_program_id(
        &ctx.accounts.investor.key(),
        &ctx.accounts.receipt_mint.key(),
        &token_2022::ID,
    );
    require!(
        ctx.accounts.investor_receipt.key() == canonical_receipt
            && ctx.accounts.investor_receipt.state == TokenAccountState::Initialized,
        VaultError::ReceiptAccountUnavailable
    );
    Ok(())
}

fn validate_compliance_subscription(
    ctx: &Context<Subscribe>,
    now: i64,
    amount: u64,
) -> Result<()> {
    let compliance_program = ctx.accounts.protocol_config.compliance_program;
    let wallet = ctx.accounts.investor.key();
    let receipt_mint = ctx.accounts.receipt_mint.key();
    let (config_key, _) = Pubkey::find_program_address(
        &[pod_compliance::COMPLIANCE_CONFIG_SEED],
        &compliance_program,
    );
    let (policy_key, _) = Pubkey::find_program_address(
        &[pod_compliance::TRANSFER_POLICY_SEED, receipt_mint.as_ref()],
        &compliance_program,
    );
    let (investor_key, _) = Pubkey::find_program_address(
        &[
            pod_compliance::INVESTOR_SEED,
            ctx.accounts.investor_record.opaque_id.as_ref(),
        ],
        &compliance_program,
    );
    let (binding_key, _) = Pubkey::find_program_address(
        &[pod_compliance::WALLET_BINDING_SEED, wallet.as_ref()],
        &compliance_program,
    );
    let (permission_key, _) = Pubkey::find_program_address(
        &[
            pod_compliance::SERIES_PERMISSION_SEED,
            receipt_mint.as_ref(),
            wallet.as_ref(),
        ],
        &compliance_program,
    );

    require_keys_eq!(
        ctx.accounts.compliance_config.key(),
        config_key,
        VaultError::InvalidComplianceState
    );
    require_keys_eq!(
        ctx.accounts.transfer_policy.key(),
        policy_key,
        VaultError::InvalidComplianceState
    );
    require_keys_eq!(
        ctx.accounts.investor_record.key(),
        investor_key,
        VaultError::InvalidComplianceState
    );
    require_keys_eq!(
        ctx.accounts.wallet_binding.key(),
        binding_key,
        VaultError::InvalidComplianceState
    );
    require_keys_eq!(
        ctx.accounts.series_permission.key(),
        permission_key,
        VaultError::InvalidComplianceState
    );

    let next_contribution = checked_add(ctx.accounts.position.contributed, amount)?;
    require!(
        compliance_program == pod_compliance::ID
            && ctx.accounts.compliance_config.schema_version == ACCOUNT_SCHEMA_V1
            && !ctx.accounts.compliance_config.paused
            && ctx.accounts.transfer_policy.schema_version == ACCOUNT_SCHEMA_V1
            && ctx.accounts.transfer_policy.config == config_key
            && ctx.accounts.transfer_policy.series == receipt_mint
            && ctx.accounts.transfer_policy.active
            && ctx.accounts.investor_record.schema_version == ACCOUNT_SCHEMA_V1
            && ctx.accounts.investor_record.config == config_key
            && ctx.accounts.investor_record.opaque_id == ctx.accounts.position.investor_id
            && ctx.accounts.investor_record.current_wallet == wallet
            && ctx.accounts.investor_record.has_wallet
            && ctx.accounts.investor_record.status == EligibilityStatus::Active
            && ctx.accounts.investor_record.expires_at > now
            && ctx.accounts.wallet_binding.schema_version == ACCOUNT_SCHEMA_V1
            && ctx.accounts.wallet_binding.config == config_key
            && ctx.accounts.wallet_binding.investor_record == investor_key
            && ctx.accounts.wallet_binding.wallet == wallet
            && ctx.accounts.wallet_binding.active
            && !ctx.accounts.wallet_binding.pending_recovery
            && ctx.accounts.series_permission.schema_version == ACCOUNT_SCHEMA_V1
            && ctx.accounts.series_permission.config == config_key
            && ctx.accounts.series_permission.series == receipt_mint
            && ctx.accounts.series_permission.investor_record == investor_key
            && ctx.accounts.series_permission.wallet == wallet
            && ctx.accounts.series_permission.provider_record
                == ctx.accounts.investor_record.provider_record
            && ctx.accounts.series_permission.status == EligibilityStatus::Active
            && ctx.accounts.series_permission.expires_at > now
            && ctx.accounts.series_permission.accepted_terms_hash
                == ctx.accounts.deal_terms.terms_hash
            && next_contribution <= ctx.accounts.series_permission.max_investment,
        VaultError::InvalidComplianceState
    );
    Ok(())
}

fn validate_release_schedule(
    ctx: &Context<ScheduleRelease>,
    args: &ScheduleReleaseArgs,
) -> Result<()> {
    require!(
        !ctx.accounts.protocol_config.pause_releases,
        VaultError::Paused
    );
    require_keys_eq!(
        ctx.accounts.risk_authority.key(),
        ctx.accounts.deal_terms.risk_authority,
        VaultError::Unauthorized
    );
    require_keys_eq!(
        ctx.accounts.treasury_authority.key(),
        ctx.accounts.protocol_config.platform_treasury_authority,
        VaultError::Unauthorized
    );
    require!(
        ctx.accounts.deal_state.mint_authority_revoked,
        VaultError::MintAuthorityStillActive
    );
    require!(
        matches!(
            ctx.accounts.deal_state.state,
            DealState::Funded | DealState::Active
        ),
        VaultError::InvalidDealState
    );
    require!(
        ctx.accounts.milestone.index == ctx.accounts.deal_state.next_milestone_index
            && !ctx.accounts.milestone.executed
            && ctx.accounts.milestone.scheduled_at == 0,
        VaultError::MilestoneOutOfSequence
    );

    if ctx.accounts.milestone.index > 0 {
        let previous = ctx
            .accounts
            .previous_treasury_movement
            .as_ref()
            .ok_or(VaultError::PriorDisbursementUnconfirmed)?;
        require!(
            previous.deal_id == ctx.accounts.deal_terms.deal_id
                && previous.milestone_index + 1 == ctx.accounts.milestone.index
                && previous.status == TreasuryMovementStatus::Reconciled,
            VaultError::PriorDisbursementUnconfirmed
        );
    }

    match ctx.accounts.milestone.gate_kind {
        ReleaseGateKind::CapitalClose => {
            require!(
                ctx.accounts.milestone.index == 0
                    && args.gate_address == Pubkey::default()
                    && args.gate_content_hash == [0; 32],
                VaultError::InvalidOracleGate
            );
        }
        ReleaseGateKind::T1Pass | ReleaseGateKind::T2Pass | ReleaseGateKind::T3Pass => {
            validate_live_oracle_gate(
                &ctx.accounts.oracle_gate_head.to_account_info(),
                &ctx.accounts.oracle_gate_revision.to_account_info(),
                ctx.accounts.protocol_config.oracle_program,
                ctx.accounts.deal_terms.key(),
                ctx.accounts.deal_terms.asset_set_hash,
                ctx.accounts.deal_terms.oracle_policy_hash,
                ctx.accounts.milestone.index,
                ctx.accounts.milestone.gate_kind,
                args.gate_address,
                args.gate_revision,
                args.gate_content_hash,
                Clock::get()?.unix_timestamp,
            )?;
        }
    }

    let execute_after = Clock::get()?
        .unix_timestamp
        .checked_add(i64::from(ctx.accounts.deal_terms.release_delay_seconds))
        .ok_or(VaultError::MathOverflow)?;
    require!(
        args.expires_at == 0 || args.expires_at > execute_after,
        VaultError::ReleaseExpired
    );
    if ctx.accounts.milestone.gate_kind != ReleaseGateKind::CapitalClose {
        let revision = deserialize_oracle_account::<pod_oracle::DealGateRevision>(
            &ctx.accounts.oracle_gate_revision.to_account_info(),
            ctx.accounts.protocol_config.oracle_program,
        )?;
        require!(
            args.expires_at > 0 && args.expires_at <= revision.expires_at,
            VaultError::ReleaseExpired
        );
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_live_oracle_gate(
    head_info: &AccountInfo,
    revision_info: &AccountInfo,
    oracle_program: Pubkey,
    deal: Pubkey,
    asset_set_hash: [u8; 32],
    policy_hash: [u8; 32],
    milestone_index: u8,
    gate_kind: ReleaseGateKind,
    expected_revision_address: Pubkey,
    expected_revision: u32,
    expected_content_hash: [u8; 32],
    now: i64,
) -> Result<()> {
    require_keys_eq!(oracle_program, pod_oracle::ID, VaultError::InvalidOracleGate);
    require_keys_eq!(
        revision_info.key(),
        expected_revision_address,
        VaultError::InvalidOracleGate
    );
    require!(
        expected_revision > 0 && expected_content_hash != [0; 32],
        VaultError::InvalidOracleGate
    );
    let head =
        deserialize_oracle_account::<pod_oracle::DealGateHead>(head_info, oracle_program)?;
    let revision =
        deserialize_oracle_account::<pod_oracle::DealGateRevision>(revision_info, oracle_program)?;
    require!(
        head.schema_version == ACCOUNT_SCHEMA_V1
            && revision.schema_version == ACCOUNT_SCHEMA_V1
            && head.deal == deal
            && revision.deal == deal
            && head.milestone_index == milestone_index
            && revision.milestone_index == milestone_index
            && head.gate_kind == gate_kind
            && revision.gate_kind == gate_kind
            && head.asset_set_hash == asset_set_hash
            && revision.asset_set_hash == asset_set_hash
            && revision.policy_hash == policy_hash
            && revision.head == head_info.key()
            && revision.revision == expected_revision
            && revision.content_hash == expected_content_hash,
        VaultError::InvalidOracleGate
    );
    pod_oracle::assert_live_gate(&head, revision_info.key(), &revision, now)
        .map_err(|_| error!(VaultError::InvalidOracleGate))
}

fn deserialize_oracle_account<T: AccountDeserialize>(
    info: &AccountInfo,
    oracle_program: Pubkey,
) -> Result<T> {
    require_keys_eq!(*info.owner, oracle_program, VaultError::InvalidOracleGate);
    let data = info
        .try_borrow_data()
        .map_err(|_| error!(VaultError::InvalidOracleGate))?;
    let mut bytes: &[u8] = &data;
    T::try_deserialize(&mut bytes).map_err(|_| error!(VaultError::InvalidOracleGate))
}

fn validate_locked_token_accounts_for_release(ctx: &Context<ExecuteRelease>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.settlement_mint.key(),
        ctx.accounts.deal_terms.settlement_mint,
        VaultError::InvalidSettlementAsset
    );
    require_keys_eq!(
        ctx.accounts.settlement_token_program.key(),
        ctx.accounts.deal_terms.settlement_token_program,
        VaultError::InvalidSettlementAsset
    );
    require_keys_eq!(
        ctx.accounts.mse_usdc_ata.key(),
        ctx.accounts.deal_terms.mse_usdc_ata,
        VaultError::InvalidTokenAccount
    );
    validate_token_account(
        &ctx.accounts.subscription_vault,
        ctx.accounts.settlement_mint.key(),
        ctx.accounts.deal_state.key(),
    )?;
    validate_token_account(
        &ctx.accounts.mse_usdc_ata,
        ctx.accounts.settlement_mint.key(),
        ctx.accounts.deal_terms.mse_wallet_owner,
    )
}

/// The status a treasury movement must hold before it can be reconciled, which
/// differs by rail: the Squads fiat-forward rail must clear its full off-chain
/// evidence chain through `BankConfirmed`, while a direct-USDC movement is complete
/// once the stablecoin has left the vault.
fn reconcile_precondition(rail: MseRailKind) -> TreasuryMovementStatus {
    match rail {
        MseRailKind::SquadsFiatForward => TreasuryMovementStatus::BankConfirmed,
        MseRailKind::DirectUsdc => TreasuryMovementStatus::UsdcReleased,
    }
}

/// Whether a rail records the conversion, SWIFT and bank-confirmation evidence
/// stages. Only the Squads fiat-forward rail has an off-chain USD leg; direct-USDC
/// movements must never enter those stages.
fn requires_squads_fiat_forward(rail: MseRailKind) -> bool {
    matches!(rail, MseRailKind::SquadsFiatForward)
}

fn is_replayed_receipt(
    receipt: &Account<OperationReceipt>,
    operation: ReceiptOperation,
    amount: u64,
    payload_hash: [u8; 32],
) -> Result<bool> {
    if receipt.schema_version == 0 {
        return Ok(false);
    }
    require!(
        receipt.schema_version == ACCOUNT_SCHEMA_V1
            && receipt.operation == operation
            && receipt.amount == amount
            && receipt.payload_hash == payload_hash,
        VaultError::IdempotencyConflict
    );
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn initialize_receipt(
    receipt: &mut Account<OperationReceipt>,
    deal_id: [u8; 32],
    actor: Pubkey,
    investor_id: [u8; 32],
    nonce: u64,
    operation: ReceiptOperation,
    amount: u64,
    payload_hash: [u8; 32],
    bump: u8,
) -> Result<()> {
    require!(payload_hash != [0; 32], VaultError::IdempotencyConflict);
    receipt.schema_version = ACCOUNT_SCHEMA_V1;
    receipt.deal_id = deal_id;
    receipt.actor = actor;
    receipt.investor_id = investor_id;
    receipt.nonce = nonce;
    receipt.operation = operation;
    receipt.amount = amount;
    receipt.payload_hash = payload_hash;
    receipt.created_at = Clock::get()?.unix_timestamp;
    receipt.bump = bump;
    receipt.reserved = [0; pod_rwa_common::RESERVED_ACCOUNT_BYTES];
    Ok(())
}

fn checked_add(lhs: u64, rhs: u64) -> Result<u64> {
    lhs.checked_add(rhs).ok_or_else(|| error!(VaultError::MathOverflow))
}

#[allow(clippy::too_many_arguments)]
fn transfer_from_vault<'info>(
    token_program: AccountInfo<'info>,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    deal_id: [u8; 32],
    bump: u8,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let state_seeds: &[&[u8]] = &[b"deal_state", deal_id.as_ref(), &[bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            *token_program.key,
            TransferChecked {
                from,
                mint,
                to,
                authority,
            },
            &[state_seeds],
        ),
        amount,
        decimals,
    )
}

#[allow(clippy::too_many_arguments)]
fn permissioned_burn_receipts<'info>(
    compliance_program: Pubkey,
    config: AccountInfo<'info>,
    transfer_policy: AccountInfo<'info>,
    source_binding: AccountInfo<'info>,
    source_permission: AccountInfo<'info>,
    source_investor: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    source_token: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    burn_caller: AccountInfo<'info>,
    source_owner: AccountInfo<'info>,
    deal_id: [u8; 32],
    series_bump: u8,
    amount: u64,
    decimals: u8,
    purpose: BurnPurpose,
) -> Result<()> {
    let series_seeds: &[&[u8]] = &[b"series", deal_id.as_ref(), &[0], &[series_bump]];
    pod_compliance::cpi::permissioned_burn(
        CpiContext::new_with_signer(
            compliance_program,
            pod_compliance::cpi::accounts::PermissionedBurn {
                config,
                transfer_policy,
                source_binding,
                source_permission,
                source_investor,
                source_token,
                mint,
                burn_caller,
                source_owner,
                token_program,
            },
            &[series_seeds],
        ),
        amount,
        decimals,
        purpose,
    )
}

fn redeem_internal(ctx: Context<Redeem>, args: RedeemArgs, restricted: bool) -> Result<()> {
    let operation = if restricted {
        ReceiptOperation::RestrictedRedemption
    } else {
        ReceiptOperation::Redemption
    };
    let live_receipts = ctx
        .accounts
        .position
        .receipts_issued
        .checked_sub(ctx.accounts.position.receipts_burned)
        .ok_or(VaultError::MathOverflow)?;
    if is_replayed_receipt(
        &ctx.accounts.operation_receipt,
        operation,
        live_receipts,
        args.payload_hash,
    )? {
        return Ok(());
    }

    require!(
        ctx.accounts.deal_state.state == DealState::Redeemable,
        VaultError::InvalidDealState
    );
    require_keys_eq!(
        ctx.accounts.position.wallet,
        ctx.accounts.investor.key(),
        VaultError::Unauthorized
    );
    require!(
        ctx.accounts.investor_receipt.amount == live_receipts && live_receipts > 0,
        VaultError::FullRedemptionRequired
    );
    let must_restrict = ctx.accounts.position.restricted_claim
        || ctx.accounts.position.eligibility_status == EligibilityStatus::SanctionsHold;
    require!(restricted == must_restrict, VaultError::InvestorNotEligible);

    let payout = checked_pro_rata(
        live_receipts,
        ctx.accounts.settlement.investor_pool,
        ctx.accounts.settlement.supply_snapshot,
    )
    .ok_or(VaultError::MathOverflow)?;
    require!(
        checked_add(ctx.accounts.settlement.claimed_investor_pool, payout)?
            <= ctx.accounts.settlement.investor_pool,
        VaultError::AccountingDeficit
    );
    validate_token_account(
        &ctx.accounts.investor_receipt,
        ctx.accounts.receipt_mint.key(),
        ctx.accounts.investor.key(),
    )?;
    validate_token_account(
        &ctx.accounts.repayment_vault,
        ctx.accounts.settlement_mint.key(),
        ctx.accounts.deal_state.key(),
    )?;

    permissioned_burn_receipts(
        ctx.accounts.compliance_program.key(),
        ctx.accounts.compliance_config.to_account_info(),
        ctx.accounts.transfer_policy.to_account_info(),
        ctx.accounts.source_binding.to_account_info(),
        ctx.accounts.source_permission.to_account_info(),
        ctx.accounts.source_investor.to_account_info(),
        ctx.accounts.receipt_token_program.to_account_info(),
        ctx.accounts.investor_receipt.to_account_info(),
        ctx.accounts.receipt_mint.to_account_info(),
        ctx.accounts.series.to_account_info(),
        ctx.accounts.investor.to_account_info(),
        ctx.accounts.deal_terms.deal_id,
        ctx.accounts.series.bump,
        live_receipts,
        ctx.accounts.series.decimals,
        if restricted {
            BurnPurpose::RestrictedRedemption
        } else {
            BurnPurpose::Redemption
        },
    )?;
    let destination = if restricted {
        require_keys_eq!(
            ctx.accounts.compliance_escrow_ata.key(),
            ctx.accounts.deal_terms.compliance_escrow_ata,
            VaultError::InvalidTokenAccount
        );
        ctx.accounts.compliance_escrow_ata.to_account_info()
    } else {
        validate_token_account(
            &ctx.accounts.investor_usdc,
            ctx.accounts.settlement_mint.key(),
            ctx.accounts.investor.key(),
        )?;
        ctx.accounts.investor_usdc.to_account_info()
    };
    transfer_from_vault(
        ctx.accounts.settlement_token_program.to_account_info(),
        ctx.accounts.repayment_vault.to_account_info(),
        ctx.accounts.settlement_mint.to_account_info(),
        destination,
        ctx.accounts.deal_state.to_account_info(),
        ctx.accounts.deal_terms.deal_id,
        ctx.accounts.deal_state.bump,
        payout,
        ctx.accounts.deal_terms.settlement_decimals,
    )?;

    ctx.accounts.position.receipts_burned =
        checked_add(ctx.accounts.position.receipts_burned, live_receipts)?;
    ctx.accounts.position.redeemed = checked_add(ctx.accounts.position.redeemed, payout)?;
    ctx.accounts.series.burned_supply =
        checked_add(ctx.accounts.series.burned_supply, live_receipts)?;
    ctx.accounts.settlement.claimed_investor_pool =
        checked_add(ctx.accounts.settlement.claimed_investor_pool, payout)?;
    if restricted {
        ctx.accounts.settlement.restricted_escrow_total =
            checked_add(ctx.accounts.settlement.restricted_escrow_total, payout)?;
    }
    ctx.accounts.deal_state.redeemed_total =
        checked_add(ctx.accounts.deal_state.redeemed_total, payout)?;

    initialize_receipt(
        &mut ctx.accounts.operation_receipt,
        ctx.accounts.deal_terms.deal_id,
        ctx.accounts.investor.key(),
        ctx.accounts.position.investor_id,
        args.nonce,
        operation,
        live_receipts,
        args.payload_hash,
        ctx.bumps.operation_receipt,
    )?;

    if ctx.accounts.series.burned_supply == ctx.accounts.series.issued_supply {
        ctx.accounts.settlement.dust_total = ctx
            .accounts
            .settlement
            .investor_pool
            .checked_sub(ctx.accounts.settlement.claimed_investor_pool)
            .ok_or(VaultError::MathOverflow)?;
        ctx.accounts.deal_state.state = DealState::Settled;
    }
    emit!(Redeemed {
        deal_id: ctx.accounts.deal_terms.deal_id,
        investor_id: ctx.accounts.position.investor_id,
        receipts_burned: live_receipts,
        payout,
        restricted,
    });
    Ok(())
}

#[event]
pub struct ProtocolInitialized {
    pub governance: Pubkey,
    pub guardian: Pubkey,
    pub oracle_program: Pubkey,
    pub compliance_program: Pubkey,
}

#[event]
pub struct MseBeneficiaryRegistered {
    pub entity_hash: [u8; 32],
    pub wallet_owner: Pubkey,
    pub usdc_ata: Pubkey,
    pub rail_kind: MseRailKind,
}

#[event]
pub struct MseBeneficiaryStatusChanged {
    pub entity_hash: [u8; 32],
    pub status: MseBeneficiaryStatus,
}

#[event]
pub struct PauseFlagsChanged {
    pub subscriptions: bool,
    pub releases: bool,
    pub transfers: bool,
    pub authority: Pubkey,
}

#[event]
pub struct SettlementAssetRegistered {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub enabled: bool,
}

#[event]
pub struct DealCreated {
    pub deal_id: [u8; 32],
    pub issuer_entity_hash: [u8; 32],
    pub beneficiary_entity_hash: [u8; 32],
    pub settlement_mint: Pubkey,
    pub receipt_mint: Pubkey,
}

#[event]
pub struct MilestoneConfigured {
    pub deal_id: [u8; 32],
    pub index: u8,
    pub gate_kind: ReleaseGateKind,
    pub allocation_bps: u16,
}

#[event]
pub struct DealStateChanged {
    pub deal_id: [u8; 32],
    pub state: DealState,
}

#[event]
pub struct InvestorApproved {
    pub deal_id: [u8; 32],
    pub investor_id: [u8; 32],
    pub wallet: Pubkey,
    pub contribution_cap: u64,
}

#[event]
pub struct InvestorStatusChanged {
    pub deal_id: [u8; 32],
    pub investor_id: [u8; 32],
    pub status: EligibilityStatus,
    pub expires_at: i64,
}

#[event]
pub struct Subscribed {
    pub deal_id: [u8; 32],
    pub investor_id: [u8; 32],
    pub wallet: Pubkey,
    pub amount: u64,
    pub nonce: u64,
}

#[event]
pub struct SubscriptionFinalized {
    pub deal_id: [u8; 32],
    pub funded_principal: u64,
    pub net_deployable: u64,
    pub repayment_target: u64,
}

#[event]
pub struct RefundClaimed {
    pub deal_id: [u8; 32],
    pub investor_id: [u8; 32],
    pub amount: u64,
}

#[event]
pub struct ReleaseScheduled {
    pub deal_id: [u8; 32],
    pub milestone_index: u8,
    pub amount: u64,
    pub gate_address: Pubkey,
    pub execute_after: i64,
}

#[event]
pub struct ReleaseCancelled {
    pub deal_id: [u8; 32],
    pub milestone_index: u8,
    pub authority: Pubkey,
}

#[event]
pub struct ReleaseExecuted {
    pub deal_id: [u8; 32],
    pub milestone_index: u8,
    pub amount: u64,
    pub mse_usdc_ata: Pubkey,
}

#[event]
pub struct TreasuryMovementChanged {
    pub deal_id: [u8; 32],
    pub milestone_index: u8,
    pub status: TreasuryMovementStatus,
}

#[event]
pub struct RepaymentDeposited {
    pub deal_id: [u8; 32],
    pub payer: Pubkey,
    pub amount: u64,
    pub accounted_total: u64,
}

#[event]
pub struct RepaymentSurplusSynced {
    pub deal_id: [u8; 32],
    pub accounted: u64,
    pub actual: u64,
    pub surplus: u64,
}

#[event]
pub struct SurplusAllocated {
    pub deal_id: [u8; 32],
    pub amount: u64,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct SettlementFinalized {
    pub deal_id: [u8; 32],
    pub investor_pool: u64,
    pub supply: u64,
    pub defaulted: bool,
}

#[event]
pub struct Redeemed {
    pub deal_id: [u8; 32],
    pub investor_id: [u8; 32],
    pub receipts_burned: u64,
    pub payout: u64,
    pub restricted: bool,
}

#[event]
pub struct IssuerDistributionWithdrawn {
    pub deal_id: [u8; 32],
    pub amount: u64,
    pub mse_usdc_ata: Pubkey,
    pub dust_retained: u64,
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn lifecycle_enums_keep_stable_discriminants() {
        fn encoded(state: DealState) -> Vec<u8> {
            let mut bytes = Vec::new();
            state.serialize(&mut bytes).unwrap();
            bytes
        }

        assert_eq!(encoded(DealState::Draft), vec![0]);
        assert_eq!(encoded(DealState::SubscriptionOpen), vec![1]);
        assert_eq!(encoded(DealState::Settled), vec![8]);
    }

    #[test]
    fn release_fixture_allocates_every_base_unit() {
        let principal = 30_000_001;
        let first = checked_bps(principal, 3_000).unwrap();
        let second = checked_bps(principal, 3_000).unwrap();
        let third = checked_bps(principal, 3_000).unwrap();
        let final_release = principal - first - second - third;
        assert_eq!(first + second + third + final_release, principal);
        assert_eq!(final_release, 3_000_001);
    }

    #[test]
    fn pro_rata_redemption_is_bounded_by_pool() {
        let pool = 24_000_001;
        let left = checked_pro_rata(15_000_000, pool, 30_000_000).unwrap();
        let right = checked_pro_rata(15_000_000, pool, 30_000_000).unwrap();
        assert!(left + right <= pool);
        assert_eq!(pool - left - right, 1);
    }

    #[test]
    fn reconcile_precondition_depends_on_rail() {
        assert_eq!(
            reconcile_precondition(MseRailKind::SquadsFiatForward),
            TreasuryMovementStatus::BankConfirmed
        );
        assert_eq!(
            reconcile_precondition(MseRailKind::DirectUsdc),
            TreasuryMovementStatus::UsdcReleased
        );
    }

    #[test]
    fn only_squads_rail_records_fiat_evidence_stages() {
        assert!(requires_squads_fiat_forward(MseRailKind::SquadsFiatForward));
        assert!(!requires_squads_fiat_forward(MseRailKind::DirectUsdc));
    }

    #[test]
    fn mse_beneficiary_serializes_within_allocated_space() {
        let beneficiary = MseBeneficiary {
            schema_version: ACCOUNT_SCHEMA_V1,
            entity_hash: [7u8; 32],
            wallet_owner: Pubkey::new_from_array([9u8; 32]),
            usdc_ata: Pubkey::new_from_array([11u8; 32]),
            rail_kind: MseRailKind::DirectUsdc,
            status: MseBeneficiaryStatus::Suspended,
            registered_at_slot: u64::MAX,
            updated_at_slot: u64::MAX,
            bump: 255,
            reserved: [0; pod_rwa_common::RESERVED_ACCOUNT_BYTES],
        };
        let mut bytes = Vec::new();
        beneficiary.serialize(&mut bytes).unwrap();
        assert!(bytes.len() + 8 <= MSE_BENEFICIARY_SPACE);
    }
}
