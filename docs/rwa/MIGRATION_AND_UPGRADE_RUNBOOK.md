# Migration, upgrade, and authority-rotation runbook

## 1. Release policy

All three programs are governed by an autonomous 2-of-3 protocol Squads.
Deployer workstations and CI roles may build and propose; they are not
long-lived upgrade authorities.

A release package contains:

- source commit;
- reproducible toolchain versions;
- program binaries and SHA-256 hashes;
- IDLs and SHA-256 hashes;
- generated client bindings;
- account schema and migration description;
- signed deployment manifest;
- test, security, and accounting reconciliation results; and
- the exact Squads proposal instructions.

Devnet is the mandatory first execution of the production architecture. A
mainnet proposal is derived from the devnet-approved source and artifacts, with
only the signed environment manifest and transaction values changed.

## 2. Change classification

| Class | Example | Required path |
|---|---|---|
| Code-only, schema-compatible | Validation or event fix with identical account decoding | Program upgrade plus full regression |
| Additive within reserved bytes | New optional field with unchanged prior semantics | Program upgrade, explicit account migration, new generated bindings |
| New successor account | Size, seed, ownership, or semantic change | New schema/PDA, old-to-new mapping, funded migration rehearsal |
| Immutable-term change | Treasury route, beneficiary, coupon, waterfall, mint or settlement asset | New deal, or purpose-built governed successor route; never an in-place edit |
| Authority rotation | Governance, treasury, risk, guardian, publisher, compliance, recovery | Role-specific procedure in section 6 |
| Emergency security fix | Active exploit or compromised authority | Pause, preserve evidence, expedited audited proposal, forward recovery |

Reserved bytes are not permission to change financial meaning. A changed
meaning always receives a new schema version and migration path.

## 3. Pre-upgrade checks

The release coordinator records a change window and verifies:

1. The source tree and lockfiles are clean at the approved commit.
2. Rust, Anchor, Solana, Node, and package-manager versions match
   [`rwa/Anchor.toml`](../../rwa/Anchor.toml) and the checked-in toolchain.
3. Rust workspace tests, TypeScript client tests/type checks, application
   build, infrastructure tests, and CDK synthesis pass.
4. Both pilot deals replay the required happy, cancellation, default,
   gate-correction, failed/returned-wire, recovery, and restricted-claim paths.
5. For every funded deal:
   - settlement mint and token program match the manifest;
   - subscription and repayment vault balances match account state;
   - receipt mint supply matches series issued less burned supply;
   - every release has one movement;
   - no unexplained bank, conversion, token, fee, or evidence difference
     remains.
6. The new IDL decodes all retained account versions.
7. The migration is rehearsed against a copy of funded devnet state and proves
   conservation at every base unit.
8. Squads members independently verify program IDs, buffer/program-data
   addresses, binary hashes, migration accounts, and manifest.
9. A known-good forward-recovery artifact is ready.
10. Operations, treasury, risk, compliance, and incident owners acknowledge
    the change window.

## 4. Standard program upgrade

1. Guardian pauses affected subscriptions, releases, and transfers. Treasury
   stops provider and bank execution at a proven state boundary.
2. Capture a finalized pre-upgrade snapshot:
   program data, configs, all active deal accounts, mints, token accounts,
   movement status, balances, slots, and hashes.
3. Build in the reproducible environment. Two reviewers independently compute
   binary and IDL hashes.
4. Upload the program buffer and create the 2-of-3 Squads proposal containing
   the exact upgrade instruction. Do not add unrelated instructions.
5. Each signer compares the proposal with the approved release package.
6. Execute and wait for finality.
7. Verify the program-data slot and binary hash, then exercise read-only
   decoding before any migration instruction.
8. If account migration is required, follow section 5 in bounded batches.
9. Deploy generated clients and indexer decoders. Rebuild projections from
   finalized chain accounts/events.
10. Run a zero-value/read-only smoke sequence and one controlled end-to-end
    devnet flow.
11. Reconcile all snapshots and re-sign the deployment manifest with actual
    program, IDL, authority, source, and binary hashes.
12. Governance removes pauses only after independent risk review.

No bank/provider action resumes solely because the binary upgrade finalized.
The corresponding account, client, manifest, and reconciliation checks must
also pass.

## 5. Successor account migration

### Design requirements

A migration instruction MUST:

- accept the canonical predecessor and canonical successor accounts;
- verify predecessor owner, discriminator, schema, PDA and bump;
- verify successor program, schema, PDA, deal/mint identity, and zeroed initial
  financial state;
- require protocol governance and any role whose locked route changes;
- copy immutable commitments without reinterpretation;
- transfer tokens through checked token instructions only;
- record pre/post amounts, supply, predecessor, successor and migration
  commitment;
- mark one canonical successor without deleting or closing the predecessor; and
- be idempotent or reject a conflicting replay.

### Execution

1. Pause the affected paths and freeze off-chain movement creation.
2. Record predecessor account bytes, balances, supply, status, and finalized
   slot.
3. Create successor accounts with the released schema and canonical PDAs.
4. Migrate one deal at a time. Keep the batch small enough for exact manual
   reconciliation.
5. Verify:

   ```text
   predecessor tokens before
   = predecessor tokens after + successor tokens after

   total receipt supply before = total receipt supply after
   investor principal before = investor principal after
   released + held + refunded before = released + held + refunded after
   repayment pool before = repayment pool after
   ```

6. Write and verify the predecessor-to-successor mapping and migration event.
7. Update generated clients and the DynamoDB canonical pointer; preserve the
   predecessor record.
8. Run the deal's next allowed state transition on devnet.
9. Continue only after the prior deal reconciles exactly.

### Rollback

- Before any account migration, governance may reinstall the prior known-good
  binary if it can decode all current accounts.
- After a successor account has received state or funds, do not downgrade to a
  decoder that cannot understand it. Pause and deploy a forward fix.
- Never move tokens back through an operator wallet, delete a predecessor, or
  edit a movement/evidence record to make the rollback appear clean.
- A failed migration remains paused until the pre/post accounting equality and
  canonical account choice are independently resolved.

## 6. Authority rotation

### Protocol upgrade governance

1. Create and verify the replacement 2-of-3 Squads.
2. Submit a proposal from the existing Squads to transfer upgrade authority to
   the exact replacement.
3. Verify program-data authority after finality for all three programs.
4. Update, sign, and distribute the deployment manifest.
5. Remove obsolete signing access and monitor for use of the old address.

### Oracle governance and publishers

- Use `propose_governance`; the pending governance accepts on-chain before the
  old authority is retired.
- For a publisher key, register the replacement first, publish and verify one
  non-financial revision, then disable the old key.
- T1, T2, T3, commodity, and FX keys remain purpose-specific. A rotation does
  not consolidate them.

### Compliance governance, providers, and recovery

- Use the compliance proposal/acceptance flow for governance.
- Register a replacement provider key with minimum capabilities, verify a
  credential lifecycle, then disable the old provider.
- The receipt recovery authority is an external governed Squads address and
  MUST equal both `ComplianceConfig.recovery_authority` and every affected
  receipt mint's Token-2022 `PermanentDelegate`. It is not the
  `TransferPolicy` PDA used as `PermissionedBurn` authority.
- To rotate it, pause receipt transfers, finish or cancel all recovery orders,
  verify no order remains `Prepared`, update the compliance configuration and
  use Token-2022 `SetAuthority(PermanentDelegate)` under the old recovery
  Squads, then verify both values equal the replacement before unpausing.
  Update every affected mint and the signed deployment manifest.
- Test the replacement with a delayed, non-production-value recovery that uses
  `prepare_recovery`, a standalone permanent-delegate Token-2022
  `TransferChecked` with hook accounts, and `execute_recovery` finalization.
  Preparation/finalization must not CPI into Token-2022.
- Existing recovery orders retain their original delay and evidence; do not
  shorten or recreate them to accelerate rotation.

### Issuer treasury

1. Stop releases, conversions, SWIFT payments, and repayment deposits.
2. Create and verify a replacement 2-of-3 issuer Squads and its USDC ATA.
3. Screen and approve the replacement route; produce a route commitment.
4. For new deals, lock the replacement route at creation.
5. For an active deal, use a purpose-built successor route migration approved
   by protocol governance, treasury, and risk. Preserve the old route and
   effective slot in the audit record.
6. Transfer custody only through approved Squads instructions and reconcile
   every base unit.
7. Update the signed manifest and resume only after a controlled deposit and
   withdrawal-path verification.

### Risk and guardian

Risk and guardian addresses in active immutable configurations rotate through a
versioned successor configuration/deal mapping. Guardian remains pause-only.
The old role is retired only after the new address is reflected in the signed
manifest and exercised in a non-financial devnet action.

## 7. Post-change evidence

The release coordinator retains:

- approved Squads proposal and execution signatures;
- pre/post finalized slots and account hashes;
- binary, IDL, client and manifest hashes;
- migration events and predecessor/successor mappings;
- pre/post token, supply and accounting reconciliation;
- authority and KMS key inventory;
- devnet replay results; and
- risk sign-off to unpause.

The acceptance evidence package is complete only when
[ACCEPTANCE_TRACEABILITY.md](ACCEPTANCE_TRACEABILITY.md) has a result and
artifact reference for every criterion.
