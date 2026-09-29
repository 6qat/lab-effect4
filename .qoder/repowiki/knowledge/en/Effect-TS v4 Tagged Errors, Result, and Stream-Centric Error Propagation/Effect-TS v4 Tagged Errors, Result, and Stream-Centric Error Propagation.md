---
kind: error_handling
name: Effect-TS v4 Tagged Errors, Result, and Stream-Centric Error Propagation
category: error_handling
scope:
    - '**'
source_files:
    - src/tcp-connection-common.ts
    - src/tcp-stream-engine.ts
    - src/cedro-protocol.ts
    - src/error-channel-operations.ts
    - src/result.ts
    - src/control-flow-operators.ts
    - src/tcp-connection-bun.ts
---

## Overview

The repository is an Effect-TS v4 example library. Error handling follows the Effect ecosystem conventions: typed failures via `Data.TaggedError`, pure failure modeling with `Result`, and stream-level error propagation through `Stream`/`Cause`. There are no custom middleware frameworks or global panic/recover handlers — errors flow explicitly through the `Effect<A, E, R>` type signature and `Stream` channels.

## Core Error Types

- **Domain-tagged errors** are defined with `Data.TaggedError`:
  - `TcpStreamError` (`tcp-connection-common.ts`) — central I/O error carrying `{ operation: "connect" | "read" | "write", message, cause? }`.
  - `ConnectionConfigError` (`tcp-connection-common.ts`) — configuration validation failure.
  - `CedroProtocolError` (`cedro-protocol.ts`) — protocol-level validation failure (missing credentials, empty ticker list).
  - `HttpError`, `MessageError`, `UnauthorizedError`, `NegativeRandomError`, `InvalidUserPayloadError` — examples in `control-flow-operators.ts` and `error-channel-operations.ts` demonstrating tagged-error usage.

All tagged errors extend a discriminated shape so callers can pattern-match on them at boundaries.

## Pure vs Async Failure Modeling

- **Pure functions** return `Result.Result<T, E>` instead of throwing or returning `Effect`. Examples:
  - `formatAuthCommand`, `formatSubCommand` in `cedro-protocol.ts` return `Result<string, CedroProtocolError>`.
  - `validateHostAndPort`, `validateConnectionConfig` in `tcp-connection-common.ts` return `Result<..., ConnectionConfigError>`.
  - `parseAge` in `result.ts` demonstrates lightweight `Result` for synchronous validation without fiber/runtime overhead.
- **Async/I-O code** uses `Effect`'s error channel. Pure `Result` values are lifted into `Effect` via `Effect.fromResult` (e.g., line 63 of `cedro-protocol.ts`).

This separation is documented inline in `result.ts`: using `Result` guarantees no blocking, no runtime requirement, and avoids noise when the error channel is never inspected.

## Error Propagation Patterns

1. **Tagged-error construction as expressions**: `new TcpStreamError({...})` and `new CedroProtocolError({...})` are used directly inside `Effect.gen` blocks; they short-circuit the effect chain.
2. **Mapping and transforming errors**:
   - `Effect.mapError` / `Effect.mapBoth` to rewrap upstream errors into domain tags (`error-channel-operations.ts`).
   - `Effect.filterOrFail` to fail with a specific tagged error when a predicate is false (used for auth null-checks and random-number validation).
3. **Stream error propagation**: The TCP engine wraps adapter `Error` events into `TcpStreamError` and propagates them via `Queue.failCauseUnsafe(queue, Cause.fail(error))` (`tcp-stream-engine.ts`). Read-side failures are squashed with `Cause.squash(exit.cause)` and converted back to `TcpStreamError` before calling `finish(error)`.
4. **Timeout and retry wrapping**:
   - `withConnectTimeout` maps timeout causes into `TcpStreamError({ operation: "connect", message: "Connection timeout", cause })`.
   - Default exponential-jittered retry schedules are built by `buildDefaultRetrySchedule` and applied via `Effect.retry(engine.connect(...), schedule)`.
5. **Layer composition**: Errors stay within the `E` type parameter of `Effect.Effect<A, E, R>`. For example, `CedroClientShape.authenticate` has type `Effect<void, TcpStreamError | CedroProtocolError>` — callers must handle both I/O and protocol errors.

## Platform-Specific Error Bridging

Platform adapters (`tcp-connection-bun.ts`, `tcp-connection-nodejs.ts`) catch raw platform exceptions in `try` blocks and convert them to `TcpStreamError` via `unknownToMessage(cause)`, which normalizes any thrown value into a string message while preserving the original `cause`.

## Test Harnesses

Tests use `try/catch` around `Effect.runPromise(...)` to assert expected failures (see `cedro-protocol.test.ts`, `tcp-connection-http-example.test.ts`). This is appropriate for test harnesses; production code relies on typed error channels rather than try/catch.

## Conventions Observed

- Prefer `Data.TaggedError` over plain `Error` subclasses for domain errors.
- Use `Result` for pure validation; lift into `Effect` only at async boundaries.
- Wrap all unknown platform errors into a single domain error type (`TcpStreamError`) at the adapter boundary.
- Preserve the original `cause` field on tagged errors for diagnostics.
- Use `Effect.retry` with configurable `Schedule` for transient network failures rather than ad-hoc loops.
- Stream consumers receive errors through the `Stream<E>` type parameter; errors terminate the stream via `Cause.fail`.
- No global error interceptors, no `panic`/`recover` usage, no unhandled promise rejections — failures are explicit in types.