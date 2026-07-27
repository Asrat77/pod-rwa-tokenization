# RWA RPC tracers

Sends real transactions to a `solana-test-validator` running the SBF-compiled programs, then
reads the accounts and token balances back. `tracer.mjs` covers protocol and MSE registration.
`phase2.mjs` covers the original V1 US-issuer and international-MSE lifecycle.

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

Then run the registration tracer:

    cd rwa/tracer/rpc && node tracer.mjs

`node_modules` is a symlink to `apps/rwa-investor/node_modules` (web3.js is already installed
there); ESM resolves from the script's own directory, not the cwd.

## Phase 1 coverage

1. All three programs deployed and executable.
2. Protocol initialisation, including `platform_treasury_authority`.
3. Two MSEs registered on **both rails** simultaneously, at distinct PDAs, with wallet/ATA/rail
   round-tripping through the on-chain account layout.
4. A **funded** non-governance signer is rejected (`Unauthorized`, lib.rs:153) and leaves no
   account behind — funded so the rejection cannot be a rent failure.
5. Governance suspension flips status without disturbing wallet or rail.

## Phase 2 setup

The lifecycle requires the official Token-2022 v11 program because that release introduced the
PermissionedBurn extension. Download the release binary and verify it before starting the
validator:

    curl -fL \
      https://github.com/solana-program/token-2022/releases/download/program%40v11.0.0/spl_token_2022.so \
      -o /tmp/spl_token_2022-v11.0.0.so
    shasum -a 256 /tmp/spl_token_2022-v11.0.0.so

Expected SHA-256:

    9bbf90b30e06778ca0feca100b29f0eeb9be576ae024f6323cc207308f51a5d1

Start a clean validator with the v11 binary loaded at the canonical Token-2022 program id:

    solana-test-validator --reset --ledger /tmp/pod-rwa-phase2-ledger --quiet \
      --bpf-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb /tmp/spl_token_2022-v11.0.0.so \
      --bpf-program GREmSWM6ugPjoKeA6tr9RxkhWHvToiYnNpV1dwNySWCn rwa/target/deploy/pod_vault.so \
      --bpf-program 9xcHEJ1EdSXZWqxsyzZ3CZChKCHJR1upJm1D9f6YhP8E rwa/target/deploy/pod_oracle.so \
      --bpf-program 6UtA4sTWNLps8y73GJCXSAy6wi28sn1oC3tqGA74rmQj rwa/target/deploy/pod_compliance.so

Then:

    cd rwa/tracer/rpc && node phase2.mjs

## Phase 2 coverage

1. US-issuer treasury and international-MSE fiat-beneficiary roles remain distinct.
2. The receipt mint has DefaultAccountState, PermanentDelegate, TransferHook, MetadataPointer
   and PermissionedBurn, with the locked Series and compliance authorities.
3. Two compliant investors subscribe 15 USDC each; the hard cap and receipt-supply invariants
   are enforced.
4. Capital close and T1/T2/T3 release 30/30/30/10 percent only to the US issuer treasury.
5. Later releases fail until the preceding conversion and SWIFT movement is bank-confirmed and
   reconciled.
6. The reverse fiat flow deposits 33 USDC into the isolated repayment vault.
7. A direct holder burn fails; governed redemption burns the full receipt supply and pays
   16.5 USDC to each investor without losing a base unit.

Deal creation and redemption use versioned transactions with address lookup tables. This is
part of the supported client path: their complete account sets exceed the legacy transaction
message limit.
