# Implementation Plan: Simplify TCP Connection Architecture and Subsystem

This document records the technical implementation plan executed to simplify the `tcp-connection` subsystem based on [`analysis.md`](./analysis.md).

## Objectives

1. Collapse [`tcp-connection-platform.ts`](../src/tcp-connection-platform.ts) from a 320-line duplicate orchestrator into a thin engine adapter satisfying [`TcpStreamEngineShape`](../src/tcp-connection-common.ts).
2. Unify [`RawSocketHandle`](../src/tcp-connection-common.ts) to return effects for `write` and `close`, which accommodates both synchronous kernel writes (Bun/Node) and asynchronous effectful writers (Platform `Socket.Socket`).
3. Simplify [`validateConnectionConfig`](../src/tcp-connection-common.ts) using direct `Result.map`.
4. Provide a generic [`makeConvenienceLayer`](../src/tcp-connection-common.ts) factory to deduplicate the identical `TcpStream*Live()` overload definitions across Bun, Node.js, and Platform.
5. Parameterize [`requestProgram`](../src/tcp-connection-http-example.ts) in `tcp-connection-http-example.ts`.
6. Extract shared test cases into `tcp-connection-test-suite.ts` to deduplicate ~350 lines across `tcp-connection-bun.test.ts`, `tcp-connection-nodejs.test.ts`, and `tcp-connection-platform.test.ts` while keeping separate test runners and full coverage.

## Public API & Backward Compatibility

All public API surface area is preserved:
- `TcpStreamBunLive`, `TcpStreamNodejsLive`, `TcpStreamPlatformLive` function overloads and behavior remain identical.
- Backward-compatible aliases (`TcpStreamLive`, `ConnectionConfigBunLive`, `ConnectionConfigNodejsLive`, etc.) are retained.
- CLI commands, options, and error handling in `tcp-connection-http-example.ts` remain unchanged.
- All unit and integration tests continue to run and pass.

## Changes Grouped by Component

### Core Shared Abstractions

#### [`src/tcp-connection-common.ts`](../src/tcp-connection-common.ts)
- Updated `RawSocketHandle` to make `write` and `close` effectful:
  ```typescript
  export interface RawSocketHandle {
    readonly write: (chunk: Uint8Array) => Effect.Effect<RawSocketWriteResult, TcpStreamError>;
    readonly close: () => Effect.Effect<void>;
  }
  ```
- Simplified `validateConnectionConfig`:
  ```typescript
  export const validateConnectionConfig = (
    config: ConnectionConfigShape,
  ): Result.Result<ConnectionConfigShape, ConnectionConfigError> =>
    Result.map(validateHostAndPort(config.host, config.port), () => config);
  ```
- In `makeTcpStream`:
  - Directly yields `socketHandle.write(chunkToWrite)`.
  - In socket finalizer and `close` handler, yields `socketHandle.close().pipe(Effect.catch(() => Effect.void))`.
- Added reusable `makeConvenienceLayer`:
  ```typescript
  export interface ConvenienceLayer<S> {
    (config: ConnectionConfigShape): Layer.Layer<S>;
    (): Layer.Layer<S, never, ConnectionConfig>;
  }

  export const makeConvenienceLayer = (
    engineLayer: Layer.Layer<TcpStreamEngine>,
  ): ConvenienceLayer<TcpStream> => {
    const base = TcpStreamLayer.pipe(Layer.provide(engineLayer));
    function layer(config: ConnectionConfigShape): Layer.Layer<TcpStream>;
    function layer(): Layer.Layer<TcpStream, never, ConnectionConfig>;
    function layer(config?: ConnectionConfigShape) {
      return config !== undefined
        ? base.pipe(Layer.provide(ConnectionConfigLive(config)))
        : base;
    }
    return layer;
  };
  ```

### Engine Adapters

#### [`src/tcp-connection-bun.ts`](../src/tcp-connection-bun.ts)
- `TcpStreamEngineBunLive` raw handle wraps `socket.write(chunk)` and `socket.flush()` in `Effect.try`, and `socket.end()` in `Effect.sync`.
- Uses `makeConvenienceLayer(TcpStreamEngineBunLive)`.

#### [`src/tcp-connection-nodejs.ts`](../src/tcp-connection-nodejs.ts)
- `makeTcpStreamEngineNodejs` raw handle wraps `socket.write(chunk)` in `Effect.try`, and `socket.destroy()` in `Effect.sync`.
- Uses `makeConvenienceLayer(TcpStreamEngineNodejsLive)`.

#### [`src/tcp-connection-platform.ts`](../src/tcp-connection-platform.ts)
- Removed duplicate orchestrator (`makeTcpStreamPlatform`, queue management, `ConnectionState`, etc.).
- Implemented `TcpStreamEnginePlatformLive` satisfying `TcpStreamEngineShape`:
  - `write`: Maps `writer(chunk)` to `RawSocketWriteResult` (`flushed: true`).
  - `close`: Closes the child scope cleanly.
- Defined `TcpStreamPlatformLive = makeConvenienceLayer(TcpStreamEnginePlatformLive)`.

### HTTP Example Application

#### [`src/tcp-connection-http-example.ts`](../src/tcp-connection-http-example.ts)
- Parameterized HTTP programs with `makeRequestProgram(layerFactory)`.

### Test Suites

#### [`src/tcp-connection-test-suite.ts`](../src/tcp-connection-test-suite.ts)
- Parameterized test runner `defineTcpStreamTestSuite` testing:
  1. Retry exhaustion on unreachable port.
  2. Immediate failure when `retry: false`.
  3. Custom `retrySchedule` support.
  4. Server recovery during retry backoff window.
  5. Binary data round-trip and graceful socket closing.
  6. Composable layer composition test.

#### Test Files
- `src/tcp-connection-bun.test.ts`: Replaced ~195 lines with `defineTcpStreamTestSuite` invocation.
- `src/tcp-connection-nodejs.test.ts`: Replaced ~189 lines with `defineTcpStreamTestSuite` invocation.
- `src/tcp-connection-platform.test.ts`: Replaced ~189 lines with `defineTcpStreamTestSuite` invocation.

## Verification Plan & Outcome

- **Automated Tests**: 48 passed, 0 failed across 6 test files (`bun test`).
- **Type Checking**: Clean (`bun x tsc --noEmit`).
- **Linting & Formatting**: Clean (`bun run lint && bun run format`).
- **Manual CLI Verification**: Tested `bun src/tcp-connection-http-example.ts` with `--engine=bun`, `--engine=nodejs`, and `--engine=platform` against local echo server. All 3 succeeded.

