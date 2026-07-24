# POD RWA tokenization

This workspace contains the production-shaped RWA protocol deployed first on
Solana devnet.

The programs deliberately separate:

- `pod_oracle`: evidence, valuation and deal-gate revisions;
- `pod_compliance`: investor eligibility, wallet policy and receipt controls;
- `pod_vault`: subscriptions, custody, releases, repayment and settlement.

The US issuer treasury is distinct from the international fiat beneficiary.
Stablecoins terminate at the issuer's configured Squads vault. A separately
reconciled treasury movement links each release to its USD conversion and SWIFT
confirmation.

## Toolchain

- Rust 1.89.0
- Anchor 1.1.2
- Agave/Solana 3.1.10
- Node.js 20–25

Run `cargo test --workspace` for deterministic domain and program tests. Anchor
integration tests additionally require the CLI versions pinned in
`Anchor.toml`.
