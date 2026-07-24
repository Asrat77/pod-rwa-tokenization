use anchor_lang::prelude::*;

#[error_code]
pub enum ComplianceError {
    #[msg("The signer is not authorized for this action")]
    InvalidAuthority,
    #[msg("The compliance program is paused")]
    ConfigPaused,
    #[msg("The provider is not active")]
    ProviderInactive,
    #[msg("The provider cannot issue or update credentials")]
    ProviderCannotIssue,
    #[msg("The provider cannot revoke credentials")]
    ProviderCannotRevoke,
    #[msg("The opaque investor identifier must not be all zeroes")]
    InvalidOpaqueId,
    #[msg("The supplied expiry is not in the future")]
    InvalidExpiry,
    #[msg("The investor already has an active wallet binding")]
    AlreadyBound,
    #[msg("The wallet does not match the active binding")]
    WalletMismatch,
    #[msg("The investor is not active and unexpired")]
    InvestorInactive,
    #[msg("The series permission is not active and unexpired")]
    PermissionInactive,
    #[msg("The transfer policy is inactive")]
    PolicyInactive,
    #[msg("The transfer is not permitted by the current policy")]
    TransferNotAllowed,
    #[msg("The account is linked to a different series")]
    InvalidSeries,
    #[msg("The supplied compliance accounts are not linked")]
    InvalidLink,
    #[msg("The recovery delay is shorter than the configured minimum")]
    RecoveryTooSoon,
    #[msg("The recovery order has expired")]
    RecoveryExpired,
    #[msg("The recovery order is not ready for execution")]
    RecoveryNotReady,
    #[msg("The recovery order is no longer proposed")]
    RecoveryNotProposed,
    #[msg("The recovery order has not been prepared for its receipt transfer")]
    RecoveryNotPrepared,
    #[msg("The recovery order fields do not match the requested rotation")]
    InvalidRecoveryOrder,
    #[msg("The recovery receipt transfer was empty, partial, or otherwise mismatched")]
    InvalidRecoveryBalance,
    #[msg("The recovery destination receipt account must be empty before preparation")]
    RecoveryDestinationNotEmpty,
    #[msg("Recovery receipt accounts must be initialized and thawed before transfer")]
    InvalidRecoveryTokenState,
    #[msg("The recovery destination permission does not exactly preserve the source claim")]
    RecoveryPermissionMismatch,
    #[msg("The receipt mint has a missing or incorrect permanent delegate")]
    InvalidPermanentDelegate,
    #[msg("The receipt account is not the canonical Token-2022 associated token account")]
    InvalidAssociatedTokenAccount,
    #[msg("The receipt mint freeze authority must be the ComplianceConfig PDA")]
    InvalidFreezeAuthority,
    #[msg("The receipt mint must initialize Token-2022 accounts as Frozen")]
    InvalidDefaultAccountState,
    #[msg("The receipt account is not in the state required for this transition")]
    InvalidReceiptAccountState,
    #[msg("A provider may freeze only a restricted, suspended, expired or revoked claim")]
    ReceiptAccountNotRestricted,
    #[msg("Restricted redemption requires an inactive or expired investor or series permission")]
    RestrictedRedemptionRequiresRestriction,
    #[msg("No governance transfer is pending")]
    NoPendingGovernance,
    #[msg("The proposed governance authority must be different")]
    SameGovernance,
    #[msg("The configured recovery delay is outside the supported range")]
    InvalidRecoveryDelay,
    #[msg("The transfer hook was not invoked by Token-2022 during a transfer")]
    TransferNotInProgress,
    #[msg("The account is already revoked")]
    AlreadyRevoked,
    #[msg("A public key argument must not be the default address")]
    InvalidPublicKey,
    #[msg("The terms hash must not be all zeroes")]
    InvalidTermsHash,
    #[msg("The maximum investment amount must be greater than zero")]
    InvalidInvestmentCap,
    #[msg("The token amount must be greater than zero")]
    InvalidAmount,
    #[msg("The receipt mint must use the Token-2022 program")]
    InvalidTokenProgram,
}
