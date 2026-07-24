# V1 acceptance traceability

This matrix is the release checklist. For each release, record `PASS` or
`FAIL`, the test/run identifier, finalized signatures or account hashes where
applicable, and the reviewer. A criterion cannot pass from a UI screenshot
alone.

| ID | Acceptance criterion | Primary implementation and verification |
|---|---|---|
| AC-01 | The US C-Corporation issues every offering; each deal pins exactly one active MSE beneficiary as its release destination. | `DealTerms.issuer_entity_hash`, `mse_wallet_owner`, `mse_usdc_ata`, `mse_rail_kind` copied from an `Active` `MseBeneficiary` in [`pod-vault`](../../rwa/programs/pod-vault/); `MseDestinationV1` validation in [`domain.ts`](../../rwa/client/src/domain.ts); execute a release and verify finalized destination. |
| AC-02 | No code treats the US issuer and the MSE beneficiary as the same entity. | `issuer_entity_hash != mse_beneficiary.entity_hash` at deal creation; `validateIssuerBeneficiarySeparation`; distinct GraphQL fields; configuration test rejects equal opaque references. |
| AC-03 | Every release reconciles to exactly one movement per rail. | Canonical `TreasuryMovement` PDA by deal and milestone carrying `rail_kind`; the Squads rail records conversion/SWIFT/bank evidence, the direct-USDC rail reconciles from `USDC_RELEASED`; `FiatDisbursementV1` state machine in [`treasury.ts`](../../rwa/client/src/treasury.ts) with a direct-rail test. |
| AC-04 | A later tranche cannot release when prior-wire evidence is missing, failed, returned, or unreconciled. | `schedule_release` validates the preceding movement; `assertDisbursementAllowsNextRelease`; tests cover absent and every blocking status. |
| AC-05 | Bank/provider fees are explicit and cannot silently reduce accounting. | Gross, net, rate, provider-fee and bank-fee fields in `TreasuryMovement`; client equations in `treasury.ts`; negative tests change each component by one minor unit. |
| AC-06 | Reverse fiat repayment reconciles to actual USDC in the isolated repayment vault. | `FiatRepaymentV1` reverse state machine; checked `deposit_repayment`; finalized source/destination/mint/amount comparison; settlement reads repayment-vault balance. |
| AC-07 | Receipt supply equals accepted, unrefunded investor principal. | Atomic `subscribe`, series issued/burned accounting, supply check at `finalize_subscription`, full-balance refund; compare mint supply, positions, and deal aggregates after every scenario. |
| AC-08 | Released capital never exceeds funded deployable capital. | Milestone basis-point sum must equal 10,000; ordered amount calculation; final milestone uses remaining deployable amount; invariant/property test across contribution and allocation ranges. |
| AC-09 | An oracle publisher cannot independently release money. | Separate publisher, risk, treasury, governance and guardian keys; gate publication has no vault CPI; schedule requires risk and treasury; execute has fixed vault destination. Attempt all release instructions with publisher alone. |
| AC-10 | Counterfeit mint, recipient ATA, bank route, gate, or evidence commitment is rejected. | Settlement asset and token-account validation; locked treasury ATA/route hashes; exact oracle head/revision validation; canonical evidence commitments. Substitute each field independently. |
| AC-11 | Direct receipt transfer and direct holder burn fail under the initial policy. | Token-2022 transfer hook in [`pod-compliance`](../../rwa/programs/pod-compliance/) with `IssuerRestricted`; `TransferPolicy` PDA is the separate `PermissionedBurn` authority and requires the configured `Series` burn caller plus source owner; test wallet-to-wallet transfer and plain burn. |
| AC-12 | Refund, default, recovery, restricted claim, and full repayment conserve every token base unit. | Checked token operations and floor pro-rata arithmetic in [`pod-rwa-common`](../../rwa/crates/pod-rwa-common/); snapshot pool/claimed/escrow/dust accounting; recovery verifies complete receipt-balance transfer; pre/post token-ledger equality in property and end-to-end tests. |
| AC-13 | Both pilot farms complete happy, cancelled, and defaulted flows without an unexplained mismatch. | Run both entries in [`pilot-deals-v1.json`](../../rwa/fixtures/pilot-deals-v1.json); attach token-account, movement, bank/provider, evidence, and settlement reconciliation for each outcome. |
| AC-14 | Subscription limits and pilot economics are exact. | Fixture locks 20/30 USDC minimum/cap, two 15 USDC investors, 1,000 bps coupon, zero fees, 33 USDC repayment, 16.5 USDC payouts; cap and payout tests use base units. |
| AC-15 | Deal opening locks every required legal, valuation, treasury, compliance, and fiat-route commitment. | `create_deal` non-zero/exact account validation; `open_subscription` locks `DealTerms`; inspect account and document bundle before opening. |
| AC-16 | Oracle gates are immutable, current, exact, unexpired `PASS` revisions. | Append-only `DealGateRevision`, canonical head pointer and `assert_live_gate` in [`pod-oracle`](../../rwa/programs/pod-oracle/); run correction, replay, wrong-deal, wrong-milestone, expiry and `FAIL` cases. |
| AC-17 | Restricted investors retain their economic claim. | Eligibility statuses and `restricted_claim`; `restricted_redeem` pays the fixed pro-rata amount to locked compliance escrow; reconcile escrow and position. |
| AC-18 | Devnet and production use the same architecture. | Compare schemas, programs, instruction flows, Token-2022 extensions, authority classes, and adapter state machine across signed manifests; only environment-specific IDs/configuration and values may differ. |
| AC-19 | Account and program upgrades preserve funded state and authority separation. | Schema versions/reserved bytes, signed binary/IDL hashes, 2-of-3 upgrade governance, funded migration and authority-rotation rehearsal per [`MIGRATION_AND_UPGRADE_RUNBOOK.md`](MIGRATION_AND_UPGRADE_RUNBOOK.md). |
| AC-20 | AWS projections never override finalized Solana claims. | `RwaChainRef` includes cluster/program/account/slot/signature/hash/reconciliation; force an indexer mismatch and verify quarantine/rebuild rather than financial mutation. |
| AC-21 | Receipt recovery and permissioned burn use distinct authorities and a re-entry-safe recovery boundary. | Inspect the mint: external governed recovery Squads equals `PermanentDelegate` and `ComplianceConfig.recovery_authority`; `TransferPolicy` PDA separately equals `PermissionedBurn` authority. Test proposal/delay → `prepare_recovery` → external delegate Token-2022 `TransferChecked` with hook accounts → `execute_recovery` finalization. Reject unprepared, partial, substituted and expired transfers and any compliance-to-Token-2022 recovery CPI. |

## Evidence package

The release package links:

- signed deployment manifest and flowmap commitment;
- program binary, IDL, client, schema, and source hashes;
- authority and role-separation snapshot;
- test logs for AC-01 through AC-21;
- finalized transaction signatures and account snapshots;
- both-farm reconciliation workbooks/records;
- failed/returned-wire and default incident evidence;
- migration and rotation rehearsal evidence; and
- independent treasury, risk, compliance, and engineering reviews.

Any unexplained token, fiat, fee, supply, authority, gate, or evidence mismatch
is a failed release criterion, regardless of total value.
