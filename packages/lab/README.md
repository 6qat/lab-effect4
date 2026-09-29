# lab

Private workspace containing the general Effect 4 learning examples:

- Creating and running effects, default services, errors, and `Result`.
- Control flow and concurrency with deferred values, queues, and pubsub.
- Typed jobs and an in-memory worker layer in [src/mq/index.ts](src/mq/index.ts).

Install dependencies once from the [repository root](../../README.md). Run individual examples from that root:

```bash
bun packages/lab/src/index.ts
bun packages/lab/src/running-effects.ts
bun packages/lab/src/creating-effects.ts
```

The files are standalone experiments and may run effects immediately when imported. `creating-effects.ts` reads `example.txt` from the current working directory; keep that file at the repository root when using the commands above. File-writing demonstrations use the same working-directory convention.

Run this project's checks from the repository root:

```bash
bun run --cwd packages/lab typecheck
bun run --cwd packages/lab test
bun run --cwd packages/lab lint
bun run --cwd packages/lab format:check
```

Use `bun run --cwd packages/lab format` to apply formatting and Biome fixes. There are currently no lab test files, so its test command permits an empty suite.

TCP implementations and their demonstrations live in [tcp](../tcp/README.md). The lab has no dependency on that workspace.
