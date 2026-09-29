---
kind: configuration_system
name: 'Repository Configuration: Tooling, Editor, and Runtime Config Files'
category: configuration_system
scope:
    - '**'
source_files:
    - package.json
    - pnpm-workspace.yaml
    - tsconfig.json
    - .github/workflows/ci.yml
    - .zed/settings.json
    - .zed/tasks.json
    - .kilo/kilo.jsonc
    - docker-compose.yml
    - scripts/sync-zed-prompts.mjs
---

This repository does not implement a runtime application configuration system (no config loader, env-var parser, feature-flag registry, or secrets manager). Instead, configuration is expressed entirely through static declarative files that govern tooling, editor behavior, CI, and local service orchestration. The patterns are:

1. **Package & workspace configuration** — `package.json` declares the project metadata, scripts (`test`, `format`, `lint`, `sync-prompts`), dependencies (`effect`, `@effect/platform-bun`, `@effect/platform-node`, `effect-mq`), and devDependencies (`typescript`, `@biomejs/biome`, `@types/bun`, `@types/node`). `pnpm-workspace.yaml` pins pnpm build overrides for specific packages and enforces an override of `@effect/platform-node-shared` to `4.0.0-rc.112`. `bun.lock` and `pnpm-lock.yaml` lock dependency versions.

2. **TypeScript compilation configuration** — `tsconfig.json` sets `module: "nodenext"`, `target: "esnext"`, `strict: true`, `verbatimModuleSyntax: true`, `isolatedModules: true`, `moduleDetection: "force"`, `skipLibCheck: true`, and enables source maps, declarations, and declaration maps. It also registers the `@effect/language-service` plugin. Types are restricted to `["node", "bun"]`.

3. **Editor configuration (Zed)** — `.zed/settings.json` configures format-on-save and wires TypeScript, JavaScript, JSON, and JSONC formatting to run `bunx biome format --stdin-file-path {buffer_path}`. `.zed/tasks.json` defines two debug tasks that launch Bun with `--inspect` / `--inspect-brk` on `$ZED_FILE`, targeting the Zed debugger URL `ws://127.0.0.1:6499/zed`.

4. **Kilo AI editor integration** — `.kilo/kilo.jsonc` points to the Kilo schema endpoint (`https://app.kilo.ai/config.json`) and is otherwise minimal; agent skill definitions live under `.agents/skills/*/agents/openai.yaml` (e.g., `allow_implicit_invocation: false` policy in `ask-matt`).

5. **CI configuration** — `.github/workflows/ci.yml` runs on push to `master` and all pull requests. It uses `pnpm/action-setup@v4` (version 11.21.0) and `oven-sh/setup-bun@v2` (Bun 1.4.1), installs deps with `pnpm install --frozen-lockfile`, then runs `bun x tsc --noEmit`, `bun test`, `bun run lint`, and `bun x biome format ./src` as separate steps.

6. **Local service configuration** — `docker-compose.yml` defines a single `redis` service using `redis:latest`, exposing port 6379, mounting a named volume `redis_data`, running with `--appendonly yes`, and health-checking via `redis-cli ping` every 10s with a 5s timeout and 5 retries.

7. **Sync script** — `scripts/sync-zed-prompts.mjs` (invoked via `pnpm sync-prompts`) synchronizes agent prompts into Zed's workspace, tying the skills library to editor configuration.

There is no runtime configuration loading code in `src/`; the Effect-TS programs in `src/` use platform abstractions from `@effect/platform-*` rather than reading environment variables or config files directly. All behavioral variation is controlled by the static configuration files listed above.