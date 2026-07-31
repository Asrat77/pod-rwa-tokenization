# RWA V1 Devnet structure review

Meeting date: 1 August 2026

## Status in one sentence

The V1 issuer lifecycle is proven against compiled programs on a local
validator, but the protocol is not yet deployed or configured on Solana Devnet
and the AWS staging account is not reachable through the current CLI profile.

## Evidence snapshot

- The local RPC tracers recorded 17 registry assertions and 40 complete
  lifecycle assertions. The broader recorded test package contains 169 passing
  RPC, Rust, TypeScript, indexer, and infrastructure checks.
- A 31 July Devnet `getMultipleAccounts` request returned `null` for all three
  program addresses in `rwa/deployments/devnet.json`.
- The readiness check also found that the configured Devnet genesis hash was
  truncated. The manifest, client validation, infrastructure default, and tests
  now use the full cluster hash returned by `getGenesisHash`.
- The Devnet manifest has no protocol-governance, issuer-treasury, risk, or
  guardian authority, and has no source commit, binary/IDL hashes, signer, or
  signature.
- The current `pod` AWS CLI profile resolves to account `412906648469`. That
  account has neither `Turmi-dev-Foundation` nor `CDKToolkit` in `us-east-1`.
  Repository deployment records reference a different staging account and the
  `turmi-dev` profile.
- The RWA indexer implementation exists under
  `infrastructure/lambdas/rwa-indexer`, but the CDK stack does not create or
  schedule the indexer Lambda.

Run the current network check with:

```sh
cd rwa
npm run check:devnet
```

## Architecture comparison

| Layer | Implemented structure | Status against proposed structure | Required work |
|---|---|---|---|
| Ground-truth capture | The Oracle AWS stack accepts farm geometry and computes T1 plow, T2 health, and T3 yield from satellite imagery. | Partial. Satellite processing exists; a ground-sensor observation contract and ingestion path do not. | Decide whether ground sensors are a V1 input. If yes, define signed observation, device/provenance, time, asset, evidence, and anti-replay fields. |
| Oracle attestation | `pod_oracle` publishes append-only T1/T2/T3 revisions, valuations, and deal-gate revisions with evidence, policy, engine, time, and content commitments. | Aligned at the on-chain boundary. | Deploy the program and connect a controlled AWS publisher/relayer that transforms finalized Oracle results into signed revisions. |
| On-chain proof | Attestation and deal-gate heads point to immutable revisions; corrections create successors. | Aligned locally, absent on Devnet. | Deploy, publish one real T1/T2/T3 chain, enable the indexer, and expose Explorer/account links. |
| Tranche release | `pod_vault` schedules ordered releases with treasury+risk approval, exact live gate revision, delay, expiry, fixed destination, and a permissionless execution transaction. Failed or stale gates block release. | The control model aligns. “Automatic” still requires an executor/keeper transaction. | Decide the executor service and funding model; deploy it after the programs and authorities exist. |
| Issuance | `DealTerms` separates issuer, servicer, beneficiary, asset, contract, and document commitments. Receipt supply is a pro-rata cash-flow claim, not title to a farm or crop. | Structurally compatible, but current documentation names the US C-Corporation as issuer rather than a bankruptcy-remote SPV. | Confirm whether `issuer_entity_hash` is the SPV and `servicer_entity_hash` is the US C-Corporation. Add a sponsor field only if the legal model needs a fourth entity role. |
| Settlement | Isolated USDC vaults, fixed coupon basis points, repayment deposit, waterfall, default recovery, redemption, and restricted redemption are implemented. | Partial wording match. The program calculates a fixed coupon target at settlement; it does not accrue coupon by elapsed time or payment period. | Confirm whether “coupon accrual” means the current fixed maturity coupon or a time/period-based accrual ledger. |
| Access | `pod_compliance` has provider records, opaque investors, wallet binding, series permission, expiry/status controls, Token-2022 transfer hook, `IssuerRestricted`, `EligiblePeer`, governed burn, and wallet recovery. | The whitelist and transfer-control structure aligns. External KYC/AML screening is not integrated. | Connect an approved provider to issue/revoke credentials and seed staging investors. |

## What is already reusable

- The three-program authority split matches Oracle, access, and settlement
  layers without requiring a rewrite.
- `issuer_entity_hash` can represent an SPV without changing account layout.
  The legal document and source-contract hashes already bind the note terms and
  collateral agreement.
- `EligiblePeer` already provides the secondary-transfer mode described by the
  whitelisted registry; V1 can remain `IssuerRestricted` until approvals allow
  secondary transfers.
- `execute_release` is permissionless after the approved gate, delay, expiry,
  sequence, vault, mint, and destination checks pass, so an AWS keeper can
  automate execution without receiving withdrawal authority.

## Decisions for the 5–10 minute review

1. **Issuer:** SPV as `Issuer` and US C-Corporation as `Servicer`, or the US
   C-Corporation as both?
2. **Coupon:** fixed coupon paid at settlement, or time/period-based accrual?
3. **Ground sensors:** required in V1, or an additional evidence source after
   the satellite path is staged?
4. **Release automation:** operations-triggered execution or an AWS keeper
   submitting the permissionless transaction?
5. **Rail:** stage only `SQUADS_FIAT_FORWARD`, or keep the implemented
   `DIRECT_USDC` rail available?
6. **AWS target:** which account/profile should host `Turmi-dev-Foundation` and
   its CDK bootstrap roles?

## Staging sequence after those decisions

1. Obtain the correct AWS account role/profile and verify `CDKToolkit`.
2. Deploy the Foundation AppSync/Cognito/RWA API stack and wire the indexer.
3. Create the four authority classes and issuer Squads treasury.
4. Build each SBF program separately, deploy all three to Devnet, verify them,
   and sign the completed manifest.
5. Register Circle Devnet USDC, the selected MSE rail, and both pilot deals.
6. Publish one T1/T2/T3 attestation chain and its deal-gate revisions.
7. Run subscription, four releases, repayment, settlement, and redemption
   through the deployed applications and retain every signature/account hash.

## Suggested opening

“The full V1 happy path is proven locally against the compiled Solana programs.
The current Devnet file is still an unsigned target manifest: none of the three
programs are deployed and its authorities are unset. The architecture already
maps cleanly to the Oracle, access, and settlement layers. The decisions we
need today are SPV versus C-Corp issuer semantics, fixed versus accrued coupon,
whether ground sensors are in V1, and which AWS account receives staging.”
