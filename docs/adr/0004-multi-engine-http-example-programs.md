# Multi-Engine HTTP Example Programs

## Status
Accepted

## Context
With three TCP implementations available in the codebase:
1. [`src/tcp-connection-bun.ts`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-bun.ts) (Bun native socket)
2. [`src/tcp-connection-nodejs.ts`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-nodejs.ts) (Node.js `net`/`tls`)
3. [`src/tcp-connection-platform.ts`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-platform.ts) (`@effect/platform` push-based `Socket.Socket.run`)

The CLI script [`src/tcp-connection-http-example.ts`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-http-example.ts) previously only ran a single hardcoded program (`requestProgram`) backed by the Bun implementation. We needed to refactor it to expose three distinct, runnable programs, one for each runtime engine, allowing comparative execution and verification.

## Decision

We replaced `requestProgram` in [`src/tcp-connection-http-example.ts`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-http-example.ts) with three distinct exported programs:

1. **CLI Engine Selection in `main` (Q1 -> Option A)**:
   - Command-line parsing extracts an optional `--engine=bun|nodejs|platform` flag (or `-e <engine>`), defaulting to `bun` when omitted.
   - Preserves backward compatibility: `bun src/tcp-connection-http-example.ts <url>` continues to use `bun` without requiring changes.
   - Added typed [`UnsupportedEngineError`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-http-example.ts#L27-L31) for unknown engine names.

2. **Extracted Contextual Request Effect (Q2 -> Option A)**:
   - Formatted the HTTP GET request and response accumulation in a shared `executeHttpRequest(url)` generator requiring [`TcpStream`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-common.ts#L22-L33) in the Effect context:
     ```typescript
     const executeHttpRequest = (url: URL) =>
       Effect.gen(function* () {
         const tcp = yield* TcpStream;
         // Send GET request, collect Stream chunks, decode UTF-8 incrementally, log response
       });
     ```
   - Avoids duplicating ~30 lines of HTTP protocol formatting and streaming decode logic across the three program definitions.

3. **Direct Convenience Layer Instantiation (Q3 -> Option A)**:
   - Built a `makeConnectionConfig(url)` helper to translate URL and protocol (plain HTTP vs HTTPS with TLS SNI and ALPN) into a [`ConnectionConfigShape`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-common.ts#L107-L113).
   - Provided layers directly to the three exported program effects:
     - [`requestProgramBun`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-http-example.ts#L182-L188): provides `TcpStreamBunLive(config)`
     - [`requestProgramNodejs`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-http-example.ts#L191-L199): provides `TcpStreamNodeLive(config)`
     - [`requestProgramPlatform`](file:///home/guiga/Devel-NT/lab-effect4/src/tcp-connection-http-example.ts#L202-L210): provides `TcpStreamPlatformLive(config)`

4. **Program Dispatch in `main`**:
   - `main` delegates to `selectedProgram` which dispatches to `requestProgramBun`, `requestProgramNodejs`, or `requestProgramPlatform` based on parsed CLI arguments.

## Consequences

### Positive
- Demonstrates runtime parity: all 3 TCP engines execute identical HTTP GET queries and return identical responses against real HTTP/HTTPS endpoints.
- Each program is exported as a standalone Effect, making them directly importable and testable in other modules or test suites.
- Clean separation of concerns between HTTP protocol formatting (`executeHttpRequest`), configuration extraction (`makeConnectionConfig`), and runtime dependency injection (`requestProgram*`).
