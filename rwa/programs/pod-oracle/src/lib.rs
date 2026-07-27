use anchor_lang::prelude::*;
use pod_rwa_common::{
    domain_hash, ContentRef, Decision, OracleProduct, ReleaseGateKind, ValuationKind,
    ACCOUNT_SCHEMA_V1, BPS_DENOMINATOR, RESERVED_ACCOUNT_BYTES,
};

declare_id!("9xcHEJ1EdSXZWqxsyzZ3CZChKCHJR1upJm1D9f6YhP8E");

const ORACLE_CONFIG_SEED: &[u8] = b"oracle-config";
const ATTESTATION_HEAD_SEED: &[u8] = b"attestation-head";
const ATTESTATION_REVISION_SEED: &[u8] = b"attestation-rev";
const VALUATION_HEAD_SEED: &[u8] = b"valuation-head";
const VALUATION_REVISION_SEED: &[u8] = b"valuation-rev";
const DEAL_GATE_HEAD_SEED: &[u8] = b"deal-gate-head";
const DEAL_GATE_REVISION_SEED: &[u8] = b"deal-gate-rev";

const ATTESTATION_HASH_DOMAIN: &[u8] = b"POD:RWA:ATTESTATION:V1";
const VALUATION_HASH_DOMAIN: &[u8] = b"POD:RWA:VALUATION:V1";
const DEAL_GATE_HASH_DOMAIN: &[u8] = b"POD:RWA:DEAL_GATE:V1";

const MAX_PUBLISHERS: usize = 8;
const MAX_ATTESTATIONS_PER_GATE: usize = 3;
const MAX_VALIDITY_SECS: i64 = 366 * 24 * 60 * 60;
const MAX_FUTURE_TOLERANCE_SECS: i64 = 60 * 60;

#[program]
pub mod pod_oracle {
    use super::*;

    pub fn initialize_oracle_config(
        ctx: Context<InitializeOracleConfig>,
        args: InitializeOracleConfigArgs,
    ) -> Result<()> {
        validate_config_args(&args)?;
        require_keys_neq!(
            ctx.accounts.governance.key(),
            args.guardian,
            OracleError::AuthoritiesMustDiffer
        );
        require_keys_neq!(
            ctx.accounts.governance.key(),
            args.initial_publisher,
            OracleError::AuthoritiesMustDiffer
        );
        require_keys_neq!(
            args.guardian,
            args.initial_publisher,
            OracleError::AuthoritiesMustDiffer
        );

        let config = &mut ctx.accounts.config;
        config.schema_version = ACCOUNT_SCHEMA_V1;
        config.bump = ctx.bumps.config;
        config.paused = false;
        config.governance = ctx.accounts.governance.key();
        config.pending_governance = Pubkey::default();
        config.guardian = args.guardian;
        config.publishers = [Pubkey::default(); MAX_PUBLISHERS];
        config.publishers[0] = args.initial_publisher;
        config.publisher_count = 1;
        config.max_attestation_validity_secs = args.max_attestation_validity_secs;
        config.max_valuation_validity_secs = args.max_valuation_validity_secs;
        config.max_gate_validity_secs = args.max_gate_validity_secs;
        config.future_tolerance_secs = args.future_tolerance_secs;
        config.reserved = [0; RESERVED_ACCOUNT_BYTES];

        emit!(OracleConfigInitialized {
            governance: config.governance,
            guardian: config.guardian,
            initial_publisher: args.initial_publisher,
        });
        Ok(())
    }

    pub fn set_publisher(
        ctx: Context<GovernOracleConfig>,
        publisher: Pubkey,
        enabled: bool,
    ) -> Result<()> {
        require!(publisher != Pubkey::default(), OracleError::ZeroPublicKey);
        let config = &mut ctx.accounts.config;
        let changed = config.set_publisher(publisher, enabled)?;

        emit!(PublisherUpdated {
            publisher,
            enabled,
            changed,
        });
        Ok(())
    }

    pub fn set_paused(ctx: Context<SetOraclePause>, paused: bool) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let authority = ctx.accounts.authority.key();
        require!(
            authority == config.governance || authority == config.guardian,
            OracleError::UnauthorizedPauseAuthority
        );
        if !paused {
            require_keys_eq!(
                authority,
                config.governance,
                OracleError::GuardianCannotUnpause
            );
        }

        config.paused = paused;
        emit!(OraclePauseUpdated { authority, paused });
        Ok(())
    }

    pub fn propose_governance(
        ctx: Context<GovernOracleConfig>,
        pending_governance: Pubkey,
    ) -> Result<()> {
        require!(
            pending_governance != Pubkey::default(),
            OracleError::ZeroPublicKey
        );
        require_keys_neq!(
            pending_governance,
            ctx.accounts.config.governance,
            OracleError::AuthoritiesMustDiffer
        );
        ctx.accounts.config.pending_governance = pending_governance;
        emit!(GovernanceTransferProposed {
            current_governance: ctx.accounts.config.governance,
            pending_governance,
        });
        Ok(())
    }

    pub fn accept_governance(ctx: Context<AcceptOracleGovernance>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(
            ctx.accounts.pending_governance.key(),
            config.pending_governance,
            OracleError::UnauthorizedGovernance
        );
        let previous_governance = config.governance;
        config.governance = config.pending_governance;
        config.pending_governance = Pubkey::default();
        emit!(GovernanceTransferred {
            previous_governance,
            governance: config.governance,
        });
        Ok(())
    }

    pub fn publish_attestation(
        ctx: Context<PublishAttestation>,
        args: PublishAttestationArgs,
    ) -> Result<()> {
        let clock = Clock::get()?;
        authorize_publisher(&ctx.accounts.config, ctx.accounts.publisher.key())?;

        let revision_hash = attestation_revision_hash(&args)?;
        let head = &mut ctx.accounts.head;
        let revision = &mut ctx.accounts.revision;

        if revision.schema_version != 0 {
            require!(
                revision.matches(&args, ctx.accounts.publisher.key(), revision_hash),
                OracleError::RevisionConflict
            );
            require_attestation_head_identity(head, &args)?;
            emit!(AttestationPublished {
                head: head.key(),
                revision: revision.key(),
                revision_number: args.revision,
                product: args.product,
                decision: args.decision,
                revision_hash,
                idempotent_replay: true,
            });
            return Ok(());
        }

        validate_attestation_args(&ctx.accounts.config, &args, clock.unix_timestamp)?;
        prepare_attestation_head(head, &args, ctx.bumps.head)?;
        validate_revision_transition(head.latest_revision, args.revision, args.correction_of)?;

        revision.schema_version = ACCOUNT_SCHEMA_V1;
        revision.bump = ctx.bumps.revision;
        revision.head = head.key();
        revision.publisher = ctx.accounts.publisher.key();
        revision.product = args.product;
        revision.subject_ref = args.subject_ref;
        revision.asset_set_hash = args.asset_set_hash;
        revision.season_id = args.season_id;
        revision.revision = args.revision;
        revision.correction_of = args.correction_of;
        revision.decision = args.decision;
        revision.confidence_bps = args.confidence_bps;
        revision.pass_fraction_bps = args.pass_fraction_bps;
        revision.observed_at = args.observed_at;
        revision.valid_until = args.valid_until;
        revision.published_at = clock.unix_timestamp;
        revision.policy_hash = args.policy_hash;
        revision.engine_version_hash = args.engine_version_hash;
        revision.result_hash = args.result_hash;
        revision.evidence_hash = args.evidence_hash;
        revision.content_hash = args.content_hash;
        revision.revision_hash = revision_hash;
        revision.reserved = [0; RESERVED_ACCOUNT_BYTES];

        head.latest_revision = args.revision;
        head.latest_revision_address = revision.key();
        head.latest_revision_hash = revision_hash;
        head.latest_decision = args.decision;
        head.latest_published_at = clock.unix_timestamp;

        emit!(AttestationPublished {
            head: head.key(),
            revision: revision.key(),
            revision_number: args.revision,
            product: args.product,
            decision: args.decision,
            revision_hash,
            idempotent_replay: false,
        });
        Ok(())
    }

    pub fn publish_valuation(
        ctx: Context<PublishValuation>,
        args: PublishValuationArgs,
    ) -> Result<()> {
        let clock = Clock::get()?;
        authorize_publisher(&ctx.accounts.config, ctx.accounts.publisher.key())?;

        let revision_hash = valuation_revision_hash(&args)?;
        let head = &mut ctx.accounts.head;
        let revision = &mut ctx.accounts.revision;

        if revision.schema_version != 0 {
            require!(
                revision.matches(&args, ctx.accounts.publisher.key(), revision_hash),
                OracleError::RevisionConflict
            );
            require_valuation_head_identity(head, &args)?;
            emit!(ValuationPublished {
                head: head.key(),
                revision: revision.key(),
                revision_number: args.revision,
                kind: args.kind,
                value: args.value,
                scale: args.scale,
                revision_hash,
                idempotent_replay: true,
            });
            return Ok(());
        }

        validate_valuation_args(&ctx.accounts.config, &args, clock.unix_timestamp)?;
        prepare_valuation_head(head, &args, ctx.bumps.head)?;
        validate_revision_transition(head.latest_revision, args.revision, args.correction_of)?;

        revision.schema_version = ACCOUNT_SCHEMA_V1;
        revision.bump = ctx.bumps.revision;
        revision.head = head.key();
        revision.publisher = ctx.accounts.publisher.key();
        revision.kind = args.kind;
        revision.base_asset_hash = args.base_asset_hash;
        revision.quote_asset_hash = args.quote_asset_hash;
        revision.value = args.value;
        revision.scale = args.scale;
        revision.revision = args.revision;
        revision.correction_of = args.correction_of;
        revision.as_of = args.as_of;
        revision.valid_until = args.valid_until;
        revision.published_at = clock.unix_timestamp;
        revision.source_hash = args.source_hash;
        revision.methodology_hash = args.methodology_hash;
        revision.evidence_hash = args.evidence_hash;
        revision.content_hash = args.content_hash;
        revision.revision_hash = revision_hash;
        revision.reserved = [0; RESERVED_ACCOUNT_BYTES];

        head.latest_revision = args.revision;
        head.latest_revision_address = revision.key();
        head.latest_revision_hash = revision_hash;
        head.latest_value = args.value;
        head.latest_scale = args.scale;
        head.latest_as_of = args.as_of;
        head.latest_published_at = clock.unix_timestamp;

        emit!(ValuationPublished {
            head: head.key(),
            revision: revision.key(),
            revision_number: args.revision,
            kind: args.kind,
            value: args.value,
            scale: args.scale,
            revision_hash,
            idempotent_replay: false,
        });
        Ok(())
    }

    /// Remaining accounts are ordered as:
    /// `[attestation_revision, attestation_head] * count`,
    /// `commodity_revision, commodity_head, fx_revision, fx_head`.
    pub fn publish_deal_gate(
        ctx: Context<PublishDealGate>,
        args: PublishDealGateArgs,
    ) -> Result<()> {
        let clock = Clock::get()?;
        authorize_publisher(&ctx.accounts.config, ctx.accounts.publisher.key())?;

        let revision_hash = deal_gate_revision_hash(&args)?;
        let head = &mut ctx.accounts.head;
        let revision = &mut ctx.accounts.revision;

        if revision.schema_version != 0 {
            require!(
                revision.matches(&args, ctx.accounts.publisher.key(), revision_hash),
                OracleError::RevisionConflict
            );
            require_deal_gate_head_identity(head, &args)?;
            emit!(DealGatePublished {
                head: head.key(),
                revision: revision.key(),
                revision_number: args.revision,
                deal: args.deal,
                milestone_index: args.milestone_index,
                decision: args.decision,
                revision_hash,
                idempotent_replay: true,
            });
            return Ok(());
        }

        validate_deal_gate_args(&ctx.accounts.config, &args, clock.unix_timestamp)?;
        validate_gate_sources(&args, ctx.remaining_accounts, clock.unix_timestamp)?;
        prepare_deal_gate_head(head, &args, ctx.bumps.head)?;
        validate_revision_transition(head.latest_revision, args.revision, args.correction_of)?;

        revision.schema_version = ACCOUNT_SCHEMA_V1;
        revision.bump = ctx.bumps.revision;
        revision.head = head.key();
        revision.publisher = ctx.accounts.publisher.key();
        revision.deal = args.deal;
        revision.milestone_index = args.milestone_index;
        revision.gate_kind = args.gate_kind;
        revision.asset_set_hash = args.asset_set_hash;
        revision.season_id = args.season_id;
        revision.revision = args.revision;
        revision.correction_of = args.correction_of;
        revision.attestation_count = args.attestation_count;
        revision.attestations = args.attestations;
        revision.commodity_valuation = args.commodity_valuation;
        revision.fx_valuation = args.fx_valuation;
        revision.policy_hash = args.policy_hash;
        revision.decision = args.decision;
        revision.evaluated_at = args.evaluated_at;
        revision.expires_at = args.expires_at;
        revision.published_at = clock.unix_timestamp;
        revision.content_hash = args.content_hash;
        revision.revision_hash = revision_hash;
        revision.reserved = [0; RESERVED_ACCOUNT_BYTES];

        head.latest_revision = args.revision;
        head.latest_revision_address = revision.key();
        head.latest_revision_hash = revision_hash;
        head.latest_decision = args.decision;
        head.latest_expires_at = args.expires_at;
        head.latest_published_at = clock.unix_timestamp;

        emit!(DealGatePublished {
            head: head.key(),
            revision: revision.key(),
            revision_number: args.revision,
            deal: args.deal,
            milestone_index: args.milestone_index,
            decision: args.decision,
            revision_hash,
            idempotent_replay: false,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeOracleConfig<'info> {
    #[account(
        init,
        payer = governance,
        space = 8 + OracleConfig::SPACE,
        seeds = [ORACLE_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, OracleConfig>,
    #[account(mut)]
    pub governance: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GovernOracleConfig<'info> {
    #[account(
        mut,
        seeds = [ORACLE_CONFIG_SEED],
        bump = config.bump,
        has_one = governance @ OracleError::UnauthorizedGovernance
    )]
    pub config: Account<'info, OracleConfig>,
    pub governance: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetOraclePause<'info> {
    #[account(mut, seeds = [ORACLE_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OracleConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptOracleGovernance<'info> {
    #[account(mut, seeds = [ORACLE_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OracleConfig>,
    pub pending_governance: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(args: PublishAttestationArgs)]
pub struct PublishAttestation<'info> {
    #[account(seeds = [ORACLE_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OracleConfig>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AttestationHead::SPACE,
        seeds = [
            ATTESTATION_HEAD_SEED,
            args.subject_ref.as_ref(),
            args.asset_set_hash.as_ref(),
            args.season_id.as_ref(),
            &[oracle_product_code(args.product)]
        ],
        bump
    )]
    pub head: Account<'info, AttestationHead>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AttestationRevision::SPACE,
        seeds = [
            ATTESTATION_REVISION_SEED,
            head.key().as_ref(),
            &args.revision.to_le_bytes()
        ],
        bump
    )]
    pub revision: Account<'info, AttestationRevision>,
    pub publisher: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: PublishValuationArgs)]
pub struct PublishValuation<'info> {
    #[account(seeds = [ORACLE_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, OracleConfig>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ValuationHead::SPACE,
        seeds = [
            VALUATION_HEAD_SEED,
            &[valuation_kind_code(args.kind)],
            args.base_asset_hash.as_ref(),
            args.quote_asset_hash.as_ref()
        ],
        bump
    )]
    pub head: Account<'info, ValuationHead>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ValuationRevision::SPACE,
        seeds = [
            VALUATION_REVISION_SEED,
            head.key().as_ref(),
            &args.revision.to_le_bytes()
        ],
        bump
    )]
    pub revision: Account<'info, ValuationRevision>,
    pub publisher: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: PublishDealGateArgs)]
pub struct PublishDealGate<'info> {
    #[account(seeds = [ORACLE_CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, OracleConfig>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + DealGateHead::SPACE,
        seeds = [
            DEAL_GATE_HEAD_SEED,
            args.deal.as_ref(),
            &[args.milestone_index]
        ],
        bump
    )]
    pub head: Box<Account<'info, DealGateHead>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + DealGateRevision::SPACE,
        seeds = [
            DEAL_GATE_REVISION_SEED,
            head.key().as_ref(),
            &args.revision.to_le_bytes()
        ],
        bump
    )]
    pub revision: Box<Account<'info, DealGateRevision>>,
    pub publisher: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeOracleConfigArgs {
    pub guardian: Pubkey,
    pub initial_publisher: Pubkey,
    pub max_attestation_validity_secs: i64,
    pub max_valuation_validity_secs: i64,
    pub max_gate_validity_secs: i64,
    pub future_tolerance_secs: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PublishAttestationArgs {
    pub product: OracleProduct,
    pub subject_ref: [u8; 32],
    pub asset_set_hash: [u8; 32],
    pub season_id: [u8; 32],
    pub revision: u32,
    pub correction_of: u32,
    pub decision: Decision,
    pub confidence_bps: u16,
    pub pass_fraction_bps: u16,
    pub observed_at: i64,
    pub valid_until: i64,
    pub policy_hash: [u8; 32],
    pub engine_version_hash: [u8; 32],
    pub result_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
    pub content_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PublishValuationArgs {
    pub kind: ValuationKind,
    pub base_asset_hash: [u8; 32],
    pub quote_asset_hash: [u8; 32],
    pub value: u64,
    pub scale: u8,
    pub revision: u32,
    pub correction_of: u32,
    pub as_of: i64,
    pub valid_until: i64,
    pub source_hash: [u8; 32],
    pub methodology_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
    pub content_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PublishDealGateArgs {
    pub deal: Pubkey,
    pub milestone_index: u8,
    pub gate_kind: ReleaseGateKind,
    pub asset_set_hash: [u8; 32],
    pub season_id: [u8; 32],
    pub revision: u32,
    pub correction_of: u32,
    pub attestation_count: u8,
    pub attestations: [ContentRef; MAX_ATTESTATIONS_PER_GATE],
    pub commodity_valuation: ContentRef,
    pub fx_valuation: ContentRef,
    pub policy_hash: [u8; 32],
    pub decision: Decision,
    pub evaluated_at: i64,
    pub expires_at: i64,
    pub content_hash: [u8; 32],
}

#[account]
pub struct OracleConfig {
    pub schema_version: u16,
    pub bump: u8,
    pub paused: bool,
    pub governance: Pubkey,
    pub pending_governance: Pubkey,
    pub guardian: Pubkey,
    pub publishers: [Pubkey; MAX_PUBLISHERS],
    pub publisher_count: u8,
    pub max_attestation_validity_secs: i64,
    pub max_valuation_validity_secs: i64,
    pub max_gate_validity_secs: i64,
    pub future_tolerance_secs: i64,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl OracleConfig {
    pub const SPACE: usize = 453;

    pub fn is_publisher(&self, publisher: &Pubkey) -> bool {
        self.publishers[..usize::from(self.publisher_count)].contains(publisher)
    }

    fn set_publisher(&mut self, publisher: Pubkey, enabled: bool) -> Result<bool> {
        let count = usize::from(self.publisher_count);
        if let Some(index) = self.publishers[..count]
            .iter()
            .position(|candidate| candidate == &publisher)
        {
            if enabled {
                return Ok(false);
            }
            self.publishers.copy_within(index + 1..count, index);
            self.publishers[count - 1] = Pubkey::default();
            self.publisher_count = self
                .publisher_count
                .checked_sub(1)
                .ok_or(OracleError::ArithmeticOverflow)?;
            return Ok(true);
        }

        if !enabled {
            return Ok(false);
        }
        require!(
            count < MAX_PUBLISHERS,
            OracleError::PublisherCapacityReached
        );
        self.publishers[count] = publisher;
        self.publisher_count = self
            .publisher_count
            .checked_add(1)
            .ok_or(OracleError::ArithmeticOverflow)?;
        Ok(true)
    }
}

#[account]
pub struct AttestationHead {
    pub schema_version: u16,
    pub bump: u8,
    pub product: OracleProduct,
    pub subject_ref: [u8; 32],
    pub asset_set_hash: [u8; 32],
    pub season_id: [u8; 32],
    pub latest_revision: u32,
    pub latest_revision_address: Pubkey,
    pub latest_revision_hash: [u8; 32],
    pub latest_decision: Decision,
    pub latest_published_at: i64,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl AttestationHead {
    pub const SPACE: usize = 241;
}

#[account]
pub struct AttestationRevision {
    pub schema_version: u16,
    pub bump: u8,
    pub head: Pubkey,
    pub publisher: Pubkey,
    pub product: OracleProduct,
    pub subject_ref: [u8; 32],
    pub asset_set_hash: [u8; 32],
    pub season_id: [u8; 32],
    pub revision: u32,
    pub correction_of: u32,
    pub decision: Decision,
    pub confidence_bps: u16,
    pub pass_fraction_bps: u16,
    pub observed_at: i64,
    pub valid_until: i64,
    pub published_at: i64,
    pub policy_hash: [u8; 32],
    pub engine_version_hash: [u8; 32],
    pub result_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
    pub content_hash: [u8; 32],
    pub revision_hash: [u8; 32],
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl AttestationRevision {
    pub const SPACE: usize = 457;

    fn matches(
        &self,
        args: &PublishAttestationArgs,
        publisher: Pubkey,
        revision_hash: [u8; 32],
    ) -> bool {
        self.publisher == publisher
            && self.product == args.product
            && self.subject_ref == args.subject_ref
            && self.asset_set_hash == args.asset_set_hash
            && self.season_id == args.season_id
            && self.revision == args.revision
            && self.correction_of == args.correction_of
            && self.decision == args.decision
            && self.confidence_bps == args.confidence_bps
            && self.pass_fraction_bps == args.pass_fraction_bps
            && self.observed_at == args.observed_at
            && self.valid_until == args.valid_until
            && self.policy_hash == args.policy_hash
            && self.engine_version_hash == args.engine_version_hash
            && self.result_hash == args.result_hash
            && self.evidence_hash == args.evidence_hash
            && self.content_hash == args.content_hash
            && self.revision_hash == revision_hash
    }
}

#[account]
pub struct ValuationHead {
    pub schema_version: u16,
    pub bump: u8,
    pub kind: ValuationKind,
    pub base_asset_hash: [u8; 32],
    pub quote_asset_hash: [u8; 32],
    pub latest_revision: u32,
    pub latest_revision_address: Pubkey,
    pub latest_revision_hash: [u8; 32],
    pub latest_value: u64,
    pub latest_scale: u8,
    pub latest_as_of: i64,
    pub latest_published_at: i64,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl ValuationHead {
    pub const SPACE: usize = 225;
}

#[account]
pub struct ValuationRevision {
    pub schema_version: u16,
    pub bump: u8,
    pub head: Pubkey,
    pub publisher: Pubkey,
    pub kind: ValuationKind,
    pub base_asset_hash: [u8; 32],
    pub quote_asset_hash: [u8; 32],
    pub value: u64,
    pub scale: u8,
    pub revision: u32,
    pub correction_of: u32,
    pub as_of: i64,
    pub valid_until: i64,
    pub published_at: i64,
    pub source_hash: [u8; 32],
    pub methodology_hash: [u8; 32],
    pub evidence_hash: [u8; 32],
    pub content_hash: [u8; 32],
    pub revision_hash: [u8; 32],
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl ValuationRevision {
    pub const SPACE: usize = 397;

    fn matches(
        &self,
        args: &PublishValuationArgs,
        publisher: Pubkey,
        revision_hash: [u8; 32],
    ) -> bool {
        self.publisher == publisher
            && self.kind == args.kind
            && self.base_asset_hash == args.base_asset_hash
            && self.quote_asset_hash == args.quote_asset_hash
            && self.value == args.value
            && self.scale == args.scale
            && self.revision == args.revision
            && self.correction_of == args.correction_of
            && self.as_of == args.as_of
            && self.valid_until == args.valid_until
            && self.source_hash == args.source_hash
            && self.methodology_hash == args.methodology_hash
            && self.evidence_hash == args.evidence_hash
            && self.content_hash == args.content_hash
            && self.revision_hash == revision_hash
    }
}

#[account]
pub struct DealGateHead {
    pub schema_version: u16,
    pub bump: u8,
    pub deal: Pubkey,
    pub milestone_index: u8,
    pub gate_kind: ReleaseGateKind,
    pub asset_set_hash: [u8; 32],
    pub season_id: [u8; 32],
    pub latest_revision: u32,
    pub latest_revision_address: Pubkey,
    pub latest_revision_hash: [u8; 32],
    pub latest_decision: Decision,
    pub latest_expires_at: i64,
    pub latest_published_at: i64,
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl DealGateHead {
    pub const SPACE: usize = 250;
}

#[account]
pub struct DealGateRevision {
    pub schema_version: u16,
    pub bump: u8,
    pub head: Pubkey,
    pub publisher: Pubkey,
    pub deal: Pubkey,
    pub milestone_index: u8,
    pub gate_kind: ReleaseGateKind,
    pub asset_set_hash: [u8; 32],
    pub season_id: [u8; 32],
    pub revision: u32,
    pub correction_of: u32,
    pub attestation_count: u8,
    pub attestations: [ContentRef; MAX_ATTESTATIONS_PER_GATE],
    pub commodity_valuation: ContentRef,
    pub fx_valuation: ContentRef,
    pub policy_hash: [u8; 32],
    pub decision: Decision,
    pub evaluated_at: i64,
    pub expires_at: i64,
    pub published_at: i64,
    pub content_hash: [u8; 32],
    pub revision_hash: [u8; 32],
    pub reserved: [u8; RESERVED_ACCOUNT_BYTES],
}

impl DealGateRevision {
    pub const SPACE: usize = 699;

    fn matches(
        &self,
        args: &PublishDealGateArgs,
        publisher: Pubkey,
        revision_hash: [u8; 32],
    ) -> bool {
        self.publisher == publisher
            && self.deal == args.deal
            && self.milestone_index == args.milestone_index
            && self.gate_kind == args.gate_kind
            && self.asset_set_hash == args.asset_set_hash
            && self.season_id == args.season_id
            && self.revision == args.revision
            && self.correction_of == args.correction_of
            && self.attestation_count == args.attestation_count
            && self.attestations == args.attestations
            && self.commodity_valuation == args.commodity_valuation
            && self.fx_valuation == args.fx_valuation
            && self.policy_hash == args.policy_hash
            && self.decision == args.decision
            && self.evaluated_at == args.evaluated_at
            && self.expires_at == args.expires_at
            && self.content_hash == args.content_hash
            && self.revision_hash == revision_hash
    }
}

#[event]
pub struct OracleConfigInitialized {
    pub governance: Pubkey,
    pub guardian: Pubkey,
    pub initial_publisher: Pubkey,
}

#[event]
pub struct PublisherUpdated {
    pub publisher: Pubkey,
    pub enabled: bool,
    pub changed: bool,
}

#[event]
pub struct OraclePauseUpdated {
    pub authority: Pubkey,
    pub paused: bool,
}

#[event]
pub struct GovernanceTransferProposed {
    pub current_governance: Pubkey,
    pub pending_governance: Pubkey,
}

#[event]
pub struct GovernanceTransferred {
    pub previous_governance: Pubkey,
    pub governance: Pubkey,
}

#[event]
pub struct AttestationPublished {
    pub head: Pubkey,
    pub revision: Pubkey,
    pub revision_number: u32,
    pub product: OracleProduct,
    pub decision: Decision,
    pub revision_hash: [u8; 32],
    pub idempotent_replay: bool,
}

#[event]
pub struct ValuationPublished {
    pub head: Pubkey,
    pub revision: Pubkey,
    pub revision_number: u32,
    pub kind: ValuationKind,
    pub value: u64,
    pub scale: u8,
    pub revision_hash: [u8; 32],
    pub idempotent_replay: bool,
}

#[event]
pub struct DealGatePublished {
    pub head: Pubkey,
    pub revision: Pubkey,
    pub revision_number: u32,
    pub deal: Pubkey,
    pub milestone_index: u8,
    pub decision: Decision,
    pub revision_hash: [u8; 32],
    pub idempotent_replay: bool,
}

#[error_code]
pub enum OracleError {
    #[msg("The caller is not the oracle governance authority")]
    UnauthorizedGovernance,
    #[msg("The caller is not an authorized oracle publisher")]
    UnauthorizedPublisher,
    #[msg("The caller may not change the oracle pause state")]
    UnauthorizedPauseAuthority,
    #[msg("The guardian may pause publication but may not unpause it")]
    GuardianCannotUnpause,
    #[msg("Oracle publication is paused")]
    OraclePaused,
    #[msg("The public key must not be zero")]
    ZeroPublicKey,
    #[msg("The supplied authorities must be different")]
    AuthoritiesMustDiffer,
    #[msg("The publisher registry is full")]
    PublisherCapacityReached,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("The configured validity window is invalid")]
    InvalidValidityConfiguration,
    #[msg("The future timestamp tolerance is invalid")]
    InvalidFutureTolerance,
    #[msg("A required hash is zero")]
    ZeroHash,
    #[msg("The basis-point value exceeds 10,000")]
    InvalidBasisPoints,
    #[msg("The observation timestamp is in the future")]
    ObservationInFuture,
    #[msg("The validity interval is invalid or expired")]
    InvalidValidityInterval,
    #[msg("The revision number must be sequential")]
    InvalidRevision,
    #[msg("A correction must name the immediately preceding revision")]
    InvalidCorrection,
    #[msg("The revision PDA already contains different content")]
    RevisionConflict,
    #[msg("The head account identity does not match the publication")]
    HeadIdentityMismatch,
    #[msg("The valuation must be greater than zero")]
    InvalidValuation,
    #[msg("The valuation scale is unsupported")]
    InvalidValuationScale,
    #[msg("The base and quote asset must be different")]
    IdenticalAssetPair,
    #[msg("The deal or referenced account key is invalid")]
    InvalidReference,
    #[msg("The milestone and gate kind do not agree")]
    InvalidMilestone,
    #[msg("The gate must contain the cumulative attestations for its milestone")]
    InvalidAttestationCount,
    #[msg("The gate decision does not match its cumulative source decisions")]
    GateDecisionMismatch,
    #[msg("The remaining source accounts are missing or out of order")]
    InvalidSourceAccounts,
    #[msg("A source account is not owned by pod_oracle")]
    InvalidSourceOwner,
    #[msg("A source revision is not the current immutable revision")]
    StaleSourceRevision,
    #[msg("The source revision does not match the gate identity")]
    SourceIdentityMismatch,
    #[msg("A source revision is expired")]
    SourceExpired,
    #[msg("The gate is not live and current")]
    GateNotLive,
}

fn validate_config_args(args: &InitializeOracleConfigArgs) -> Result<()> {
    require!(
        args.guardian != Pubkey::default(),
        OracleError::ZeroPublicKey
    );
    require!(
        args.initial_publisher != Pubkey::default(),
        OracleError::ZeroPublicKey
    );
    for value in [
        args.max_attestation_validity_secs,
        args.max_valuation_validity_secs,
        args.max_gate_validity_secs,
    ] {
        require!(
            value > 0 && value <= MAX_VALIDITY_SECS,
            OracleError::InvalidValidityConfiguration
        );
    }
    require!(
        (0..=MAX_FUTURE_TOLERANCE_SECS).contains(&args.future_tolerance_secs),
        OracleError::InvalidFutureTolerance
    );
    Ok(())
}

fn authorize_publisher(config: &OracleConfig, publisher: Pubkey) -> Result<()> {
    require!(!config.paused, OracleError::OraclePaused);
    require!(
        config.is_publisher(&publisher),
        OracleError::UnauthorizedPublisher
    );
    Ok(())
}

fn validate_attestation_args(
    config: &OracleConfig,
    args: &PublishAttestationArgs,
    now: i64,
) -> Result<()> {
    require_nonzero_hashes(&[
        &args.subject_ref,
        &args.asset_set_hash,
        &args.season_id,
        &args.policy_hash,
        &args.engine_version_hash,
        &args.result_hash,
        &args.evidence_hash,
        &args.content_hash,
    ])?;
    require!(
        args.confidence_bps <= BPS_DENOMINATOR && args.pass_fraction_bps <= BPS_DENOMINATOR,
        OracleError::InvalidBasisPoints
    );
    validate_time_window(
        args.observed_at,
        args.valid_until,
        now,
        config.future_tolerance_secs,
        config.max_attestation_validity_secs,
    )
}

fn validate_valuation_args(
    config: &OracleConfig,
    args: &PublishValuationArgs,
    now: i64,
) -> Result<()> {
    require_nonzero_hashes(&[
        &args.base_asset_hash,
        &args.quote_asset_hash,
        &args.source_hash,
        &args.methodology_hash,
        &args.evidence_hash,
        &args.content_hash,
    ])?;
    require!(
        args.base_asset_hash != args.quote_asset_hash,
        OracleError::IdenticalAssetPair
    );
    require!(args.value > 0, OracleError::InvalidValuation);
    require!(args.scale <= 18, OracleError::InvalidValuationScale);
    validate_time_window(
        args.as_of,
        args.valid_until,
        now,
        config.future_tolerance_secs,
        config.max_valuation_validity_secs,
    )
}

fn validate_deal_gate_args(
    config: &OracleConfig,
    args: &PublishDealGateArgs,
    now: i64,
) -> Result<()> {
    require!(
        args.deal != Pubkey::default(),
        OracleError::InvalidReference
    );
    require_nonzero_hashes(&[
        &args.asset_set_hash,
        &args.season_id,
        &args.policy_hash,
        &args.content_hash,
    ])?;
    require!(
        args.milestone_index == release_gate_code(args.gate_kind),
        OracleError::InvalidMilestone
    );
    let expected = usize::from(release_gate_code(args.gate_kind));
    require!(
        usize::from(args.attestation_count) == expected,
        OracleError::InvalidAttestationCount
    );
    for (index, content_ref) in args.attestations.iter().enumerate() {
        if index < expected {
            validate_content_ref(content_ref)?;
        } else {
            require!(
                content_ref == &ContentRef::default(),
                OracleError::InvalidAttestationCount
            );
        }
    }
    validate_content_ref(&args.commodity_valuation)?;
    validate_content_ref(&args.fx_valuation)?;
    validate_time_window(
        args.evaluated_at,
        args.expires_at,
        now,
        config.future_tolerance_secs,
        config.max_gate_validity_secs,
    )
}

fn validate_time_window(
    observed_at: i64,
    valid_until: i64,
    now: i64,
    future_tolerance_secs: i64,
    max_validity_secs: i64,
) -> Result<()> {
    let max_observed_at = now
        .checked_add(future_tolerance_secs)
        .ok_or(OracleError::ArithmeticOverflow)?;
    require!(
        observed_at <= max_observed_at,
        OracleError::ObservationInFuture
    );
    require!(
        valid_until > observed_at && valid_until > now,
        OracleError::InvalidValidityInterval
    );
    let duration = valid_until
        .checked_sub(observed_at)
        .ok_or(OracleError::ArithmeticOverflow)?;
    require!(
        duration <= max_validity_secs,
        OracleError::InvalidValidityInterval
    );
    Ok(())
}

fn validate_revision_transition(latest: u32, revision: u32, correction_of: u32) -> Result<()> {
    let expected = latest
        .checked_add(1)
        .ok_or(OracleError::ArithmeticOverflow)?;
    require!(revision == expected, OracleError::InvalidRevision);
    require!(correction_of == latest, OracleError::InvalidCorrection);
    Ok(())
}

fn prepare_attestation_head(
    head: &mut Account<AttestationHead>,
    args: &PublishAttestationArgs,
    bump: u8,
) -> Result<()> {
    if head.schema_version == 0 {
        head.schema_version = ACCOUNT_SCHEMA_V1;
        head.bump = bump;
        head.product = args.product;
        head.subject_ref = args.subject_ref;
        head.asset_set_hash = args.asset_set_hash;
        head.season_id = args.season_id;
        head.reserved = [0; RESERVED_ACCOUNT_BYTES];
    }
    require_attestation_head_identity(head, args)
}

fn require_attestation_head_identity(
    head: &AttestationHead,
    args: &PublishAttestationArgs,
) -> Result<()> {
    require!(
        head.schema_version == ACCOUNT_SCHEMA_V1
            && head.product == args.product
            && head.subject_ref == args.subject_ref
            && head.asset_set_hash == args.asset_set_hash
            && head.season_id == args.season_id,
        OracleError::HeadIdentityMismatch
    );
    Ok(())
}

fn prepare_valuation_head(
    head: &mut Account<ValuationHead>,
    args: &PublishValuationArgs,
    bump: u8,
) -> Result<()> {
    if head.schema_version == 0 {
        head.schema_version = ACCOUNT_SCHEMA_V1;
        head.bump = bump;
        head.kind = args.kind;
        head.base_asset_hash = args.base_asset_hash;
        head.quote_asset_hash = args.quote_asset_hash;
        head.reserved = [0; RESERVED_ACCOUNT_BYTES];
    }
    require_valuation_head_identity(head, args)
}

fn require_valuation_head_identity(
    head: &ValuationHead,
    args: &PublishValuationArgs,
) -> Result<()> {
    require!(
        head.schema_version == ACCOUNT_SCHEMA_V1
            && head.kind == args.kind
            && head.base_asset_hash == args.base_asset_hash
            && head.quote_asset_hash == args.quote_asset_hash,
        OracleError::HeadIdentityMismatch
    );
    Ok(())
}

fn prepare_deal_gate_head(
    head: &mut Account<DealGateHead>,
    args: &PublishDealGateArgs,
    bump: u8,
) -> Result<()> {
    if head.schema_version == 0 {
        head.schema_version = ACCOUNT_SCHEMA_V1;
        head.bump = bump;
        head.deal = args.deal;
        head.milestone_index = args.milestone_index;
        head.gate_kind = args.gate_kind;
        head.asset_set_hash = args.asset_set_hash;
        head.season_id = args.season_id;
        head.reserved = [0; RESERVED_ACCOUNT_BYTES];
    }
    require_deal_gate_head_identity(head, args)
}

fn require_deal_gate_head_identity(head: &DealGateHead, args: &PublishDealGateArgs) -> Result<()> {
    require!(
        head.schema_version == ACCOUNT_SCHEMA_V1
            && head.deal == args.deal
            && head.milestone_index == args.milestone_index
            && head.gate_kind == args.gate_kind
            && head.asset_set_hash == args.asset_set_hash
            && head.season_id == args.season_id,
        OracleError::HeadIdentityMismatch
    );
    Ok(())
}

fn validate_gate_sources(
    args: &PublishDealGateArgs,
    accounts: &[AccountInfo],
    now: i64,
) -> Result<()> {
    let count = usize::from(args.attestation_count);
    let expected_accounts = count
        .checked_mul(2)
        .and_then(|value| value.checked_add(4))
        .ok_or(OracleError::ArithmeticOverflow)?;
    require!(
        accounts.len() == expected_accounts,
        OracleError::InvalidSourceAccounts
    );

    let mut aggregate_decision = Decision::Pass;
    for index in 0..count {
        let revision_info = &accounts[index * 2];
        let head_info = &accounts[index * 2 + 1];
        let revision: AttestationRevision = deserialize_oracle_account(revision_info)?;
        let head: AttestationHead = deserialize_oracle_account(head_info)?;
        let expected_product = expected_product_at(index)?;
        let content_ref = &args.attestations[index];

        require_keys_eq!(
            content_ref.address,
            revision_info.key(),
            OracleError::SourceIdentityMismatch
        );
        require_keys_eq!(
            revision.head,
            head_info.key(),
            OracleError::SourceIdentityMismatch
        );
        require!(
            content_ref.revision == revision.revision
                && content_ref.content_hash == revision.content_hash
                && head.latest_revision == revision.revision
                && head.latest_revision_address == revision_info.key()
                && head.latest_revision_hash == revision.revision_hash,
            OracleError::StaleSourceRevision
        );
        require!(
            revision.product == expected_product
                && revision.asset_set_hash == args.asset_set_hash
                && revision.season_id == args.season_id,
            OracleError::SourceIdentityMismatch
        );
        aggregate_decision = match (aggregate_decision, revision.decision) {
            (Decision::Fail, _) | (_, Decision::Fail) => Decision::Fail,
            (Decision::Inconclusive, _) | (_, Decision::Inconclusive) => Decision::Inconclusive,
            _ => Decision::Pass,
        };
        require!(
            revision.valid_until >= now && revision.valid_until >= args.expires_at,
            OracleError::SourceExpired
        );
    }
    if count > 0 {
        require!(
            args.decision == aggregate_decision,
            OracleError::GateDecisionMismatch
        );
    }

    let valuation_offset = count * 2;
    validate_valuation_source(
        &args.commodity_valuation,
        ValuationKind::CommodityPrice,
        &accounts[valuation_offset],
        &accounts[valuation_offset + 1],
        args.expires_at,
    )?;
    validate_valuation_source(
        &args.fx_valuation,
        ValuationKind::FxRate,
        &accounts[valuation_offset + 2],
        &accounts[valuation_offset + 3],
        args.expires_at,
    )
}

fn validate_valuation_source(
    content_ref: &ContentRef,
    expected_kind: ValuationKind,
    revision_info: &AccountInfo,
    head_info: &AccountInfo,
    gate_expires_at: i64,
) -> Result<()> {
    let revision: ValuationRevision = deserialize_oracle_account(revision_info)?;
    let head: ValuationHead = deserialize_oracle_account(head_info)?;
    require_keys_eq!(
        content_ref.address,
        revision_info.key(),
        OracleError::SourceIdentityMismatch
    );
    require_keys_eq!(
        revision.head,
        head_info.key(),
        OracleError::SourceIdentityMismatch
    );
    require!(
        revision.kind == expected_kind && head.kind == expected_kind,
        OracleError::SourceIdentityMismatch
    );
    require!(
        content_ref.revision == revision.revision
            && content_ref.content_hash == revision.content_hash
            && head.latest_revision == revision.revision
            && head.latest_revision_address == revision_info.key()
            && head.latest_revision_hash == revision.revision_hash,
        OracleError::StaleSourceRevision
    );
    require!(
        revision.valid_until >= gate_expires_at,
        OracleError::SourceExpired
    );
    Ok(())
}

fn deserialize_oracle_account<T: AccountDeserialize>(info: &AccountInfo) -> Result<T> {
    require_keys_eq!(*info.owner, crate::ID, OracleError::InvalidSourceOwner);
    let data = info
        .try_borrow_data()
        .map_err(|_| error!(OracleError::InvalidSourceAccounts))?;
    let mut bytes: &[u8] = &data;
    T::try_deserialize(&mut bytes).map_err(|_| error!(OracleError::InvalidSourceAccounts))
}

pub fn assert_live_gate(
    head: &DealGateHead,
    revision_address: Pubkey,
    revision: &DealGateRevision,
    now: i64,
) -> Result<()> {
    require!(
        revision.decision == Decision::Pass
            && revision.expires_at >= now
            && head.latest_revision == revision.revision
            && head.latest_revision_address == revision_address
            && head.latest_revision_hash == revision.revision_hash
            && head.latest_decision == Decision::Pass
            && head.latest_expires_at == revision.expires_at
            && revision.head != Pubkey::default(),
        OracleError::GateNotLive
    );
    Ok(())
}

fn validate_content_ref(content_ref: &ContentRef) -> Result<()> {
    require!(
        content_ref.address != Pubkey::default()
            && content_ref.revision > 0
            && content_ref.content_hash != [0; 32],
        OracleError::InvalidReference
    );
    Ok(())
}

fn require_nonzero_hashes(hashes: &[&[u8; 32]]) -> Result<()> {
    require!(
        hashes.iter().all(|hash| **hash != [0; 32]),
        OracleError::ZeroHash
    );
    Ok(())
}

fn attestation_revision_hash(args: &PublishAttestationArgs) -> Result<[u8; 32]> {
    hash_serialized(ATTESTATION_HASH_DOMAIN, args)
}

fn valuation_revision_hash(args: &PublishValuationArgs) -> Result<[u8; 32]> {
    hash_serialized(VALUATION_HASH_DOMAIN, args)
}

fn deal_gate_revision_hash(args: &PublishDealGateArgs) -> Result<[u8; 32]> {
    hash_serialized(DEAL_GATE_HASH_DOMAIN, args)
}

fn hash_serialized<T: AnchorSerialize>(domain: &[u8], value: &T) -> Result<[u8; 32]> {
    let mut bytes = Vec::new();
    AnchorSerialize::serialize(value, &mut bytes)
        .map_err(|_| error!(OracleError::InvalidReference))?;
    Ok(domain_hash(domain, &bytes))
}

const fn oracle_product_code(product: OracleProduct) -> u8 {
    match product {
        OracleProduct::T1Plow => 0,
        OracleProduct::T2Health => 1,
        OracleProduct::T3Yield => 2,
    }
}

const fn valuation_kind_code(kind: ValuationKind) -> u8 {
    match kind {
        ValuationKind::CommodityPrice => 0,
        ValuationKind::FxRate => 1,
    }
}

const fn release_gate_code(kind: ReleaseGateKind) -> u8 {
    match kind {
        ReleaseGateKind::CapitalClose => 0,
        ReleaseGateKind::T1Pass => 1,
        ReleaseGateKind::T2Pass => 2,
        ReleaseGateKind::T3Pass => 3,
    }
}

fn expected_product_at(index: usize) -> Result<OracleProduct> {
    match index {
        0 => Ok(OracleProduct::T1Plow),
        1 => Ok(OracleProduct::T2Health),
        2 => Ok(OracleProduct::T3Yield),
        _ => err!(OracleError::InvalidAttestationCount),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    fn config() -> OracleConfig {
        OracleConfig {
            schema_version: ACCOUNT_SCHEMA_V1,
            bump: 255,
            paused: false,
            governance: Pubkey::new_unique(),
            pending_governance: Pubkey::default(),
            guardian: Pubkey::new_unique(),
            publishers: [Pubkey::default(); MAX_PUBLISHERS],
            publisher_count: 0,
            max_attestation_validity_secs: 1_000,
            max_valuation_validity_secs: 1_000,
            max_gate_validity_secs: 1_000,
            future_tolerance_secs: 30,
            reserved: [0; RESERVED_ACCOUNT_BYTES],
        }
    }

    fn attestation_args() -> PublishAttestationArgs {
        PublishAttestationArgs {
            product: OracleProduct::T1Plow,
            subject_ref: hash(1),
            asset_set_hash: hash(2),
            season_id: hash(3),
            revision: 1,
            correction_of: 0,
            decision: Decision::Pass,
            confidence_bps: 8_500,
            pass_fraction_bps: 8_000,
            observed_at: 900,
            valid_until: 1_500,
            policy_hash: hash(4),
            engine_version_hash: hash(5),
            result_hash: hash(6),
            evidence_hash: hash(7),
            content_hash: hash(8),
        }
    }

    #[test]
    fn publisher_registry_is_bounded_and_idempotent() {
        let mut config = config();
        let first = Pubkey::new_unique();
        assert!(config.set_publisher(first, true).unwrap());
        assert!(!config.set_publisher(first, true).unwrap());
        assert!(config.is_publisher(&first));

        for _ in 1..MAX_PUBLISHERS {
            config.set_publisher(Pubkey::new_unique(), true).unwrap();
        }
        assert!(config.set_publisher(Pubkey::new_unique(), true).is_err());
        assert!(config.set_publisher(first, false).unwrap());
        assert!(!config.is_publisher(&first));
        assert_eq!(usize::from(config.publisher_count), MAX_PUBLISHERS - 1);
    }

    #[test]
    fn publisher_authorization_honors_registry_and_pause() {
        let mut config = config();
        let publisher = Pubkey::new_unique();
        config.set_publisher(publisher, true).unwrap();
        authorize_publisher(&config, publisher).unwrap();
        assert!(authorize_publisher(&config, Pubkey::new_unique()).is_err());
        config.paused = true;
        assert!(authorize_publisher(&config, publisher).is_err());
    }

    #[test]
    fn attestation_validation_enforces_bps_hashes_and_freshness() {
        let config = config();
        let mut args = attestation_args();
        validate_attestation_args(&config, &args, 1_000).unwrap();

        args.confidence_bps = 10_001;
        assert!(validate_attestation_args(&config, &args, 1_000).is_err());
        args.confidence_bps = 8_500;
        args.result_hash = [0; 32];
        assert!(validate_attestation_args(&config, &args, 1_000).is_err());
        args.result_hash = hash(6);
        args.valid_until = 1_000;
        assert!(validate_attestation_args(&config, &args, 1_000).is_err());
    }

    #[test]
    fn revisions_must_be_sequential_corrections() {
        validate_revision_transition(0, 1, 0).unwrap();
        validate_revision_transition(1, 2, 1).unwrap();
        assert!(validate_revision_transition(1, 3, 1).is_err());
        assert!(validate_revision_transition(1, 2, 0).is_err());
    }

    #[test]
    fn canonical_hash_is_stable_and_content_sensitive() {
        let first = attestation_args();
        let mut second = first.clone();
        assert_eq!(
            attestation_revision_hash(&first).unwrap(),
            attestation_revision_hash(&second).unwrap()
        );
        second.pass_fraction_bps += 1;
        assert_ne!(
            attestation_revision_hash(&first).unwrap(),
            attestation_revision_hash(&second).unwrap()
        );
        let mut serialized = Vec::new();
        AnchorSerialize::serialize(&first, &mut serialized).unwrap();
        assert_ne!(
            domain_hash(ATTESTATION_HASH_DOMAIN, &serialized),
            domain_hash(VALUATION_HASH_DOMAIN, &serialized)
        );
    }

    #[test]
    fn exact_revision_replay_matches_but_conflicting_content_does_not() {
        let args = attestation_args();
        let publisher = Pubkey::new_unique();
        let revision_hash = attestation_revision_hash(&args).unwrap();
        let revision = AttestationRevision {
            schema_version: ACCOUNT_SCHEMA_V1,
            bump: 1,
            head: Pubkey::new_unique(),
            publisher,
            product: args.product,
            subject_ref: args.subject_ref,
            asset_set_hash: args.asset_set_hash,
            season_id: args.season_id,
            revision: args.revision,
            correction_of: args.correction_of,
            decision: args.decision,
            confidence_bps: args.confidence_bps,
            pass_fraction_bps: args.pass_fraction_bps,
            observed_at: args.observed_at,
            valid_until: args.valid_until,
            published_at: 1_000,
            policy_hash: args.policy_hash,
            engine_version_hash: args.engine_version_hash,
            result_hash: args.result_hash,
            evidence_hash: args.evidence_hash,
            content_hash: args.content_hash,
            revision_hash,
            reserved: [0; RESERVED_ACCOUNT_BYTES],
        };
        assert!(revision.matches(&args, publisher, revision_hash));

        let mut conflict = args;
        conflict.result_hash = hash(99);
        assert!(!revision.matches(
            &conflict,
            publisher,
            attestation_revision_hash(&conflict).unwrap()
        ));
    }

    #[test]
    fn valuation_requires_integer_value_and_distinct_pair() {
        let config = config();
        let args = PublishValuationArgs {
            kind: ValuationKind::FxRate,
            base_asset_hash: hash(1),
            quote_asset_hash: hash(2),
            value: 5_750_000,
            scale: 6,
            revision: 1,
            correction_of: 0,
            as_of: 900,
            valid_until: 1_500,
            source_hash: hash(3),
            methodology_hash: hash(4),
            evidence_hash: hash(5),
            content_hash: hash(6),
        };
        validate_valuation_args(&config, &args, 1_000).unwrap();

        let mut zero = args.clone();
        zero.value = 0;
        assert!(validate_valuation_args(&config, &zero, 1_000).is_err());
        let mut same_pair = args;
        same_pair.quote_asset_hash = same_pair.base_asset_hash;
        assert!(validate_valuation_args(&config, &same_pair, 1_000).is_err());
    }

    #[test]
    fn gate_requires_cumulative_sources_and_consistent_milestone() {
        let config = config();
        let reference = ContentRef {
            address: Pubkey::new_unique(),
            revision: 1,
            content_hash: hash(1),
        };
        let args = PublishDealGateArgs {
            deal: Pubkey::new_unique(),
            milestone_index: 2,
            gate_kind: ReleaseGateKind::T2Pass,
            asset_set_hash: hash(2),
            season_id: hash(3),
            revision: 1,
            correction_of: 0,
            attestation_count: 2,
            attestations: [reference, reference, ContentRef::default()],
            commodity_valuation: reference,
            fx_valuation: reference,
            policy_hash: hash(4),
            decision: Decision::Pass,
            evaluated_at: 900,
            expires_at: 1_500,
            content_hash: hash(5),
        };
        validate_deal_gate_args(&config, &args, 1_000).unwrap();

        let mut non_cumulative = args.clone();
        non_cumulative.attestation_count = 1;
        assert!(validate_deal_gate_args(&config, &non_cumulative, 1_000).is_err());
        let mut wrong_milestone = args.clone();
        wrong_milestone.milestone_index = 1;
        assert!(validate_deal_gate_args(&config, &wrong_milestone, 1_000).is_err());

        // Negative corrections are valid revision metadata; source-account validation
        // enforces that their cumulative decision is actually FAIL.
        let mut failed = args;
        failed.decision = Decision::Fail;
        validate_deal_gate_args(&config, &failed, 1_000).unwrap();
    }

    #[test]
    fn live_gate_requires_current_head_hash_and_expiry() {
        let revision_key = Pubkey::new_unique();
        let head_key = Pubkey::new_unique();
        let mut revision = DealGateRevision {
            schema_version: ACCOUNT_SCHEMA_V1,
            bump: 1,
            head: head_key,
            publisher: Pubkey::new_unique(),
            deal: Pubkey::new_unique(),
            milestone_index: 0,
            gate_kind: ReleaseGateKind::CapitalClose,
            asset_set_hash: hash(1),
            season_id: hash(2),
            revision: 1,
            correction_of: 0,
            attestation_count: 0,
            attestations: [ContentRef::default(); MAX_ATTESTATIONS_PER_GATE],
            commodity_valuation: ContentRef::default(),
            fx_valuation: ContentRef::default(),
            policy_hash: hash(3),
            decision: Decision::Pass,
            evaluated_at: 900,
            expires_at: 1_500,
            published_at: 1_000,
            content_hash: hash(4),
            revision_hash: hash(5),
            reserved: [0; RESERVED_ACCOUNT_BYTES],
        };
        let head = DealGateHead {
            schema_version: ACCOUNT_SCHEMA_V1,
            bump: 1,
            deal: revision.deal,
            milestone_index: 0,
            gate_kind: ReleaseGateKind::CapitalClose,
            asset_set_hash: revision.asset_set_hash,
            season_id: revision.season_id,
            latest_revision: 1,
            latest_revision_address: revision_key,
            latest_revision_hash: revision.revision_hash,
            latest_decision: Decision::Pass,
            latest_expires_at: revision.expires_at,
            latest_published_at: 1_000,
            reserved: [0; RESERVED_ACCOUNT_BYTES],
        };
        assert_live_gate(&head, revision_key, &revision, 1_200).unwrap();
        assert!(assert_live_gate(&head, revision_key, &revision, 1_501).is_err());
        revision.revision_hash = hash(9);
        assert!(assert_live_gate(&head, revision_key, &revision, 1_200).is_err());
    }

    #[test]
    fn account_space_constants_cover_serialized_accounts() {
        let config = config();
        let mut serialized = Vec::new();
        AnchorSerialize::serialize(&config, &mut serialized).unwrap();
        assert!(serialized.len() <= OracleConfig::SPACE);
        assert_eq!(RESERVED_ACCOUNT_BYTES, config.reserved.len());
    }
}
