# AI Agent Instructions & Guidelines

## 1. Project Overview & Runtime

- **Runtime**: Bun / Node.js
- **Package Manager**: pnpm (configured in `devEngines`) / Bun
- **Language**: TypeScript (strict mode)

---

## 2. Effect Version 4 Conventions (`effect@4.0.0-rc.*`)

Always use **Effect v4** conventions, patterns, and APIs. Do not use legacy Effect v2/v3 signatures.

### Key Differences & Migration: Effect v3 vs. Effect v4

| Area                      | Effect v3 (Legacy)                     | Effect v4 (Current / Preferred)                  | Notes                                                                                   |
| :------------------------ | :------------------------------------- | :----------------------------------------------- | :-------------------------------------------------------------------------------------- |
| **Catch All Errors**      | `Effect.catchAll`                      | `Effect.catch`                                   | Dropped the `*All` suffix across combinators.                                           |
| **Catch Defects**         | `Effect.catchAllDefect`                | `Effect.catchDefect`                             | Handles unexpected defects / dies.                                                      |
| **Catch Causes**          | `Effect.catchAllCause`                 | `Effect.catchCause`                              | Handles full underlying `Cause` (interrupts, defects, failures).                        |
| **Catch Predicates**      | `Effect.catchSome`                     | `Effect.catchIf` / `Effect.catchSome`            | Predicate-based error catching.                                                         |
| **Tagged Errors**         | `Effect.catchTags` / `Effect.catchTag` | `Effect.catchTags` / `Effect.catchTag`           | Supports single tag or array of tags: `Effect.catchTag(["ErrorA", "ErrorB"], handler)`. |
| **Platform RunMain**      | Multi-package layers                   | `@effect/platform-bun` / `@effect/platform-node` | Dedicated `BunRuntime.runMain` and `NodeRuntime.runMain` runners.                       |
| **Data & Error Modeling** | Custom classes / `Data.TaggedError`    | `Schema.TaggedError`                             | Built-in schema validation, serialization, and typing out-of-the-box.                   |

---

### Core Effect v4 Guidelines

- **Error Handling**:
  - Use `Effect.catch` instead of deprecated `Effect.catchAll`.
  - Use `Effect.catchTag` / `Effect.catchTags` for tagged error discrimination.
  - Use `Effect.tapError` for logging errors without recovering or clearing the error channel.
  - Use `Effect.catchDefect` instead of `Effect.catchAllDefect`.
  - Use `Effect.catchCause` instead of `Effect.catchAllCause`.

- **Application Entry Point**:
  - Run top-level applications/scripts using `BunRuntime.runMain` (from `@effect/platform-bun`) or `NodeRuntime.runMain` (from `@effect/platform-node`).
  - Do not use raw `Effect.runPromise` or wrap `runMain` in synchronous `try/catch` blocks at the top level.

- **Idiomatic TypeScript & Effect Patterns**:
  - Prefer generator functions with `Effect.gen(function* () { ... })` and `yield*` for sequential, asynchronous, and contextual workflows.
  - Define custom domain errors using `Schema.TaggedError` or class declarations extending `Data.TaggedError`.
  - Prefer services defined with `Context.Tag` / `Effect.Tag` and modular layers built with `Layer`.
  - Avoid unmanaged synchronous side-effects (e.g. `console.log`, `process.exit`) within business logic. Always use Effect managed services (e.g., `Console.log`, `Console.error`, `Effect.sync`, `Effect.fail`).

---

## 3. Code Formatting & Linting

- **Formatter**: Use **Biome exclusively** for formatting code.
- Check `package.json` for canonical script commands before running formatters or linters:
  - Format: `bun run format` (or `pnpm run format`, which runs `biome format --write ./src`)
  - Lint: `bun run lint` (or `pnpm run lint`, which runs `biome lint .`)
  - Typecheck: `bun x tsc --noEmit` (or `pnpm exec tsc --noEmit`)
- Always ensure code changes pass formatting and type checking cleanly without errors.
