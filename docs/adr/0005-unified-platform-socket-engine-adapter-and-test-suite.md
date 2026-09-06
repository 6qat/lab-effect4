# ADR 0005: Unified Platform Socket Engine Adapter and Deduplicated Test Suite

## Status

Accepted (Supersedes [ADR 0003](0003-effect-platform-push-socket-implementation.md))

## Context

In [ADR 0002](0002-unified-tcp-stream-engine-adapter-seam.md), we extracted a shared engine adapter seam ([`TcpStreamEngine`](../../src/tcp-connection-common.ts)) for Bun (`Bun.connect`) and Node.js (`node:net` / `node:tls`). In [ADR 0003](0003-effect-platform-push-socket-implementation.md), we introduced a parallel implementation for `@effect/platform` push-based sockets ([`src/tcp-connection-platform.ts`](../../src/tcp-connection-platform.ts)) to avoid shoehorning its effectful writer into the then-synchronous `RawSocketHandle.write` signature.

However, maintaining `tcp-connection-platform.ts` as a separate orchestrator resulted in:

1. Duplication of `ConnectionConfig` validation and error handling.
2. Duplication of the unbounded incoming queue management and connection lifecycle state machine.
3. Duplication of connection retry policy schedules and backoff windows.
4. Duplication of stream and text encoding implementations.
5. Repeated function overload boilerplate (`TcpStream*Live()`) across Bun, Node.js, and Platform.
6. Near-identical test suites (~190 lines each across Bun, Node.js, and Platform test files).

Furthermore, [`RawSocketHandle`](../../src/tcp-connection-common.ts) previously modeled `write` and `close` as synchronous void functions, preventing Effect-native socket abstractions from cleanly satisfying the adapter seam.

## Decision

We modernized and unified the engine seam across all three runtime targets, superseding ADR 0003:

1. **Effectful `RawSocketHandle` Contract**:
   Updated [`RawSocketHandle`](../../src/tcp-connection-common.ts) so both `write` and `close` return effects:
   ```typescript
   export interface RawSocketHandle {
     readonly write: (
       chunk: Uint8Array,
     ) => Effect.Effect<RawSocketWriteResult, TcpStreamError>;
     readonly close: () => Effect.Effect<void>;
   }
   ```
   This accommodates synchronous kernel socket operations (Bun `socket.write()` / Node.js `net.Socket.write()`, wrapped in `Effect.try`) and asynchronous effectful writers (Platform `socket.writer`, wrapped via `Effect.mapBoth`).

2. **Platform Engine Adapter (`TcpStreamEnginePlatformLive`)**:
   Refactored [`src/tcp-connection-platform.ts`](../../src/tcp-connection-platform.ts) from a duplicate orchestrator into a thin engine adapter satisfying `TcpStreamEngineShape`:
   - Wraps `@effect/platform-bun` / `effect/unstable/socket/Socket` in `RawSocketHandle`.
   - Bridges socket reading to `SocketCallbacks` and handles scoped teardown.
   - Deletes ~190 lines of duplicate queue, state machine, and retry logic.

3. **Generic Convenience Layer Factory (`makeConvenienceLayer`)**:
   Extracted [`makeConvenienceLayer`](../../src/tcp-connection-common.ts) in common to eliminate repeated function overload boilerplate across `TcpStreamBunLive`, `TcpStreamNodejsLive`, and `TcpStreamPlatformLive`.

4. **Parameterized HTTP Example Request Programs (`makeRequestProgram`)**:
    Deduplicated the request execution pipelines in [`src/tcp-connection-http-example.ts`](../../src/tcp-connection-http-example.ts) using a shared program factory.
    `makeRequestProgram(layerFactory, url)` takes the target URL explicitly so it stays
    pure and testable; the CLI-wired `requestProgram*` constants delegate to
    `makeCliRequestProgram(layerFactory)`, which reads the URL from argv.

5. **Deduplicated Parameterized Test Runner (`defineTcpStreamTestSuite`)**:
   Extracted a parameterized test suite in [`src/tcp-connection-test-suite.ts`](../../src/tcp-connection-test-suite.ts) verifying all 6 key operational scenarios:
   - Exhausting configured retry attempts on unreachable ports.
   - Immediate failure when `retry: false`.
   - Custom `Schedule` policies.
   - Server availability during retry backoff window.
   - Binary data transmission and graceful teardown.
   - Composable layer provision via `TcpStreamLayer` and engine layers.
   Reduced the individual test files (`tcp-connection-bun.test.ts`, `tcp-connection-nodejs.test.ts`, `tcp-connection-platform.test.ts`) from ~190 lines each to ~13 lines each.

## Consequences

### Positive

- **True Single Orchestrator**: Bun, Node.js, and `@effect/platform` now all route through the same shared `makeTcpStream` orchestrator. Zero duplicate concurrency, queueing, or retry logic remains.
- **Over 400 Lines Saved**: Production code reduced by ~200 lines and test boilerplate reduced by ~350 lines while expanding test coverage.
- **Full Backward Compatibility**: All public types, layer signatures, CLI options, and alias exports remain identical.
- **Resource Safety**: Scoped lifecycle teardown handles graceful and unexpected socket closures without deadlocks or lingering fibers.

### Trade-offs

- Adapting future socket transports to `TcpStreamEngineShape` requires implementing the effectful `RawSocketHandle` contract.

