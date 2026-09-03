# Unified TCP Stream Engine Adapter Seam

## Status
Accepted

## Context
In [ADR 0001](file:///home/guiga/Devel-NT/lab-effect4/docs/adr/0001-direct-engine-socket-wrappers.md), we decided to build direct runtime engine socket wrappers (`Bun.connect` and `node:net` / `node:tls`) unified under a shared `TcpStream` service rather than adopting `@effect/platform`'s push-based `Socket.Socket.run(handler)`.

However, the initial implementation duplicated ~90% of the orchestration logic across `src/tcp-connection-bun.ts` and `src/tcp-connection-nodejs.ts`:
- Concurrency control via `Semaphore(1)` write locks
- Incoming byte streaming via `Queue.unbounded` and `Stream.fromQueue`
- Backpressure coordination via `Deferred` drain waiters
- Connection state tracking (`Open` vs `Closed`) and error propagation
- Reconnection retry scheduling with exponential backoff and jitter
- Independent, duplicated `ConnectionConfig` service tags (`ConnectionConfigBun` and `ConnectionConfigNode`)

## Decision
We extracted an internal adapter seam (`TcpStreamEngine`) and consolidated all connection lifecycle and concurrency management into a single deep orchestrator module (`TcpStream`):

1. **Minimal Engine Adapter Seam (`TcpStreamEngine`)**:
   - `SocketCallbacks`: Minimal event interface passed from `TcpStream` to the engine (`onData`, `onDrain`, `onClose`, `onError`).
   - `RawSocketHandle`: Normalized socket handle returned by the engine, exposing:
     - `write(chunk: Uint8Array): RawSocketWriteResult`: Normalizes backpressure to `{ flushed: boolean, bytesWritten: number }`, accommodating Bun's partial kernel write semantics and Node's stream buffer semantics.
     - `close(): void`: Idempotent socket termination.
   - `TcpStreamEngine`: Service with `connect(config, callbacks): Effect<RawSocketHandle, TcpStreamError>`.

2. **Deep Orchestrator (`TcpStream`)**:
   - Encapsulates incoming queues, write semaphores, drain waiters, connection state mutations, exponential backoff retries, and Effect Scope finalizers.
   - Resides in `src/tcp-connection-common.ts` / `src/tcp-connection.ts`.

3. **Thin Engine Adapters**:
   - `src/tcp-connection-bun.ts`: Contains only `Bun.connect` mapping and exports `TcpStreamEngineBunLive`.
   - `src/tcp-connection-nodejs.ts`: Contains only `node:net` / `node:tls` mapping and exports `TcpStreamEngineNodejsLive`.

4. **Dual Layer Provisioning**:
   - Composable layer: `TcpStreamLayer` (requires `TcpStreamEngine` + `ConnectionConfig`).
   - Convenience layers: `TcpStreamBunLive(config?)` and `TcpStreamNodeLive(config?)` packaging engine and optional config.

5. **Unified Connection Configuration**:
   - A single `ConnectionConfig` service tag.
   - TLS accepts `boolean | Bun.TLSOptions | tls.ConnectionOptions` with explanatory runtime documentation.

## Consequences

### Positive
- **Zero duplication**: Concurrency, drain synchronization, queue lifecycle, and retry backoff are implemented once and tested once.
- **Preserves ADR 0001**: Direct socket engine control is maintained with no loss of performance or lower-level capabilities.
- **High leverage & deep module**: Sockets are thin adapters (<100–150 lines); the orchestrator handles all complexity behind a clean interface.
- **Backward compatibility**: All existing imports (`TcpStreamBunLive`, `TcpStreamNodeLive`, `ConnectionConfigBunLive`, `TcpStreamLive`) continue working with identical semantics.

### Trade-offs
- Adding a new runtime engine requires implementing `TcpStreamEngineShape` and mapping backpressure to `RawSocketWriteResult`.
