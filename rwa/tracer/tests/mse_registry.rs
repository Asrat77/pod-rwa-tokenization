//! Phase 1 tracer: the MSE beneficiary registry, exercised on-chain.
//!
//! Runs `pod_vault` natively through solana-program-test's BanksClient, so this needs no
//! SBF platform-tools toolchain and no validator. It proves the real instruction dispatch,
//! PDA derivation, governance gating and rail discriminants introduced by the multi-MSE
//! refactor — the parts unit tests can only assert about in isolation.

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use pod_rwa_common::{MseBeneficiaryStatus, MseRailKind};
use pod_vault::state::MseBeneficiary;
// Pubkey comes from anchor so it is definitionally the same type the programs were compiled
// against; the remaining types come from the modular crates program-test itself uses.
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::system_program;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_signer::Signer;
use solana_transaction::Transaction;

const PROTOCOL_SEED: &[u8] = b"protocol";
const MSE_BENEFICIARY_SEED: &[u8] = b"mse-beneficiary";

/// Adapts an Anchor `entry` to the fn pointer `processor!` expects.
///
/// Anchor generates `entry<'info>(&'info Pubkey, &'info [AccountInfo<'info>], &'info [u8])` —
/// one lifetime shared by all three arguments — while `processor!` requires a higher-ranked
/// fn with four independent lifetimes. The compiler cannot bridge the two because
/// `AccountInfo` is invariant in its lifetime parameter.
///
/// The shortening is sound in this direction: `entry` only reads the slice for the duration
/// of the call and never stores an `AccountInfo` beyond it, so no borrow outlives the frame
/// the runtime already guarantees.
macro_rules! anchor_processor {
    ($program:path) => {{
        fn adapter(
            program_id: &Pubkey,
            accounts: &[anchor_lang::prelude::AccountInfo],
            instruction_data: &[u8],
        ) -> anchor_lang::solana_program::entrypoint::ProgramResult {
            // SAFETY: see the doc comment — the callee does not retain these borrows.
            let accounts: &[anchor_lang::prelude::AccountInfo] =
                unsafe { core::mem::transmute(accounts) };
            $program(program_id, accounts, instruction_data)
        }
        processor!(adapter)
    }};
}

struct Harness {
    ctx: ProgramTestContext,
    governance: Keypair,
    guardian: Pubkey,
    compliance_authority: Pubkey,
    platform_treasury_authority: Pubkey,
    protocol_config: Pubkey,
}

fn protocol_config_pda() -> Pubkey {
    Pubkey::find_program_address(&[PROTOCOL_SEED], &pod_vault::ID).0
}

fn mse_beneficiary_pda(entity_hash: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[MSE_BENEFICIARY_SEED, entity_hash], &pod_vault::ID).0
}

async fn start() -> Harness {
    let mut program_test = ProgramTest::new(
        "pod_vault",
        pod_vault::ID,
        anchor_processor!(pod_vault::entry),
    );
    // The vault validates that the configured oracle/compliance program ids match these
    // deployed programs, so both must be present even though phase 1 does not call them.
    program_test.add_program(
        "pod_oracle",
        pod_oracle::ID,
        anchor_processor!(pod_oracle::entry),
    );
    program_test.add_program(
        "pod_compliance",
        pod_compliance::ID,
        anchor_processor!(pod_compliance::entry),
    );

    let mut ctx = program_test.start_with_context().await;

    let governance = Keypair::new();
    // Fund governance so it can pay for account creation.
    let fund = solana_system_interface::instruction::transfer(
        &ctx.payer.pubkey(),
        &governance.pubkey(),
        10_000_000_000,
    );
    let tx = Transaction::new_signed_with_payer(
        &[fund],
        Some(&ctx.payer.pubkey()),
        &[&ctx.payer],
        ctx.last_blockhash,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();

    Harness {
        governance,
        guardian: Pubkey::new_unique(),
        compliance_authority: Pubkey::new_unique(),
        platform_treasury_authority: Pubkey::new_unique(),
        protocol_config: protocol_config_pda(),
        ctx,
    }
}

impl Harness {
    /// Give an account enough lamports to pay rent, so a rejected transaction can only be
    /// failing on the authorization check and not on an unfunded payer.
    async fn fund(&mut self, target: &Pubkey) {
        let blockhash = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let ix =
            solana_system_interface::instruction::transfer(&self.ctx.payer.pubkey(), target, 1_000_000_000);
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&self.ctx.payer.pubkey()),
            &[&self.ctx.payer],
            blockhash,
        );
        self.ctx.banks_client.process_transaction(tx).await.unwrap();
    }

    async fn account_exists(&mut self, address: Pubkey) -> bool {
        self.ctx
            .banks_client
            .get_account(address)
            .await
            .unwrap()
            .is_some()
    }

    async fn send(
        &mut self,
        ix: Instruction,
        extra_signers: &[&Keypair],
    ) -> Result<(), solana_program_test::BanksClientError> {
        let blockhash = self.ctx.banks_client.get_latest_blockhash().await.unwrap();
        let mut signers: Vec<&Keypair> = vec![&self.ctx.payer];
        signers.extend_from_slice(extra_signers);
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&self.ctx.payer.pubkey()),
            &signers,
            blockhash,
        );
        self.ctx.banks_client.process_transaction(tx).await
    }

    async fn initialize_protocol(&mut self) {
        let args = pod_vault::InitializeProtocolArgs {
            governance: self.governance.pubkey(),
            guardian: self.guardian,
            compliance_authority: self.compliance_authority,
            platform_treasury_authority: self.platform_treasury_authority,
            oracle_program: pod_oracle::ID,
            compliance_program: pod_compliance::ID,
        };
        let ix = Instruction {
            program_id: pod_vault::ID,
            accounts: pod_vault::accounts::InitializeProtocol {
                protocol_config: self.protocol_config,
                payer: self.ctx.payer.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: pod_vault::instruction::InitializeProtocol { args }.data(),
        };
        self.send(ix, &[]).await.expect("protocol initializes");
    }

    fn register_mse_ix(
        &self,
        signer: Pubkey,
        entity_hash: [u8; 32],
        wallet_owner: Pubkey,
        usdc_ata: Pubkey,
        rail_kind: MseRailKind,
    ) -> Instruction {
        let args = pod_vault::RegisterMseBeneficiaryArgs {
            entity_hash,
            wallet_owner,
            usdc_ata,
            rail_kind,
        };
        Instruction {
            program_id: pod_vault::ID,
            accounts: pod_vault::accounts::RegisterMseBeneficiary {
                protocol_config: self.protocol_config,
                mse_beneficiary: mse_beneficiary_pda(&entity_hash),
                governance: signer,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: pod_vault::instruction::RegisterMseBeneficiary { args }.data(),
        }
    }

    async fn read_beneficiary(&mut self, entity_hash: &[u8; 32]) -> MseBeneficiary {
        let account = self
            .ctx
            .banks_client
            .get_account(mse_beneficiary_pda(entity_hash))
            .await
            .unwrap()
            .expect("beneficiary account exists");
        MseBeneficiary::try_deserialize(&mut account.data.as_slice())
            .expect("beneficiary decodes")
    }
}

#[tokio::test]
async fn registry_holds_many_mses_across_both_rails() {
    let mut h = start().await;
    h.initialize_protocol().await;

    // The platform's own MSE: Squads custody, USD forwarded over SWIFT off-chain.
    let platform_hash = [1u8; 32];
    let platform_wallet = Pubkey::new_unique();
    let platform_ata = Pubkey::new_unique();
    let ix = h.register_mse_ix(
        h.governance.pubkey(),
        platform_hash,
        platform_wallet,
        platform_ata,
        MseRailKind::SquadsFiatForward,
    );
    let governance = h.governance.insecure_clone();
    h.send(ix, &[&governance]).await.expect("platform MSE registers");

    // A third-party MSE: paid USDC directly, no fiat leg.
    let third_party_hash = [2u8; 32];
    let third_party_wallet = Pubkey::new_unique();
    let third_party_ata = Pubkey::new_unique();
    let ix = h.register_mse_ix(
        h.governance.pubkey(),
        third_party_hash,
        third_party_wallet,
        third_party_ata,
        MseRailKind::DirectUsdc,
    );
    h.send(ix, &[&governance]).await.expect("third-party MSE registers");

    // Both live simultaneously at distinct PDAs — this is the "multiple MSE wallets"
    // requirement, and the derivation is what keeps them from colliding.
    let platform = h.read_beneficiary(&platform_hash).await;
    assert_eq!(platform.wallet_owner, platform_wallet);
    assert_eq!(platform.usdc_ata, platform_ata);
    assert_eq!(platform.rail_kind, MseRailKind::SquadsFiatForward);
    assert_eq!(platform.status, MseBeneficiaryStatus::Active);

    let third_party = h.read_beneficiary(&third_party_hash).await;
    assert_eq!(third_party.wallet_owner, third_party_wallet);
    assert_eq!(third_party.rail_kind, MseRailKind::DirectUsdc);
    assert_eq!(third_party.status, MseBeneficiaryStatus::Active);
    assert_ne!(
        mse_beneficiary_pda(&platform_hash),
        mse_beneficiary_pda(&third_party_hash)
    );
}

#[tokio::test]
async fn only_governance_may_register_an_mse() {
    let mut h = start().await;
    h.initialize_protocol().await;

    let impostor = Keypair::new();
    h.fund(&impostor.pubkey()).await;

    let entity_hash = [3u8; 32];
    let ix = h.register_mse_ix(
        impostor.pubkey(),
        entity_hash,
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        MseRailKind::DirectUsdc,
    );
    let result = h.send(ix, &[&impostor]).await;
    assert!(
        result.is_err(),
        "a non-governance signer must not be able to register a payout destination"
    );
    // The impostor was funded, so this cannot be a rent failure — and no registry entry
    // may survive the rejected transaction.
    assert!(
        !h.account_exists(mse_beneficiary_pda(&entity_hash)).await,
        "a rejected registration must not leave a beneficiary account behind"
    );
}

#[tokio::test]
async fn governance_can_suspend_a_registered_mse() {
    let mut h = start().await;
    h.initialize_protocol().await;

    let entity_hash = [4u8; 32];
    let governance = h.governance.insecure_clone();
    let ix = h.register_mse_ix(
        h.governance.pubkey(),
        entity_hash,
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        MseRailKind::SquadsFiatForward,
    );
    h.send(ix, &[&governance]).await.expect("registers");
    assert_eq!(
        h.read_beneficiary(&entity_hash).await.status,
        MseBeneficiaryStatus::Active
    );

    let suspend = Instruction {
        program_id: pod_vault::ID,
        accounts: pod_vault::accounts::SetMseBeneficiaryStatus {
            protocol_config: h.protocol_config,
            mse_beneficiary: mse_beneficiary_pda(&entity_hash),
            governance: h.governance.pubkey(),
        }
        .to_account_metas(None),
        data: pod_vault::instruction::SetMseBeneficiaryStatus {
            status: MseBeneficiaryStatus::Suspended,
        }
        .data(),
    };
    h.send(suspend, &[&governance]).await.expect("suspends");

    // A suspended beneficiary stays on-chain but can no longer back a new deal;
    // `create_deal` requires an Active entry.
    assert_eq!(
        h.read_beneficiary(&entity_hash).await.status,
        MseBeneficiaryStatus::Suspended
    );
}
