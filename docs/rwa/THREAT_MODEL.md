# RWA V1 threat model

## 1. Security objectives

V1 protects five assets:

1. USDC in deal subscription, issuer treasury, and repayment accounts;
2. receipt supply and each investor's enforceable pro-rata claim;
3. immutable deal, gate, valuation, and settlement records;
4. beneficiary, identity, bank, and compliance evidence; and
5. upgrade, treasury, risk, oracle, compliance, guardian, and wallet keys.

The primary safety properties are conservation of token base units, separation
of parties and duties, exact binding of evidence to an economic event, and
recoverability without granting any single actor unilateral withdrawal power.

## 2. Trust boundaries

| Boundary | Trusted fact | Verification |
|---|---|---|
| Wallet → application | Investor controls the presented wallet | Expiring domain/identity/cluster/program-scoped signed challenge |
| Application → Solana | Submitted instruction targets the intended deployment | Signed manifest and genesis/program verification |
| Oracle publisher → `pod_oracle` | Publisher is registered for revision publication | Publisher allowlist, append-only revisions, policy/content hashes |
| `pod_oracle` → `pod_vault` | Gate is current, exact, unexpired, and `PASS` | Canonical head/revision derivation and full gate-field validation |
| Investor → token programs | Mint, account owner, decimals and amount are exact | Checked Token/Token-2022 transfers |
| Vault → issuer treasury | USDC reaches only the locked issuer ATA | Deal terms plus exact ATA/owner/mint validation |
| Treasury → provider/bank | Manual action matches approved movement | Dual approval, encrypted evidence, commitments, independent review |
| Bank → AWS mirror | Confirmation belongs to the recorded movement | UETR/value-date/beneficiary/amount matching |
| DynamoDB/indexer → user interface | Projection reflects finalized chain state | Slot/signature/account hash, reconciliation timestamp, chain remains authoritative |
| Governance → upgrade | Authorized binary and schema are deployed | 2-of-3 Squads, reproducible build, binary/IDL/manifest hashes |

## 3. Threats and controls

| Threat | Preventive controls | Detection / response |
|---|---|---|
| Counterfeit USDC or token-program substitution | Settlement asset allowlist; exact mint, owner, token program and decimals stored in `DealTerms`; checked transfers | Transaction/account reconciliation; pause and reject manifest mismatch |
| Treasury ATA substitution | Exact issuer Squads owner and ATA locked before opening; no operator-entered release destination | Compare finalized destination to deal terms; incident if mismatch |
| Issuer/FiatBeneficiary conflation | Distinct entity hashes and client validation; beneficiary has no token account | Configuration validation and acceptance test |
| Oracle fabricates a release | Publisher can only append oracle records; separate risk signer and delay; vault has fixed destination | Alert on authority collision or release without risk approval |
| Stale, failed, or corrected gate replay | Canonical head and exact revision/hash/content/decision/expiry checks | Gate-correction and expiry tests; cancel queued release |
| Oracle or RPC reorg/finality error | Financial workflow records finalized slot and signature; indexer never treats processed state as final | Reconcile account hash at finalized commitment; quarantine divergence |
| Unauthorized direct receipt transfer | Token-2022 hook; active source and destination binding/permission; initial `IssuerRestricted` mode | Transfer failure telemetry and policy-account monitoring |
| Holder destroys receipt claim | Separate `TransferPolicy` PDA is the Token-2022 `PermissionedBurn` authority; configured `Series` burn caller and holder must also sign | Supply reconciliation; pause on unexpected mint supply change |
| Wallet takeover or lost key | Cognito-to-wallet binding, series permission, delayed external recovery-Squads proposal, prepared destination, full-balance transfer and verified finalization | Compliance suspension; recovery evidence and post-recovery review |
| Permanent delegate abuses recovery power | External recovery Squads is the mint `PermanentDelegate`, but the hook permits only an unexpired prepared order, canonical ATAs, same investor/series and complete snapshotted balance | Alert on every delegate transfer; reject unprepared, partial, substituted or expired transfers; finalize only after exact balance proof |
| Burn and recovery authorities are conflated | Mint `PermanentDelegate` is an external Squads signer; mint `PermissionedBurn` authority is the distinct `TransferPolicy` PDA | Manifest/extension inspection and authority-separation test |
| Compliance recovery causes indirect re-entry | Prepare and finalize perform no Token-2022 CPI; external permanent delegate submits standalone `TransferChecked` with hook accounts between them | Static instruction review plus integration test of prepare → transfer hook → finalize |
| Sanctioned/restricted investor loses claim | Status blocks ordinary actions; restricted redemption sends payout to compliance escrow | Escrow and position reconciliation |
| Subscription/redeem replay | PDA idempotency receipt binds nonce, operation, amount and payload hash | Conflicting replay fails; duplicate receipt alert |
| Cap or arithmetic overflow | Checked integer arithmetic, basis-point bounds, atomic transfer/mint, hard and investor caps | Property/fuzz tests and supply/vault invariants |
| Rounding leaks value | Floor pro-rata calculation; fixed snapshot; explicit dust | Settlement reconciliation includes claimed pool and dust |
| Double or excess release | Ordered milestones, allocation totals, total-released versus deployable check | Movement and vault reconciliation; pause releases |
| Previous wire absent or returned | Next milestone checks prior movement status | `FAILED`/`RETURNED` exception queue blocks release |
| Fabricated conversion/SWIFT evidence | Encrypted originals, domain-separated commitments, dual approval, independent confirmation reviewer | Recompute commitments and reconcile UETR/amount/beneficiary |
| Hidden fee or FX loss | Gross, net, provider fee, bank fee, and scaled rate are explicit | Reconciliation equations fail on unexplained difference |
| Bank evidence counted as repayment | Settlement uses real repayment-vault USDC; bank workflow is separate | Compare acquired USDC with finalized deposit |
| Evidence or PII disclosure | Opaque on-chain references; encrypted AWS storage; no full UETR or bank details in logs/shared files | Access logs, classification alerts, credential rotation and incident response |
| KMS, provider, bank, or RPC outage | Idempotent state machine; no implicit success; multiple RPC reads | Remain at last proven state, retry safely, escalate overdue movement |
| Compromised operator role | Separate Cognito groups and Solana keys; dual control | Audit role use, revoke session/key, pause affected path |
| Guardian abuse | Guardian can only add pauses and cannot withdraw or unpause | Governance review and guardian rotation |
| Governance/upgrade compromise | Autonomous 2-of-3, hash-pinned build, migration rehearsal, signed manifest | Emergency pause, reject unknown binary/IDL, execute incident upgrade procedure |
| Indexer overwrites chain truth | DynamoDB is explicitly non-authoritative; chain reference included in records | Rebuild projection from finalized accounts/events |
| Denial-of-service or account spam | Canonical PDAs, bounded publishers/milestones, payer funds account creation | Rate limits, cost alerts, operations queue prioritization |

## 4. Required abuse tests

Every release candidate exercises:

- wrong mint, token program, decimals, vault owner, treasury ATA, and receipt
  mint;
- issuer and FiatBeneficiary using the same opaque reference;
- expired, `FAIL`, non-latest, wrong-deal, wrong-milestone, wrong-policy, and
  corrected gate revisions;
- oracle publisher attempting release without risk and treasury signatures;
- duplicate nonce with same and conflicting payloads;
- transfer between two investors under `IssuerRestricted`;
- transfer to an inactive, expired, revoked, suspended, or sanctions-held
  wallet under `EligiblePeer`;
- direct holder burn without the `TransferPolicy` PDA, configured `Series` burn
  caller, and source-owner signatures;
- recovery delegate transfer without a prepared order, before delay, after
  expiry, for a different series/investor/ATA, for a partial amount, or without
  all resolved hook accounts;
- recovery finalization before transfer, after a partial transfer, with a
  non-zero source balance, or with destination balance different from the
  prepared snapshot;
- any recovery path that attempts
  `pod_compliance → Token-2022 → pod_compliance` indirect re-entry;
- incomplete receipt redemption;
- release above available deployable capital and out-of-order milestone;
- missing, failed, returned, or unreconciled previous wire;
- fee/rate/amount mismatch on conversion and SWIFT;
- repayment from wrong source or to wrong vault;
- bank evidence without USDC deposit;
- underfunded refund, shortfall/default, restricted claim, recovery, and full
  repayment;
- KMS denial, provider timeout, RPC timeout, and indexer lag; and
- upgrade, authority rotation, and funded successor migration.

Each failure must leave token balances and financial account state unchanged
unless the state machine explicitly records a terminal exception.

## 5. Monitoring signals

Page the responsible on-call role for:

- any unknown program binary, IDL, genesis hash, or authority;
- vault balance below accounted balance;
- receipt mint supply different from series accounting;
- release transaction to a destination other than the locked issuer ATA;
- gate head/revision mismatch after scheduling;
- movement stuck after `USDC_RELEASED`, `CONVERTED`, or `SWIFT_SENT`;
- returned wire after a later tranche was queued;
- repayment conversion without matching vault deposit;
- unexpected transfer-hook or burn success;
- a permanent-delegate receipt transfer that has no matching prepared recovery
  order, or a prepared recovery that remains unfinalized;
- repeated signature, nonce, or commitment conflict;
- evidence-store access outside the expected role/session; or
- pause or upgrade instruction.

## 6. Incident priorities

1. **Contain.** Guardian pauses subscriptions/releases/transfers as applicable;
   treasury stops provider and bank actions. Guardian never withdraws funds.
2. **Preserve.** Record finalized slots, signatures, account data, provider and
   bank evidence, CloudTrail, KMS, Cognito, and application logs.
3. **Classify.** Determine affected deal, account, authority, evidence, and
   maximum token/fiat exposure. Do not collapse issuer and beneficiary impacts
   into one party.
4. **Reconcile.** Establish actual token balances and actual bank/provider
   positions before changing any status.
5. **Recover.** Governance rotates keys, performs the rehearsed program or
   account migration, and creates successor records; never rewrite immutable
   evidence.
6. **Resume.** Governance unpauses only after independent review confirms
   invariants and the deployment manifest is re-signed.

Migration and key-rotation procedures are in
[MIGRATION_AND_UPGRADE_RUNBOOK.md](MIGRATION_AND_UPGRADE_RUNBOOK.md).
