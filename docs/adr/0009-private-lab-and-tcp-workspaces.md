# Private Lab and TCP Workspaces

The repository uses two private Bun workspace packages under `packages/`: `packages/lab` for general Effect examples, including the message-queue example, and `packages/tcp` for connection implementations, line framing, Cedro, the HTTP demonstration, and their tests. Keeping TCP demonstrations with their implementation preserves independent projects without introducing a cross-package API or a publishing contract.

Each project owns its sources, runtime dependencies, and TypeScript configuration; shared development tooling and commands that check both projects stay at the repository root. Bun is the authoritative installer in local development and CI, with one root `bun.lock`, replacing the inconsistent Bun/pnpm setup.

The migration preserves runtime behavior while updating source paths, launch instructions, and documentation. Old `src/` paths may be removed without compatibility wrappers; public packaging and unrelated runtime refactoring are outside this change.
