use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("The signer is not authorized for this operation")]
    Unauthorized,
    #[msg("The protocol operation is paused")]
    Paused,
    #[msg("The account schema version is unsupported")]
    UnsupportedSchema,
    #[msg("The supplied deal terms are invalid")]
    InvalidTerms,
    #[msg("The issuer and fiat beneficiary must be distinct entities")]
    IssuerBeneficiaryCollision,
    #[msg("The authority roles must be distinct")]
    AuthorityCollision,
    #[msg("The settlement asset does not match its registered configuration")]
    InvalidSettlementAsset,
    #[msg("The token account does not have the required mint, program, or owner")]
    InvalidTokenAccount,
    #[msg("The receipt mint is not controlled by Token-2022")]
    InvalidReceiptMint,
    #[msg("The receipt mint extension set or authority configuration is invalid")]
    InvalidReceiptExtension,
    #[msg("The compliance account graph does not authorize this investor or series")]
    InvalidComplianceState,
    #[msg("The receipt token account must be the canonical, thawed Token-2022 ATA")]
    ReceiptAccountUnavailable,
    #[msg("The deal is not in the required lifecycle state")]
    InvalidDealState,
    #[msg("The subscription window is not open")]
    SubscriptionWindowClosed,
    #[msg("The subscription would exceed the deal or investor cap")]
    SubscriptionCapExceeded,
    #[msg("The investor is not currently eligible")]
    InvestorNotEligible,
    #[msg("The investor has not accepted the locked deal terms")]
    TermsNotAccepted,
    #[msg("The release milestone configuration is invalid")]
    InvalidMilestone,
    #[msg("Release milestone allocations must total 10,000 basis points")]
    MilestoneAllocationMismatch,
    #[msg("A release milestone is out of sequence")]
    MilestoneOutOfSequence,
    #[msg("The release has not reached its execution time")]
    ReleaseDelayActive,
    #[msg("The release approval has expired")]
    ReleaseExpired,
    #[msg("The release has been cancelled or already executed")]
    ReleaseUnavailable,
    #[msg("The prior fiat disbursement is not bank-confirmed")]
    PriorDisbursementUnconfirmed,
    #[msg("The oracle gate is missing, stale, inconclusive, failed, or superseded")]
    InvalidOracleGate,
    #[msg("The operation receipt nonce conflicts with a different payload")]
    IdempotencyConflict,
    #[msg("The raise cannot be finalized yet")]
    RaiseNotFinalizable,
    #[msg("This deal cannot use the pre-release refund path")]
    RefundUnavailable,
    #[msg("The repayment is not from a registered servicer")]
    InvalidRepaymentSource,
    #[msg("The repayment vault balance is below accounted liabilities")]
    AccountingDeficit,
    #[msg("Settlement cannot be finalized yet")]
    SettlementNotReady,
    #[msg("The holder must redeem the complete live receipt balance")]
    FullRedemptionRequired,
    #[msg("Arithmetic overflow or invalid division")]
    MathOverflow,
    #[msg("The treasury movement transition is invalid")]
    InvalidTreasuryTransition,
    #[msg("The evidence record does not match the locked deal or release")]
    EvidenceMismatch,
    #[msg("Mint authority must be revoked before the deal can become active")]
    MintAuthorityStillActive,
    #[msg("The issuer settlement distribution has already been withdrawn")]
    IssuerDistributionAlreadyWithdrawn,
    #[msg("The MSE beneficiary is not active in the registry")]
    InactiveMseBeneficiary,
    #[msg("RWA V1 supports only the US issuer Squads fiat-forward treasury rail")]
    UnsupportedMseRail,
}
