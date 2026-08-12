# Treasury, SWIFT, and reverse-repayment runbook

## 1. Purpose and control boundary

The V1 `TreasuryRailAdapter` is bank-agnostic. Its controlled-manual driver
requires authorized staff to use approved provider and bank portals while the
platform enforces workflow state, dual approval, evidence commitments, and
reconciliation. A future provider API implements the same adapter and state
machine.

This runbook covers the only active V1 rail,
`SQUADS_FIAT_FORWARD`. `DIRECT_USDC` is a reserved future discriminant and is
rejected by V1 program, API, and client boundaries.

Released USDC is custodied in the US issuer's Squads treasury and forwarded to
the international MSE as USD over SWIFT. Full evidence chain:

- `USDC_RELEASED` proves USDC arrived at the US issuer Squads treasury ATA.
- `CONVERTED` proves the recorded conversion and explicit fee breakdown.
- `SWIFT_SENT` proves the payment instruction was accepted for transmission.
- `BANK_CONFIRMED` proves an independent reviewer matched the beneficiary,
  value, UETR, and bank confirmation.
- `RECONCILED` proves the complete release-to-beneficiary accounting tie-out.

No operator may infer a beneficiary payment from an on-chain release alone.

## 2. Data handling

Store encrypted full evidence in the approved AWS evidence store:

- beneficiary legal and bank details;
- provider trade/order reference;
- full UETR and value date;
- conversion receipt;
- payment instruction and bank confirmation;
- sanctions and beneficiary-screening result;
- incoming repayment confirmation; and
- reviewer notes.

On Solana and in ordinary application records, store only the required
non-sensitive amounts, statuses, opaque entity references, and
domain-separated commitments. Do not put bank account or routing numbers,
credentials, API keys, private keys, identity documents, or full UETRs in a
shared file, log, transaction memo, DynamoDB projection, or support ticket.

Create commitments with the canonical functions in
[`rwa/client/src/evidence.ts`](../../rwa/client/src/evidence.ts). Preserve the
original evidence object exactly; a transformed file must receive a new
commitment.

## 3. Outbound disbursement

### Required record

One `FiatDisbursementV1` and one on-chain `TreasuryMovement` exist for each
`dealId + milestoneIndex`. The record contains:

- milestone and release references;
- finalized release signature/slot and released USDC base units;
- conversion provider commitment;
- gross and net USD minor units;
- conversion rate, provider fees, and bank fees;
- FiatBeneficiary and approved bank-route commitments;
- UETR, sending evidence, and bank-confirmation commitments;
- treasury and risk approvers and timestamps; and
- state and any failure/return evidence.

All money values are integers. USDC values use six-decimal base units; USD
values use cents; rates use the scale declared by the schema.

### Preflight

Operations completes these checks before creating a proposal:

1. Deal is `FUNDED` or `ACTIVE`; mint authority is revoked.
2. Milestone is the next unexecuted milestone.
3. Capital-close or exact latest unexpired `PASS` gate is selected.
4. Locked issuer, treasury ATA, FiatBeneficiary, bank-route, document, oracle,
   and compliance commitments match the approved deal.
5. For milestone 1 or later, the previous movement is `RECONCILED`, including
   independently reviewed `BANK_CONFIRMED` evidence; it is neither failed nor
   returned.
6. Treasury balance, release allocation, total released, and net deployable
   capital reconcile.
7. Beneficiary, bank, conversion provider, and payment purpose are screened
   under the current policies.
8. No proposer, treasury approver, risk approver, or confirmation reviewer is
   reusing a prohibited role.

If any check fails, do not create or approve the release.

### Procedure

1. **Propose — `PROPOSED`.** Operations creates the disbursement record against
   the immutable deal and milestone. The system derives the issuer treasury and
   beneficiary commitments from the deal; the operator does not type a
   destination wallet.
2. **Approve — `APPROVED`.** A treasury approver confirms custody, liquidity,
   and provider route. A distinct risk approver confirms the gate, screening,
   amount, beneficiary route, and previous-movement prerequisite. Both
   signatures are required.
3. **Schedule.** Risk and treasury sign the on-chain milestone schedule. The
   record fixes gate revision, amount, exact treasury ATA, and execute-after
   time.
4. **Release — `USDC_RELEASED`.** After the delay, submit `execute_release`.
   Wait for finalized commitment. Verify source subscription vault,
   destination US issuer treasury ATA, mint, token program, decimals, amount,
   signature, and finalized slot. Attach that proof to the movement. This does
   not prove that the international MSE received funding.
5. **Convert — `CONVERTED`.** Treasury converts the released USDC to the issuer
   bank account through the approved provider. Upload the receipt. Record:
   `gross USD = net USD + provider fees` at the conversion leg, plus the
   declared rate. The USDC source must equal the finalized release.
6. **Send — `SWIFT_SENT`.** Treasury sends USD from the issuer bank account to
   the approved FiatBeneficiary route. Record:
   `SWIFT gross USD = beneficiary net USD + bank fees`. Hash the UETR and
   sending evidence; retain the full values only in encrypted storage.
7. **Confirm — `BANK_CONFIRMED`.** A reviewer independent of proposal and both
   approvals compares the full UETR, value date, currency, gross/net values,
   beneficiary legal identity, approved bank route, and bank confirmation.
   The reviewer records the confirmation commitment.
8. **Reconcile — `RECONCILED`.** Risk or governance verifies the equations
   below, checks all commitments against encrypted source evidence, anchors the
   final reconciliation commitment, and closes the movement.

### Outbound reconciliation

For each movement:

```text
released USDC = provider USDC input
conversion gross USD = conversion net USD + provider fees
SWIFT gross USD = conversion net USD
SWIFT gross USD = beneficiary net USD + bank fees
movement destination ATA = locked MSE beneficiary ATA
movement beneficiary hash = locked MSE beneficiary hash
movement bank-route hash = locked approved route hash
```

Any other FX spread or intermediary deduction is an explicit named fee field or
an exception. It may not silently reduce investor, issuer, or beneficiary
accounting.

### Failure and return handling

- Before an on-chain release, cancel the schedule, record `FAILED`, attach a
  reason/evidence commitment, and leave funds in the subscription vault.
- After release but before SWIFT, record `FAILED`; inventory the exact USDC or
  USD location and obtain a new dual-approved disposition. Do not reuse the
  original movement for another beneficiary.
- A rejected or returned wire becomes `RETURNED` even if it had previously
  reached `BANK_CONFIRMED` or `RECONCILED`. Record the return value date,
  returned amount, deductions, and evidence commitment.
- `FAILED` and `RETURNED` block all later releases. Risk/governance must resolve
  the exception through an auditable successor movement or return of funds; no
  status may be edited backward.
- Suspected beneficiary substitution, unauthorized payment, sanctions match,
  or key compromise triggers the incident procedure in
  [the threat model](THREAT_MODEL.md#6-incident-priorities).

## 4. Reverse repayment

The reverse workflow proves that fiat proceeds became real deal-vault USDC.
Authorized payer types are `FIAT_BENEFICIARY`, `BUYER`, or `SERVICER`. The
record always names an opaque payer reference; it never assumes the payer is the
FiatBeneficiary.

### Procedure

1. **Propose — `PROPOSED`.** Create one repayment record for the deal, payer,
   expected currency, issuer bank account, and deal repayment-vault ATA.
2. **Receive fiat — `FIAT_RECEIVED`.** Match the incoming bank confirmation to
   payer, purpose, deal, value date, and issuer account. Record:
   `gross received USD = net received USD + bank fees`, and commit the full bank
   evidence.
3. **Convert — `CONVERTED`.** Convert the net received USD to USDC through the
   approved provider. Record provider commitment, input USD, provider fees,
   converted USD, acquired USDC, rate, and conversion-evidence commitment.
4. **Deposit — `USDC_DEPOSITED`.** The US issuer Squads treasury invokes
   `deposit_repayment` and performs a checked transfer from its USDC ATA to the
   exact deal repayment vault. Wait for finality. The deposit amount must equal
   acquired USDC and use the locked settlement mint, token program, and
   decimals.
5. **Reconcile — `RECONCILED`.** Verify the bank, conversion, treasury, and
   on-chain equations, then commit the reconciliation evidence. Only finalized
   USDC in the isolated repayment vault becomes accounted repayment.

```text
incoming gross USD = incoming net USD + bank fees
conversion source USD = incoming net USD
conversion source USD = converted USD + provider fees
acquired USDC = finalized on-chain deposit USDC
deposit source = issuer treasury ATA
deposit destination = deal repayment vault ATA
```

If USDC arrives without a matching repayment record, `sync_repayment_surplus`
identifies it as unallocated surplus. Governance may allocate it only with a
non-zero evidence commitment. A failed or returned incoming payment receives an
exception record and cannot be counted toward repayment.

## 5. End-of-day and close controls

Treasury and operations jointly produce a daily exception report containing:

- approved but unreleased movements past their execution window;
- released but unconverted balances;
- converted but unsent USD;
- sent but unconfirmed wires past the service-level deadline;
- failed or returned movements;
- fiat receipts without conversion;
- acquired USDC not deposited;
- repayment-vault surplus or deficit;
- commitment verification failures; and
- DynamoDB records that diverge from finalized Solana accounts.

No financial period closes while an unexplained token, bank, conversion, or
evidence mismatch remains.
