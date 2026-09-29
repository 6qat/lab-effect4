---
kind: dependency_management
name: pnpm Workspace with Lockfiles, Overrides, and Skills Lock for Effect-TS v4 Lab
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - pnpm-workspace.yaml
    - pnpm-lock.yaml
    - skills-lock.json
    - bun.lock/bun.lock
    - .github/workflows/ci.yml
---

## System / Approach

This repository is a **single-package pnpm workspace** (no nested `package.json` workspaces) that manages Node/TypeScript dependencies via **pnpm**, with a committed `pnpm-lock.yaml` lockfile. It also maintains a separate `skills-lock.json` to pin third-party Markdown-based agent skills sourced from GitHub (`mattpocock/skills`). A `bun.lock/bun.lock` file exists alongside the pnpm lock, indicating Bun is used as the runtime/test runner but not as the primary package manager.

## Key Files

- `package.json` — declares runtime dependencies (`effect`, `@effect/platform-bun`, `@effect/platform-node`, `effect-mq`) and dev dependencies (`typescript`, `@biomejs/biome`, `@types/node`, `@types/bun`, `@effect/language-service`). Scripts use `bun test`, `biome format`, and `biome lint`.
- `pnpm-workspace.yaml` — defines build allowlist entries (`@parcel/watcher`, `msgpackr-extract`) and an **override** pinning `@effect/platform-node-shared` to `4.0.0-rc.112` to resolve version conflicts within the Effect ecosystem.
- `pnpm-lock.yaml` — full deterministic lockfile (lockfileVersion `9.0`) recording exact installed versions and integrity hashes for every dependency; also records the pinned pnpm version (`^12.5.1`).
- `skills-lock.json` — pins each skill from `mattpocock/skills` by source, path, and a `computedHash`, ensuring reproducible skill content in `.agents/skills/`.
- `bun.lock/bun.lock` — Bun's own lockfile (present but secondary; runtime tests are executed via `bun test`).
- `.github/workflows/ci.yml` — CI pipeline that runs typechecking, tests, linting, and formatting on push/PR, implicitly relying on the committed lockfiles for reproducible installs.

## Architecture & Conventions

- **Single root package**: All code lives under `src/` and there are no child packages; dependency management is centralized in the root `package.json`.
- **Lockfiles committed**: Both `pnpm-lock.yaml` and `skills-lock.json` are checked in, guaranteeing deterministic builds across machines and CI.
- **Effect ecosystem version alignment**: Runtime deps pin `effect` and `@effect/platform-*` to specific `4.0.0-rc.*` pre-release versions. Cross-package incompatibilities are resolved centrally via the `overrides` section in `pnpm-workspace.yaml` (e.g., forcing `@effect/platform-node-shared` to `4.0.0-rc.112`).
- **Skills as external dependencies**: Agent skills are not npm packages; they are fetched from a GitHub repo and locked by hash in `skills-lock.json`, then copied into `.agents/skills/<name>/SKILL.md`. This is a form of vendoring driven by a lockfile rather than manual copy-paste.
- **No private registry or vendored node_modules**: There is no `.npmrc`, `NPM_TOKEN`, `NPM_REGISTRY`, or `GOPRIVATE` configuration visible. Dependencies are resolved against the public npm registry.
- **Bun as runtime, pnpm as installer**: Despite having a `bun.lock`, the declared package manager in the lockfile metadata is pnpm (`packageManagerDependencies.pnpm: specifier ^12.5.1`). Tests run through `bun test`, so Bun is the execution environment while pnpm resolves packages.

## Conventions & Constraints

- **Dependency specifiers**: Production dependencies use exact versions for tightly-coupled Effect packages (`"effect": "4.0.0-rc.109"`, `"@effect/platform-bun": "4.0.0-rc.111"`) and caret ranges for looser ones (`"effect-mq": "^0.7.0"`). Dev dependencies consistently use caret ranges (`^`).
- **Overrides over patching**: Version conflicts within the Effect ecosystem are resolved through pnpm's `overrides` in `pnpm-workspace.yaml` rather than per-package patches.
- **Build-time native modules allowed**: The `allowBuilds` list explicitly permits native addon builds for `@parcel/watcher` and `msgpackr-extract`, acknowledging that some transitive dependencies require compilation during install.
- **Deterministic skill set**: Each skill entry in `skills-lock.json` includes a `computedHash`; any drift in the upstream skill content would be detectable by comparing this hash, acting as an integrity check.
- **CI enforces lockfile consistency**: The CI workflow runs typecheck, test, lint, and format steps, which depend on the committed lockfiles; changing dependencies without committing updated lockfiles will cause CI failures on fresh installs.