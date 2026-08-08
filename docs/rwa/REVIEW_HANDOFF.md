# RWA V1 review handoff

## Integration boundary

The review branch is `feat/rwa-tokenization-v1`, based on
`feat/pod-app-dev-workspace` at `c990386`. The repository's current `main`
branch has unrelated Git history, so the review PR targets the actual parent
branch. Integrating the parent Oracle workspace into `main` remains a separate
repository decision; this PR does not hide that boundary or force an
unrelated-history merge.

## Review scope

The review baseline for this slice is commit
`c0eb83b95fe84d8fc1cf6048293be173bc97850a`. The lifecycle change is
`c23cfce` plus any review-fix commit that follows it.

This slice adds a real local-validator proof of the original V1
`SQUADS_FIAT_FORWARD` route:

1. register the US-controlled issuer treasury route;
2. create a five-extension Token-2022 receipt mint;
3. accept two 15-USDC subscriptions and enforce the 30-USDC hard cap;
4. close funding and release 30/30/30/10 percent against immutable gates;
5. block later releases until prior conversion and SWIFT evidence reconciles;
6. deposit 33 USDC through the on-chain leg of the reverse repayment route;
7. finalize the investor waterfall; and
8. reject direct holder burn and redeem exactly 16.5 USDC per investor.

The Rust changes box large Anchor account wrappers. They do not change account
data layouts, PDA seeds, instruction arguments, or serialized interfaces. The
change removes SBF frames that exceeded Solana's 4 KiB stack limit.

## Reproduce

Follow [`rwa/tracer/rpc/README.md`](../../rwa/tracer/rpc/README.md) to build the
three programs separately, verify their artifacts, download and verify the
official Token-2022 v11 program, and start a clean validator. Run Phase 1:

```sh
cd rwa/tracer/rpc
node tracer.mjs
```

Stop the validator, restart it with `--reset`, and then run Phase 2:

```sh
cd rwa/tracer/rpc
node phase2.mjs
```

The reset is required because both tracers initialize the canonical protocol
PDA.

## Verification recorded

| Check | Result |
|---|---:|
| Phase 1 registry RPC tracer | 17 passed |
| Phase 2 lifecycle RPC tracer | 40 passed |
| Rust workspace tests | 42 passed |
| TypeScript client tests | 52 passed |
| RWA indexer tests | 21 passed |
| Infrastructure tests | 6 passed |
| Client type-check and build | Passed |
| Investor application production build | Passed |
| Compliance and vault isolated SBF builds | No stack-limit violations |
| `git diff --check` | Passed |

The tracer is development-only. `npm audit` reports advisories in transitive
dependencies of the pinned Solana JavaScript v1 SDK; npm offers only
incompatible downgrades, not a patched compatible tree. Do not reuse this
dependency set in a production service, and reassess it when the tracer moves
to the successor Solana client libraries.

## Required reviewer focus

- Confirm USDC can only reach the US issuer treasury, and assess the recorded
  gap that the international fiat beneficiary currently exists only through
  bank-route and financing-contract commitments.
- Confirm every negative assertion also verifies that no financial state
  survives the rejected transaction.
- Confirm the receipt extension authorities match the Series, compliance, burn
  and recovery authority model.
- Confirm the 30-USDC subscription balance, four releases, 33-USDC repayment,
  30 receipt units burned, and two 16.5-USDC payouts conserve every base unit.
- Confirm using versioned transactions and lookup tables does not weaken signer
  or fixed-destination checks.

## Remaining release work

This slice is not a release-completion claim. The acceptance matrix still
requires a distinct `FiatBeneficiary` account instead of relying only on bank
route and financing-contract commitments, reverse bank/conversion evidence,
direct-transfer rejection, failed-raise refund, every intermediate,
failed/returned and unreconciled wire state, default, restricted-claim escrow,
wallet recovery, counterfeit substitutions, gate correction, replay,
wrong-deal/milestone, expiry and `FAIL` scenarios, both-farm replay, clean
devnet deployment, failure injection, migration, authority rotation, and
indexer mismatch quarantine evidence.

## External inputs still required

The remaining local implementation and review work does not require shared
credentials. Deployment requires inputs that are deliberately absent from the
repository:

- the intended AWS account, region, assumable role/profile, and CDK bootstrap;
- Devnet upgrade/program authority key custody and funded deployer;
- the issuer Squads treasury address and authority matrix;
- a credentialed RPC endpoint stored in Secrets Manager; and
- confirmed issuer/servicer, coupon, beneficiary-rail, and release-executor
  decisions.

No access key, private key, RPC credential, bank detail, or beneficiary secret
belongs in this branch or its PR.
