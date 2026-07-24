# `@pod/rwa-client`

Framework-independent TypeScript domain primitives shared by the POD RWA
program clients, AWS services, operational tools, and web applications.

The package intentionally contains no React, wallet-provider, bank-provider, or
Solana RPC dependency. Those integrations are injected at their trust
boundaries.

## Guarantees

- Financial values are canonical, non-negative base-unit strings and are
  calculated with `bigint`.
- Deployment manifests bind a client to an exact cluster genesis hash, program
  set, settlement mint, and independent authority set.
- The issuer treasury and fiat beneficiary are distinct domain roles and
  distinct legal-entity references.
- Outbound disbursements require independent treasury and risk approvals,
  exact USDC release reconciliation, conversion evidence, SWIFT confirmation,
  and independent reconciliation.
- Reverse repayments reconcile incoming fiat, conversion, the issuer treasury,
  and the deal repayment vault.
- Sensitive rail evidence is represented in domain records only by
  domain-separated SHA-256 commitments.
- Wallet-binding messages are scoped to the web origin, wallet, identity,
  Solana genesis hash, program, nonce, and a maximum five-minute lifetime.

## Commands

```sh
npm install --workspaces=false
npm test
npm run typecheck
npm run build
```

Consumers import from the package root:

```ts
import {
  ControlledManualTreasuryRailAdapter,
  baseUnits,
  validateDeploymentManifest,
} from "@pod/rwa-client";
```
