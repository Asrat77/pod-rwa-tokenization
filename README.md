# POD RWA tokenization

Solana programs and supporting services for tokenizing agricultural financing contracts:
investors subscribe USDC, capital is released against oracle-verified crop milestones, and
repayment settles through an investor-first waterfall.

## Provenance

Extracted with full history (27 commits, 2026-07-24 → 2026-08-12) from
`proofofdirt/PODAPPSAWSNative`, branch `feat/pod-app-dev-workspace`, at merge commit `21702fd`
(PR #5). Only RWA-owned paths were carried across. Ownership of this repository is expected to
transfer to the organisation later.

## Layout

| Path | What |
|---|---|
| `rwa/programs/` | Three Anchor programs: `pod_oracle`, `pod_compliance`, `pod_vault` |
| `rwa/crates/pod-rwa-common/` | Shared types, checked integer money math, domain hashing |
| `rwa/client/` | `@pod/rwa-client` — TS domain types mirroring the on-chain contracts |
| `rwa/tracer/rpc/` | Local-validator tracers: `tracer.mjs` (registry), `phase2.mjs` (lifecycle) |
| `rwa/scripts/` | `check-devnet-readiness.mjs`, `inspect-live-mapping.mjs` |
| `apps/rwa-investor/` | Investor client — wallet binding, subscription, position timeline |
| `apps/web-redesign/src/workflows/rwa/` | Operations treasury desk |
| `infrastructure/lambdas/rwa-api/` | GraphQL resolver — wallet challenges, dual-approval treasury flow |
| `infrastructure/lambdas/rwa-indexer/` | Decodes finalized accounts into the DynamoDB mirror |
| `docs/rwa/` | Architecture, threat model, authority matrix, runbooks, devnet review |
| `infrastructure/lib/rwa-stack.ts` | Standalone CDK stack — the RWA plane only, importing the platform's table/pool/bus by name |
| `infrastructure/graphql/rwa.graphql` | RWA GraphQL surface, separate from the platform-wide schema |

Start with [`docs/rwa/ARCHITECTURE.md`](docs/rwa/ARCHITECTURE.md).

## Deliberately not extracted

- **Foundation stack wiring.** ~128 lines defining the RWA Lambdas, AppSync data source, evidence
  bucket, Cognito groups and indexer schedule live inside the *shared*
  `infrastructure/lib/infrastructure-stack.ts` upstream, interleaved with farm, livestock and
  contract resources owned by the wider platform. Preserved verbatim for reference in
  [`infrastructure/RWA_CDK_WIRING.md`](infrastructure/RWA_CDK_WIRING.md).
- **The GraphQL schema.** `infrastructure/graphql/schema.graphql` upstream is one document
  covering the whole platform; the `Rwa*` types are a section of it, not a separate file.
- **The host application.** `apps/web-redesign/` is the platform console; only its RWA
  workflow directory is here, so it will not build standalone.

## Status

The full issuer lifecycle is proven on a local validator against compiled SBF programs.
**Nothing is deployed to Devnet** — the three program addresses are unallocated, the four
authority classes are unset, and the deployment manifest is unsigned.

Recorded verification: 42 Rust · 53 client · 21 indexer · 6 infrastructure ·
17 registry RPC · 40 lifecycle RPC.

Run the network check with `cd rwa && npm run check:devnet`.
See [`docs/rwa/DEVNET_STRUCTURE_REVIEW_2026-08-01.md`](docs/rwa/DEVNET_STRUCTURE_REVIEW_2026-08-01.md)
for the staging sequence and the decisions still outstanding.

## Building

Programs must be built **one at a time** — a whole-workspace build silently produces
valid-but-empty 896-byte `.so` files, because cargo unifies the `no-entrypoint` feature across
the workspace:

```sh
cd rwa/programs/pod-oracle     && cargo-build-sbf
cd rwa/programs/pod-compliance && cargo-build-sbf
cd rwa/programs/pod-vault      && cargo-build-sbf
```

Always verify the artifacts rather than the exit code — each `.so` should be hundreds of KB and
the three checksums must differ. Full recipe in [`rwa/tracer/rpc/README.md`](rwa/tracer/rpc/README.md).
