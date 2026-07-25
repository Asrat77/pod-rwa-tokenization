# Tracer harness — native BanksClient attempt (parked)

This crate tries to run the three programs natively through `solana-program-test`, avoiding
the SBF toolchain entirely. **It compiles and executes, but every test fails**, and the reason
is architectural rather than fixable by configuration:

    entry → dispatch → try_accounts (the `init` constraint)
          → anchor_lang::system_program::create_account
          → solana_invoke::invoke_signed
          → unimplemented!("only supported with target_os = solana")

anchor-lang 1.1.2's `solana_program` is a shim over the modular crates, and
`solana-invoke 0.5.0` / `solana-cpi 3.x` deliberately dropped syscall-stub support ("This crate
does not support overwriting syscall stubs for offchain code"). `solana-program-test` installs
its stubs into `solana_sysvar::program_stubs`, which `solana-invoke` does not even depend on.
Any Anchor `init` therefore panics. Phase 2 would hit the same wall again on Token-2022 CPI.

The only escape would be `[patch.crates-io] solana-invoke = <fork>` adding a solana-sysvar
dependency and routing the `#[cfg(not(target_os = "solana"))]` branch to
`solana_sysvar::program_stubs::sol_invoke_signed` — untried.

**Use `cargo-build-sbf` + `solana-test-validator` instead.** The test bodies here are still
worth keeping: the MSE-registry scenarios port directly to an RPC-based tracer.

## Why this crate is excluded from the workspace

It depends on the programs with `no-entrypoint`. Cargo unifies features across a workspace
build, so including it strips `entrypoint!` from the real SBF build and silently produces
valid-but-empty 896-byte `.so` files. See the comment in `../Cargo.toml`.
