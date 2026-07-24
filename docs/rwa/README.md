# RWA V1 documentation

This directory is the operating specification for the RWA Tokenization V1
implementation. V1 is an issuer-sponsored financing workflow: a US
C-Corporation issues the participation instrument, receives released USDC in
its controlled treasury, converts it to USD, and sends USD to an international
fiat beneficiary. The international beneficiary never receives protocol USDC.

Solana devnet is the first deployment of this architecture. A production
deployment changes the signed deployment manifest, authorities, endpoints, and
transaction values—not the account model or workflow.

## Document set

- [Architecture and product specification](ARCHITECTURE.md)
- [Accounts and authorities](ACCOUNTS_AND_AUTHORITIES.md)
- [Treasury, SWIFT, and reverse-repayment runbook](TREASURY_RAIL_RUNBOOK.md)
- [Threat model](THREAT_MODEL.md)
- [Migration, upgrade, and authority-rotation runbook](MIGRATION_AND_UPGRADE_RUNBOOK.md)
- [Issuer flowmap intake](FLOWMAP_INTAKE.md)
- [Acceptance traceability](ACCEPTANCE_TRACEABILITY.md)

## Normative language

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` describe protocol requirements. A
release is acceptable only when every `MUST` in this document set and every
item in the acceptance matrix is satisfied.

## Implementation map

| Area | Current path |
|---|---|
| Shared Rust types and checked accounting | [`rwa/crates/pod-rwa-common`](../../rwa/crates/pod-rwa-common/) |
| Oracle program | [`rwa/programs/pod-oracle`](../../rwa/programs/pod-oracle/) |
| Compliance program | [`rwa/programs/pod-compliance`](../../rwa/programs/pod-compliance/) |
| Vault and settlement program | [`rwa/programs/pod-vault`](../../rwa/programs/pod-vault/) |
| TypeScript domain and rail adapter | [`rwa/client`](../../rwa/client/) |
| Deployment manifests | [`rwa/deployments`](../../rwa/deployments/) |
| Pilot deal fixtures | [`rwa/fixtures/pilot-deals-v1.json`](../../rwa/fixtures/pilot-deals-v1.json) |
| Flowmap intake template | [`rwa/fixtures/issuer-flowmap.template.yaml`](../../rwa/fixtures/issuer-flowmap.template.yaml) |
| AppSync contract | [`infrastructure/graphql/schema.graphql`](../../infrastructure/graphql/schema.graphql) |
| AWS deployment | [`infrastructure/lib/infrastructure-stack.ts`](../../infrastructure/lib/infrastructure-stack.ts) |
| Investor application | [`apps/rwa-investor`](../../apps/rwa-investor/) |

Amounts exposed through APIs are canonical non-negative base-unit strings.
On-chain USDC and receipt accounting uses integers; no financial calculation
uses floating-point arithmetic.
