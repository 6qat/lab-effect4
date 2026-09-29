---
kind: build_system
name: pnpm + Bun Build & CI Pipeline for Effect-TS v4 Examples
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - tsconfig.json
    - .github/workflows/ci.yml
    - pnpm-workspace.yaml
    - docker-compose.yml
    - scripts/sync-zed-prompts.mjs
---

## What system/approach is used

This repository is a **single-package pnpm workspace** built with **Bun** as the runtime and test runner, **TypeScript** (v7) for compilation/typechecking, and **Biome** for linting/formatting. There are no Makefiles or shell build scripts; all build orchestration lives in `package.json` scripts and GitHub Actions.

- **Package manager**: pnpm (`pnpm-workspace.yaml`, `pnpm-lock.yaml`). The workspace declares overrides to pin transitive dependency versions (e.g. `@effect/platform-node-shared: 4.0.0-rc.112`) and allows specific native builds (`@parcel/watcher`, `msgpackr-extract`).
- **Runtime / test runner**: Bun (`bun test`, `bun x tsc`, `bun run ...`). Tests are co-located next to source files (`*.test.ts`) and executed via `bun test`.
- **Compiler**: TypeScript with `module: "nodenext"`, `target: "esnext"`, `strict: true`, `verbatimModuleSyntax: true`, `isolatedModules: true`, `moduleDetection: "force"`. No `outDir`/`rootDir` — the project is not published as a compiled artifact; it runs directly from `src/`.
- **Lint/format**: Biome v2 (`biome format --write`, `biome check --write`, `biome lint .`).
- **CI**: GitHub Actions (`.github/workflows/ci.yml`) on push to `master` and all pull requests.
- **Containerization**: A `docker-compose.yml` that only spins up a Redis service for local development/testing; there is no Dockerfile and no image built for this repo.

## Key files and packages

- `package.json` — defines the four npm scripts (`test`, `format`, `lint`, `sync-prompts`) and pins all dependencies, including `effect@4.0.0-rc.109`, `@effect/platform-bun@4.0.0-rc.111`, `@effect/platform-node@4.0.0-rc.111`, plus dev deps `typescript`, `@biomejs/biome`, `@types/bun`, `@types/node`, `@effect/language-service`.
- `tsconfig.json` — strict TS config with `nodenext` module resolution, declaration+map generation enabled, and the `@effect/language-service` plugin.
- `.github/workflows/ci.yml` — single `verify` job on `ubuntu-24.04` that installs pnpm 11.21.0 and Bun 1.4.1, then runs `pnpm install --frozen-lockfile`, `tsc --noEmit`, `bun test`, `bun run lint`, and `biome format ./src`.
- `pnpm-workspace.yaml` — workspace-level overrides and allowed native builds.
- `docker-compose.yml` — local Redis service (health-checked, append-only mode) used by TCP/connection tests.
- `scripts/sync-zed-prompts.mjs` — helper script invoked via `pnpm sync-prompts` to copy agent skill Markdown into Zed's `.zed/prompts` directory.

## Architecture and conventions

- **No publishable artifact**: The project has no `main` entry beyond a placeholder `index.js`, no `dist/` output, and no packaging step. It is treated as an executable example library that runs directly from source under Bun.
- **Tests alongside sources**: Every feature file has a sibling `*.test.ts` (e.g. `cedro-protocol.test.ts`, `tcp-connection-bun.test.ts`, `tcp-stream-engine.test.ts`). Tests target platform-specific implementations (`tcp-connection-bun.ts`, `tcp-connection-nodejs.ts`, `tcp-connection-platform.ts`) through a shared `tcp-connection-test-suite.ts`.
- **Platform abstraction**: The build does not differentiate platforms at compile time; instead, separate source files implement per-platform behavior and tests select the appropriate one. This avoids cross-compilation concerns — the same codebase runs under both Bun and Node via different imports.
- **Dependency pinning strategy**: Runtime dependencies use exact `-rc.x` versions; workspace-level `overrides` in `pnpm-workspace.yaml` force a specific version of a transitive dependency (`@effect/platform-node-shared`) to resolve conflicts between Effect packages.
- **Formatting/linting as gate**: The CI pipeline treats formatting as a failure condition (`biome format ./src` without `--write`), so style drift is rejected automatically.
- **Local dev services**: Redis is provisioned via docker-compose for integration-style tests rather than mocked in-process.

## Conventions and constraints

- **Run everything through Bun**: All commands in CI and scripts use `bun` (or `bun x` to invoke binaries like `tsc` and `biome`), ensuring consistent toolchain versions across environments.
- **Frozen lockfile in CI**: `pnpm install --frozen-lockfile` enforces that dependency changes must go through explicit updates that regenerate the lockfile.
- **Strict TypeScript enforced**: `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, and `moduleDetection: "force"` are non-negotiable compiler flags in `tsconfig.json`.
- **No emitted JS**: `tsc` is invoked with `--noEmit` in CI; the project never produces a `dist/` bundle.
- **Biome is the sole formatter/linter**: No ESLint/Prettier; all style rules live under Biome configuration (inherited defaults).
- **Single CI job**: The workflow runs one `verify` job sequentially performing typecheck → test → lint → format-check; there is no matrix over Node/Bun versions.
- **Redis required for some tests**: Platform connection tests depend on a running Redis instance started via `docker-compose`; absence of the container will cause those tests to fail.