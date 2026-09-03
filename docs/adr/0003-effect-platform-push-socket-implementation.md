# Effect Platform Push Socket Implementation

## Status
Accepted

## Context
In [ADR 0001](file:///home/guiga/Devel-NT/lab-effect4/docs/adr/0001-direct-engine-socket-wrappers.md) and [ADR 0002](file:///home/guiga/Devel-NT/lab-effect4/docs/adr/0002-unified-tcp-stream-engine-adapter-seam.md), we established direct runtime socket engine adapters (`Bun.connect` and `node:net`/`node:tls`) unified under a shared `TcpStream` orchestrator.

To provide a comprehensive benchmark and evaluate Effect's native ecosystem abstractions, we wanted to create a third TCP implementation powered directly by `@effect/platform`'s push-based `Socket.Socket` (`NodeSocket.makeNet` / `NodeSocket.fromDuplex`).

## Decision
We implemented `TcpStreamPlatformLive` under the `-platform` suffix in [`src/tcp-connection-platform.ts`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-platform.ts):

1. **Suffix Selection**:
   - Chose `-platform` (`src/tcp-connection-platform.ts` and `src/tcp-connection-platform.test.ts`) to align with `@effect/platform` terminology (*Q1 -> Option A*).

2. **Parallel `TcpStream` Layer**:
   - Built a direct parallel layer (`TcpStreamPlatformLive`) implementing [`TcpStreamShape`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-common.ts) (*Q2 -> Option A*).
   - Avoided shoehorning `@effect/platform`'s effectful `socket.writer` into the synchronous `RawSocketHandle.write` signature of `TcpStreamEngine`.

3. **Push-to-Pull Queue Bridge**:
   - Bridged `socket.run(chunk => Queue.offerUnsafe(incoming, chunk))` to an unbounded Effect `Queue`, consumed downstream as a pull-based `Stream.fromQueue(incoming)` (*Q3 -> Option A*).

4. **Connection Readiness Handshake**:
   - Used a `Deferred<void, TcpStreamError>` passed to `socket.run(..., { onOpen })` and awaited during connection setup (*Q4 -> Option A*).
   - This ensures that connection failures (e.g. `ECONNREFUSED`) fail the connection attempt early and trigger configured retry schedules before the `TcpStream` service is returned.
   - Used isolated child scopes per attempt (`Scope.fork(parentScope, "sequential")`) so failed retry attempts clean up immediately without leaking listeners.

5. **Dual-Mode TLS & Plain TCP**:
   - Plain TCP connects via `NodeSocket.makeNet({ host, port })`.
   - Encrypted TLS connects via `NodeSocket.fromDuplex(...)` wrapping Node's `tls.connect` (*Q5 -> Option A*).

6. **Tag-Based Error Mapping**:
   - Mapped typed `SocketError` reasons (`SocketOpenError`, `SocketWriteError`, `SocketReadError`, `SocketCloseError`) into domain `TcpStreamError` instances with explicit operation tags (*Q6 -> Option A*).

## Consequences

### Positive
- Allows direct comparative benchmarking between native engine wrappers (`-bun`, `-nodejs`) and `@effect/platform`'s official socket abstractions (`-platform`).
- Provides 100% API compatibility (`TcpStreamShape`) across all 3 implementations.
- Maintains full support for connection retries (`buildDefaultRetrySchedule`), TLS, and binary/text streaming.

### Trade-offs
- `@effect/platform`'s `fromDuplex` uses Node streams under the hood, adding an extra layer of abstraction compared to native engine wrappers.
