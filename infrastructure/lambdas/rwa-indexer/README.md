# RWA finalized-account indexer

This Node 22 Lambda polls `pod_vault` at `finalized` commitment and mirrors its
query-facing state into the shared DynamoDB domain table. It uses only Node
built-ins, the Lambda runtime AWS SDK v3, and Solana JSON-RPC over `fetch`.

The indexer fails closed before any write unless:

1. `RWA_PROGRAM_ID` is a valid 32-byte Solana address.
2. the RPC node's `getGenesisHash` exactly matches `RWA_CLUSTER_GENESIS`;
3. `getAccountInfo(RWA_PROGRAM_ID)` returns an executable account; and
4. every indexed account is owned by that exact program and decodes as schema V1.

## Environment

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TABLE_NAME` | yes | — | DynamoDB domain table |
| `SOLANA_RPC_URL` | yes | — | HTTP(S) Solana JSON-RPC endpoint |
| `RWA_PROGRAM_ID` | yes | — | Deployed `pod_vault` program |
| `RWA_CLUSTER_GENESIS` | yes | — | Exact expected cluster genesis hash |
| `RPC_TIMEOUT_MS` | no | `20000` | Timeout for each HTTP RPC request |
| `MAX_ACCOUNTS_PER_TYPE` | no | `5000` | Fail-closed response cap for each discriminator |
| `MAX_ITEMS_PER_RUN` | no | `20000` | Fail-closed DynamoDB item cap |
| `MAX_SIGNATURE_LOOKUPS` | no | `250` | Latest-signature enrichment budget |
| `RPC_BATCH_SIZE` | no | `50` | JSON-RPC calls per signature page |
| `DYNAMO_WRITE_PAGE_SIZE` | no | `10` | Concurrent conditional writes per page |

Invoke with `{ "dryRun": true }` to perform all RPC validation, decoding, joins,
wallet-binding reads, and mapping without writes. Add
`"skipIdentityResolution": true` for an RPC-only local dry run; position keys
then fall back to their opaque on-chain investor hashes.

## Accounts and decoders

The indexer calculates each Anchor discriminator as the first eight bytes of
`sha256("account:<RustStructName>")`, filters `getProgramAccounts` at byte zero,
then safely decodes the exact Borsh V1 layouts:

- `DealTerms`
- `DealStateAccount`
- `ReleaseMilestone`
- `InvestorDealPosition`
- `SettlementSnapshot`
- `TreasuryMovement`

Unknown schemas, enum variants, invalid Borsh booleans, truncated buffers,
foreign owners, non-canonical PDAs, or non-base64 account data stop the run.
Canonical addresses are recomputed from the exact Rust seed tuple and stored
account bump. Account SHA-256 values cover the complete returned account buffer,
including Anchor's allocated trailing space.

`getProgramAccounts` has no cursor protocol. To keep polling bounded, this
implementation partitions the snapshot into six discriminator-filtered calls
and rejects any type exceeding `MAX_ACCOUNTS_PER_TYPE`. Signature enrichment and
DynamoDB writes are explicitly paged.

## DynamoDB mirror model

All amounts are base-10 strings so no `u64` precision is lost.

| Record | Primary key | Secondary index |
| --- | --- | --- |
| Deal | `PK=RWA#DEAL#<deal-hash>`, `SK=META` | `GSI1PK=RWA#DEALS` |
| Milestone | same deal PK, `SK=MILESTONE#<index>` | `GSI1PK=RWA#DEAL#<deal>#MILESTONES` |
| Position | same deal PK, `SK=POSITION#<opaque-investor-hash>` | GSI1 by deal, GSI2 by wallet |
| Settlement | same deal PK, `SK=SETTLEMENT` | — |
| Treasury movement | `PK=RWA#MOVEMENT#chain_<account>`, `SK=META` | `GSI1PK=RWA#DEAL#<deal>#TREASURY` |

The deal item joins immutable `DealTerms` with mutable `DealStateAccount`.
`chain` points at the state account and carries its raw account hash; the item
also retains both source account hashes plus a composite hash used for
conditional writes. Other records' `chain.accountHash` is the SHA-256 of that
single raw Solana account.

Each put is accepted only when no indexed record exists, an older record lacks
index metadata, or the incoming finalized slot is not older and the source hash
changed. Repeated polls are therefore idempotent, and a lagging RPC response
cannot overwrite newer mirrored state. Closed-account deletion is intentionally
not inferred from one polling snapshot; retention/closure policy should be an
explicit audited workflow.

The index stores only hashes, public wallet/program addresses, and protocol
status. A position joins the wallet-owner guard to recover the API's opaque
`investor_...` identifier and verifies that its SHA-256 exactly equals the
on-chain `[u8; 32]` investor identifier. Legal identity, Cognito subject hashes,
bank data, UETRs, and documents are never fetched or written.

### Receipt balance caveat

`RwaPosition.receiptBaseUnits` is calculated as on-chain
`receipts_issued - receipts_burned`. The item sets:

```text
receiptAccountingBasis = ISSUED_MINUS_BURNED
receiptBalanceAuthoritative = false
```

This is a useful V1 projection while peer transfers are disabled, but it is not
presented as an independently authoritative Token-2022 wallet balance. If a
future eligible-peer policy enables transfers, token-account indexing must be
added before this projection can be used as a holder balance.

## Tests

Run the dependency-free decoder suite:

```bash
cd infrastructure/lambdas/rwa-indexer
npm test
```

The tests exercise all six Rust layouts with allocated trailing space and pin
their discriminator bytes. They also cover schema, enum, discriminator, and
truncation rejection.
