# Multi-Engine HTTP Example Programs

## Status

Accepted

## Context

Following [ADR 0002](file:///home/guiga/Devel-NT/lab-effect4/docs/adr/0002-unified-tcp-stream-engine-adapter-seam.md) and [ADR 0003](file:///home/guiga/Devel-NT/lab-effect4/docs/adr/0003-effect-platform-push-socket-implementation.md), we have three distinct TCP engines available:

1. `Bun.connect` ([`tcp-connection-bun.ts`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-bun.ts))
2. `node:net` / `node:tls` ([`tcp-connection-nodejs.ts`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-nodejs.ts))
3. `@effect/platform` push socket ([`tcp-connection-platform.ts`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-platform.ts))

We needed an executable example demonstrating HTTP/1.1 requests across all three engines with clean CLI selection.

## Decision

We refactored [`src/tcp-connection-http-example.ts`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-http-example.ts) to support multi-engine execution:

1. **CLI Flag Selection with Default Engine (Q1 -> Option A)**:
   - Added `--engine=bun|nodejs|platform` command-line argument.
   - Defaults to `bun` when no `--engine` flag is specified.
   - Positional argument provides the target URL (e.g., `bun src/tcp-connection-http-example.ts --engine=nodejs https://example.com`).

2. **Unified Request Logic (Q2 -> Option A)**:
   - Extracted common HTTP formatting, sending, and response collection into `executeHttpRequest(url)`:
     ```typescript
     export const executeHttpRequest = (url: URL) =>
       Effect.gen(function* () {
         const tcp = yield* TcpStream;
         // Format HTTP GET, yield* tcp.sendText(...), Stream.runCollect(tcp.stream)
       });
     ```
   - Avoids duplicating ~30 lines of HTTP protocol formatting and streaming decode logic across the three program definitions.

3. **Direct Convenience Layer Instantiation (Q3 -> Option A)**:
   - Built a `makeConnectionConfig(url)` helper to translate URL and protocol (plain HTTP vs HTTPS with TLS SNI and ALPN) into a [`ConnectionConfigShape`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-common.ts#L107-L113).
   - Provided layers directly to the three exported program effects:
     - [`requestProgramBun`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-http-example.ts#L182-L188): provides `TcpStreamBunLive(config)`
     - [`requestProgramNodejs`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-http-example.ts#L191-L199): provides `TcpStreamNodejsLive(config)`
     - [`requestProgramPlatform`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-http-example.ts#L202-L210): provides `TcpStreamPlatformLive(config)`

4. **Program Dispatch in `main`**:
   - `main` delegates to `dispatchProgram` which dispatches to `requestProgramBun`, `requestProgramNodejs`, or `requestProgramPlatform` based on parsed CLI arguments.

## Consequences

### Positive

- Allows direct comparative execution and testing across all three engines with a single CLI command.
- Decouples HTTP request execution logic from engine layer wiring.
- Provides exported individual program effects (`requestProgramBun`, `requestProgramNodejs`, `requestProgramPlatform`) for testing and programmatic use.

### Trade-offs

- The CLI parser assumes simple single-flag `--engine=` format without full CLI framework dependencies (kept lightweight with zero extra packages).
