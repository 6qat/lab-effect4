---
kind: logging_system
name: Logging via Effect Console with ad-hoc console.log in examples
category: logging_system
scope:
    - '**'
source_files:
    - packages/lab/src/control-flow-if.ts
    - packages/lab/src/concurrency-deferred.ts
    - packages/lab/src/concurrency-queue.ts
    - packages/lab/src/control-flow-loop.ts
    - packages/lab/src/control-flow-zip.ts
    - packages/tcp/src/tcp-connection-http-example.ts
---

## What system/approach is used

The repository has **no dedicated logging framework, logger abstraction, log-level strategy, or structured-log configuration**. Output is produced in two ways:

1. **Effect's built-in `Console` / `Effect.log`** — the only logging API imported from the `effect` package and used inside Effect programs.
2. **Bare `console.log`** calls scattered in example files under `packages/lab/src/`, typically at program boundaries (`Effect.runPromise(...).then(console.log)`) or for quick debugging.

There is no custom logger module, no log levels (debug/info/warn/error), no sink configuration, no file/console/telemetry routing, and no initialization of a global logger.

## Key files and packages

- `packages/lab/src/control-flow-if.ts` — imports `Console` from `effect` and uses `yield* Console.log("Heads")` / `Console.log("Tails")` inside an `Effect.gen` program.
- `packages/lab/src/concurrency-deferred.ts` — mixes `yield* Effect.log(value)` with many bare `console.log(...)` calls; also demonstrates `Effect.runPromise(_program3).then(() => console.log("End."))`.
- `packages/lab/src/concurrency-queue.ts` — uses `yield* Effect.log(`Size: ${size}`)`.
- `packages/lab/src/control-flow-loop.ts` — uses `yield* Effect.log(`Processing step ${count}`)`.
- `packages/lab/src/control-flow-zip.ts` — uses `Effect.tap(Console.log("task1 done"))` and `Effect.tap(Console.log("task2 done"))`.
- `packages/tcp/src/tcp-connection-http-example.ts` — uses `yield* Console.log(response)` for normal output and `Console.error(...)` in `Effect.catchTag` / `Effect.tapError` handlers to report TCP errors, CLI usage errors, unsupported protocols, invalid URLs, and unsupported engines.

## Architecture and conventions

- Logging lives **inline in each example/example program**; there is no shared logging utility or module.
- Inside Effect programs, side effects are expressed through Effect's effect types: `Console.log` and `Console.error` are Effects themselves, invoked with `yield*` (generator style) or composed via `pipe` / `Effect.tap` / `Effect.tapError`.
- Error reporting in the TCP HTTP example follows a consistent pattern: `Effect.catchTag("TcpStreamError", ...)` prints a formatted error message including `error.operation`, `error.message`, and `error.cause`; `Effect.tapError` branches on specific error tags (`MissingCliArgError`, `UnsupportedProtocolError`, `InvalidUrlError`, `UnsupportedEngineError`) and emits user-facing messages via `Console.error`.
- Bare `console.log` is used only at the edges of programs (e.g., `Effect.runPromise(result).then(console.log)`) — not inside Effect programs — suggesting it is reserved for top-level result printing rather than structured logging.

## Conventions and constraints

- **Observed convention**: Example code that needs to emit logs does so by importing `Console` (and sometimes `Effect.log`) directly from `effect` and using them as Effects inside `Effect.gen` blocks. There is no central logger factory or configuration file.
- **Observed convention**: The TCP library's user-facing program (`tcp-connection-http-example.ts`) routes all error output through `Console.error` inside `catchTag` / `tapError` handlers, keeping error messages human-readable and tag-specific.
- **No enforced rules**: There is no lint rule, type constraint, or documented policy enforcing a particular log level, structured field shape, or sink. The absence of any logging configuration means these are descriptive patterns, not requirements.
- **No structured logging**: No JSON log records, no correlation IDs, no timestamp fields, no log levels beyond the implicit distinction between `Console.log` (info-like) and `Console.error` (error-like).
- **No runtime configuration**: There is no environment variable, config object, or Layer wiring that controls verbosity or output destinations.