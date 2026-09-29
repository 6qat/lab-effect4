---
kind: external_dependency
name: Biome formatter and linter
slug: biome
category: external_dependency
category_hints:
    - vendor_identity
scope:
    - '**'
---

Biome is the sole formatting and linting tool. `bun run format` runs `biome format --write ./src && biome check --write ./src`; `bun run lint` runs `biome lint .`. Prettier and ESLint are explicitly prohibited per AGENTS.md.