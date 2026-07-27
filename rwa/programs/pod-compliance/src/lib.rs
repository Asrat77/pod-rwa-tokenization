use std::cell::RefMut;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_2022::{
        freeze_account,
        spl_token_2022::{
            extension::{
                default_account_state::DefaultAccountState, permanent_delegate::PermanentDelegate,
                transfer_hook::TransferHookAccount, BaseStateWithExtensionsMut,
                PodStateWithExtensionsMut,
            },
            pod::PodAccount,
            state::AccountState as TokenAccountState,
        },
        thaw_account, FreezeAccount, ThawAccount,
    },
    token_interface::{get_mint_extension_data, Mint, TokenAccount, TokenInterface},
};
use pod_rwa_common::{EligibilityStatus, TransferPolicyMode};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::{
    ExecuteInstruction, InitializeExtraAccountMetaListInstruction,
};

mod error;
mod state;

pub use error::*;
pub use state::*;

declare_id!("6UtA4sTWNLps8y73GJCXSAy6wi28sn1oC3tqGA74rmQj");

#[program]
pub mod pod_compliance {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        recovery_authority: Pubkey,
        min_recovery_delay_seconds: i64,
    ) -> Result<()> {
        require_keys_neq!(
            recovery_authority,
            Pubkey::default(),
            ComplianceError::InvalidPublicKey
        );
        validate_recovery_delay(min_recovery_delay_seconds)?;

        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        config.schema_version = schema_v1();
        config.governance = ctx.accounts.governance.key();
        config.pending_governance = Pubkey::default();
        config.has_pending_governance = false;
        config.recovery_authority = recovery_authority;
        config.paused = false;
        config.min_recovery_delay_seconds = min_recovery_delay_seconds;
        config.created_at = now;
        config.updated_at = now;
        config.bump = ctx.bumps.config;
        config.reserved = initialize_reserved();

        emit!(ConfigInitialized {
            config: config.key(),
            governance: config.governance,
            recovery_authority,
            min_recovery_delay_seconds,
            timestamp: now,
        });
        Ok(())
    }

    pub fn update_config(
        ctx: Context<GovernConfig>,
        recovery_authority: Pubkey,
        min_recovery_delay_seconds: i64,
        paused: bool,
    ) -> Result<()> {
        require_keys_neq!(
            recovery_authority,
            Pubkey::default(),
            ComplianceError::InvalidPublicKey
        );
        validate_recovery_delay(min_recovery_delay_seconds)?;

        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        config.recovery_authority = recovery_authority;
        config.min_recovery_delay_seconds = min_recovery_delay_seconds;
        config.paused = paused;
        config.updated_at = now;

        emit!(ConfigUpdated {
            config: config.key(),
            recovery_authority,
            min_recovery_delay_seconds,
            paused,
            timestamp: now,
        });
        Ok(())
    }

    pub fn propose_governance(
        ctx: Context<GovernConfig>,
        pending_governance: Pubkey,
    ) -> Result<()> {
        require_keys_neq!(
            pending_governance,
            Pubkey::default(),
            ComplianceError::InvalidPublicKey
        );
        require_keys_neq!(
            pending_governance,
            ctx.accounts.config.governance,
            ComplianceError::SameGovernance
        );

        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        config.pending_governance = pending_governance;
        config.has_pending_governance = true;
        config.updated_at = now;

        emit!(GovernanceProposed {
            config: config.key(),
            current_governance: config.governance,
            pending_governance,
            timestamp: now,
        });
        Ok(())
    }

    pub fn accept_governance(ctx: Context<AcceptGovernance>) -> Result<()> {
        require!(
            ctx.accounts.config.has_pending_governance,
            ComplianceError::NoPendingGovernance
        );
        require_keys_eq!(
            ctx.accounts.config.pending_governance,
            ctx.accounts.pending_governance.key(),
            ComplianceError::InvalidAuthority
        );

        let now = Clock::get()?.unix_timestamp;
        let config = &mut ctx.accounts.config;
        let old_governance = config.governance;
        config.governance = ctx.accounts.pending_governance.key();
        config.pending_governance = Pubkey::default();
        config.has_pending_governance = false;
        config.updated_at = now;

        emit!(GovernanceAccepted {
            config: config.key(),
            old_governance,
            new_governance: config.governance,
            timestamp: now,
        });
        Ok(())
    }

    pub fn register_provider(
        ctx: Context<RegisterProvider>,
        provider_authority: Pubkey,
        can_issue: bool,
        can_revoke: bool,
    ) -> Result<()> {
        require_keys_neq!(
            provider_authority,
            Pubkey::default(),
            ComplianceError::InvalidPublicKey
        );
        let now = Clock::get()?.unix_timestamp;
        let provider = &mut ctx.accounts.provider_record;
        provider.schema_version = schema_v1();
        provider.config = ctx.accounts.config.key();
        provider.authority = provider_authority;
        provider.can_issue = can_issue;
        provider.can_revoke = can_revoke;
        provider.active = true;
        provider.created_at = now;
        provider.updated_at = now;
        provider.bump = ctx.bumps.provider_record;
        provider.reserved = initialize_reserved();

        emit!(ProviderChanged {
            provider_record: provider.key(),
            provider_authority,
            active: true,
            can_issue,
            can_revoke,
            timestamp: now,
        });
        Ok(())
    }

    pub fn update_provider(
        ctx: Context<UpdateProvider>,
        can_issue: bool,
        can_revoke: bool,
        active: bool,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let provider = &mut ctx.accounts.provider_record;
        provider.can_issue = can_issue;
        provider.can_revoke = can_revoke;
        provider.active = active;
        provider.updated_at = now;

        emit!(ProviderChanged {
            provider_record: provider.key(),
            provider_authority: provider.authority,
            active,
            can_issue,
            can_revoke,
            timestamp: now,
        });
        Ok(())
    }

    pub fn issue_investor(
        ctx: Context<IssueInvestor>,
        opaque_id: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require_provider(
            &ctx.accounts.provider_record,
            &ctx.accounts.provider_authority,
            true,
            false,
        )?;
        require!(opaque_id != [0; 32], ComplianceError::InvalidOpaqueId);

        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, ComplianceError::InvalidExpiry);

        let investor = &mut ctx.accounts.investor_record;
        investor.schema_version = schema_v1();
        investor.opaque_id = opaque_id;
        investor.config = ctx.accounts.config.key();
        investor.provider_record = ctx.accounts.provider_record.key();
        investor.current_wallet = Pubkey::default();
        investor.has_wallet = false;
        investor.status = EligibilityStatus::Active;
        investor.issued_at = now;
        investor.updated_at = now;
        investor.expires_at = expires_at;
        investor.bump = ctx.bumps.investor_record;
        investor.reserved = initialize_reserved();

        emit!(InvestorChanged {
            investor_record: investor.key(),
            opaque_id,
            provider_record: investor.provider_record,
            status: investor.status,
            expires_at,
            timestamp: now,
        });
        Ok(())
    }

    pub fn update_investor(
        ctx: Context<ManageInvestor>,
        status: EligibilityStatus,
        expires_at: i64,
    ) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require_provider(
            &ctx.accounts.provider_record,
            &ctx.accounts.provider_authority,
            true,
            false,
        )?;
        require_keys_eq!(
            ctx.accounts.investor_record.provider_record,
            ctx.accounts.provider_record.key(),
            ComplianceError::InvalidLink
        );
        require!(
            status != EligibilityStatus::Revoked,
            ComplianceError::AlreadyRevoked
        );

        let now = Clock::get()?.unix_timestamp;
        if status == EligibilityStatus::Active {
            require!(expires_at > now, ComplianceError::InvalidExpiry);
        }

        let investor = &mut ctx.accounts.investor_record;
        investor.status = status;
        investor.expires_at = expires_at;
        investor.updated_at = now;

        emit!(InvestorChanged {
            investor_record: investor.key(),
            opaque_id: investor.opaque_id,
            provider_record: investor.provider_record,
            status,
            expires_at,
            timestamp: now,
        });
        Ok(())
    }

    pub fn revoke_investor(ctx: Context<ManageInvestor>) -> Result<()> {
        require_provider(
            &ctx.accounts.provider_record,
            &ctx.accounts.provider_authority,
            false,
            true,
        )?;
        require_keys_eq!(
            ctx.accounts.investor_record.provider_record,
            ctx.accounts.provider_record.key(),
            ComplianceError::InvalidLink
        );
        require!(
            ctx.accounts.investor_record.status != EligibilityStatus::Revoked,
            ComplianceError::AlreadyRevoked
        );

        let now = Clock::get()?.unix_timestamp;
        let investor = &mut ctx.accounts.investor_record;
        investor.status = EligibilityStatus::Revoked;
        investor.updated_at = now;

        emit!(InvestorChanged {
            investor_record: investor.key(),
            opaque_id: investor.opaque_id,
            provider_record: investor.provider_record,
            status: investor.status,
            expires_at: investor.expires_at,
            timestamp: now,
        });
        Ok(())
    }

    pub fn bind_wallet(ctx: Context<BindWallet>) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require_provider(
            &ctx.accounts.provider_record,
            &ctx.accounts.provider_authority,
            true,
            false,
        )?;
        validate_provider_investor_link(
            &ctx.accounts.provider_record,
            &ctx.accounts.investor_record,
        )?;

        let now = Clock::get()?.unix_timestamp;
        require!(
            is_currently_active(
                ctx.accounts.investor_record.status,
                ctx.accounts.investor_record.expires_at,
                now
            ),
            ComplianceError::InvestorInactive
        );
        require!(
            !ctx.accounts.investor_record.has_wallet,
            ComplianceError::AlreadyBound
        );

        let wallet = ctx.accounts.wallet.key();
        initialize_wallet_binding(
            &mut ctx.accounts.wallet_binding,
            ctx.accounts.config.key(),
            ctx.accounts.investor_record.key(),
            ctx.accounts.investor_record.opaque_id,
            wallet,
            now,
            ctx.bumps.wallet_binding,
        );

        let investor = &mut ctx.accounts.investor_record;
        investor.current_wallet = wallet;
        investor.has_wallet = true;
        investor.updated_at = now;

        emit!(WalletBindingChanged {
            investor_record: investor.key(),
            old_wallet: Pubkey::default(),
            new_wallet: wallet,
            recovered: false,
            timestamp: now,
        });
        Ok(())
    }

    pub fn rotate_wallet(ctx: Context<RotateWallet>) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require_provider(
            &ctx.accounts.provider_record,
            &ctx.accounts.provider_authority,
            true,
            false,
        )?;
        validate_provider_investor_link(
            &ctx.accounts.provider_record,
            &ctx.accounts.investor_record,
        )?;
        validate_active_binding(
            &ctx.accounts.old_binding,
            ctx.accounts.investor_record.key(),
            ctx.accounts.old_wallet.key(),
        )?;
        require_keys_eq!(
            ctx.accounts.investor_record.current_wallet,
            ctx.accounts.old_wallet.key(),
            ComplianceError::WalletMismatch
        );
        require_keys_neq!(
            ctx.accounts.old_wallet.key(),
            ctx.accounts.new_wallet.key(),
            ComplianceError::WalletMismatch
        );

        let now = Clock::get()?.unix_timestamp;
        deactivate_binding(&mut ctx.accounts.old_binding, now);
        initialize_wallet_binding(
            &mut ctx.accounts.new_binding,
            ctx.accounts.config.key(),
            ctx.accounts.investor_record.key(),
            ctx.accounts.investor_record.opaque_id,
            ctx.accounts.new_wallet.key(),
            now,
            ctx.bumps.new_binding,
        );

        let investor = &mut ctx.accounts.investor_record;
        let old_wallet = investor.current_wallet;
        investor.current_wallet = ctx.accounts.new_wallet.key();
        investor.updated_at = now;

        emit!(WalletBindingChanged {
            investor_record: investor.key(),
            old_wallet,
            new_wallet: investor.current_wallet,
            recovered: false,
            timestamp: now,
        });
        Ok(())
    }

    pub fn set_series_permission(
        ctx: Context<SetSeriesPermission>,
        series: Pubkey,
        accepted_terms_hash: [u8; 32],
        max_investment: u64,
        expires_at: i64,
    ) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require_provider(
            &ctx.accounts.provider_record,
            &ctx.accounts.provider_authority,
            true,
            false,
        )?;
        validate_provider_investor_link(
            &ctx.accounts.provider_record,
            &ctx.accounts.investor_record,
        )?;
        validate_active_binding(
            &ctx.accounts.wallet_binding,
            ctx.accounts.investor_record.key(),
            ctx.accounts.wallet.key(),
        )?;
        require_keys_eq!(
            ctx.accounts.investor_record.current_wallet,
            ctx.accounts.wallet.key(),
            ComplianceError::WalletMismatch
        );
        require!(
            accepted_terms_hash != [0; 32],
            ComplianceError::InvalidTermsHash
        );
        require!(max_investment > 0, ComplianceError::InvalidInvestmentCap);

        let now = Clock::get()?.unix_timestamp;
        require!(
            is_currently_active(
                ctx.accounts.investor_record.status,
                ctx.accounts.investor_record.expires_at,
                now
            ),
            ComplianceError::InvestorInactive
        );
        require!(
            expires_at > now && expires_at <= ctx.accounts.investor_record.expires_at,
            ComplianceError::InvalidExpiry
        );

        let permission = &mut ctx.accounts.series_permission;
        let is_new_permission = permission.schema_version == 0;
        if !is_new_permission {
            require_keys_eq!(
                permission.config,
                ctx.accounts.config.key(),
                ComplianceError::InvalidLink
            );
            require_keys_eq!(permission.series, series, ComplianceError::InvalidSeries);
            require_keys_eq!(
                permission.investor_record,
                ctx.accounts.investor_record.key(),
                ComplianceError::InvalidLink
            );
            require_keys_eq!(
                permission.wallet,
                ctx.accounts.wallet.key(),
                ComplianceError::WalletMismatch
            );
        }

        let issued_at = if is_new_permission {
            now
        } else {
            permission.issued_at
        };
        permission.schema_version = schema_v1();
        permission.config = ctx.accounts.config.key();
        permission.series = series;
        permission.investor_record = ctx.accounts.investor_record.key();
        permission.wallet = ctx.accounts.wallet.key();
        permission.provider_record = ctx.accounts.provider_record.key();
        permission.status = EligibilityStatus::Active;
        permission.accepted_terms_hash = accepted_terms_hash;
        permission.max_investment = max_investment;
        permission.issued_at = issued_at;
        permission.updated_at = now;
        permission.expires_at = expires_at;
        permission.bump = ctx.bumps.series_permission;
        if is_new_permission {
            permission.reserved = initialize_reserved();
        }

        emit!(SeriesPermissionChanged {
            series,
            investor_record: permission.investor_record,
            wallet: permission.wallet,
            status: permission.status,
            max_investment,
            expires_at,
            timestamp: now,
        });
        Ok(())
    }

    pub fn revoke_series_permission(ctx: Context<RevokeSeriesPermission>) -> Result<()> {
        require_provider(
            &ctx.accounts.provider_record,
            &ctx.accounts.provider_authority,
            false,
            true,
        )?;
        require_keys_eq!(
            ctx.accounts.series_permission.provider_record,
            ctx.accounts.provider_record.key(),
            ComplianceError::InvalidLink
        );
        require!(
            ctx.accounts.series_permission.status != EligibilityStatus::Revoked,
            ComplianceError::AlreadyRevoked
        );

        let now = Clock::get()?.unix_timestamp;
        let permission = &mut ctx.accounts.series_permission;
        permission.status = EligibilityStatus::Revoked;
        permission.updated_at = now;

        emit!(SeriesPermissionChanged {
            series: permission.series,
            investor_record: permission.investor_record,
            wallet: permission.wallet,
            status: permission.status,
            max_investment: permission.max_investment,
            expires_at: permission.expires_at,
            timestamp: now,
        });
        Ok(())
    }

    pub fn configure_transfer_policy(
        ctx: Context<ConfigureTransferPolicy>,
        series: Pubkey,
        issuer: Pubkey,
        burn_caller: Pubkey,
        mode: TransferPolicyMode,
        active: bool,
    ) -> Result<()> {
        require_keys_neq!(series, Pubkey::default(), ComplianceError::InvalidPublicKey);
        require_keys_neq!(issuer, Pubkey::default(), ComplianceError::InvalidPublicKey);
        require_keys_neq!(
            burn_caller,
            Pubkey::default(),
            ComplianceError::InvalidPublicKey
        );
        let now = Clock::get()?.unix_timestamp;
        let policy = &mut ctx.accounts.transfer_policy;
        let is_new_policy = policy.schema_version == 0;

        if !is_new_policy {
            require_keys_eq!(
                policy.config,
                ctx.accounts.config.key(),
                ComplianceError::InvalidLink
            );
            require_keys_eq!(policy.series, series, ComplianceError::InvalidSeries);
        }

        policy.schema_version = schema_v1();
        policy.config = ctx.accounts.config.key();
        policy.series = series;
        policy.issuer = issuer;
        policy.burn_caller = burn_caller;
        policy.mode = mode;
        policy.active = active;
        policy.updated_at = now;
        policy.bump = ctx.bumps.transfer_policy;
        if is_new_policy {
            policy.reserved = initialize_reserved();
        }

        emit!(TransferPolicyChanged {
            series,
            issuer,
            burn_caller,
            mode,
            active,
            timestamp: now,
        });
        Ok(())
    }

    /// Thaws an eligible investor's canonical Token-2022 receipt ATA so
    /// `pod_vault::subscribe` can atomically transfer USDC and mint receipts.
    /// The registered provider must control the investor credential and have
    /// issue authority. Accounts created from a Frozen-by-default mint remain
    /// unusable until this instruction succeeds.
    pub fn thaw_receipt_account(ctx: Context<ProviderReceiptAccountControl>) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require_provider(
            &ctx.accounts.provider_record,
            &ctx.accounts.provider_authority,
            true,
            false,
        )?;

        let now = Clock::get()?.unix_timestamp;
        validate_receipt_account_control(
            &ctx.accounts.config,
            ctx.accounts.config.key(),
            &ctx.accounts.provider_record,
            ctx.accounts.provider_record.key(),
            &ctx.accounts.investor_record,
            ctx.accounts.investor_record.key(),
            &ctx.accounts.wallet_binding,
            &ctx.accounts.series_permission,
            &ctx.accounts.transfer_policy,
            ctx.accounts.wallet.key(),
            &ctx.accounts.mint,
            &ctx.accounts.receipt_account,
            ctx.accounts.token_program.key(),
            ReceiptAccountTransition::ThawEligible,
            now,
        )?;

        thaw_canonical_receipt_account(
            &ctx.accounts.config,
            &ctx.accounts.mint,
            &ctx.accounts.receipt_account,
            &ctx.accounts.token_program,
        )?;
        emit_receipt_account_state_changed(
            &ctx.accounts.mint,
            &ctx.accounts.investor_record,
            ctx.accounts.wallet.key(),
            &ctx.accounts.receipt_account,
            ctx.accounts.provider_authority.key(),
            ctx.accounts.provider_record.key(),
            false,
            false,
        )
    }

    /// Freezes a restricted, suspended, expired or revoked investor's
    /// canonical receipt ATA. Freezing blocks token operations but leaves the
    /// receipt balance and its legal claim intact.
    pub fn freeze_receipt_account(ctx: Context<ProviderReceiptAccountControl>) -> Result<()> {
        require_provider(
            &ctx.accounts.provider_record,
            &ctx.accounts.provider_authority,
            false,
            true,
        )?;

        let now = Clock::get()?.unix_timestamp;
        validate_receipt_account_control(
            &ctx.accounts.config,
            ctx.accounts.config.key(),
            &ctx.accounts.provider_record,
            ctx.accounts.provider_record.key(),
            &ctx.accounts.investor_record,
            ctx.accounts.investor_record.key(),
            &ctx.accounts.wallet_binding,
            &ctx.accounts.series_permission,
            &ctx.accounts.transfer_policy,
            ctx.accounts.wallet.key(),
            &ctx.accounts.mint,
            &ctx.accounts.receipt_account,
            ctx.accounts.token_program.key(),
            ReceiptAccountTransition::FreezeRestricted,
            now,
        )?;

        freeze_canonical_receipt_account(
            &ctx.accounts.config,
            &ctx.accounts.mint,
            &ctx.accounts.receipt_account,
            &ctx.accounts.token_program,
        )?;
        emit_receipt_account_state_changed(
            &ctx.accounts.mint,
            &ctx.accounts.investor_record,
            ctx.accounts.wallet.key(),
            &ctx.accounts.receipt_account,
            ctx.accounts.provider_authority.key(),
            ctx.accounts.provider_record.key(),
            true,
            false,
        )
    }

    /// Governance override for incident response and controlled recovery. The
    /// same canonical claim/account links are enforced, but governance may
    /// thaw a restricted account for an atomic recovery or escrow-redemption
    /// transaction. The transfer hook and PermissionedBurn policy continue to
    /// prevent the holder from moving or burning a restricted claim alone.
    pub fn govern_thaw_receipt_account(ctx: Context<GovernReceiptAccountControl>) -> Result<()> {
        validate_receipt_account_control(
            &ctx.accounts.config,
            ctx.accounts.config.key(),
            &ctx.accounts.provider_record,
            ctx.accounts.provider_record.key(),
            &ctx.accounts.investor_record,
            ctx.accounts.investor_record.key(),
            &ctx.accounts.wallet_binding,
            &ctx.accounts.series_permission,
            &ctx.accounts.transfer_policy,
            ctx.accounts.wallet.key(),
            &ctx.accounts.mint,
            &ctx.accounts.receipt_account,
            ctx.accounts.token_program.key(),
            ReceiptAccountTransition::GovernThaw,
            Clock::get()?.unix_timestamp,
        )?;

        thaw_canonical_receipt_account(
            &ctx.accounts.config,
            &ctx.accounts.mint,
            &ctx.accounts.receipt_account,
            &ctx.accounts.token_program,
        )?;
        emit_receipt_account_state_changed(
            &ctx.accounts.mint,
            &ctx.accounts.investor_record,
            ctx.accounts.wallet.key(),
            &ctx.accounts.receipt_account,
            ctx.accounts.governance.key(),
            ctx.accounts.provider_record.key(),
            false,
            true,
        )
    }

    /// Governance override for incident response. This can freeze a valid
    /// linked receipt account before the provider record is updated or when a
    /// provider has been disabled.
    pub fn govern_freeze_receipt_account(ctx: Context<GovernReceiptAccountControl>) -> Result<()> {
        validate_receipt_account_control(
            &ctx.accounts.config,
            ctx.accounts.config.key(),
            &ctx.accounts.provider_record,
            ctx.accounts.provider_record.key(),
            &ctx.accounts.investor_record,
            ctx.accounts.investor_record.key(),
            &ctx.accounts.wallet_binding,
            &ctx.accounts.series_permission,
            &ctx.accounts.transfer_policy,
            ctx.accounts.wallet.key(),
            &ctx.accounts.mint,
            &ctx.accounts.receipt_account,
            ctx.accounts.token_program.key(),
            ReceiptAccountTransition::GovernFreeze,
            Clock::get()?.unix_timestamp,
        )?;

        freeze_canonical_receipt_account(
            &ctx.accounts.config,
            &ctx.accounts.mint,
            &ctx.accounts.receipt_account,
            &ctx.accounts.token_program,
        )?;
        emit_receipt_account_state_changed(
            &ctx.accounts.mint,
            &ctx.accounts.investor_record,
            ctx.accounts.wallet.key(),
            &ctx.accounts.receipt_account,
            ctx.accounts.governance.key(),
            ctx.accounts.provider_record.key(),
            true,
            true,
        )
    }

    /// Co-signs the Token-2022 PermissionedBurnExtension::BurnChecked
    /// instruction. The configured pod-vault Series PDA must invoke this
    /// instruction as a signer, and the holder must independently sign as the
    /// source owner. The TransferPolicy PDA is the mint's permissioned-burn
    /// authority, so neither party can burn receipt supply alone.
    pub fn permissioned_burn(
        ctx: Context<PermissionedBurn>,
        amount: u64,
        decimals: u8,
        purpose: BurnPurpose,
    ) -> Result<()> {
        require!(amount > 0, ComplianceError::InvalidAmount);
        require_keys_eq!(
            ctx.accounts.transfer_policy.series,
            ctx.accounts.mint.key(),
            ComplianceError::InvalidSeries
        );
        require_keys_eq!(
            ctx.accounts.transfer_policy.burn_caller,
            ctx.accounts.burn_caller.key(),
            ComplianceError::InvalidAuthority
        );
        require_keys_eq!(
            ctx.accounts.source_token.owner,
            ctx.accounts.source_owner.key(),
            ComplianceError::WalletMismatch
        );
        require!(
            ctx.accounts.mint.decimals == decimals,
            ComplianceError::InvalidSeries
        );

        validate_party_links(
            &ctx.accounts.transfer_policy,
            ctx.accounts.source_owner.key(),
            &ctx.accounts.source_binding,
            &ctx.accounts.source_permission,
            &ctx.accounts.source_investor,
            ctx.accounts.source_investor.key(),
        )?;
        validate_burn_purpose(
            purpose,
            &ctx.accounts.source_investor,
            &ctx.accounts.source_permission,
            Clock::get()?.unix_timestamp,
        )?;

        // Token-2022 v11 introduced PermissionedBurn. Anchor SPL 1.1.2 does
        // not yet expose a CPI wrapper, so encode the stable public interface:
        // outer discriminator 46, BurnChecked discriminator 2, amount LE, and
        // decimals. The account order is defined by the SPL interface.
        let instruction = Instruction {
            program_id: ctx.accounts.token_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.source_token.key(), false),
                AccountMeta::new(ctx.accounts.mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.transfer_policy.key(), true),
                AccountMeta::new_readonly(ctx.accounts.source_owner.key(), true),
            ],
            data: permissioned_burn_instruction_data(amount, decimals),
        };
        let mint_key = ctx.accounts.mint.key();
        let policy_seeds: &[&[u8]] = &[
            TRANSFER_POLICY_SEED,
            mint_key.as_ref(),
            &[ctx.accounts.transfer_policy.bump],
        ];
        invoke_signed(
            &instruction,
            &[
                ctx.accounts.source_token.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.transfer_policy.to_account_info(),
                ctx.accounts.source_owner.to_account_info(),
            ],
            &[policy_seeds],
        )?;

        emit!(PermissionedBurnExecuted {
            series: ctx.accounts.mint.key(),
            investor_record: ctx.accounts.source_investor.key(),
            wallet: ctx.accounts.source_owner.key(),
            burn_caller: ctx.accounts.burn_caller.key(),
            amount,
            purpose,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn propose_recovery(
        ctx: Context<ProposeRecovery>,
        order_id: [u8; 32],
        new_wallet: Pubkey,
        series: Pubkey,
        execute_after: i64,
        expires_at: i64,
    ) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require!(order_id != [0; 32], ComplianceError::InvalidRecoveryOrder);
        require_keys_neq!(
            new_wallet,
            Pubkey::default(),
            ComplianceError::InvalidPublicKey
        );
        require_keys_neq!(series, Pubkey::default(), ComplianceError::InvalidPublicKey);
        require!(
            ctx.accounts.investor_record.has_wallet,
            ComplianceError::WalletMismatch
        );
        require_keys_neq!(
            ctx.accounts.investor_record.current_wallet,
            new_wallet,
            ComplianceError::WalletMismatch
        );

        let now = Clock::get()?.unix_timestamp;
        let minimum_execute_after = now
            .checked_add(ctx.accounts.config.min_recovery_delay_seconds)
            .ok_or(ComplianceError::RecoveryTooSoon)?;
        require!(
            execute_after >= minimum_execute_after,
            ComplianceError::RecoveryTooSoon
        );
        require!(expires_at > execute_after, ComplianceError::InvalidExpiry);

        let order = &mut ctx.accounts.recovery_order;
        order.schema_version = schema_v1();
        order.config = ctx.accounts.config.key();
        order.series = series;
        order.opaque_id = ctx.accounts.investor_record.opaque_id;
        order.investor_record = ctx.accounts.investor_record.key();
        order.old_wallet = ctx.accounts.investor_record.current_wallet;
        order.new_wallet = new_wallet;
        order.initiated_by = ctx.accounts.recovery_authority.key();
        order.permanent_delegate = Pubkey::default();
        order.order_id = order_id;
        order.expected_receipt_amount = 0;
        order.execute_after = execute_after;
        order.expires_at = expires_at;
        order.created_at = now;
        order.prepared_at = 0;
        order.executed_at = 0;
        order.status = RecoveryStatus::Proposed;
        order.bump = ctx.bumps.recovery_order;
        order.reserved = initialize_reserved();

        emit!(RecoveryChanged {
            recovery_order: order.key(),
            investor_record: order.investor_record,
            old_wallet: order.old_wallet,
            new_wallet,
            status: order.status,
            timestamp: now,
        });
        Ok(())
    }

    pub fn cancel_recovery(ctx: Context<CancelRecovery>) -> Result<()> {
        let authority = ctx.accounts.authority.key();
        require!(
            authority == ctx.accounts.config.governance
                || authority == ctx.accounts.config.recovery_authority,
            ComplianceError::InvalidAuthority
        );
        require!(
            ctx.accounts.recovery_order.status == RecoveryStatus::Proposed,
            ComplianceError::RecoveryNotProposed
        );

        let now = Clock::get()?.unix_timestamp;
        let order = &mut ctx.accounts.recovery_order;
        order.status = RecoveryStatus::Cancelled;
        order.executed_at = now;

        emit!(RecoveryChanged {
            recovery_order: order.key(),
            investor_record: order.investor_record,
            old_wallet: order.old_wallet,
            new_wallet: order.new_wallet,
            status: order.status,
            timestamp: now,
        });
        Ok(())
    }

    /// Prepares the destination credential and binds it to the exact
    /// timelocked order, series, source wallet, and expiry. Token-2022 must be
    /// invoked as a separate instruction by the mint's permanent delegate.
    ///
    /// This separation is required by Solana's call-stack rules: this program
    /// is also the mint's transfer hook, so a CPI from this instruction into
    /// Token-2022 would attempt the forbidden indirect re-entry
    /// `pod_compliance -> Token-2022 -> pod_compliance`.
    pub fn prepare_recovery(ctx: Context<PrepareRecovery>) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        let now = Clock::get()?.unix_timestamp;
        let order = &ctx.accounts.recovery_order;
        require!(
            order.status == RecoveryStatus::Proposed,
            ComplianceError::RecoveryNotProposed
        );
        require!(
            now >= order.execute_after,
            ComplianceError::RecoveryNotReady
        );
        require!(now <= order.expires_at, ComplianceError::RecoveryExpired);
        require_keys_eq!(
            order.investor_record,
            ctx.accounts.investor_record.key(),
            ComplianceError::InvalidRecoveryOrder
        );
        require_keys_eq!(
            order.old_wallet,
            ctx.accounts.old_binding.wallet,
            ComplianceError::InvalidRecoveryOrder
        );
        require_keys_eq!(
            order.new_wallet,
            ctx.accounts.new_wallet.key(),
            ComplianceError::InvalidRecoveryOrder
        );
        require_keys_eq!(
            order.series,
            ctx.accounts.mint.key(),
            ComplianceError::InvalidSeries
        );
        require_keys_eq!(
            ctx.accounts.investor_record.current_wallet,
            order.old_wallet,
            ComplianceError::WalletMismatch
        );
        validate_active_binding(
            &ctx.accounts.old_binding,
            ctx.accounts.investor_record.key(),
            order.old_wallet,
        )?;
        validate_recovery_permission(
            &ctx.accounts.old_permission,
            ctx.accounts.config.key(),
            ctx.accounts.mint.key(),
            ctx.accounts.investor_record.key(),
            order.old_wallet,
        )?;
        require_keys_eq!(
            ctx.accounts.transfer_policy.config,
            ctx.accounts.config.key(),
            ComplianceError::InvalidLink
        );
        require_keys_eq!(
            ctx.accounts.transfer_policy.series,
            ctx.accounts.mint.key(),
            ComplianceError::InvalidSeries
        );
        require!(
            ctx.accounts.transfer_policy.active,
            ComplianceError::PolicyInactive
        );
        validate_token_2022_account(
            &ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_token_2022_account(
            &ctx.accounts.old_receipt_ata.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_token_2022_account(
            &ctx.accounts.new_receipt_ata.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_receipt_ata(
            ctx.accounts.old_receipt_ata.key(),
            ctx.accounts.old_receipt_ata.mint,
            ctx.accounts.old_receipt_ata.owner,
            order.old_wallet,
            ctx.accounts.mint.key(),
            ctx.accounts.token_program.key(),
        )?;
        validate_receipt_ata(
            ctx.accounts.new_receipt_ata.key(),
            ctx.accounts.new_receipt_ata.mint,
            ctx.accounts.new_receipt_ata.owner,
            order.new_wallet,
            ctx.accounts.mint.key(),
            ctx.accounts.token_program.key(),
        )?;
        require!(
            ctx.accounts.old_receipt_ata.amount > 0,
            ComplianceError::InvalidRecoveryBalance
        );
        require!(
            ctx.accounts.new_receipt_ata.amount == 0,
            ComplianceError::RecoveryDestinationNotEmpty
        );
        require!(
            ctx.accounts.old_receipt_ata.state == TokenAccountState::Initialized
                && ctx.accounts.new_receipt_ata.state == TokenAccountState::Initialized,
            ComplianceError::InvalidRecoveryTokenState
        );

        let permanent_delegate = mint_permanent_delegate(&ctx.accounts.mint.to_account_info())?;
        require_keys_eq!(
            permanent_delegate,
            ctx.accounts.config.recovery_authority,
            ComplianceError::InvalidPermanentDelegate
        );

        let old_wallet = order.old_wallet;
        let new_wallet = order.new_wallet;
        initialize_pending_recovery_binding(
            &mut ctx.accounts.new_binding,
            ctx.accounts.config.key(),
            ctx.accounts.investor_record.key(),
            ctx.accounts.investor_record.opaque_id,
            new_wallet,
            ctx.accounts.recovery_order.key(),
            old_wallet,
            ctx.accounts.mint.key(),
            order.expires_at,
            now,
            ctx.bumps.new_binding,
        );
        copy_permission_for_recovery(
            &mut ctx.accounts.new_permission,
            &ctx.accounts.old_permission,
            new_wallet,
            now,
            ctx.bumps.new_permission,
        );

        let order = &mut ctx.accounts.recovery_order;
        order.permanent_delegate = permanent_delegate;
        order.expected_receipt_amount = ctx.accounts.old_receipt_ata.amount;
        order.prepared_at = now;
        order.status = RecoveryStatus::Prepared;

        emit!(RecoveryPrepared {
            recovery_order: order.key(),
            investor_record: order.investor_record,
            series: order.series,
            old_wallet,
            new_wallet,
            permanent_delegate,
            expected_receipt_amount: order.expected_receipt_amount,
            timestamp: now,
        });
        emit!(RecoveryChanged {
            recovery_order: order.key(),
            investor_record: order.investor_record,
            old_wallet,
            new_wallet,
            status: order.status,
            timestamp: now,
        });
        Ok(())
    }

    /// Finalizes a prepared recovery after the external permanent delegate has
    /// moved the complete source balance with Token-2022 TransferChecked. The
    /// source and destination ATA balances make partial or substituted
    /// transfers impossible to finalize.
    pub fn execute_recovery(ctx: Context<ExecuteRecovery>) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        let now = Clock::get()?.unix_timestamp;
        let order = &ctx.accounts.recovery_order;
        require!(
            order.status == RecoveryStatus::Prepared,
            ComplianceError::RecoveryNotPrepared
        );
        require_keys_eq!(
            order.investor_record,
            ctx.accounts.investor_record.key(),
            ComplianceError::InvalidRecoveryOrder
        );
        require_keys_eq!(
            order.old_wallet,
            ctx.accounts.old_binding.wallet,
            ComplianceError::InvalidRecoveryOrder
        );
        require_keys_eq!(
            order.new_wallet,
            ctx.accounts.new_wallet.key(),
            ComplianceError::InvalidRecoveryOrder
        );
        require_keys_eq!(
            order.series,
            ctx.accounts.mint.key(),
            ComplianceError::InvalidSeries
        );
        require_keys_eq!(
            ctx.accounts.investor_record.current_wallet,
            order.old_wallet,
            ComplianceError::WalletMismatch
        );
        validate_active_binding(
            &ctx.accounts.old_binding,
            ctx.accounts.investor_record.key(),
            order.old_wallet,
        )?;
        validate_pending_recovery_binding(
            &ctx.accounts.new_binding,
            ctx.accounts.config.key(),
            ctx.accounts.investor_record.key(),
            order.new_wallet,
            ctx.accounts.recovery_order.key(),
            order.old_wallet,
            order.series,
        )?;
        validate_recovery_permission(
            &ctx.accounts.old_permission,
            ctx.accounts.config.key(),
            order.series,
            ctx.accounts.investor_record.key(),
            order.old_wallet,
        )?;
        validate_recovery_permission(
            &ctx.accounts.new_permission,
            ctx.accounts.config.key(),
            order.series,
            ctx.accounts.investor_record.key(),
            order.new_wallet,
        )?;
        require!(
            permissions_match_for_recovery(
                &ctx.accounts.old_permission,
                &ctx.accounts.new_permission
            ),
            ComplianceError::RecoveryPermissionMismatch
        );
        require_keys_eq!(
            ctx.accounts.transfer_policy.config,
            ctx.accounts.config.key(),
            ComplianceError::InvalidLink
        );
        require_keys_eq!(
            ctx.accounts.transfer_policy.series,
            order.series,
            ComplianceError::InvalidSeries
        );
        validate_token_2022_account(
            &ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_token_2022_account(
            &ctx.accounts.old_receipt_ata.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_token_2022_account(
            &ctx.accounts.new_receipt_ata.to_account_info(),
            ctx.accounts.token_program.key(),
        )?;
        validate_receipt_ata(
            ctx.accounts.old_receipt_ata.key(),
            ctx.accounts.old_receipt_ata.mint,
            ctx.accounts.old_receipt_ata.owner,
            order.old_wallet,
            order.series,
            ctx.accounts.token_program.key(),
        )?;
        validate_receipt_ata(
            ctx.accounts.new_receipt_ata.key(),
            ctx.accounts.new_receipt_ata.mint,
            ctx.accounts.new_receipt_ata.owner,
            order.new_wallet,
            order.series,
            ctx.accounts.token_program.key(),
        )?;
        require!(
            order.expected_receipt_amount > 0
                && ctx.accounts.old_receipt_ata.amount == 0
                && ctx.accounts.new_receipt_ata.amount == order.expected_receipt_amount,
            ComplianceError::InvalidRecoveryBalance
        );
        require_keys_eq!(
            mint_permanent_delegate(&ctx.accounts.mint.to_account_info())?,
            order.permanent_delegate,
            ComplianceError::InvalidPermanentDelegate
        );

        let old_wallet = order.old_wallet;
        let new_wallet = order.new_wallet;
        let recovered_amount = order.expected_receipt_amount;
        deactivate_binding(&mut ctx.accounts.old_binding, now);
        activate_recovered_binding(&mut ctx.accounts.new_binding, now);

        let old_permission = &mut ctx.accounts.old_permission;
        old_permission.status = EligibilityStatus::Revoked;
        old_permission.updated_at = now;

        let investor = &mut ctx.accounts.investor_record;
        investor.current_wallet = new_wallet;
        investor.updated_at = now;

        let order = &mut ctx.accounts.recovery_order;
        order.status = RecoveryStatus::Executed;
        order.executed_at = now;

        emit!(WalletBindingChanged {
            investor_record: investor.key(),
            old_wallet,
            new_wallet,
            recovered: true,
            timestamp: now,
        });
        emit!(ReceiptBalanceRecovered {
            recovery_order: order.key(),
            investor_record: investor.key(),
            series: order.series,
            old_wallet,
            new_wallet,
            permanent_delegate: order.permanent_delegate,
            amount: recovered_amount,
            timestamp: now,
        });
        emit!(RecoveryChanged {
            recovery_order: order.key(),
            investor_record: order.investor_record,
            old_wallet,
            new_wallet,
            status: order.status,
            timestamp: now,
        });
        Ok(())
    }

    #[instruction(
        discriminator = InitializeExtraAccountMetaListInstruction::SPL_DISCRIMINATOR_SLICE
    )]
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        require_not_paused(&ctx.accounts.config)?;
        require_keys_eq!(
            ctx.accounts.transfer_policy.series,
            ctx.accounts.mint.key(),
            ComplianceError::InvalidSeries
        );

        let extra_account_metas = transfer_hook_extra_account_metas()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
            &extra_account_metas,
        )
        .map_err(|_| ProgramError::InvalidAccountData)?;
        Ok(())
    }

    #[instruction(discriminator = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE)]
    pub fn transfer_hook(ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        check_is_transferring(&ctx)?;
        let now = Clock::get()?.unix_timestamp;
        let permanent_delegate = mint_permanent_delegate(&ctx.accounts.mint.to_account_info())?;
        if ctx.accounts.owner.key() == permanent_delegate {
            enforce_recovery_transfer_policy(
                &ctx.accounts.config,
                &ctx.accounts.transfer_policy,
                ctx.accounts.mint.key(),
                amount,
                ctx.accounts.source_token.amount,
                ctx.accounts.destination_token.amount,
                ctx.accounts.source_token.owner,
                ctx.accounts.destination_token.owner,
                &ctx.accounts.source_binding,
                &ctx.accounts.destination_binding,
                &ctx.accounts.source_permission,
                &ctx.accounts.destination_permission,
                &ctx.accounts.source_investor,
                ctx.accounts.source_investor.key(),
                &ctx.accounts.destination_investor,
                ctx.accounts.destination_investor.key(),
                now,
            )?;

            emit!(RecoveryTransferValidated {
                recovery_order: ctx.accounts.destination_binding.recovery_order,
                investor_record: ctx.accounts.source_investor.key(),
                series: ctx.accounts.mint.key(),
                source_wallet: ctx.accounts.source_token.owner,
                destination_wallet: ctx.accounts.destination_token.owner,
                permanent_delegate,
                amount,
                timestamp: now,
            });
        } else {
            enforce_transfer_policy(
                &ctx.accounts.config,
                &ctx.accounts.transfer_policy,
                ctx.accounts.mint.key(),
                ctx.accounts.source_token.owner,
                ctx.accounts.destination_token.owner,
                &ctx.accounts.source_binding,
                &ctx.accounts.destination_binding,
                &ctx.accounts.source_permission,
                &ctx.accounts.destination_permission,
                &ctx.accounts.source_investor,
                ctx.accounts.source_investor.key(),
                &ctx.accounts.destination_investor,
                ctx.accounts.destination_investor.key(),
                now,
            )?;

            emit!(TransferValidated {
                series: ctx.accounts.mint.key(),
                source_wallet: ctx.accounts.source_token.owner,
                destination_wallet: ctx.accounts.destination_token.owner,
                mode: ctx.accounts.transfer_policy.mode,
                timestamp: now,
            });
        }
        Ok(())
    }
}

fn validate_recovery_delay(delay_seconds: i64) -> Result<()> {
    require!(
        (MIN_RECOVERY_DELAY_SECONDS..=MAX_RECOVERY_DELAY_SECONDS).contains(&delay_seconds),
        ComplianceError::InvalidRecoveryDelay
    );
    Ok(())
}

fn require_not_paused(config: &ComplianceConfig) -> Result<()> {
    require!(!config.paused, ComplianceError::ConfigPaused);
    Ok(())
}

fn require_provider(
    provider: &ProviderRecord,
    provider_authority: &Signer,
    needs_issue: bool,
    needs_revoke: bool,
) -> Result<()> {
    require_keys_eq!(
        provider.authority,
        provider_authority.key(),
        ComplianceError::InvalidAuthority
    );
    require!(provider.active, ComplianceError::ProviderInactive);
    if needs_issue {
        require!(provider.can_issue, ComplianceError::ProviderCannotIssue);
    }
    if needs_revoke {
        require!(provider.can_revoke, ComplianceError::ProviderCannotRevoke);
    }
    Ok(())
}

fn validate_provider_investor_link(
    provider: &Account<ProviderRecord>,
    investor: &Account<InvestorRecord>,
) -> Result<()> {
    require_keys_eq!(
        investor.provider_record,
        provider.key(),
        ComplianceError::InvalidLink
    );
    require_keys_eq!(
        investor.config,
        provider.config,
        ComplianceError::InvalidLink
    );
    Ok(())
}

fn validate_active_binding(
    binding: &WalletBinding,
    investor_record: Pubkey,
    wallet: Pubkey,
) -> Result<()> {
    require!(binding.active, ComplianceError::WalletMismatch);
    require_keys_eq!(
        binding.investor_record,
        investor_record,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(binding.wallet, wallet, ComplianceError::WalletMismatch);
    Ok(())
}

fn initialize_wallet_binding(
    binding: &mut Account<WalletBinding>,
    config: Pubkey,
    investor_record: Pubkey,
    opaque_id: [u8; 32],
    wallet: Pubkey,
    now: i64,
    bump: u8,
) {
    binding.schema_version = schema_v1();
    binding.opaque_id = opaque_id;
    binding.config = config;
    binding.investor_record = investor_record;
    binding.wallet = wallet;
    binding.active = true;
    binding.pending_recovery = false;
    binding.recovery_order = Pubkey::default();
    binding.recovery_source_wallet = Pubkey::default();
    binding.recovery_series = Pubkey::default();
    binding.recovery_expires_at = 0;
    binding.bound_at = now;
    binding.unbound_at = 0;
    binding.bump = bump;
    binding.reserved = initialize_reserved();
}

fn deactivate_binding(binding: &mut Account<WalletBinding>, now: i64) {
    binding.active = false;
    binding.pending_recovery = false;
    binding.recovery_order = Pubkey::default();
    binding.recovery_source_wallet = Pubkey::default();
    binding.recovery_series = Pubkey::default();
    binding.recovery_expires_at = 0;
    binding.unbound_at = now;
}

#[allow(clippy::too_many_arguments)]
fn initialize_pending_recovery_binding(
    binding: &mut Account<WalletBinding>,
    config: Pubkey,
    investor_record: Pubkey,
    opaque_id: [u8; 32],
    wallet: Pubkey,
    recovery_order: Pubkey,
    recovery_source_wallet: Pubkey,
    recovery_series: Pubkey,
    recovery_expires_at: i64,
    now: i64,
    bump: u8,
) {
    binding.schema_version = schema_v1();
    binding.opaque_id = opaque_id;
    binding.config = config;
    binding.investor_record = investor_record;
    binding.wallet = wallet;
    binding.active = false;
    binding.pending_recovery = true;
    binding.recovery_order = recovery_order;
    binding.recovery_source_wallet = recovery_source_wallet;
    binding.recovery_series = recovery_series;
    binding.recovery_expires_at = recovery_expires_at;
    binding.bound_at = now;
    binding.unbound_at = 0;
    binding.bump = bump;
    binding.reserved = initialize_reserved();
}

fn activate_recovered_binding(binding: &mut Account<WalletBinding>, now: i64) {
    binding.active = true;
    binding.pending_recovery = false;
    binding.recovery_order = Pubkey::default();
    binding.recovery_source_wallet = Pubkey::default();
    binding.recovery_series = Pubkey::default();
    binding.recovery_expires_at = 0;
    binding.bound_at = now;
    binding.unbound_at = 0;
}

fn copy_permission_for_recovery(
    destination: &mut Account<SeriesPermission>,
    source: &Account<SeriesPermission>,
    new_wallet: Pubkey,
    now: i64,
    bump: u8,
) {
    destination.schema_version = schema_v1();
    destination.config = source.config;
    destination.series = source.series;
    destination.investor_record = source.investor_record;
    destination.wallet = new_wallet;
    destination.provider_record = source.provider_record;
    destination.status = source.status;
    destination.accepted_terms_hash = source.accepted_terms_hash;
    destination.max_investment = source.max_investment;
    destination.issued_at = source.issued_at;
    destination.updated_at = now;
    destination.expires_at = source.expires_at;
    destination.bump = bump;
    destination.reserved = initialize_reserved();
}

#[allow(clippy::too_many_arguments)]
fn validate_pending_recovery_binding(
    binding: &WalletBinding,
    config: Pubkey,
    investor_record: Pubkey,
    wallet: Pubkey,
    recovery_order: Pubkey,
    recovery_source_wallet: Pubkey,
    recovery_series: Pubkey,
) -> Result<()> {
    require!(
        binding.pending_recovery && !binding.active,
        ComplianceError::RecoveryNotPrepared
    );
    require_keys_eq!(binding.config, config, ComplianceError::InvalidLink);
    require_keys_eq!(
        binding.investor_record,
        investor_record,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(binding.wallet, wallet, ComplianceError::WalletMismatch);
    require_keys_eq!(
        binding.recovery_order,
        recovery_order,
        ComplianceError::InvalidRecoveryOrder
    );
    require_keys_eq!(
        binding.recovery_source_wallet,
        recovery_source_wallet,
        ComplianceError::InvalidRecoveryOrder
    );
    require_keys_eq!(
        binding.recovery_series,
        recovery_series,
        ComplianceError::InvalidSeries
    );
    Ok(())
}

fn validate_recovery_permission(
    permission: &SeriesPermission,
    config: Pubkey,
    series: Pubkey,
    investor_record: Pubkey,
    wallet: Pubkey,
) -> Result<()> {
    require_keys_eq!(permission.config, config, ComplianceError::InvalidLink);
    require_keys_eq!(permission.series, series, ComplianceError::InvalidSeries);
    require_keys_eq!(
        permission.investor_record,
        investor_record,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(permission.wallet, wallet, ComplianceError::WalletMismatch);
    Ok(())
}

fn permissions_match_for_recovery(
    source: &SeriesPermission,
    destination: &SeriesPermission,
) -> bool {
    source.config == destination.config
        && source.series == destination.series
        && source.investor_record == destination.investor_record
        && source.provider_record == destination.provider_record
        && source.status == destination.status
        && source.accepted_terms_hash == destination.accepted_terms_hash
        && source.max_investment == destination.max_investment
        && source.issued_at == destination.issued_at
        && source.expires_at == destination.expires_at
}

fn validate_token_2022_account(account: &AccountInfo, token_program: Pubkey) -> Result<()> {
    require_keys_eq!(
        token_program,
        anchor_spl::token_2022::ID,
        ComplianceError::InvalidTokenProgram
    );
    require_keys_eq!(
        *account.owner,
        token_program,
        ComplianceError::InvalidTokenProgram
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_receipt_ata(
    token_account: Pubkey,
    account_mint: Pubkey,
    account_owner: Pubkey,
    expected_owner: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
) -> Result<()> {
    require_keys_eq!(account_mint, mint, ComplianceError::InvalidSeries);
    require_keys_eq!(
        account_owner,
        expected_owner,
        ComplianceError::WalletMismatch
    );
    let expected_ata =
        get_associated_token_address_with_program_id(&expected_owner, &mint, &token_program);
    require_keys_eq!(
        token_account,
        expected_ata,
        ComplianceError::InvalidAssociatedTokenAccount
    );
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReceiptAccountTransition {
    ThawEligible,
    FreezeRestricted,
    GovernThaw,
    GovernFreeze,
}

#[allow(clippy::too_many_arguments)]
fn validate_receipt_account_control(
    config: &ComplianceConfig,
    config_key: Pubkey,
    provider: &ProviderRecord,
    provider_key: Pubkey,
    investor: &InvestorRecord,
    investor_key: Pubkey,
    binding: &WalletBinding,
    permission: &SeriesPermission,
    policy: &TransferPolicy,
    wallet: Pubkey,
    mint: &InterfaceAccount<Mint>,
    receipt_account: &InterfaceAccount<TokenAccount>,
    token_program: Pubkey,
    transition: ReceiptAccountTransition,
    now: i64,
) -> Result<()> {
    require_keys_eq!(provider.config, config_key, ComplianceError::InvalidLink);
    require_keys_eq!(
        investor.provider_record,
        provider_key,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(
        permission.provider_record,
        provider_key,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(investor.config, config_key, ComplianceError::InvalidLink);
    require_keys_eq!(policy.config, config_key, ComplianceError::InvalidLink);
    require_keys_eq!(policy.series, mint.key(), ComplianceError::InvalidSeries);

    validate_party_links(policy, wallet, binding, permission, investor, investor_key)?;
    require!(
        permission.accepted_terms_hash != [0; 32],
        ComplianceError::InvalidTermsHash
    );
    require!(
        permission.max_investment > 0,
        ComplianceError::InvalidInvestmentCap
    );

    validate_token_2022_account(&mint.to_account_info(), token_program)?;
    validate_token_2022_account(&receipt_account.to_account_info(), token_program)?;
    validate_receipt_mint_profile(&mint.to_account_info(), mint.freeze_authority, config_key)?;
    validate_receipt_ata(
        receipt_account.key(),
        receipt_account.mint,
        receipt_account.owner,
        wallet,
        mint.key(),
        token_program,
    )?;

    validate_receipt_account_transition(
        config.paused,
        policy.active,
        investor.status,
        investor.expires_at,
        permission.status,
        permission.expires_at,
        receipt_account.state,
        transition,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn validate_receipt_account_transition(
    config_paused: bool,
    policy_active: bool,
    investor_status: EligibilityStatus,
    investor_expires_at: i64,
    permission_status: EligibilityStatus,
    permission_expires_at: i64,
    account_state: TokenAccountState,
    transition: ReceiptAccountTransition,
    now: i64,
) -> Result<()> {
    match transition {
        ReceiptAccountTransition::ThawEligible => {
            require!(!config_paused, ComplianceError::ConfigPaused);
            require!(policy_active, ComplianceError::PolicyInactive);
            require!(
                is_currently_active(investor_status, investor_expires_at, now),
                ComplianceError::InvestorInactive
            );
            require!(
                is_currently_active(permission_status, permission_expires_at, now),
                ComplianceError::PermissionInactive
            );
            require!(
                account_state == TokenAccountState::Frozen,
                ComplianceError::InvalidReceiptAccountState
            );
        }
        ReceiptAccountTransition::FreezeRestricted => {
            require!(
                !is_currently_active(investor_status, investor_expires_at, now)
                    || !is_currently_active(permission_status, permission_expires_at, now),
                ComplianceError::ReceiptAccountNotRestricted
            );
            require!(
                account_state == TokenAccountState::Initialized,
                ComplianceError::InvalidReceiptAccountState
            );
        }
        ReceiptAccountTransition::GovernThaw => {
            require!(
                account_state == TokenAccountState::Frozen,
                ComplianceError::InvalidReceiptAccountState
            );
        }
        ReceiptAccountTransition::GovernFreeze => {
            require!(
                account_state == TokenAccountState::Initialized,
                ComplianceError::InvalidReceiptAccountState
            );
        }
    }
    Ok(())
}

fn validate_receipt_mint_profile(
    mint: &AccountInfo,
    freeze_authority: anchor_lang::solana_program::program_option::COption<Pubkey>,
    expected_freeze_authority: Pubkey,
) -> Result<()> {
    let configured_freeze_authority = Option::<Pubkey>::from(freeze_authority)
        .ok_or_else(|| error!(ComplianceError::InvalidFreezeAuthority))?;
    require_keys_eq!(
        configured_freeze_authority,
        expected_freeze_authority,
        ComplianceError::InvalidFreezeAuthority
    );

    let default_state = get_mint_extension_data::<DefaultAccountState>(mint)
        .map_err(|_| error!(ComplianceError::InvalidDefaultAccountState))?;
    require!(
        default_state.state == TokenAccountState::Frozen as u8,
        ComplianceError::InvalidDefaultAccountState
    );
    Ok(())
}

fn thaw_canonical_receipt_account<'info>(
    config: &Account<'info, ComplianceConfig>,
    mint: &InterfaceAccount<'info, Mint>,
    receipt_account: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let bump = [config.bump];
    let authority_seeds: &[&[u8]] = &[COMPLIANCE_CONFIG_SEED, &bump];
    let signer_seeds = &[authority_seeds];
    thaw_account(CpiContext::new_with_signer(
        token_program.key(),
        ThawAccount {
            account: receipt_account.to_account_info(),
            mint: mint.to_account_info(),
            authority: config.to_account_info(),
        },
        signer_seeds,
    ))
}

fn freeze_canonical_receipt_account<'info>(
    config: &Account<'info, ComplianceConfig>,
    mint: &InterfaceAccount<'info, Mint>,
    receipt_account: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
) -> Result<()> {
    let bump = [config.bump];
    let authority_seeds: &[&[u8]] = &[COMPLIANCE_CONFIG_SEED, &bump];
    let signer_seeds = &[authority_seeds];
    freeze_account(CpiContext::new_with_signer(
        token_program.key(),
        FreezeAccount {
            account: receipt_account.to_account_info(),
            mint: mint.to_account_info(),
            authority: config.to_account_info(),
        },
        signer_seeds,
    ))
}

#[allow(clippy::too_many_arguments)]
fn emit_receipt_account_state_changed(
    mint: &InterfaceAccount<Mint>,
    investor: &Account<InvestorRecord>,
    wallet: Pubkey,
    receipt_account: &InterfaceAccount<TokenAccount>,
    authority: Pubkey,
    provider_record: Pubkey,
    frozen: bool,
    governance_override: bool,
) -> Result<()> {
    emit!(ReceiptAccountStateChanged {
        series: mint.key(),
        investor_record: investor.key(),
        wallet,
        receipt_account: receipt_account.key(),
        authority,
        provider_record,
        frozen,
        governance_override,
        timestamp: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

fn mint_permanent_delegate(mint: &AccountInfo) -> Result<Pubkey> {
    let extension = get_mint_extension_data::<PermanentDelegate>(mint)
        .map_err(|_| error!(ComplianceError::InvalidPermanentDelegate))?;
    Option::<Pubkey>::from(extension.delegate)
        .ok_or_else(|| error!(ComplianceError::InvalidPermanentDelegate))
}

#[allow(clippy::too_many_arguments)]
fn enforce_transfer_policy(
    config: &ComplianceConfig,
    policy: &TransferPolicy,
    series: Pubkey,
    source_wallet: Pubkey,
    destination_wallet: Pubkey,
    source_binding: &WalletBinding,
    destination_binding: &WalletBinding,
    source_permission: &SeriesPermission,
    destination_permission: &SeriesPermission,
    source_investor: &InvestorRecord,
    source_investor_key: Pubkey,
    destination_investor: &InvestorRecord,
    destination_investor_key: Pubkey,
    now: i64,
) -> Result<()> {
    require_not_paused(config)?;
    require!(policy.active, ComplianceError::PolicyInactive);
    require_keys_eq!(
        policy.config,
        source_binding.config,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(
        policy.config,
        destination_binding.config,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(policy.series, series, ComplianceError::InvalidSeries);

    validate_transfer_party(
        policy,
        source_wallet,
        source_binding,
        source_permission,
        source_investor,
        source_investor_key,
        now,
    )?;
    validate_transfer_party(
        policy,
        destination_wallet,
        destination_binding,
        destination_permission,
        destination_investor,
        destination_investor_key,
        now,
    )?;

    match policy.mode {
        TransferPolicyMode::IssuerRestricted => {
            require!(
                source_wallet == policy.issuer || destination_wallet == policy.issuer,
                ComplianceError::TransferNotAllowed
            );
        }
        TransferPolicyMode::EligiblePeer => {}
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn enforce_recovery_transfer_policy(
    config: &ComplianceConfig,
    policy: &TransferPolicy,
    series: Pubkey,
    amount: u64,
    source_balance_after_transfer: u64,
    destination_balance_after_transfer: u64,
    source_wallet: Pubkey,
    destination_wallet: Pubkey,
    source_binding: &WalletBinding,
    destination_binding: &WalletBinding,
    source_permission: &SeriesPermission,
    destination_permission: &SeriesPermission,
    source_investor: &InvestorRecord,
    source_investor_key: Pubkey,
    destination_investor: &InvestorRecord,
    destination_investor_key: Pubkey,
    now: i64,
) -> Result<()> {
    require_not_paused(config)?;
    require!(policy.active, ComplianceError::PolicyInactive);
    require_keys_eq!(policy.series, series, ComplianceError::InvalidSeries);
    require!(amount > 0, ComplianceError::InvalidRecoveryBalance);
    require!(
        source_balance_after_transfer == 0 && destination_balance_after_transfer == amount,
        ComplianceError::InvalidRecoveryBalance
    );
    require_keys_neq!(
        source_wallet,
        destination_wallet,
        ComplianceError::WalletMismatch
    );
    require_keys_eq!(
        source_investor_key,
        destination_investor_key,
        ComplianceError::InvalidLink
    );
    require!(
        source_investor.opaque_id == destination_investor.opaque_id,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(
        source_investor.config,
        policy.config,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(
        destination_investor.config,
        policy.config,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(
        source_investor.current_wallet,
        source_wallet,
        ComplianceError::WalletMismatch
    );

    validate_active_binding(source_binding, source_investor_key, source_wallet)?;
    require_keys_eq!(
        source_binding.config,
        policy.config,
        ComplianceError::InvalidLink
    );
    require!(
        destination_binding.pending_recovery && !destination_binding.active,
        ComplianceError::RecoveryNotPrepared
    );
    require_keys_eq!(
        destination_binding.config,
        policy.config,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(
        destination_binding.investor_record,
        source_investor_key,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(
        destination_binding.wallet,
        destination_wallet,
        ComplianceError::WalletMismatch
    );
    require_keys_eq!(
        destination_binding.recovery_source_wallet,
        source_wallet,
        ComplianceError::InvalidRecoveryOrder
    );
    require_keys_eq!(
        destination_binding.recovery_series,
        series,
        ComplianceError::InvalidSeries
    );
    require!(
        destination_binding.recovery_order != Pubkey::default(),
        ComplianceError::InvalidRecoveryOrder
    );
    require!(
        now <= destination_binding.recovery_expires_at,
        ComplianceError::RecoveryExpired
    );

    validate_recovery_permission(
        source_permission,
        policy.config,
        series,
        source_investor_key,
        source_wallet,
    )?;
    validate_recovery_permission(
        destination_permission,
        policy.config,
        series,
        destination_investor_key,
        destination_wallet,
    )?;
    require!(
        permissions_match_for_recovery(source_permission, destination_permission),
        ComplianceError::RecoveryPermissionMismatch
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_transfer_party(
    policy: &TransferPolicy,
    wallet: Pubkey,
    binding: &WalletBinding,
    permission: &SeriesPermission,
    investor: &InvestorRecord,
    investor_key: Pubkey,
    now: i64,
) -> Result<()> {
    validate_party_links(policy, wallet, binding, permission, investor, investor_key)?;

    require!(
        is_currently_active(permission.status, permission.expires_at, now),
        ComplianceError::PermissionInactive
    );
    require!(
        is_currently_active(investor.status, investor.expires_at, now),
        ComplianceError::InvestorInactive
    );
    Ok(())
}

fn validate_burn_purpose(
    purpose: BurnPurpose,
    investor: &InvestorRecord,
    permission: &SeriesPermission,
    now: i64,
) -> Result<()> {
    let investor_active = is_currently_active(investor.status, investor.expires_at, now);
    let permission_active = is_currently_active(permission.status, permission.expires_at, now);

    match purpose {
        BurnPurpose::Refund => Ok(()),
        BurnPurpose::Redemption => {
            require!(investor_active, ComplianceError::InvestorInactive);
            require!(permission_active, ComplianceError::PermissionInactive);
            Ok(())
        }
        BurnPurpose::RestrictedRedemption => {
            require!(
                !investor_active || !permission_active,
                ComplianceError::RestrictedRedemptionRequiresRestriction
            );
            Ok(())
        }
    }
}

fn permissioned_burn_instruction_data(amount: u64, decimals: u8) -> Vec<u8> {
    let mut data = Vec::with_capacity(11);
    data.push(46);
    data.push(2);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    data
}

/// Builds the permanent-delegate Token-2022 checked transfer used between
/// `prepare_recovery` and `execute_recovery`.
///
/// `resolved_hook_accounts` must be supplied in the order stored by this
/// program's ExtraAccountMetaList: config, policy, source binding,
/// destination binding, source permission, destination permission, source
/// investor, destination investor. Token-2022 expects those accounts first,
/// followed by the validation-state PDA and the hook program.
pub fn build_recovery_transfer_checked_instruction(
    token_program: Pubkey,
    source_receipt_ata: Pubkey,
    mint: Pubkey,
    destination_receipt_ata: Pubkey,
    permanent_delegate: Pubkey,
    amount: u64,
    decimals: u8,
    resolved_hook_accounts: [Pubkey; TRANSFER_HOOK_EXTRA_ACCOUNT_COUNT],
    extra_account_meta_list: Pubkey,
    hook_program: Pubkey,
) -> Result<Instruction> {
    require_keys_eq!(
        token_program,
        anchor_spl::token_2022::ID,
        ComplianceError::InvalidTokenProgram
    );
    require_keys_eq!(hook_program, crate::ID, ComplianceError::InvalidLink);
    require!(amount > 0, ComplianceError::InvalidRecoveryBalance);

    let mut instruction = anchor_spl::token_2022::spl_token_2022::instruction::transfer_checked(
        &token_program,
        &source_receipt_ata,
        &mint,
        &destination_receipt_ata,
        &permanent_delegate,
        &[],
        amount,
        decimals,
    )?;
    instruction.accounts.extend(
        resolved_hook_accounts
            .into_iter()
            .map(|key| AccountMeta::new_readonly(key, false)),
    );
    instruction
        .accounts
        .push(AccountMeta::new_readonly(extra_account_meta_list, false));
    instruction
        .accounts
        .push(AccountMeta::new_readonly(hook_program, false));
    Ok(instruction)
}

fn validate_party_links(
    policy: &TransferPolicy,
    wallet: Pubkey,
    binding: &WalletBinding,
    permission: &SeriesPermission,
    investor: &InvestorRecord,
    investor_key: Pubkey,
) -> Result<()> {
    require!(binding.active, ComplianceError::WalletMismatch);
    require_keys_eq!(binding.wallet, wallet, ComplianceError::WalletMismatch);
    require_keys_eq!(
        binding.investor_record,
        investor_key,
        ComplianceError::InvalidLink
    );
    require!(
        binding.opaque_id == investor.opaque_id,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(binding.config, policy.config, ComplianceError::InvalidLink);

    require_keys_eq!(
        permission.config,
        policy.config,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(
        permission.series,
        policy.series,
        ComplianceError::InvalidSeries
    );
    require_keys_eq!(
        permission.investor_record,
        investor_key,
        ComplianceError::InvalidLink
    );
    require_keys_eq!(permission.wallet, wallet, ComplianceError::WalletMismatch);

    require_keys_eq!(investor.config, policy.config, ComplianceError::InvalidLink);
    require_keys_eq!(
        investor.current_wallet,
        wallet,
        ComplianceError::WalletMismatch
    );
    Ok(())
}

fn transfer_hook_extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    let source_owner = Seed::AccountData {
        account_index: 0,
        data_index: 32,
        length: 32,
    };
    let destination_owner = Seed::AccountData {
        account_index: 2,
        data_index: 32,
        length: 32,
    };

    let metas = vec![
        ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal {
                bytes: COMPLIANCE_CONFIG_SEED.to_vec(),
            }],
            false,
            false,
        ),
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: TRANSFER_POLICY_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        ),
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: WALLET_BINDING_SEED.to_vec(),
                },
                source_owner.clone(),
            ],
            false,
            false,
        ),
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: WALLET_BINDING_SEED.to_vec(),
                },
                destination_owner.clone(),
            ],
            false,
            false,
        ),
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: SERIES_PERMISSION_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                source_owner,
            ],
            false,
            false,
        ),
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: SERIES_PERMISSION_SEED.to_vec(),
                },
                Seed::AccountKey { index: 1 },
                destination_owner,
            ],
            false,
            false,
        ),
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: INVESTOR_SEED.to_vec(),
                },
                Seed::AccountData {
                    account_index: 7,
                    data_index: WalletBinding::OPAQUE_ID_DATA_OFFSET,
                    length: 32,
                },
            ],
            false,
            false,
        ),
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: INVESTOR_SEED.to_vec(),
                },
                Seed::AccountData {
                    account_index: 8,
                    data_index: WalletBinding::OPAQUE_ID_DATA_OFFSET,
                    length: 32,
                },
            ],
            false,
            false,
        ),
    ];

    metas
        .into_iter()
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| error!(ComplianceError::InvalidLink))
}

fn check_is_transferring(ctx: &Context<TransferHook>) -> Result<()> {
    let source_token_info = ctx.accounts.source_token.to_account_info();
    let mut account_data_ref: RefMut<&mut [u8]> = source_token_info.try_borrow_mut_data()?;
    let mut account = PodStateWithExtensionsMut::<PodAccount>::unpack(*account_data_ref)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    let extension = account
        .get_extension_mut::<TransferHookAccount>()
        .map_err(|_| ProgramError::InvalidAccountData)?;
    require!(
        bool::from(extension.transferring),
        ComplianceError::TransferNotInProgress
    );
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = governance,
        space = ComplianceConfig::SPACE,
        seeds = [COMPLIANCE_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, ComplianceConfig>,
    #[account(mut)]
    pub governance: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GovernConfig<'info> {
    #[account(
        mut,
        seeds = [COMPLIANCE_CONFIG_SEED],
        bump = config.bump,
        has_one = governance
    )]
    pub config: Account<'info, ComplianceConfig>,
    pub governance: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptGovernance<'info> {
    #[account(mut, seeds = [COMPLIANCE_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ComplianceConfig>,
    pub pending_governance: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(provider_authority: Pubkey)]
pub struct RegisterProvider<'info> {
    #[account(
        seeds = [COMPLIANCE_CONFIG_SEED],
        bump = config.bump,
        has_one = governance
    )]
    pub config: Account<'info, ComplianceConfig>,
    #[account(
        init,
        payer = governance,
        space = ProviderRecord::SPACE,
        seeds = [PROVIDER_SEED, provider_authority.as_ref()],
        bump
    )]
    pub provider_record: Account<'info, ProviderRecord>,
    #[account(mut)]
    pub governance: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProvider<'info> {
    #[account(
        seeds = [COMPLIANCE_CONFIG_SEED],
        bump = config.bump,
        has_one = governance
    )]
    pub config: Account<'info, ComplianceConfig>,
    #[account(
        mut,
        seeds = [PROVIDER_SEED, provider_record.authority.as_ref()],
        bump = provider_record.bump,
        constraint = provider_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub provider_record: Account<'info, ProviderRecord>,
    pub governance: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(opaque_id: [u8; 32])]
pub struct IssueInvestor<'info> {
    #[account(seeds = [COMPLIANCE_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ComplianceConfig>,
    #[account(
        seeds = [PROVIDER_SEED, provider_authority.key().as_ref()],
        bump = provider_record.bump,
        constraint = provider_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub provider_record: Account<'info, ProviderRecord>,
    #[account(
        init,
        payer = provider_authority,
        space = InvestorRecord::SPACE,
        seeds = [INVESTOR_SEED, opaque_id.as_ref()],
        bump
    )]
    pub investor_record: Account<'info, InvestorRecord>,
    #[account(mut)]
    pub provider_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageInvestor<'info> {
    #[account(seeds = [COMPLIANCE_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ComplianceConfig>,
    #[account(
        seeds = [PROVIDER_SEED, provider_authority.key().as_ref()],
        bump = provider_record.bump,
        constraint = provider_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub provider_record: Account<'info, ProviderRecord>,
    #[account(
        mut,
        seeds = [INVESTOR_SEED, investor_record.opaque_id.as_ref()],
        bump = investor_record.bump,
        constraint = investor_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub investor_record: Account<'info, InvestorRecord>,
    pub provider_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct BindWallet<'info> {
    #[account(seeds = [COMPLIANCE_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ComplianceConfig>,
    #[account(
        seeds = [PROVIDER_SEED, provider_authority.key().as_ref()],
        bump = provider_record.bump,
        constraint = provider_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub provider_record: Account<'info, ProviderRecord>,
    #[account(
        mut,
        seeds = [INVESTOR_SEED, investor_record.opaque_id.as_ref()],
        bump = investor_record.bump,
        constraint = investor_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub investor_record: Account<'info, InvestorRecord>,
    #[account(
        init,
        payer = provider_authority,
        space = WalletBinding::SPACE,
        seeds = [WALLET_BINDING_SEED, wallet.key().as_ref()],
        bump
    )]
    pub wallet_binding: Account<'info, WalletBinding>,
    pub wallet: Signer<'info>,
    #[account(mut)]
    pub provider_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RotateWallet<'info> {
    #[account(seeds = [COMPLIANCE_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ComplianceConfig>>,
    #[account(
        seeds = [PROVIDER_SEED, provider_authority.key().as_ref()],
        bump = provider_record.bump,
        constraint = provider_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub provider_record: Box<Account<'info, ProviderRecord>>,
    #[account(
        mut,
        seeds = [INVESTOR_SEED, investor_record.opaque_id.as_ref()],
        bump = investor_record.bump,
        constraint = investor_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub investor_record: Box<Account<'info, InvestorRecord>>,
    #[account(
        mut,
        seeds = [WALLET_BINDING_SEED, old_wallet.key().as_ref()],
        bump = old_binding.bump
    )]
    pub old_binding: Box<Account<'info, WalletBinding>>,
    #[account(
        init,
        payer = provider_authority,
        space = WalletBinding::SPACE,
        seeds = [WALLET_BINDING_SEED, new_wallet.key().as_ref()],
        bump
    )]
    pub new_binding: Box<Account<'info, WalletBinding>>,
    pub old_wallet: Signer<'info>,
    pub new_wallet: Signer<'info>,
    #[account(mut)]
    pub provider_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(series: Pubkey)]
pub struct SetSeriesPermission<'info> {
    #[account(seeds = [COMPLIANCE_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ComplianceConfig>>,
    #[account(
        seeds = [PROVIDER_SEED, provider_authority.key().as_ref()],
        bump = provider_record.bump,
        constraint = provider_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub provider_record: Box<Account<'info, ProviderRecord>>,
    #[account(
        seeds = [INVESTOR_SEED, investor_record.opaque_id.as_ref()],
        bump = investor_record.bump,
        constraint = investor_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub investor_record: Box<Account<'info, InvestorRecord>>,
    #[account(
        seeds = [WALLET_BINDING_SEED, wallet.key().as_ref()],
        bump = wallet_binding.bump,
        constraint = wallet_binding.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub wallet_binding: Box<Account<'info, WalletBinding>>,
    #[account(
        init_if_needed,
        payer = provider_authority,
        space = SeriesPermission::SPACE,
        seeds = [SERIES_PERMISSION_SEED, series.as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub series_permission: Box<Account<'info, SeriesPermission>>,
    /// CHECK: The wallet need not sign when a registered provider updates an
    /// existing permission, but its address is bound by the WalletBinding PDA.
    pub wallet: UncheckedAccount<'info>,
    #[account(mut)]
    pub provider_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeSeriesPermission<'info> {
    #[account(seeds = [COMPLIANCE_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ComplianceConfig>,
    #[account(
        seeds = [PROVIDER_SEED, provider_authority.key().as_ref()],
        bump = provider_record.bump,
        constraint = provider_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub provider_record: Account<'info, ProviderRecord>,
    #[account(
        mut,
        seeds = [
            SERIES_PERMISSION_SEED,
            series_permission.series.as_ref(),
            series_permission.wallet.as_ref()
        ],
        bump = series_permission.bump,
        constraint = series_permission.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub series_permission: Account<'info, SeriesPermission>,
    pub provider_authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(series: Pubkey)]
pub struct ConfigureTransferPolicy<'info> {
    #[account(
        seeds = [COMPLIANCE_CONFIG_SEED],
        bump = config.bump,
        has_one = governance
    )]
    pub config: Account<'info, ComplianceConfig>,
    #[account(
        init_if_needed,
        payer = governance,
        space = TransferPolicy::SPACE,
        seeds = [TRANSFER_POLICY_SEED, series.as_ref()],
        bump
    )]
    pub transfer_policy: Account<'info, TransferPolicy>,
    #[account(mut)]
    pub governance: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProviderReceiptAccountControl<'info> {
    #[account(seeds = [COMPLIANCE_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ComplianceConfig>>,
    #[account(
        seeds = [PROVIDER_SEED, provider_authority.key().as_ref()],
        bump = provider_record.bump,
        constraint = provider_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub provider_record: Box<Account<'info, ProviderRecord>>,
    #[account(
        seeds = [INVESTOR_SEED, investor_record.opaque_id.as_ref()],
        bump = investor_record.bump,
        constraint = investor_record.config == config.key() @ ComplianceError::InvalidLink,
        constraint = investor_record.provider_record == provider_record.key() @ ComplianceError::InvalidLink
    )]
    pub investor_record: Box<Account<'info, InvestorRecord>>,
    #[account(
        seeds = [WALLET_BINDING_SEED, wallet.key().as_ref()],
        bump = wallet_binding.bump,
        constraint = wallet_binding.config == config.key() @ ComplianceError::InvalidLink,
        constraint = wallet_binding.investor_record == investor_record.key() @ ComplianceError::InvalidLink,
        constraint = wallet_binding.wallet == wallet.key() @ ComplianceError::WalletMismatch
    )]
    pub wallet_binding: Box<Account<'info, WalletBinding>>,
    #[account(
        seeds = [
            SERIES_PERMISSION_SEED,
            mint.key().as_ref(),
            wallet.key().as_ref()
        ],
        bump = series_permission.bump,
        constraint = series_permission.config == config.key() @ ComplianceError::InvalidLink,
        constraint = series_permission.investor_record == investor_record.key() @ ComplianceError::InvalidLink,
        constraint = series_permission.provider_record == provider_record.key() @ ComplianceError::InvalidLink,
        constraint = series_permission.wallet == wallet.key() @ ComplianceError::WalletMismatch,
        constraint = series_permission.series == mint.key() @ ComplianceError::InvalidSeries
    )]
    pub series_permission: Box<Account<'info, SeriesPermission>>,
    #[account(
        seeds = [TRANSFER_POLICY_SEED, mint.key().as_ref()],
        bump = transfer_policy.bump,
        constraint = transfer_policy.config == config.key() @ ComplianceError::InvalidLink,
        constraint = transfer_policy.series == mint.key() @ ComplianceError::InvalidSeries
    )]
    pub transfer_policy: Box<Account<'info, TransferPolicy>>,
    #[account(mut, address = transfer_policy.series @ ComplianceError::InvalidSeries)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = wallet,
        token::token_program = token_program
    )]
    pub receipt_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Bound through the WalletBinding PDA, InvestorRecord and
    /// SeriesPermission, then used to derive the canonical Token-2022 ATA.
    pub wallet: UncheckedAccount<'info>,
    pub provider_authority: Signer<'info>,
    #[account(address = anchor_spl::token_2022::ID @ ComplianceError::InvalidTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct GovernReceiptAccountControl<'info> {
    #[account(
        seeds = [COMPLIANCE_CONFIG_SEED],
        bump = config.bump,
        has_one = governance
    )]
    pub config: Box<Account<'info, ComplianceConfig>>,
    #[account(
        seeds = [PROVIDER_SEED, provider_record.authority.as_ref()],
        bump = provider_record.bump,
        constraint = provider_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub provider_record: Box<Account<'info, ProviderRecord>>,
    #[account(
        seeds = [INVESTOR_SEED, investor_record.opaque_id.as_ref()],
        bump = investor_record.bump,
        constraint = investor_record.config == config.key() @ ComplianceError::InvalidLink,
        constraint = investor_record.provider_record == provider_record.key() @ ComplianceError::InvalidLink
    )]
    pub investor_record: Box<Account<'info, InvestorRecord>>,
    #[account(
        seeds = [WALLET_BINDING_SEED, wallet.key().as_ref()],
        bump = wallet_binding.bump,
        constraint = wallet_binding.config == config.key() @ ComplianceError::InvalidLink,
        constraint = wallet_binding.investor_record == investor_record.key() @ ComplianceError::InvalidLink,
        constraint = wallet_binding.wallet == wallet.key() @ ComplianceError::WalletMismatch
    )]
    pub wallet_binding: Box<Account<'info, WalletBinding>>,
    #[account(
        seeds = [
            SERIES_PERMISSION_SEED,
            mint.key().as_ref(),
            wallet.key().as_ref()
        ],
        bump = series_permission.bump,
        constraint = series_permission.config == config.key() @ ComplianceError::InvalidLink,
        constraint = series_permission.investor_record == investor_record.key() @ ComplianceError::InvalidLink,
        constraint = series_permission.provider_record == provider_record.key() @ ComplianceError::InvalidLink,
        constraint = series_permission.wallet == wallet.key() @ ComplianceError::WalletMismatch,
        constraint = series_permission.series == mint.key() @ ComplianceError::InvalidSeries
    )]
    pub series_permission: Box<Account<'info, SeriesPermission>>,
    #[account(
        seeds = [TRANSFER_POLICY_SEED, mint.key().as_ref()],
        bump = transfer_policy.bump,
        constraint = transfer_policy.config == config.key() @ ComplianceError::InvalidLink,
        constraint = transfer_policy.series == mint.key() @ ComplianceError::InvalidSeries
    )]
    pub transfer_policy: Box<Account<'info, TransferPolicy>>,
    #[account(mut, address = transfer_policy.series @ ComplianceError::InvalidSeries)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = wallet,
        token::token_program = token_program
    )]
    pub receipt_account: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Bound through the WalletBinding PDA, InvestorRecord and
    /// SeriesPermission, then used to derive the canonical Token-2022 ATA.
    pub wallet: UncheckedAccount<'info>,
    pub governance: Signer<'info>,
    #[account(address = anchor_spl::token_2022::ID @ ComplianceError::InvalidTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct PermissionedBurn<'info> {
    #[account(seeds = [COMPLIANCE_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ComplianceConfig>>,
    #[account(
        seeds = [TRANSFER_POLICY_SEED, mint.key().as_ref()],
        bump = transfer_policy.bump,
        constraint = transfer_policy.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub transfer_policy: Box<Account<'info, TransferPolicy>>,
    #[account(
        seeds = [WALLET_BINDING_SEED, source_owner.key().as_ref()],
        bump = source_binding.bump,
        constraint = source_binding.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub source_binding: Box<Account<'info, WalletBinding>>,
    #[account(
        seeds = [
            SERIES_PERMISSION_SEED,
            mint.key().as_ref(),
            source_owner.key().as_ref()
        ],
        bump = source_permission.bump,
        constraint = source_permission.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub source_permission: Box<Account<'info, SeriesPermission>>,
    #[account(
        seeds = [INVESTOR_SEED, source_binding.opaque_id.as_ref()],
        bump = source_investor.bump,
        constraint = source_investor.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub source_investor: Box<Account<'info, InvestorRecord>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = source_owner
    )]
    pub source_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = transfer_policy.series @ ComplianceError::InvalidSeries)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = transfer_policy.burn_caller @ ComplianceError::InvalidAuthority)]
    pub burn_caller: Signer<'info>,
    pub source_owner: Signer<'info>,
    #[account(address = anchor_spl::token_2022::ID @ ComplianceError::InvalidTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 32])]
pub struct ProposeRecovery<'info> {
    #[account(
        seeds = [COMPLIANCE_CONFIG_SEED],
        bump = config.bump,
        has_one = recovery_authority
    )]
    pub config: Account<'info, ComplianceConfig>,
    #[account(
        seeds = [INVESTOR_SEED, investor_record.opaque_id.as_ref()],
        bump = investor_record.bump,
        constraint = investor_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub investor_record: Account<'info, InvestorRecord>,
    #[account(
        init,
        payer = recovery_authority,
        space = RecoveryOrder::SPACE,
        seeds = [RECOVERY_ORDER_SEED, investor_record.key().as_ref(), order_id.as_ref()],
        bump
    )]
    pub recovery_order: Account<'info, RecoveryOrder>,
    #[account(mut)]
    pub recovery_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelRecovery<'info> {
    #[account(seeds = [COMPLIANCE_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ComplianceConfig>,
    #[account(
        mut,
        seeds = [
            RECOVERY_ORDER_SEED,
            recovery_order.investor_record.as_ref(),
            recovery_order.order_id.as_ref()
        ],
        bump = recovery_order.bump,
        constraint = recovery_order.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub recovery_order: Account<'info, RecoveryOrder>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct PrepareRecovery<'info> {
    #[account(
        seeds = [COMPLIANCE_CONFIG_SEED],
        bump = config.bump,
        has_one = governance
    )]
    pub config: Box<Account<'info, ComplianceConfig>>,
    #[account(
        seeds = [INVESTOR_SEED, investor_record.opaque_id.as_ref()],
        bump = investor_record.bump,
        constraint = investor_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub investor_record: Box<Account<'info, InvestorRecord>>,
    #[account(
        mut,
        seeds = [
            RECOVERY_ORDER_SEED,
            recovery_order.investor_record.as_ref(),
            recovery_order.order_id.as_ref()
        ],
        bump = recovery_order.bump,
        constraint = recovery_order.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub recovery_order: Box<Account<'info, RecoveryOrder>>,
    #[account(
        seeds = [TRANSFER_POLICY_SEED, mint.key().as_ref()],
        bump = transfer_policy.bump,
        constraint = transfer_policy.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub transfer_policy: Box<Account<'info, TransferPolicy>>,
    #[account(
        seeds = [WALLET_BINDING_SEED, recovery_order.old_wallet.as_ref()],
        bump = old_binding.bump
    )]
    pub old_binding: Box<Account<'info, WalletBinding>>,
    #[account(
        init,
        payer = governance,
        space = WalletBinding::SPACE,
        seeds = [WALLET_BINDING_SEED, recovery_order.new_wallet.as_ref()],
        bump
    )]
    pub new_binding: Box<Account<'info, WalletBinding>>,
    #[account(
        seeds = [
            SERIES_PERMISSION_SEED,
            mint.key().as_ref(),
            recovery_order.old_wallet.as_ref()
        ],
        bump = old_permission.bump
    )]
    pub old_permission: Box<Account<'info, SeriesPermission>>,
    #[account(
        init,
        payer = governance,
        space = SeriesPermission::SPACE,
        seeds = [
            SERIES_PERMISSION_SEED,
            mint.key().as_ref(),
            recovery_order.new_wallet.as_ref()
        ],
        bump
    )]
    pub new_permission: Box<Account<'info, SeriesPermission>>,
    pub old_receipt_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub new_receipt_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = recovery_order.new_wallet @ ComplianceError::InvalidRecoveryOrder)]
    pub new_wallet: Signer<'info>,
    #[account(mut)]
    pub governance: Signer<'info>,
    #[account(address = anchor_spl::token_2022::ID @ ComplianceError::InvalidTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteRecovery<'info> {
    #[account(
        seeds = [COMPLIANCE_CONFIG_SEED],
        bump = config.bump,
        has_one = governance
    )]
    pub config: Box<Account<'info, ComplianceConfig>>,
    #[account(
        mut,
        seeds = [INVESTOR_SEED, investor_record.opaque_id.as_ref()],
        bump = investor_record.bump,
        constraint = investor_record.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub investor_record: Box<Account<'info, InvestorRecord>>,
    #[account(
        mut,
        seeds = [
            RECOVERY_ORDER_SEED,
            recovery_order.investor_record.as_ref(),
            recovery_order.order_id.as_ref()
        ],
        bump = recovery_order.bump,
        constraint = recovery_order.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub recovery_order: Box<Account<'info, RecoveryOrder>>,
    #[account(
        seeds = [TRANSFER_POLICY_SEED, mint.key().as_ref()],
        bump = transfer_policy.bump,
        constraint = transfer_policy.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub transfer_policy: Box<Account<'info, TransferPolicy>>,
    #[account(
        mut,
        seeds = [WALLET_BINDING_SEED, recovery_order.old_wallet.as_ref()],
        bump = old_binding.bump
    )]
    pub old_binding: Box<Account<'info, WalletBinding>>,
    #[account(
        mut,
        seeds = [WALLET_BINDING_SEED, recovery_order.new_wallet.as_ref()],
        bump = new_binding.bump
    )]
    pub new_binding: Box<Account<'info, WalletBinding>>,
    #[account(
        mut,
        seeds = [
            SERIES_PERMISSION_SEED,
            mint.key().as_ref(),
            recovery_order.old_wallet.as_ref()
        ],
        bump = old_permission.bump
    )]
    pub old_permission: Box<Account<'info, SeriesPermission>>,
    #[account(
        seeds = [
            SERIES_PERMISSION_SEED,
            mint.key().as_ref(),
            recovery_order.new_wallet.as_ref()
        ],
        bump = new_permission.bump
    )]
    pub new_permission: Box<Account<'info, SeriesPermission>>,
    pub old_receipt_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub new_receipt_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = recovery_order.new_wallet @ ComplianceError::InvalidRecoveryOrder)]
    pub new_wallet: Signer<'info>,
    pub governance: Signer<'info>,
    #[account(address = anchor_spl::token_2022::ID @ ComplianceError::InvalidTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(
        seeds = [COMPLIANCE_CONFIG_SEED],
        bump = config.bump,
        has_one = governance
    )]
    pub config: Account<'info, ComplianceConfig>,
    #[account(
        seeds = [TRANSFER_POLICY_SEED, mint.key().as_ref()],
        bump = transfer_policy.bump,
        constraint = transfer_policy.config == config.key() @ ComplianceError::InvalidLink
    )]
    pub transfer_policy: Account<'info, TransferPolicy>,
    #[account(
        init,
        payer = governance,
        space = ExtraAccountMetaList::size_of(TRANSFER_HOOK_EXTRA_ACCOUNT_COUNT).unwrap(),
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    /// CHECK: The SPL TLV library owns and validates this program-derived data.
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub governance: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Account order is part of the SPL Transfer Hook interface. The first four
/// accounts are fixed by Token-2022, followed by the validation PDA and the
/// eight accounts described in that PDA.
#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint)]
    pub source_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(token::mint = mint)]
    pub destination_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Token-2022 supplies the transfer authority. Eligibility is
    /// evaluated against the token-account owners, not this delegate.
    pub owner: UncheckedAccount<'info>,
    #[account(
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump
    )]
    /// CHECK: Validated by its canonical Transfer Hook PDA.
    pub extra_account_meta_list: UncheckedAccount<'info>,
    #[account(seeds = [COMPLIANCE_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ComplianceConfig>>,
    #[account(
        seeds = [TRANSFER_POLICY_SEED, mint.key().as_ref()],
        bump = transfer_policy.bump
    )]
    pub transfer_policy: Box<Account<'info, TransferPolicy>>,
    #[account(
        seeds = [WALLET_BINDING_SEED, source_token.owner.as_ref()],
        bump = source_binding.bump
    )]
    pub source_binding: Box<Account<'info, WalletBinding>>,
    #[account(
        seeds = [WALLET_BINDING_SEED, destination_token.owner.as_ref()],
        bump = destination_binding.bump
    )]
    pub destination_binding: Box<Account<'info, WalletBinding>>,
    #[account(
        seeds = [
            SERIES_PERMISSION_SEED,
            mint.key().as_ref(),
            source_token.owner.as_ref()
        ],
        bump = source_permission.bump
    )]
    pub source_permission: Box<Account<'info, SeriesPermission>>,
    #[account(
        seeds = [
            SERIES_PERMISSION_SEED,
            mint.key().as_ref(),
            destination_token.owner.as_ref()
        ],
        bump = destination_permission.bump
    )]
    pub destination_permission: Box<Account<'info, SeriesPermission>>,
    #[account(
        seeds = [INVESTOR_SEED, source_binding.opaque_id.as_ref()],
        bump = source_investor.bump
    )]
    pub source_investor: Box<Account<'info, InvestorRecord>>,
    #[account(
        seeds = [INVESTOR_SEED, destination_binding.opaque_id.as_ref()],
        bump = destination_investor.bump
    )]
    pub destination_investor: Box<Account<'info, InvestorRecord>>,
}

#[event]
pub struct ConfigInitialized {
    pub config: Pubkey,
    pub governance: Pubkey,
    pub recovery_authority: Pubkey,
    pub min_recovery_delay_seconds: i64,
    pub timestamp: i64,
}

#[event]
pub struct ConfigUpdated {
    pub config: Pubkey,
    pub recovery_authority: Pubkey,
    pub min_recovery_delay_seconds: i64,
    pub paused: bool,
    pub timestamp: i64,
}

#[event]
pub struct GovernanceProposed {
    pub config: Pubkey,
    pub current_governance: Pubkey,
    pub pending_governance: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct GovernanceAccepted {
    pub config: Pubkey,
    pub old_governance: Pubkey,
    pub new_governance: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ProviderChanged {
    pub provider_record: Pubkey,
    pub provider_authority: Pubkey,
    pub active: bool,
    pub can_issue: bool,
    pub can_revoke: bool,
    pub timestamp: i64,
}

#[event]
pub struct InvestorChanged {
    pub investor_record: Pubkey,
    pub opaque_id: [u8; 32],
    pub provider_record: Pubkey,
    pub status: EligibilityStatus,
    pub expires_at: i64,
    pub timestamp: i64,
}

#[event]
pub struct WalletBindingChanged {
    pub investor_record: Pubkey,
    pub old_wallet: Pubkey,
    pub new_wallet: Pubkey,
    pub recovered: bool,
    pub timestamp: i64,
}

#[event]
pub struct SeriesPermissionChanged {
    pub series: Pubkey,
    pub investor_record: Pubkey,
    pub wallet: Pubkey,
    pub status: EligibilityStatus,
    pub max_investment: u64,
    pub expires_at: i64,
    pub timestamp: i64,
}

#[event]
pub struct TransferPolicyChanged {
    pub series: Pubkey,
    pub issuer: Pubkey,
    pub burn_caller: Pubkey,
    pub mode: TransferPolicyMode,
    pub active: bool,
    pub timestamp: i64,
}

#[event]
pub struct ReceiptAccountStateChanged {
    pub series: Pubkey,
    pub investor_record: Pubkey,
    pub wallet: Pubkey,
    pub receipt_account: Pubkey,
    pub authority: Pubkey,
    pub provider_record: Pubkey,
    pub frozen: bool,
    pub governance_override: bool,
    pub timestamp: i64,
}

#[event]
pub struct PermissionedBurnExecuted {
    pub series: Pubkey,
    pub investor_record: Pubkey,
    pub wallet: Pubkey,
    pub burn_caller: Pubkey,
    pub amount: u64,
    pub purpose: BurnPurpose,
    pub timestamp: i64,
}

#[event]
pub struct RecoveryPrepared {
    pub recovery_order: Pubkey,
    pub investor_record: Pubkey,
    pub series: Pubkey,
    pub old_wallet: Pubkey,
    pub new_wallet: Pubkey,
    pub permanent_delegate: Pubkey,
    pub expected_receipt_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct RecoveryTransferValidated {
    pub recovery_order: Pubkey,
    pub investor_record: Pubkey,
    pub series: Pubkey,
    pub source_wallet: Pubkey,
    pub destination_wallet: Pubkey,
    pub permanent_delegate: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct ReceiptBalanceRecovered {
    pub recovery_order: Pubkey,
    pub investor_record: Pubkey,
    pub series: Pubkey,
    pub old_wallet: Pubkey,
    pub new_wallet: Pubkey,
    pub permanent_delegate: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct TransferValidated {
    pub series: Pubkey,
    pub source_wallet: Pubkey,
    pub destination_wallet: Pubkey,
    pub mode: TransferPolicyMode,
    pub timestamp: i64,
}

#[event]
pub struct RecoveryChanged {
    pub recovery_order: Pubkey,
    pub investor_record: Pubkey,
    pub old_wallet: Pubkey,
    pub new_wallet: Pubkey,
    pub status: RecoveryStatus,
    pub timestamp: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use pod_rwa_common::RESERVED_ACCOUNT_BYTES;

    fn key(seed: u8) -> Pubkey {
        Pubkey::new_from_array([seed; 32])
    }

    fn active_investor(config: Pubkey, wallet: Pubkey, opaque_id: [u8; 32]) -> InvestorRecord {
        InvestorRecord {
            schema_version: schema_v1(),
            opaque_id,
            config,
            provider_record: key(90),
            current_wallet: wallet,
            has_wallet: true,
            status: EligibilityStatus::Active,
            issued_at: 1,
            updated_at: 1,
            expires_at: 1_000,
            bump: 1,
            reserved: initialize_reserved(),
        }
    }

    fn active_binding(
        config: Pubkey,
        investor: Pubkey,
        wallet: Pubkey,
        opaque_id: [u8; 32],
    ) -> WalletBinding {
        WalletBinding {
            schema_version: schema_v1(),
            opaque_id,
            config,
            investor_record: investor,
            wallet,
            active: true,
            pending_recovery: false,
            recovery_order: Pubkey::default(),
            recovery_source_wallet: Pubkey::default(),
            recovery_series: Pubkey::default(),
            recovery_expires_at: 0,
            bound_at: 1,
            unbound_at: 0,
            bump: 1,
            reserved: initialize_reserved(),
        }
    }

    fn pending_recovery_binding(
        config: Pubkey,
        investor: Pubkey,
        wallet: Pubkey,
        opaque_id: [u8; 32],
        source_wallet: Pubkey,
        series: Pubkey,
    ) -> WalletBinding {
        WalletBinding {
            schema_version: schema_v1(),
            opaque_id,
            config,
            investor_record: investor,
            wallet,
            active: false,
            pending_recovery: true,
            recovery_order: key(80),
            recovery_source_wallet: source_wallet,
            recovery_series: series,
            recovery_expires_at: 1_000,
            bound_at: 1,
            unbound_at: 0,
            bump: 1,
            reserved: initialize_reserved(),
        }
    }

    fn active_permission(
        config: Pubkey,
        series: Pubkey,
        investor: Pubkey,
        wallet: Pubkey,
    ) -> SeriesPermission {
        SeriesPermission {
            schema_version: schema_v1(),
            config,
            series,
            investor_record: investor,
            wallet,
            provider_record: key(90),
            status: EligibilityStatus::Active,
            accepted_terms_hash: [7; 32],
            max_investment: 30_000_000,
            issued_at: 1,
            updated_at: 1,
            expires_at: 1_000,
            bump: 1,
            reserved: initialize_reserved(),
        }
    }

    #[test]
    fn all_long_lived_accounts_reserve_migration_space() {
        assert!(ComplianceConfig::SPACE > 8 + RESERVED_ACCOUNT_BYTES);
        assert!(ProviderRecord::SPACE > 8 + RESERVED_ACCOUNT_BYTES);
        assert!(InvestorRecord::SPACE > 8 + RESERVED_ACCOUNT_BYTES);
        assert!(WalletBinding::SPACE > 8 + RESERVED_ACCOUNT_BYTES);
        assert!(SeriesPermission::SPACE > 8 + RESERVED_ACCOUNT_BYTES);
        assert!(TransferPolicy::SPACE > 8 + RESERVED_ACCOUNT_BYTES);
        assert!(RecoveryOrder::SPACE > 8 + RESERVED_ACCOUNT_BYTES);
    }

    #[test]
    fn eligibility_requires_active_and_unexpired() {
        assert!(is_currently_active(EligibilityStatus::Active, 101, 100));
        assert!(!is_currently_active(EligibilityStatus::Active, 100, 100));
        assert!(!is_currently_active(EligibilityStatus::Suspended, 101, 100));
        assert!(!is_currently_active(
            EligibilityStatus::SanctionsHold,
            101,
            100
        ));
    }

    #[test]
    fn issuer_restricted_blocks_peer_to_peer() {
        let config_key = key(1);
        let series = key(2);
        let issuer = key(3);
        let source_wallet = key(4);
        let destination_wallet = key(5);
        let source_investor_key = key(6);
        let destination_investor_key = key(7);
        let source_id = [11; 32];
        let destination_id = [12; 32];
        let policy = TransferPolicy {
            schema_version: schema_v1(),
            config: config_key,
            series,
            issuer,
            burn_caller: key(8),
            mode: TransferPolicyMode::IssuerRestricted,
            active: true,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };
        let source_investor = active_investor(config_key, source_wallet, source_id);
        let destination_investor = active_investor(config_key, destination_wallet, destination_id);
        let source_binding =
            active_binding(config_key, source_investor_key, source_wallet, source_id);
        let destination_binding = active_binding(
            config_key,
            destination_investor_key,
            destination_wallet,
            destination_id,
        );
        let source_permission =
            active_permission(config_key, series, source_investor_key, source_wallet);
        let destination_permission = active_permission(
            config_key,
            series,
            destination_investor_key,
            destination_wallet,
        );
        let config = ComplianceConfig {
            schema_version: schema_v1(),
            governance: key(20),
            pending_governance: Pubkey::default(),
            has_pending_governance: false,
            recovery_authority: key(21),
            paused: false,
            min_recovery_delay_seconds: 60,
            created_at: 1,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };

        assert!(enforce_transfer_policy(
            &config,
            &policy,
            series,
            source_wallet,
            destination_wallet,
            &source_binding,
            &destination_binding,
            &source_permission,
            &destination_permission,
            &source_investor,
            source_investor_key,
            &destination_investor,
            destination_investor_key,
            100,
        )
        .is_err());
    }

    #[test]
    fn eligible_peer_allows_two_current_investors() {
        let config_key = key(1);
        let series = key(2);
        let source_wallet = key(4);
        let destination_wallet = key(5);
        let source_investor_key = key(6);
        let destination_investor_key = key(7);
        let source_id = [11; 32];
        let destination_id = [12; 32];
        let policy = TransferPolicy {
            schema_version: schema_v1(),
            config: config_key,
            series,
            issuer: key(3),
            burn_caller: key(8),
            mode: TransferPolicyMode::EligiblePeer,
            active: true,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };
        let source_investor = active_investor(config_key, source_wallet, source_id);
        let destination_investor = active_investor(config_key, destination_wallet, destination_id);
        let source_binding =
            active_binding(config_key, source_investor_key, source_wallet, source_id);
        let destination_binding = active_binding(
            config_key,
            destination_investor_key,
            destination_wallet,
            destination_id,
        );
        let source_permission =
            active_permission(config_key, series, source_investor_key, source_wallet);
        let destination_permission = active_permission(
            config_key,
            series,
            destination_investor_key,
            destination_wallet,
        );
        let config = ComplianceConfig {
            schema_version: schema_v1(),
            governance: key(20),
            pending_governance: Pubkey::default(),
            has_pending_governance: false,
            recovery_authority: key(21),
            paused: false,
            min_recovery_delay_seconds: 60,
            created_at: 1,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };

        assert!(enforce_transfer_policy(
            &config,
            &policy,
            series,
            source_wallet,
            destination_wallet,
            &source_binding,
            &destination_binding,
            &source_permission,
            &destination_permission,
            &source_investor,
            source_investor_key,
            &destination_investor,
            destination_investor_key,
            100,
        )
        .is_ok());
    }

    #[test]
    fn a_revoked_investor_cannot_transfer_under_peer_policy() {
        let config_key = key(1);
        let series = key(2);
        let source_wallet = key(4);
        let destination_wallet = key(5);
        let source_investor_key = key(6);
        let destination_investor_key = key(7);
        let source_id = [11; 32];
        let destination_id = [12; 32];
        let policy = TransferPolicy {
            schema_version: schema_v1(),
            config: config_key,
            series,
            issuer: key(3),
            burn_caller: key(8),
            mode: TransferPolicyMode::EligiblePeer,
            active: true,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };
        let mut source_investor = active_investor(config_key, source_wallet, source_id);
        source_investor.status = EligibilityStatus::Revoked;
        let destination_investor = active_investor(config_key, destination_wallet, destination_id);
        let source_binding =
            active_binding(config_key, source_investor_key, source_wallet, source_id);
        let destination_binding = active_binding(
            config_key,
            destination_investor_key,
            destination_wallet,
            destination_id,
        );
        let source_permission =
            active_permission(config_key, series, source_investor_key, source_wallet);
        let destination_permission = active_permission(
            config_key,
            series,
            destination_investor_key,
            destination_wallet,
        );
        let config = ComplianceConfig {
            schema_version: schema_v1(),
            governance: key(20),
            pending_governance: Pubkey::default(),
            has_pending_governance: false,
            recovery_authority: key(21),
            paused: false,
            min_recovery_delay_seconds: 60,
            created_at: 1,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };

        assert!(enforce_transfer_policy(
            &config,
            &policy,
            series,
            source_wallet,
            destination_wallet,
            &source_binding,
            &destination_binding,
            &source_permission,
            &destination_permission,
            &source_investor,
            source_investor_key,
            &destination_investor,
            destination_investor_key,
            100,
        )
        .is_err());
    }

    #[test]
    fn transfer_hook_meta_layout_is_stable() {
        let metas = transfer_hook_extra_account_metas().unwrap();
        assert_eq!(metas.len(), TRANSFER_HOOK_EXTRA_ACCOUNT_COUNT);
        assert_eq!(WalletBinding::OPAQUE_ID_DATA_OFFSET, 10);
    }

    #[test]
    fn permissioned_burn_encoding_matches_token_2022_v11() {
        let data = permissioned_burn_instruction_data(0x0807_0605_0403_0201, 6);
        assert_eq!(data, vec![46, 2, 1, 2, 3, 4, 5, 6, 7, 8, 6],);
    }

    #[test]
    fn governed_recovery_moves_a_complete_restricted_claim() {
        let config_key = key(1);
        let series = key(2);
        let issuer = key(3);
        let source_wallet = key(4);
        let destination_wallet = key(5);
        let investor_key = key(6);
        let opaque_id = [11; 32];
        let policy = TransferPolicy {
            schema_version: schema_v1(),
            config: config_key,
            series,
            issuer,
            burn_caller: key(8),
            mode: TransferPolicyMode::IssuerRestricted,
            active: true,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };
        let mut investor = active_investor(config_key, source_wallet, opaque_id);
        investor.status = EligibilityStatus::SanctionsHold;
        let source_binding = active_binding(config_key, investor_key, source_wallet, opaque_id);
        let destination_binding = pending_recovery_binding(
            config_key,
            investor_key,
            destination_wallet,
            opaque_id,
            source_wallet,
            series,
        );
        let mut source_permission =
            active_permission(config_key, series, investor_key, source_wallet);
        source_permission.status = EligibilityStatus::SanctionsHold;
        let mut destination_permission = source_permission.clone();
        destination_permission.wallet = destination_wallet;
        let config = ComplianceConfig {
            schema_version: schema_v1(),
            governance: key(20),
            pending_governance: Pubkey::default(),
            has_pending_governance: false,
            recovery_authority: key(21),
            paused: false,
            min_recovery_delay_seconds: 60,
            created_at: 1,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };
        let amount = 15_000_000;

        assert!(enforce_recovery_transfer_policy(
            &config,
            &policy,
            series,
            amount,
            0,
            amount,
            source_wallet,
            destination_wallet,
            &source_binding,
            &destination_binding,
            &source_permission,
            &destination_permission,
            &investor,
            investor_key,
            &investor,
            investor_key,
            100,
        )
        .is_ok());
    }

    #[test]
    fn governed_recovery_rejects_a_partial_balance_move() {
        let config_key = key(1);
        let series = key(2);
        let source_wallet = key(4);
        let destination_wallet = key(5);
        let investor_key = key(6);
        let opaque_id = [11; 32];
        let policy = TransferPolicy {
            schema_version: schema_v1(),
            config: config_key,
            series,
            issuer: key(3),
            burn_caller: key(8),
            mode: TransferPolicyMode::EligiblePeer,
            active: true,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };
        let investor = active_investor(config_key, source_wallet, opaque_id);
        let source_binding = active_binding(config_key, investor_key, source_wallet, opaque_id);
        let destination_binding = pending_recovery_binding(
            config_key,
            investor_key,
            destination_wallet,
            opaque_id,
            source_wallet,
            series,
        );
        let source_permission = active_permission(config_key, series, investor_key, source_wallet);
        let mut destination_permission = source_permission.clone();
        destination_permission.wallet = destination_wallet;
        let config = ComplianceConfig {
            schema_version: schema_v1(),
            governance: key(20),
            pending_governance: Pubkey::default(),
            has_pending_governance: false,
            recovery_authority: key(21),
            paused: false,
            min_recovery_delay_seconds: 60,
            created_at: 1,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };
        let amount = 10_000_000;

        assert!(enforce_recovery_transfer_policy(
            &config,
            &policy,
            series,
            amount,
            5_000_000,
            amount,
            source_wallet,
            destination_wallet,
            &source_binding,
            &destination_binding,
            &source_permission,
            &destination_permission,
            &investor,
            investor_key,
            &investor,
            investor_key,
            100,
        )
        .is_err());
    }

    #[test]
    fn governed_recovery_rejects_an_incorrect_series() {
        let config_key = key(1);
        let series = key(2);
        let source_wallet = key(4);
        let destination_wallet = key(5);
        let investor_key = key(6);
        let opaque_id = [11; 32];
        let policy = TransferPolicy {
            schema_version: schema_v1(),
            config: config_key,
            series,
            issuer: key(3),
            burn_caller: key(8),
            mode: TransferPolicyMode::EligiblePeer,
            active: true,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };
        let investor = active_investor(config_key, source_wallet, opaque_id);
        let source_binding = active_binding(config_key, investor_key, source_wallet, opaque_id);
        let destination_binding = pending_recovery_binding(
            config_key,
            investor_key,
            destination_wallet,
            opaque_id,
            source_wallet,
            key(99),
        );
        let source_permission = active_permission(config_key, series, investor_key, source_wallet);
        let mut destination_permission = source_permission.clone();
        destination_permission.wallet = destination_wallet;
        let config = ComplianceConfig {
            schema_version: schema_v1(),
            governance: key(20),
            pending_governance: Pubkey::default(),
            has_pending_governance: false,
            recovery_authority: key(21),
            paused: false,
            min_recovery_delay_seconds: 60,
            created_at: 1,
            updated_at: 1,
            bump: 1,
            reserved: initialize_reserved(),
        };
        let amount = 15_000_000;

        assert!(enforce_recovery_transfer_policy(
            &config,
            &policy,
            series,
            amount,
            0,
            amount,
            source_wallet,
            destination_wallet,
            &source_binding,
            &destination_binding,
            &source_permission,
            &destination_permission,
            &investor,
            investor_key,
            &investor,
            investor_key,
            100,
        )
        .is_err());
    }

    #[test]
    fn recovery_transfer_checked_builder_appends_hook_resolution_accounts() {
        let source = key(1);
        let mint = key(2);
        let destination = key(3);
        let delegate = key(4);
        let resolved = [
            key(10),
            key(11),
            key(12),
            key(13),
            key(14),
            key(15),
            key(16),
            key(17),
        ];
        let validation = key(18);
        let amount = 15_000_000;
        let instruction = build_recovery_transfer_checked_instruction(
            anchor_spl::token_2022::ID,
            source,
            mint,
            destination,
            delegate,
            amount,
            6,
            resolved,
            validation,
            crate::ID,
        )
        .unwrap();

        assert_eq!(instruction.program_id, anchor_spl::token_2022::ID);
        assert_eq!(instruction.accounts.len(), 14);
        assert_eq!(instruction.accounts[0], AccountMeta::new(source, false));
        assert_eq!(
            instruction.accounts[1],
            AccountMeta::new_readonly(mint, false)
        );
        assert_eq!(
            instruction.accounts[2],
            AccountMeta::new(destination, false)
        );
        assert_eq!(
            instruction.accounts[3],
            AccountMeta::new_readonly(delegate, true)
        );
        for (index, key) in resolved.into_iter().enumerate() {
            assert_eq!(
                instruction.accounts[index + 4],
                AccountMeta::new_readonly(key, false)
            );
        }
        assert_eq!(
            instruction.accounts[12],
            AccountMeta::new_readonly(validation, false)
        );
        assert_eq!(
            instruction.accounts[13],
            AccountMeta::new_readonly(crate::ID, false)
        );
        assert_eq!(instruction.data[0], 12);
        assert_eq!(&instruction.data[1..9], &amount.to_le_bytes());
        assert_eq!(instruction.data[9], 6);
    }

    #[test]
    fn recovery_receipt_accounts_must_be_canonical_and_correctly_owned() {
        let wallet = key(1);
        let mint = key(2);
        let token_program = anchor_spl::token_2022::ID;
        let ata = get_associated_token_address_with_program_id(&wallet, &mint, &token_program);

        assert!(validate_receipt_ata(ata, mint, wallet, wallet, mint, token_program).is_ok());
        assert!(validate_receipt_ata(ata, mint, key(99), wallet, mint, token_program).is_err());
        assert!(validate_receipt_ata(key(98), mint, wallet, wallet, mint, token_program).is_err());
    }

    #[test]
    fn provider_thaw_requires_an_eligible_claim_and_frozen_account() {
        assert!(validate_receipt_account_transition(
            false,
            true,
            EligibilityStatus::Active,
            1_000,
            EligibilityStatus::Active,
            1_000,
            TokenAccountState::Frozen,
            ReceiptAccountTransition::ThawEligible,
            100,
        )
        .is_ok());
        assert!(validate_receipt_account_transition(
            false,
            true,
            EligibilityStatus::Suspended,
            1_000,
            EligibilityStatus::Active,
            1_000,
            TokenAccountState::Frozen,
            ReceiptAccountTransition::ThawEligible,
            100,
        )
        .is_err());
        assert!(validate_receipt_account_transition(
            false,
            true,
            EligibilityStatus::Active,
            1_000,
            EligibilityStatus::Active,
            1_000,
            TokenAccountState::Initialized,
            ReceiptAccountTransition::ThawEligible,
            100,
        )
        .is_err());
    }

    #[test]
    fn provider_freeze_requires_a_restricted_claim() {
        assert!(validate_receipt_account_transition(
            false,
            true,
            EligibilityStatus::SanctionsHold,
            1_000,
            EligibilityStatus::Active,
            1_000,
            TokenAccountState::Initialized,
            ReceiptAccountTransition::FreezeRestricted,
            100,
        )
        .is_ok());
        assert!(validate_receipt_account_transition(
            false,
            true,
            EligibilityStatus::Active,
            1_000,
            EligibilityStatus::Active,
            1_000,
            TokenAccountState::Initialized,
            ReceiptAccountTransition::FreezeRestricted,
            100,
        )
        .is_err());
    }

    #[test]
    fn governance_account_control_is_status_independent_but_state_strict() {
        assert!(validate_receipt_account_transition(
            true,
            false,
            EligibilityStatus::Revoked,
            1,
            EligibilityStatus::Revoked,
            1,
            TokenAccountState::Frozen,
            ReceiptAccountTransition::GovernThaw,
            100,
        )
        .is_ok());
        assert!(validate_receipt_account_transition(
            true,
            false,
            EligibilityStatus::Active,
            1_000,
            EligibilityStatus::Active,
            1_000,
            TokenAccountState::Initialized,
            ReceiptAccountTransition::GovernFreeze,
            100,
        )
        .is_ok());
        assert!(validate_receipt_account_transition(
            false,
            true,
            EligibilityStatus::Active,
            1_000,
            EligibilityStatus::Active,
            1_000,
            TokenAccountState::Initialized,
            ReceiptAccountTransition::GovernThaw,
            100,
        )
        .is_err());
    }

    #[test]
    fn normal_redemption_requires_current_eligibility() {
        let config = key(1);
        let wallet = key(2);
        let investor_key = key(3);
        let series = key(4);
        let mut investor = active_investor(config, wallet, [5; 32]);
        let permission = active_permission(config, series, investor_key, wallet);

        assert!(
            validate_burn_purpose(BurnPurpose::Redemption, &investor, &permission, 100).is_ok()
        );
        investor.status = EligibilityStatus::Suspended;
        assert!(
            validate_burn_purpose(BurnPurpose::Redemption, &investor, &permission, 100).is_err()
        );
    }

    #[test]
    fn restricted_redemption_requires_a_restriction_or_expiry() {
        let config = key(1);
        let wallet = key(2);
        let investor_key = key(3);
        let series = key(4);
        let investor = active_investor(config, wallet, [5; 32]);
        let mut permission = active_permission(config, series, investor_key, wallet);

        assert!(validate_burn_purpose(
            BurnPurpose::RestrictedRedemption,
            &investor,
            &permission,
            100,
        )
        .is_err());
        permission.expires_at = 100;
        assert!(validate_burn_purpose(
            BurnPurpose::RestrictedRedemption,
            &investor,
            &permission,
            100,
        )
        .is_ok());
    }

    #[test]
    fn refund_remains_available_to_a_linked_restricted_holder() {
        let config = key(1);
        let wallet = key(2);
        let investor_key = key(3);
        let series = key(4);
        let mut investor = active_investor(config, wallet, [5; 32]);
        investor.status = EligibilityStatus::Revoked;
        let mut permission = active_permission(config, series, investor_key, wallet);
        permission.status = EligibilityStatus::SanctionsHold;

        assert!(validate_burn_purpose(BurnPurpose::Refund, &investor, &permission, 100).is_ok());
    }
}
