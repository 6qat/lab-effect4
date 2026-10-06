# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **[`CONTEXT.md`](../../CONTEXT.md)** at the repo root defines the TCP domain vocabulary.
- **[`docs/adr/`](../adr/)** at the repo root: read ADRs that touch the area you're about to work in, including workspace decisions.
- **[`docs/research/`](../research/)**: protocol and API reference notes (e.g. [`cedro-times-and-trades.md`](../research/cedro-times-and-trades.md) for Cedro `V:` trade messages). Read the relevant note before parsing or emitting protocol messages.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

The two workspaces share the root documentation. `tcp` contains the networking domain; `lab` contains learning examples and does not introduce a separate business context.

```
/
├── CONTEXT.md
├── docs/adr/
└── packages/
    ├── lab/src/
    └── tcp/src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR 0008 (Caller-First TCP Stream Engine), but worth reopening because…_
