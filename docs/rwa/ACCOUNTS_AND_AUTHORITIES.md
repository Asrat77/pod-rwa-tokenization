# Accounts and authorities

This document fixes the V1 account ownership, PDA namespace, mutability, and
authority separation. Seed fragments are UTF-8 literals; bracketed values are
canonical serialized bytes.

## 1. On-chain accounts

### `pod_oracle`

| Account | PDA seeds | Purpose | Authorized mutation |
|---|---|---|---|
| `OracleConfig` | `oracle-config` | Governance, guardian, publisher allowlist, validity limits, pause state | Governance manages publishers and transfers governance; guardian may pause only |
| `AttestationHead` | `attestation-head`, subject, asset set, season, product | Latest pointer for T1/T2/T3 subject | Registered publisher through publish instruction |
| `AttestationRevision` | `attestation-rev`, head, revision u32 | Immutable evidence, decision, policy, engine, result and content commitments | Created once by registered publisher; conflicting replay rejected |
| `ValuationHead` | `valuation-head`, kind, base asset, quote asset | Latest commodity-price or FX pointer | Registered publisher |
| `ValuationRevision` | `valuation-rev`, head, revision u32 | Immutable scaled valuation and source/method commitments | Created once by registered publisher |
| `DealGateHead` | `deal-gate-head`, deal, milestone index | Latest valid gate revision | Registered publisher |
| `DealGateRevision` | `deal-gate-rev`, head, revision u32 | Immutable gate decision linked to attestations and valuations | Created once by registered publisher |

Revision PDAs are append-only. A correction names its predecessor and creates a
new revision. Consumers accept a gate only when its head points to that exact
revision and both report a live `PASS`.

### `pod_compliance`

| Account | PDA seeds | Purpose | Authorized mutation |
|---|---|---|---|
| `ComplianceConfig` | `compliance-config` | Governance, external recovery Squads address, recovery delay and pause | Governance; pending governance must accept; configured recovery address must equal each receipt mint's `PermanentDelegate` |
| `ProviderRecord` | `provider`, provider authority | Registered eligibility issuer/revoker capabilities | Compliance governance |
| `InvestorRecord` | `investor`, opaque investor id | Status, expiry, provider and current wallet; no legal identity | Registered provider within granted capability |
| `WalletBinding` | `wallet-binding`, wallet | One active wallet binding to an opaque investor, or a pending destination bound to an exact recovery order/source/series/expiry | Provider binding; prepare/finalize recovery under compliance governance |
| `SeriesPermission` | `series-permission`, receipt mint, wallet | Series eligibility, accepted terms, cap and expiry | Registered provider |
| `TransferPolicy` | `transfer-policy`, receipt mint | Initial issuer-restricted or later eligible-peer policy; Token-2022 `PermissionedBurn` authority and allowed `Series` burn caller | Compliance governance configures; PDA signs only the governed burn CPI |
| `RecoveryOrder` | `recovery-order`, investor record, order id | Delayed, expiring recovery for one series; records old/new wallets, mint `PermanentDelegate`, snapshotted amount and `Proposed → Prepared → Executed` or `Cancelled` state | External recovery Squads proposes; recovery Squads/governance may cancel while proposed; compliance governance plus replacement wallet prepare and finalize |
| extra-account meta list | `extra-account-metas`, receipt mint | Canonical Token-2022 hook account resolver | Initialized against the transfer policy |

Legal identity, sanctions-screening documents, bank details, and recovery case
documents MUST NOT be placed in these accounts. `opaque_id` and commitments are
non-reversible references to controlled off-chain records.

### `pod_vault`

| Account | PDA seeds | Purpose | Authorized mutation |
|---|---|---|---|
| `ProtocolConfig` | `protocol` | Governance, guardian, compliance and program bindings, `platform_treasury_authority` (the release proposer), pause flags | Governance; guardian can add a pause but cannot remove one |
| `SettlementAssetConfig` | `asset`, settlement mint | Allowed mint, token program and decimals | Protocol governance |
| `MseBeneficiary` | `mse-beneficiary`, entity hash | Compatibility-named registry entry binding the international MSE reference to the US issuer's Squads wallet owner and USDC ATA; V1 requires `rail_kind = SquadsFiatForward` | Governance registers and may suspend; wallet rotation registers a new entity hash; `DirectUsdc` is reserved and rejected in V1 |
| `DealTerms` | `deal_terms`, deal id hash | Locked legal, party, valuation, economic terms and the pinned MSE destination (`mse_wallet_owner`, `mse_usdc_ata`, `mse_rail_kind`) copied from an active registry entry | Governance in `DRAFT`; immutable after opening |
| `DealStateAccount` | `deal_state`, deal id hash | Lifecycle and aggregate accounting; authority of both deal vaults | Program state machine only |
| `Series` | `series`, deal id hash, series index | Receipt mint and issued/burned supply | Program state machine; V1 index is `0` |
| `ReleaseMilestone` | `milestone`, deal id hash, index | Gate, allocation, schedule, risk approval and execution evidence | Governance configures in `DRAFT`; risk schedules; guardian cancels; program executes |
| `InvestorDealPosition` | `position`, deal id hash, opaque investor id | Cap, eligibility, accepted terms and investor accounting | Compliance authority and investor operations |
| `OperationReceipt` | operation-specific prefix, deal, actor/investor, nonce | Idempotency commitment for subscription, refund, repayment or redemption | Created once; matching replay is a no-op, conflict fails |
| `TreasuryMovement` | `treasury_movement`, deal id hash, milestone index | One V1 release evidence chain from USDC treasury receipt through conversion, SWIFT, bank confirmation, and reconciliation | Platform treasury records conversion/SWIFT; governance confirms and reconciles |
| `SettlementSnapshot` | `settlement`, deal id hash | Fixed supply, vault balance and waterfall pools | Created once when settlement conditions hold |

Operation receipt prefixes are `subscription_receipt`, `refund_receipt`,
`repayment_receipt`, and `redemption_receipt`.

## 2. Token accounts and mints

| Asset/account | Owner or authority | Constraint |
|---|---|---|
| Settlement USDC mint | Configured token program | Exact manifest mint, six decimals on devnet |
| Deal subscription vault | `DealStateAccount` PDA | Settlement mint; isolated per deal |
| Deal repayment vault | `DealStateAccount` PDA | Settlement mint; different account from subscription vault |
| Issuer treasury USDC ATA | US issuer Squads vault PDA | Exact locked ATA; sole release destination |
| Compliance escrow USDC ATA | Controlled compliance escrow | Restricted investor payouts only |
| Receipt mint | Token-2022; mint authority is `Series` PDA until close | Required extension set; mint authority revoked at funding close |
| Investor receipt account | Bound investor wallet | Transfer hook policy applies |

The FiatBeneficiary has no protocol token account and no vault authority.

For each receipt mint, the external governed recovery Squads public key is the
Token-2022 `PermanentDelegate`. The `TransferPolicy` PDA is a different address
and is the Token-2022 `PermissionedBurn` authority. Neither authority may be
substituted for the other.

## 3. Authority matrix

Distinct public keys are mandatory even when the same US legal entity employs
the operators.

| Capability | Authority | Threshold / key type | Explicitly cannot |
|---|---|---|---|
| Program upgrade, account migration, protocol incident recovery | Protocol governance Squads | Autonomous 2-of-3 | Publish oracle data, recover an investor receipt balance, or execute a treasury transfer alone |
| Issuer USDC custody and bank execution | US issuer treasury Squads | Separate 2-of-3 | Publish oracle data or act as risk approval |
| Release and bank-confirmation risk approval | Risk Squads/address | Separate from treasury and governance | Move vault funds alone |
| T1/T2/T3 publication | Product-specific AWS KMS publisher keys | Allowlisted per oracle config | Release vault funds |
| Commodity-price publication | Dedicated AWS KMS publisher key | Allowlisted | Release vault funds |
| FX publication | Dedicated AWS KMS publisher key | Allowlisted | Release vault funds |
| Investor credential issue/revoke | Registered compliance provider keys | Capability-scoped | Change deal economics or move funds |
| Receipt recovery proposal and token transfer | External recovery Squads; mint `PermanentDelegate` and `ComplianceConfig.recovery_authority` | Separate governed Squads plus configured delay | Prepare/finalize compliance state, change amount/destination, or authorize `PermissionedBurn` |
| Receipt recovery preparation/finalization | Compliance governance plus replacement wallet | Both sign; source/destination balances verified | Move tokens by CPI or bypass the external permanent delegate |
| Refund/redemption burn | `TransferPolicy` PDA as `PermissionedBurn` authority; configured `Series` PDA burn caller; source owner | All required by the permissioned-burn instruction | Execute a recovery transfer or burn without holder and vault authorization |
| Emergency pause | Guardian | Pause-only | Unpause or withdraw |
| Investor subscription/redemption | Bound investor wallet | Wallet signature plus active permission | Exceed cap, transfer directly under V1 policy, or burn alone |
| Servicer repayment deposit | Configured US servicer authority/Squads | Treasury workflow approval | Treat bank evidence as on-chain repayment |

The same key MUST NOT fill any pair of protocol governance, issuer treasury,
risk, guardian, oracle-publisher, external receipt-recovery, or compliance
governance roles. The `TransferPolicy` PDA is derived by the compliance program
and is never configured as the mint `PermanentDelegate`.

## 4. Receipt recovery transaction boundary

Recovery is a three-transaction sequence after proposal and delay:

| Phase | Signers | State and balance effect |
|---|---|---|
| Prepare: `pod_compliance.prepare_recovery` | Compliance governance and replacement wallet | Creates pending destination binding/permission; snapshots complete source balance; no token movement |
| Transfer: Token-2022 `TransferChecked` with hook accounts | External recovery Squads `PermanentDelegate` | Moves exactly the snapshot from canonical old ATA to canonical new ATA; transfer hook validates the prepared order and post-transfer balances |
| Finalize: `pod_compliance.execute_recovery` | Compliance governance and replacement wallet | Re-verifies source `0` and destination `snapshot`, deactivates old binding/permission, activates replacement |

The checked transfer resolves the hook validation accounts in canonical order:
compliance config, transfer policy, source binding, destination binding, source
permission, destination permission, source investor, destination investor,
extra-account-meta list, and `pod_compliance` hook program. Clients use
`build_recovery_transfer_checked_instruction` from
[`pod-compliance`](../../rwa/programs/pod-compliance/) rather than constructing
this list ad hoc.

The transfer is submitted directly to Token-2022, not as a CPI from
`pod_compliance`. This prevents the forbidden indirect re-entry
`pod_compliance → Token-2022 → pod_compliance` because the compliance program is
also the mint's transfer hook. Until finalize succeeds, the old binding remains
canonical and the replacement binding remains pending.

## 5. Schema and successor rules

Every financial account begins with `schema_version`, stores its PDA bump,
reserves space for compatible additions, and is decoded by generated clients
for that exact schema. The following rules apply:

1. Immutable revision and terms accounts are never rewritten for a new schema.
2. A compatible additive change may consume reserved bytes only after a
   released decoder and migration rehearsal.
3. A semantic or size-incompatible change creates a successor PDA/account and
   an auditable old-to-new mapping.
4. Active balances move only through a dedicated migration instruction that
   proves source, successor, mint, amount, and authority.
5. Indexers retain both records and mark one canonical; they never delete the
   predecessor.
6. Deployment manifests pin binary and IDL hashes so clients cannot silently
   decode an account with the wrong schema.

See [the migration runbook](MIGRATION_AND_UPGRADE_RUNBOOK.md) for execution
controls.
