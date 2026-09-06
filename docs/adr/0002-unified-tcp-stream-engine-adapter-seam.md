# Unified TCP Stream Engine Adapter Seam

## Status

Accepted (Amended by [ADR 0005](0005-unified-platform-socket-engine-adapter-and-test-suite.md) and [ADR 0006](0006-scope-owned-platform-engine-lifecycle.md): `RawSocketHandle.write`/`close` are now effectful, and `TcpStreamEngineShape.connect` may require `Scope.Scope`)

## Context

In [ADR 0001](file:///home/guiga/Devel-NT/lab-effect4/docs/adr/0001-direct-engine-socket-wrappers.md), we established direct runtime socket engine wrappers for Bun (`Bun.connect`) and Node.js (`node:net` / `node:tls`). However, maintaining parallel connection orchestrators resulted in duplicate orchestration logic (retry schedules, queue management, backpressure drain handling).

## Decision

We extracted a shared engine adapter seam ([`TcpStreamEngine`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-common.ts)):

1. **Shared Orchestration Layer** ([`TcpStreamLayer`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-common.ts)):
   - Encapsulates `Queue`, `MutableRef`, connection retry schedules, backpressure waiters, and streaming.
   - Depends on `TcpStreamEngine` and `ConnectionConfig`.

2. **Engine Seam Protocol** (`TcpStreamEngine`):
    - Defined `TcpStreamEngineShape` requiring:
      ```typescript
      readonly connect: (
        config: ConnectionConfigShape,
        callbacks: SocketCallbacks,
      ) => Effect.Effect<RawSocketHandle, TcpStreamError, Scope.Scope>;
      ```
    - `RawSocketHandle` provides effectful `write(chunk): Effect<RawSocketWriteResult, TcpStreamError>` and `close(): Effect<void>`.
      The Platform adapter always reports `flushed: true` because `@effect/platform`'s
      `socket.writer` applies backpressure by suspending until the kernel buffer drains
      rather than returning `flushed: false` plus an `onDrain` signal; the orchestrator's
      drain-wait path stays for the Bun/Node adapters, which do report partial writes.
    - `SocketCallbacks` provides `onData`, `onDrain`, `onError`, and `onClose`.
    - `connect` may require `Scope.Scope` so an adapter's Effect-managed resources are torn down when the caller's scope closes or is interrupted, not only when `close()` is called explicitly (see [ADR 0006](0006-scope-owned-platform-engine-lifecycle.md)).

3. **Thin Engine Adapters**:
   - `src/tcp-connection-bun.ts`: Contains only `Bun.connect` mapping and exports `TcpStreamEngineBunLive`.
   - `src/tcp-connection-nodejs.ts`: Contains only `node:net` / `node:tls` mapping and exports `TcpStreamEngineNodejsLive`.

4. **Dual Layer Provisioning**:
   - Composable layer: `TcpStreamLayer` (requires `TcpStreamEngine` + `ConnectionConfig`).
   - Convenience layers: `TcpStreamBunLive(config?)` and `TcpStreamNodejsLive(config?)` packaging engine and optional config.

5. **Unified Connection Configuration**:
   - A single `ConnectionConfig` service tag.
   - TLS accepts `boolean | Bun.TLSOptions | tls.ConnectionOptions` with explanatory runtime documentation.

## Consequences

### Positive

- **Zero duplication**: Concurrency, drain synchronization, queue lifecycle, and retry backoff are implemented once and tested once.
- **Preserves ADR 0001**: Direct socket engine control is maintained with no loss of performance or lower-level capabilities.
- **High leverage & deep module**: Sockets are thin adapters (<100–150 lines); the orchestrator handles all complexity behind a clean interface.
- **Backward compatibility**: All existing imports (`TcpStreamBunLive`, `TcpStreamNodejsLive`, `TcpStreamNodeLive`, `ConnectionConfigBunLive`, `TcpStreamLive`) continue working with identical semantics.

### Trade-offs

- Adding a new runtime engine requires implementing `TcpStreamEngineShape` and mapping backpressure to `RawSocketWriteResult`.
