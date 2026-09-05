# TCP Connection Codebase — Analysis & Simplification Opportunities

## Architecture Overview

The tcp-connection subsystem has **three** independent implementations behind a unified [`TcpStream`](../src/tcp-connection-common.ts) service:

| File | Strategy | Lines |
|------|----------|-------|
| [`tcp-connection-common.ts`](../src/tcp-connection-common.ts) | Shared contracts + `makeTcpStream` orchestrator (engine-adapter pattern) | 369 |
| [`tcp-connection-bun.ts`](../src/tcp-connection-bun.ts) | Thin Bun-native engine adapter | 124 |
| [`tcp-connection-nodejs.ts`](../src/tcp-connection-nodejs.ts) | Thin Node.js engine adapter | 199 |
| [`tcp-connection-platform.ts`](../src/tcp-connection-platform.ts) | **Separate** full orchestrator using `@effect/platform` Socket.Socket | 320 |
| [`tcp-connection-http-example.ts`](../src/tcp-connection-http-example.ts) | CLI example dispatching across all three engines | 291 |
| [`tcp-connection.ts`](../src/tcp-connection.ts) | Re-export shim (backward compat) | 10 |

**Total**: ~1,313 lines of production code, ~778 lines of tests.

---

## Findings & Simplification Suggestions

### 1. `tcp-connection-platform.ts` duplicates the orchestration it was meant to eliminate

> [!IMPORTANT]
> This is the single biggest simplification opportunity.

[`makeTcpStreamPlatform`](../src/tcp-connection-platform.ts) was a **second full orchestrator** (320 lines) that re-implemented:
- `ConnectionConfig` validation
- Unbounded queue + `ConnectionState` state machine
- Retry schedule resolution via the same `Option.match` pattern
- `send` / `sendText` / `close` methods

Meanwhile, [ADR 0002](adr/0002-unified-tcp-stream-engine-adapter-seam.md) already stated *"Zero duplication: orchestration is implemented once"* — but that only held for Bun + Node.js; the platform variant bypassed the seam entirely.

**Suggestion**: Implement a `TcpStreamEnginePlatformLive` adapter that satisfies [`TcpStreamEngineShape`](../src/tcp-connection-common.ts) by wrapping `Socket.Socket.run` + `socket.writer` into the `RawSocketHandle` / `SocketCallbacks` contract. Then compose it through `TcpStreamLayer` just like Bun and Node.js do. This would:
- **Delete ~200 lines** of duplicate orchestration
- Make `tcp-connection-platform.ts` as thin as the Bun adapter (~80–120 lines)
- Truly fulfill ADR 0002's promise

**Potential obstacle**: The platform `Socket.Socket.run` is push-based and scope-managed, whereas `TcpStreamEngineShape.connect` returns an imperative `RawSocketHandle`. Bridging the two requires:
  - Adapting `RawSocketHandle` to make `write` and `close` effectful (`Effect.Effect<RawSocketWriteResult, TcpStreamError>` and `Effect.Effect<void>`), allowing both synchronous kernel writes and effectful writers.

---

### 2. `sendText` in `tcp-connection-platform.ts` is over-engineered

Previous implementation used `Stream.make → Stream.encodeText → Stream.runFold` with manual buffer concatenation to encode a string to `Uint8Array`. Compare with the common orchestrator's approach:

```typescript
const encoder = new TextEncoder();
const sendText = (data: string) => send(encoder.encode(data));
```

The platform version allocated an intermediate stream, a fold accumulator, and multiple copies — all to do what `new TextEncoder().encode(data)` does in one call.

**Suggestion**: Use the same `TextEncoder.encode` pattern from `tcp-connection-common.ts`.

---

### 3. `validateConnectionConfig` is a thin wrapper that adds no value

`validateConnectionConfig` called `validateHostAndPort`, checked for failure, and returned the original config unchanged. It could be inlined:

```typescript
// Simplified (1 function):
export const validateConnectionConfig = (config: ConnectionConfigShape) =>
  Result.map(validateHostAndPort(config.host, config.port), () => config);
```

---

### 4. The retry schedule resolution is duplicated between the two orchestrators

Both `makeTcpStream` and `makeTcpStreamPlatform` contained the exact same `retrySchedule` resolution + `Option.match` connect pattern. Collapsing Platform into the shared orchestrator removes this duplication completely.

---

### 5. `ConnectionState` type is duplicated

The same discriminated union was defined in both `tcp-connection-common.ts` and `tcp-connection-platform.ts`. Collapsing Platform into the shared engine seam eliminates the duplicate definition.

---

### 6. Backward compatibility aliases are proliferating

`tcp-connection-nodejs.ts` and `tcp-connection-bun.ts` export several legacy aliases (`ConnectionConfigBunLive`, `ConnectionConfigNodejsLive`, `TcpStreamLive`). Retained for backward compatibility with existing tests and consumers.

---

### 7. The `TcpStream*Live()` overload pattern is repeated three times

All three convenience layer factories followed identical structure.

**Suggestion**: Extract a generic factory in `tcp-connection-common.ts`:

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

---

### 8. Test files are ~90% identical

The three test files (`bun`, `nodejs`, `platform`) were near-copies of each other, differing only in:
- Which `*Live` layer was used
- Port numbers
- Test description strings

**Suggestion**: Write a shared parameterized test suite that takes a layer factory and a port range (`defineTcpStreamTestSuite`). This cuts ~350 lines of test code to ~180.

---

### 9. HTTP example's `requestProgramBun/Nodejs/Platform` are identical except the layer

Define a single parameterized `makeRequestProgram(layerFactory)` helper in `src/tcp-connection-http-example.ts`.

---

## Impact Summary

| Suggestion | Lines saved (est.) | Complexity reduction | Risk | Status |
|---|---|---|---|---|
| **#1** Collapse platform into engine seam | ~200 | ★★★★★ | Medium | Implemented |
| **#2** Simplify `sendText` in platform | ~15 | ★★ | Low | Implemented |
| **#3** Inline `validateConnectionConfig` | ~10 | ★ | None | Implemented |
| **#4** Eliminate retry schedule duplication | ~20 | ★★ | None | Implemented |
| **#5** Eliminate duplicate `ConnectionState` | ~3 | ★ | None | Implemented |
| **#6** Maintain backward compat aliases | ~0 | ★ | None | Retained |
| **#7** Generic convenience layer factory | ~30 | ★★ | None | Implemented |
| **#8** Parameterized test suite | ~350 | ★★★ | Low | Implemented |
| **#9** Single parameterized `requestProgram` | ~30 | ★★ | None | Implemented |

