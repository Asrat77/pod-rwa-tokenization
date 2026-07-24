# pod-compliance receipt-account control

`pod-compliance` is the sole on-chain controller for Token-2022 receipt-account
freeze state. Freezing a token account does not burn its balance or remove the
investor's claim.

## Receipt mint contract

Before `pod-vault::create_deal` accepts a series mint, the mint must be
initialized under the Token-2022 program with this exact authority split:

| Mint capability | Required authority |
| --- | --- |
| Mint authority | The corresponding `pod-vault` `Series` PDA until funding closes |
| Freeze authority | `ComplianceConfig` PDA: `find_program_address([b"compliance-config"], pod_compliance::ID)` |
| Permanent delegate | The external recovery Squads address stored in `ComplianceConfig.recovery_authority` |
| Permissioned burn | `TransferPolicy` PDA: `find_program_address([b"transfer-policy", mint], pod_compliance::ID)` |
| Transfer hook | `pod_compliance::ID` |

The mint must also include `DefaultAccountState` set to `Frozen`. The compliance
instructions reject a missing extension, a non-Frozen default, another token
program, or any other freeze authority. Permanent delegate and permissioned
burn authority are deliberately separate from the freeze authority.

`pod-vault::create_deal` must validate these values from the mint account, not
accept hashes or client assertions as substitutes.

## Account-state workflow

1. Create the investor's canonical Token-2022 associated token account.
2. A registered provider issues an active, unexpired investor credential,
   wallet binding and series permission.
3. The provider calls `thaw_receipt_account`.
4. `pod-vault::subscribe` may then mint receipts to that ATA.
5. After suspension, revocation, sanctions hold or expiry, a provider with
   revoke authority calls `freeze_receipt_account`.

Provider thaw is limited to active, unexpired investors and permissions.
Provider freeze is limited to non-active or expired claims. Governance has
separate thaw/freeze overrides for incident response, recovery and controlled
restricted redemption, while all account, provider, investor, wallet, series
and canonical-ATA links remain mandatory.

Governance thaw of a restricted account should be composed in the same
transaction as the controlled recovery or restricted-redemption action. A
restricted investor still cannot transfer through the transfer hook or burn
through PermissionedBurn without the configured vault caller.

Burn-purpose rules are enforced by `permissioned_burn`:

- `Refund` remains available to every strictly linked holder.
- `Redemption` requires both investor and series permission to be active and
  unexpired.
- `RestrictedRedemption` requires at least one of those records to be
  non-active or expired.
