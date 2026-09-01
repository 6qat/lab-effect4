# Effect v3 vs Effect v4 Differences Research

## Executive Summary

Effect version 4 (`v4`) introduces significant API modernization, removing deprecated patterns and refining the core vocabulary around concurrency, layer scoping, and error handling. The shift from `v3` to `v4` emphasizes clarity (e.g., distinguishing child fiber forks from detached daemon forks), deeper integration of `Schema` natively within error modeling, and dedicated platform runtimes.

---

## 1. Error Handling and Catch Combinators

Effect v4 simplifies its error-handling combinators by dropping the `All` suffix, aligning the naming conventions more intuitively with standard JavaScript patterns.

- **`Effect.catchAll` → `Effect.catch`**: The standard error-channel recovery combinator.
- **`Effect.catchAllDefect` → `Effect.catchDefect`**: Handles unexpected defects/dies.
- **`Effect.catchAllCause` → `Effect.catchCause`**: Handles the full underlying `Cause` (interrupts, defects, and failures).
- **`Effect.catchSome` → `Effect.catchIf` / `Effect.catchSome`**: Predicate-based error catching.
- **`Effect.catchTags` / `Effect.catchTag`**: Remains and continues to support single tag or array of tags (e.g., `Effect.catchTag(["ErrorA", "ErrorB"], handler)`).

*(Source: [Effect GitHub Release Notes & Changelogs](https://github.com/Effect-TS/effect/releases))*

---

## 2. Structured Concurrency and Fibers

The fiber and forking API has been clarified to make concurrency lifetimes explicit, preventing accidental memory leaks or detached tasks.

- **`Effect.fork` → `Effect.forkChild`**: Spawns a supervised child fiber that is directly tied to the parent fiber's lifetime.
- **`Effect.forkDaemon` → `Effect.forkDetach`**: Explicitly spawns an un-parented (detached) background fiber.
- **`Effect.forkScoped` / `Effect.forkIn`**: Unchanged, used to tie fiber lifecycles to an explicit `Scope`.
- **Fiber Pools**: Heavy emphasis on `FiberSet` / `FiberHandle` for structured, scoped pools of dynamic fibers instead of manual management.

*(Source: [Effect Core API Reference](https://effect.website/docs/v4/api/effect))*

---

## 3. Layer and Scope Management

The `Layer` API underwent a structural simplification to automatically handle resource scopes.

- **`Layer.scoped` removal**: `Layer.scoped` has been removed entirely in v4.
- **`Layer.effect` scoping natively**: `Layer.effect` natively manages `Scope`. It strips `Scope.Scope` from requirements (`Exclude<R, Scope.Scope>`), executes the construction effect inside the layer's internal scope, and automatically manages lifecycles and finalizers.
- **Layer Provision**: Chaining multiple `Effect.provide` calls is flagged as an anti-pattern. Dependent layers should be merged into a single layer graph via `Layer.provide` or `Layer.merge` prior to providing them to the program.

*(Source: Effect v4 Migration Guide / GitHub Issues ([#3691](https://github.com/Effect-TS/effect/issues/3691)))*

---

## 4. Error Modeling and Schemas

Data classes for errors have been deeply integrated with the `Schema` ecosystem in v4.

- **`Data.TaggedError` → `Schema.TaggedError`**: Defines custom domain errors using `Schema.TaggedError` instead of custom classes extending `Data.TaggedError`. 
- This transition provides built-in schema validation, serialization/deserialization over the wire (JSON/RPC), and automated typing out-of-the-box.

*(Source: [Effect Docs: Schema Introduction](https://www.effect.website/docs/v4/schema/introduction))*

---

## 5. Platform Runners

Effect v4 introduces dedicated module packages and runners for specific JavaScript environments, abstracting away the boilerplate of multi-package layer composition for bootstrapping applications.

- **`@effect/platform-bun`** and **`@effect/platform-node`**: Serve as the primary entry points for these runtimes.
- **`BunRuntime.runMain` / `NodeRuntime.runMain`**: Standard execution runners replacing manual multi-package layers and `Effect.runPromise` wrapped in synchronous `try/catch` blocks at the top level.

*(Source: [Effect Docs: Installation](https://www.effect.website/docs/v4/getting-started/installation))*

---

## 6. Context and Services

- **Idiomatic tag access**: Unmanaged side-effects and unnecessary generation blocks are strictly discouraged. Services defined via `Context.Tag` (or `Effect.Tag`) should be invoked directly, instead of redundantly wrapping a single statement or Tag retrieval in `Effect.gen`.
- **`Context.Service`**: Emerging pattern as part of the Context API changes in the v4 architecture.

*(Source: [Effect Onboarding Docs](https://www.effect.website/docs/v4/onboarding))*

---

## Sources & References

- Official Effect v4 API Reference: [https://effect.website/docs/v4/api](https://effect.website/docs/v4/api)
- Effect GitHub Repository: [https://github.com/Effect-TS/effect](https://github.com/Effect-TS/effect)
- Effect Issues & Release Notes: [https://github.com/Effect-TS/effect/releases](https://github.com/Effect-TS/effect/releases)
- Local Project Rules: `lab-effect4/AGENTS.md`

