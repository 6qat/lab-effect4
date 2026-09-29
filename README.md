# lab-effect4

A private Bun monorepo for Effect 4 experiments and TCP networking.

| Project | Contents |
| --- | --- |
| [lab](packages/lab/README.md) | Effect examples for creation, execution, control flow, errors, concurrency, and message queues. |
| [tcp](packages/tcp/README.md) | TCP engines, shared connection lifecycle, line framing, Cedro client, HTTP demonstration, and tests. |

Each project owns its source files, runtime dependencies, and TypeScript configuration. Shared development tools and the Bun lockfile live at the repository root. The two projects have no dependency on each other.

## Install and check

Run installation from the repository root:

```bash
bun install
```

CI uses `bun install --frozen-lockfile` with the root `bun.lock`.

Run checks for both projects from the root:

```bash
bun run typecheck
bun run test
bun run lint
bun run format:check
```

Use `bun run format` to apply formatting and Biome fixes. To check one project, select its directory:

```bash
bun run --cwd packages/lab typecheck
bun run --cwd packages/tcp test
```

Both projects expose `typecheck`, `test`, `lint`, `format`, and `format:check`. The lab test command succeeds when no tests are present.

## Run examples

Run individual examples from the repository root:

```bash
bun packages/lab/src/index.ts
bun packages/lab/src/running-effects.ts
bun packages/tcp/src/tcp-connection-http-example.ts --engine=bun https://example.com
```

Examples can execute work at module load. File I/O examples resolve relative filenames against the current working directory; root invocation preserves the existing location of the ignored `example.txt`.

## Design and conventions

The TCP domain vocabulary stays in [CONTEXT.md](CONTEXT.md), with decisions in [docs/adr](docs/adr/) and supporting material in [docs/research](docs/research/). The learning examples do not introduce a separate business context. See [ADR 0009](docs/adr/0009-private-lab-and-tcp-workspaces.md) for the workspace boundary and [AGENTS.md](AGENTS.md) for repository conventions.
