# AGENTS.md

Welcome! This repository (`lab-effect4`) is built using **TypeScript**, **Effect version 4** (`effect@4.0.0-rc.*`, `@effect/platform-bun@4.0.0-rc.*`), and **Bun** as the primary runtime and package runner.

All AI agents and contributors working in this codebase **must strictly adhere** to the conventions and guidelines described below.

---

## 1. Effect Version 4 Conventions

This project targets **Effect v4**. Do not use deprecated Effect v3 patterns or combinators.

### Effect v3 vs. Effect v4 Key Differences

| Concept / Action          | Effect v3                              | Effect v4                                        | Description & Notes                                                                     |
| :------------------------ | :------------------------------------- | :----------------------------------------------- | :-------------------------------------------------------------------------------------- |
| **Catch All Errors**      | `Effect.catchAll`                      | `Effect.catch`                                   | Standard error-channel recovery combinator.                                             |
| **Catch Defects**         | `Effect.catchAllDefect`                | `Effect.catchDefect`                             | Handles unexpected defects / dies.                                                      |
| **Catch Causes**          | `Effect.catchAllCause`                 | `Effect.catchCause`                              | Handles full underlying `Cause` (interrupts, defects, failures).                        |
| **Catch Predicates**      | `Effect.catchSome`                     | `Effect.catchIf` / `Effect.catchSome`            | Predicate-based error catching.                                                         |
| **Tagged Errors**         | `Effect.catchTags` / `Effect.catchTag` | `Effect.catchTags` / `Effect.catchTag`           | Supports single tag or array of tags: `Effect.catchTag(["ErrorA", "ErrorB"], handler)`. |
| **Fork Child Fiber**      | `Effect.fork`                          | `Effect.forkChild`                               | Explicitly forks a supervised child fiber bound to parent fiber lifetime.               |
| **Fork Daemon Fiber**     | `Effect.forkDaemon`                    | `Effect.forkDetach`                              | Forks an un-parented / detached background fiber.                                       |
| **Fork In Scope**         | `Effect.forkScoped` / `Effect.forkIn`  | `Effect.forkScoped` / `Effect.forkIn`            | Forks a fiber bound to the current or supplied `Scope`.                                 |
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

- **Concurrency & Fibers**:
  - Use `Effect.forkChild` to spawn supervised child fibers tied to parent lifetime (replaces `Effect.fork`).
  - Use `Effect.forkDetach` to spawn detached/daemon background fibers (replaces `Effect.forkDaemon`).
  - Use `Effect.forkScoped` or `Effect.forkIn` to tie fiber lifecycles to an explicit `Scope`.
  - Use `FiberSet` / `FiberHandle` for structured, scoped pools of fibers.

- **Layer Composition & Providing**:
  - **Never chain multiple `Effect.provide` calls** (flags `effect(multipleEffectProvide)`).
  - Always compose dependent layers using `Layer.provide` / `Layer.merge` into a single layer graph before providing to effects:
    ```typescript
    // Correct:
    const tcpLayer = TcpStreamLive().pipe(Layer.provide(configLayer));
    const programWithLayer = program.pipe(Effect.provide(tcpLayer));
    ```

- **Application Entry Point**:
  - Run top-level applications/scripts using `BunRuntime.runMain` (from `@effect/platform-bun`) or `NodeRuntime.runMain` (from `@effect/platform-node`).
  - Do not use raw `Effect.runPromise` or wrap `runMain` in synchronous `try/catch` blocks at the top level.

- **Idiomatic TypeScript & Effect Patterns**:
  - Prefer generator functions with `Effect.gen(function* () { ... })` and `yield*` for sequential, multi-step asynchronous, and contextual workflows.
  - Avoid wrapping a single statement or Tag retrieval in `Effect.gen` (`effect(unnecessaryEffectGen)`). Use the Effect or Tag directly:
    ```typescript
    // ❌ Redundant:
    Effect.gen(function* () {
      return yield* TcpStream;
    });
    // ✅ Direct:
    TcpStream;
    ```
  - Define custom domain errors using `Schema.TaggedError` or class declarations extending `Data.TaggedError`.
  - Prefer services defined with `Context.Tag` / `Effect.Tag` and modular layers built with `Layer`.
  - Avoid unmanaged synchronous side-effects (e.g. `console.log`, `process.exit`) within business logic. Always use Effect managed services (e.g., `Console.log`, `Console.error`, `Effect.sync`, `Effect.fail`).

---

## 2. Code Formatting & Linting

Code formatting and linting are strictly enforced via **Biome**:

- **Format Command**: `bun run format` (formats `./src` via `biome format --write ./src`)\
- **Lint Command**: `bun run lint` (lints the repository via `biome lint .`)
- **Do not use Prettier or ESLint.**

Always check [`package.json`](./package.json) for the exact scripts and execute `bun run format` and `bun run lint` before committing any changes.

---

## 3. Type Checking

TypeScript types must compile cleanly with zero errors:

```bash
bun x tsc --noEmit
# or
pnpm exec tsc --noEmit
```

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository using root-level `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
