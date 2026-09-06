# ADR 0007: Interruption-Safe Engine Connect and Honest Lifecycle Assertions

## Status

Accepted (Refines [ADR 0006](0006-scope-owned-platform-engine-lifecycle.md); corrects [ADR 0005](0005-unified-platform-socket-engine-adapter-and-test-suite.md))

## Context

A follow-up review of the lifecycle work in ADRs 0005–0006 found remaining gaps:

1. **Platform connect closed its per-attempt scope on failure but not on interruption.** The setup was observed with `Effect.exit`, which (per the runtime source) has only success and error continuations — it cannot observe interruption of the acquiring fiber. On interrupt, `Scope.close(childScope, exit)` was skipped, leaving the live socket and forked read fiber to be cleaned up only by the ambient scope's cascade during unwinding, with finalizers receiving the ambient exit rather than the attempt's own.
2. **The Bun engine had no cancellation hook at all.** `connectOnce` was an `Effect.tryPromise`; a connect interrupted mid-flight left the promise running with no owner. When it later resolved, a fully-connected socket was created that nothing would ever release — a leak until process exit. (`Bun.connect` exposes no abort signal or socket handle before settlement, so an in-flight connect cannot be torn down immediately on interrupt; against real networks, where SYN timeouts run minutes, interrupted mid-flight connects are routine.) The Node.js engine already covered this window via its `Effect.callback` cleanup return.
3. **The "ends the stream cleanly" test could not detect an unclean end.** It wrapped `Stream.runDrain` in `Effect.catch(() => Effect.void)`, making a stream that *fails* indistinguishable from one that *ends* — the assertion was weaker than the test's name. (Source verification: all three engines do end cleanly — `@effect/platform-bun`'s `BunSocket` re-exports `NodeSocket`, whose `onEnd` completes `run` with `Effect.void` on a clean remote FIN — so the masked assertion happened to hold.)
4. **ADR 0005's "Full Backward Compatibility" claim was false** — `RawSocketHandle.write`/`close` becoming effectful is a breaking change for external `TcpStreamEngine` implementors, and `makeTcpStreamPlatform` was later removed as dead code.
5. Assorted test hygiene: gated-schedule taps forked an unmanaged fiber per tap just to complete a `Deferred` (`Deferred.succeed` completes immediately); the TLS fixture hardcoded `/tmp`; the retry-recovery test retried with no bound; the dead `basePort` option was still passed by every engine test file.

## Decision

1. **Platform connect observes its setup with `Effect.onExit`** instead of `Effect.exit` + a manual failure branch:
   ```typescript
   return yield* Effect.onExit(setup, (exit) =>
     Exit.isSuccess(exit) ? Effect.void : Scope.close(childScope, exit),
   );
   ```
   `onExit` runs its handler on success, failure, *and* interruption, in an uninterruptible region, so a mid-setup interrupt closes the attempt's scope promptly with the interrupt exit. A successful setup leaves the scope open — the returned handle owns it, per ADR 0006's contract.
2. **The Bun engine's connect is restructured from `Effect.tryPromise` to `Effect.callback`**, mirroring the Node.js engine: a `cancelled` flag makes late socket callbacks inert, routes late promise settlement to forceful `socket.terminate()` teardown instead of handing over a handle nobody will release, and the cleanup return terminates a socket if it becomes visible during the cancellation race. Since `Bun.connect` exposes no abort signal or socket handle before settlement, an in-flight connect still cannot be torn down before it settles; the adapter now contains that limitation and prevents stale callbacks and late-settlement leaks.
3. **The immediate-remote-close test now asserts the drain's own `Exit`** (deliberately not caught), so a regression turning clean closes into stream failures fails the test instead of hiding behind the catch.
4. **ADR 0005's compatibility claim is corrected** via a Status-line pointer to this ADR; the historical text stays untouched.
5. **Hygiene**: gated-schedule taps complete the gate `Deferred` directly; unreachable-port tests reserve a port on `127.0.0.1` while targeting `127.0.0.2` to avoid release-then-connect races; the TLS fixture uses `os.tmpdir()` with bounded startup and awaited cleanup; the retry-recovery test is bounded by an explicit `Effect.timeout("5 seconds")`; the dead `basePort` option is removed from the suite and its callers.
6. **A GitHub Actions CI workflow** (`pnpm install --frozen-lockfile`, `tsc --noEmit`, `bun test`, Biome lint and format check) backs the "N tests pass" claims in commit messages, which until now were author-assertions on a repo with no CI.

## Consequences

### Positive

- Engine adapters now handle interrupted connect attempts by themselves, promptly and with the correct exit, instead of relying on the ambient scope's cascade — completing the scope-ownership contract ADR 0006 stated where the runtime exposes the resource.
- The Bun engine closes its late-settlement leak window: a socket that becomes visible after cancellation is forcefully terminated and its callbacks are inert. A connection that has not settled is still bounded by Bun's own networking lifecycle because `Bun.connect` exposes neither an abort signal nor a pre-settlement socket handle.
- The lifecycle test suite's assertions now match their names; a clean-close regression is detectable.
- Test-claims are CI-verified.

### Trade-offs

- The interrupt-mid-handshake guard-rail test (silent TLS server, prompt bounded interrupt, no defects) passes both before and after these changes: the ambient-scope cascade already cleaned up during unwinding once ADR 0006's parent-linkage landed. It locks the prompt-interruption contract going forward rather than proving a regression fix; Bun's pre-settlement socket limitation is not deterministically observable black-box because the connect must expose a socket after the interrupt, so the late-settlement path is covered by the adapter protocol and code review rather than a red test.
- The Bun engine's `Effect.callback` restructure trades the compactness of `tryPromise` for an explicit cancellation protocol; it now mirrors the Node.js engine one-to-one.
- CI requires an `openssl` binary (the TLS fixture's fail-loud choice) — present on GitHub's `ubuntu-latest` runners.
