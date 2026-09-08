# ADR 0006: Scope-Owned Platform Engine Lifecycle and Atomic Socket Acquisition

## Status

Accepted (Amends [ADR 0002](0002-unified-tcp-stream-engine-adapter-seam.md), refines [ADR 0005](0005-unified-platform-socket-engine-adapter-and-test-suite.md), and is superseded for attempt ownership by [ADR 0008](0008-caller-first-tcp-stream-engine.md))

## Context

A review of [ADR 0005](0005-unified-platform-socket-engine-adapter-and-test-suite.md)'s implementation found that [`TcpStreamEnginePlatformLive`](../../src/tcp-connection-platform.ts) had two related lifecycle problems, both stemming from tracking "has this connection closed" with a single mutable flag:

1. **An unlinked child scope.** `connect` created its per-connection `Scope` via `Scope.make()`, which is never registered with any parent. Nothing guarantees it is ever closed except an explicit call to `RawSocketHandle.close()`.
2. **A single flag conflating two different events.** `hasClosed` was set both when the background read loop (`socket.run`) finished on its own (the *remote* side closing or erroring) and when `close()` was called *explicitly*. Once the read loop finished, `hasClosed` was already `true`, so a later explicit `close()` call skipped `Scope.close` entirely — the writer's release action and the "destroy the socket if not already closed" finalizer never ran.
3. In [`makeTcpStream`](../../src/tcp-connection-common.ts), a successful `connect` and the `Effect.addFinalizer` call that guards it were two separate steps, leaving a window in which an interruption between them would skip registering the socket's teardown altogether.

### What investigation confirmed, and what it didn't

Instrumenting the code and reproducing both scenarios against real Bun/Node sockets showed:

- Problem 2 is real and reproducible: after a server-initiated close, a subsequent explicit `close()` verifiably skipped `Scope.close`.
- Under this engine's actual configuration, `node:net`'s default `allowHalfOpen: false` means the client's writable side is already auto-ended by the time the skip would matter, so **this specific skip had no currently-observable effect** (no dangling socket, no hung fiber) in either the graceful-close or the connection-refused case. A hypothesized `ReferenceError` from reading `hasClosed` before its declaration (a real temporal-dead-zone hazard given where the `let` sat in the function) also did not reproduce: the forked fiber that would trigger it is interrupted by `Scope.close` before it gets there.

The fix is adopted anyway, because the correct behavior (idempotent, unconditional teardown; scope ownership tied to the caller) shouldn't depend on `allowHalfOpen` defaults, a specific Effect scheduler's interleaving, or the specific adapters that exist today.

## Decision

1. **`TcpStreamEngineShape.connect` may require `Scope.Scope`** ([`tcp-connection-common.ts`](../../src/tcp-connection-common.ts)):
   ```typescript
   readonly connect: (
     config: ConnectionConfigShape,
     callbacks: SocketCallbacks,
   ) => Effect.Effect<RawSocketHandle, TcpStreamError, Scope.Scope>;
   ```
   Adapters with nothing to scope (Bun, Node.js) are unaffected: an effect with `R = never` already satisfies a signature requiring `Scope.Scope`.

2. **The Platform adapter forks a child of the ambient scope** instead of an orphaned one:
   ```typescript
   const parentScope = yield* Scope.Scope;
   const childScope = yield* Scope.fork(parentScope);
   ```
   Per `Scope.fork`'s own contract, closing the parent closes the child with the same exit, and closing the child early (our `close()`) detaches it from the parent. This means the connection is torn down when the caller's scope closes or is interrupted, whether or not `close()` was ever called.

3. **`close()` unconditionally closes the scope**, relying on `Scope.close` already being a no-op once a scope is closed, rather than tracking a separate `hasClosed` flag:
   ```typescript
   close: (): Effect.Effect<void> => Scope.close(childScope, Exit.void),
   ```
   "The read loop ended" and "the scope has been closed" are no longer the same variable.

4. **`makeTcpStream` acquires the socket handle with `Effect.acquireRelease`**, passing `{ interruptible: true }`, instead of a bare `connect` followed by a separate `Effect.addFinalizer`:
   ```typescript
   const socketHandle = yield* Effect.acquireRelease(
     connectWithRetry,
     (handle) =>
       Effect.gen(function* () {
         finishIncoming();
         yield* handle.close().pipe(Effect.catch(() => Effect.void));
       }),
     { interruptible: true },
   );
   ```
   This closes the interruption window between a successful connect and finalizer registration for all three engines, not just Platform, while `acquireRelease`'s guarantee that release runs whenever acquire *does* produce a value holds regardless of `interruptible`.

   **`interruptible: true` is required, not optional.** `Effect.acquireRelease`'s `acquire` step is uninterruptible by default. `connectWithRetry` is not a single atomic step — it is the *entire* connect-and-retry sequence, including every backoff sleep. An initial version of this change omitted the option, and the added "interrupting during retry backoff" test (below) caught it immediately: interrupting a fiber stuck in backoff no longer returned in well under one retry delay, it blocked until the whole retry schedule exhausted (multiple seconds), because the uninterruptible region silently swallowed every interrupt signal until `connectWithRetry` finished on its own. This would have been a real, severe regression — a connection attempt becoming uncancellable — shipped in the name of fixing a latent, currently-unobservable one. It was only caught because the test suite was extended per point 5 below *before* moving on, and that test failed loudly (real timings around 2000ms against an expected bound of 150ms) rather than silently.

5. **Regression coverage for this contract was added to the shared, parameterized suite** ([`defineTcpStreamTestSuite`](../../src/tcp-connection-test-suite.ts)), run against all three engines:
   - `close()` called twice does not throw.
   - A failed connection attempt (`retry: false`, unreachable port) fails with a `TcpStreamError` and no defects (`Cause.hasDies` is `false`), and exhausting a bounded retry schedule against an unreachable port completes within a bounded time (each attempt cleans up and moves on rather than hanging).
   - An immediate remote close (before any data is exchanged) ends the incoming stream and lets `close()` resolve without hanging.
   - Interrupting the program after a successful connection still closes the underlying socket, observed from the test's own server.
   - Interrupting a fiber that is mid-retry-backoff (never having connected at all) returns promptly instead of blocking until the retry schedule exhausts — this is the test that caught the `interruptible: true` regression above.

## Consequences

### Positive

- The teardown contract (`close()` is idempotent and unconditional; the connection is scoped to, and torn down with, the caller) is now explicit and enforced by the type system and the scope tree, not an implicit consequence of a particular scheduler interleaving or socket default.
- Future engine adapters that *do* have resources without `allowHalfOpen`-style auto-cleanup (e.g. a transport without half-close semantics) are protected by construction, not by accident.
- The shared test suite now exercises the lifecycle behavior most at risk (close idempotency, clean failure, interruption-driven teardown) for Bun, Node.js, and Platform alike, closing the coverage gap ADR 0005's suite left.

### Trade-offs

- `TcpStreamEngineShape.connect`'s signature is one line more complex (`Scope.Scope` in `R`), and any *future* adapter that spawns Effect-managed child resources must remember to fork from that scope rather than reaching for `Scope.make()`.
- The tests targeting the originally suspected defects (Context) could not reproduce them live; they lock in the desired behavior going forward rather than proving a regression fix against a demonstrated failure. The tests targeting the *acquisition* change (point 5's last two) did catch a real, more severe defect introduced by the fix itself (see point 4) — evidence for writing the lifecycle tests before, not after, changing acquisition strategy.
- Anyone reaching for `Effect.acquireRelease` around a retry loop must pass `{ interruptible: true }` explicitly; the default is silently the wrong choice for that shape of `acquire` and produces no type error.
