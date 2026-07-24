# Issuer flowmap intake

## 1. Request

Use this copy-ready request with the team:

> Please provide the RWA issuer flowmap using the checked-in V1 template. It
> should confirm the US C-Corporation's issuer, treasury, and servicer roles;
> Squads treasury structure; conversion provider and issuer bank path; wire
> approval matrix; beneficiary template; fee and FX treatment; exception
> handling; and the complete reverse repayment route. Please use opaque
> references only—do not include account numbers, credentials, personal data,
> private keys, or full UETRs.

Complete
[`rwa/fixtures/issuer-flowmap.template.yaml`](../../rwa/fixtures/issuer-flowmap.template.yaml)
and return it through the approved project document channel.

## 2. Required content

### Legal and operating roles

- US issuer legal entity reference, jurisdiction, and state of incorporation;
- confirmation that the US entity is the token `Issuer`;
- confirmation that it owns/controls the on-chain `Treasury`;
- confirmation that it is the V1 `Servicer`;
- international `FiatBeneficiary` opaque entity reference and jurisdiction;
- confirmation that the FiatBeneficiary receives USD at its bank, not USDC;
- financing-contract and governing-document references; and
- responsible business roles, expressed as role names rather than personal
  names.

### Treasury and custody

- issuer Squads multisig reference, threshold, member-role matrix, vault index,
  vault PDA, and USDC ATA;
- separate protocol governance and risk Squads references;
- separate external receipt-recovery Squads reference, configured as both
  `ComplianceConfig.recovery_authority` and each receipt mint's Token-2022
  `PermanentDelegate`;
- confirmation that the `pod_compliance` `TransferPolicy` PDA—not the recovery
  Squads—is the distinct Token-2022 `PermissionedBurn` authority;
- Circle USDC mint, token program, decimals, and supported cluster;
- conversion provider legal reference, supported source/destination accounts,
  operating hours, cutoffs, settlement timing, and confirmation artifacts;
- issuer bank reference and sending-bank evidence type; and
- custody and reconciliation owner by role.

### Outbound SWIFT

- proposer, treasury approver, risk approver, executor, independent reviewer,
  and reconciler roles;
- approved FiatBeneficiary jurisdictions and currencies;
- beneficiary-template identifier and bank-route commitment method;
- payment-purpose and required-reference fields;
- UETR, value date, provider receipt, sending confirmation, and receiving-bank
  confirmation availability;
- provider fee, FX spread, bank fee, intermediary deduction, and return-fee
  treatment;
- failed, rejected, delayed, recalled, and returned-wire workflow; and
- expected service levels and escalation roles.

### Reverse repayment

- authorized payer types: FiatBeneficiary, buyer, or servicer;
- allowed issuer receiving accounts and incoming-bank evidence;
- payer-to-deal matching rule and required remittance reference;
- USD-to-USDC provider and fee/rate treatment;
- issuer treasury USDC source and exact deal repayment-vault destination;
- confirmation and finality requirements;
- surplus, shortfall, returned receipt, and unmatched payment handling; and
- reconciler and approval roles.

### Evidence and records

- encrypted system of record for each full document;
- retention period and legal-hold policy;
- KMS key owner, access roles, audit-log source, and break-glass procedure;
- canonical commitment input and normalization rule;
- timezone for operational timestamps and UTC storage requirement; and
- source-system identifiers that are safe to expose as commitments.

## 3. Prohibited content

The shared flowmap MUST NOT contain:

- bank account, routing, IBAN, or SWIFT/BIC values;
- full UETRs;
- portal URLs containing tenant or secret identifiers;
- passwords, API credentials, bearer tokens, certificates, seeds, private
  keys, recovery phrases, or KMS key material;
- investor or beneficiary personal data;
- identity, bank, sanctions, or wire documents; or
- unredacted screenshots.

The secure system stores those values. The flowmap stores opaque references,
role names, commitment methods, and approved process structure.

## 4. Mapping to implementation

| Flowmap item | V1 destination |
|---|---|
| Issuer legal reference | `DealTerms.issuer_entity_hash` / `IssuerV1` |
| Servicer legal reference | `DealTerms.servicer_entity_hash` / `ServicerV1` |
| FiatBeneficiary reference | `DealTerms.beneficiary_entity_hash` / `FiatBeneficiaryV1` |
| Financing contract | `DealTerms.source_contract_hash` |
| Document bundle | `DealTerms.document_bundle_hash` |
| Approved beneficiary route | `DealTerms.bank_route_hash` |
| Issuer Squads vault PDA | `DealTerms.issuer_treasury_owner` |
| Issuer USDC ATA | `DealTerms.issuer_treasury_ata` |
| Risk signer | `DealTerms.risk_authority` |
| Receipt recovery Squads | `ComplianceConfig.recovery_authority`, receipt mint `PermanentDelegate`, and signed deployment manifest |
| Governed burn authority | Receipt mint `PermissionedBurn` authority set to the `TransferPolicy` PDA |
| Conversion provider | `TreasuryMovement.conversion_provider_hash` |
| Provider/bank fees and FX | `TreasuryMovement` amount/rate/fee fields |
| UETR and confirmation | committed evidence in `TreasuryMovement`; full source in encrypted AWS storage |
| Reverse route | `FiatRepaymentV1` plus `pod_vault.deposit_repayment` |
| Role-to-operation mapping | Cognito groups and Solana authority manifest |

## 5. Intake validation

The architecture owner and treasury/risk reviewers jointly reject the flowmap
unless:

- issuer, treasury, servicer, and FiatBeneficiary are unambiguous and distinct;
- all on-chain addresses can be independently derived and verified;
- the wire approval matrix enforces treasury/risk separation and independent
  confirmation review;
- gross, net, FX, provider fee, bank fee, and return fee treatment is explicit;
- failed and returned payments have a blocking path;
- the reverse fiat-to-USDC-to-repayment-vault route is complete;
- evidence locations, commitments, retention, and access roles are defined;
- no prohibited secret or personal data is present; and
- every required field maps to an immutable deal term, signed deployment
  manifest, controlled runtime configuration, or encrypted evidence record.

After approval, hash the reviewed flowmap, place the commitment in the deal's
document bundle, and retain the versioned source in the approved document
system. A changed treasury, provider, bank, beneficiary route, fee policy, or
repayment path creates a new reviewed version and the migration/new-deal
decision required by [the upgrade runbook](MIGRATION_AND_UPGRADE_RUNBOOK.md).
