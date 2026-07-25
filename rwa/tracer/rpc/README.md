# Phase 1 RPC tracer

Sends real transactions to a `solana-test-validator` running the SBF-compiled programs, then
reads the accounts back and decodes them. This is the on-chain proof of the multi-MSE refactor.

## Run

Build each program **in isolation** (a whole-workspace build silently emits empty 896-byte
`.so` files — see `../../Cargo.toml`):

    cd rwa/programs/pod-oracle     && cargo-build-sbf
    cd rwa/programs/pod-compliance && cargo-build-sbf
    cd rwa/programs/pod-vault      && cargo-build-sbf

Verify the artifacts before trusting the exit code — each `.so` must be hundreds of KB and the
three MD5s must differ:

    ls -lh rwa/target/deploy/*.so && md5 -q rwa/target/deploy/*.so

Start the validator with the programs at their declared ids:

    solana-test-validator --reset --ledger /tmp/pod-ledger --quiet \
      --bpf-program GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn rwa/target/deploy/pod_vault.so \
      --bpf-program 9xcHEJ1EdSXZWqxsyzZ3CZChKCHJR1upJm1D9f6YhP8E rwa/target/deploy/pod_oracle.so \
      --bpf-program 6UtA4sTWNLps8y73GJCXSAy6wi28sn1oC3tqGA74rmQj rwa/target/deploy/pod_compliance.so

Then:

    cd rwa/tracer/rpc && node tracer.mjs

`node_modules` is a symlink to `apps/rwa-investor/node_modules` (web3.js is already installed
there); ESM resolves from the script's own directory, not the cwd.

## What it covers

1. All three programs deployed and executable.
2. Protocol initialisation, including `platform_treasury_authority`.
3. Two MSEs registered on **both rails** simultaneously, at distinct PDAs, with wallet/ATA/rail
   round-tripping through the on-chain account layout.
4. A **funded** non-governance signer is rejected (`Unauthorized`, lib.rs:153) and leaves no
   account behind — funded so the rejection cannot be a rent failure.
5. Governance suspension flips status without disturbing wallet or rail.

## Not yet covered (phase 2)

Subscribe → two-rail releases → repayment → settlement → redemption. That needs a Token-2022
receipt mint carrying all five required extensions, including the hand-rolled PermissionedBurn
TLV (id 28), which anchor-spl 1.1.2 does not expose.
