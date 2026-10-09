# Matt Pocock Skills

A practical guide to the Matt Pocock engineering workflow installed in this repository. The skills are composable: use the flow that fits the work, and invoke a standalone skill when you only need that discipline.

## How to invoke skills

For a **user-invoked** skill, type its slash command (for example, `/grill-with-docs`). These skills do not run automatically. **Model-invoked** skills can be selected by the agent when relevant; you can also ask for one directly by name (for example, “Use the `pr` skill to draft the PR body”).

Each skill’s `SKILL.md` is its full, authoritative procedure. Start with `/ask-matt` if you are unsure which skill or flow applies.

## Before the first engineering flow

Run `/setup-matt-pocock-skills` once when a repository has not been configured. It establishes the issue tracker, triage labels, and domain-document layout the other skills rely on. This repository already documents GitHub Issues, the canonical triage labels, root `GLOSSARY.md`, and `docs/adr/`; see `AGENTS.md` and `docs/agents/`.

## Common workflows

### Build a feature

1. Use `/grill-with-docs` to clarify the idea while updating the project glossary and recording important decisions in ADRs. Use `/grill-me` when there is no working repository; it does not write project docs.
2. For a design question that needs a runnable example or UI, use `/handoff` to carry the question into a separate prototype, run `/prototype`, then hand the findings back.
3. For a multi-session feature, use `/to-spec` to produce a spec, then `/to-tickets` to break it into ordered, dependency-aware tickets.
4. Choose an implementation path:
   - **`/implement`** builds one ticket at a time. Start a fresh context for each ticket when appropriate; the skill uses `/tdd` and finishes with `/code-review`.
   - **`/implement-spec`** builds the whole ticketed spec in one run. It treats tickets as a dependency graph, runs implementer subagents in separate worktrees across the ready frontier, and integrates the results on one branch. Choose it when you want the agent to orchestrate the full build rather than drive tickets individually.
5. When preparing a pull request, use **`pr`** to write its body. It asks for a concise visual summary, before/after evidence, and a call on merge risk and blast radius; it drafts text rather than creating or submitting the PR.
6. Before clearing the session, run **`/retro`** to identify improvements to the agent’s environment for future work. It focuses on navigation, checks, standards, steering, tools, and information access—not code changes.

### Handle bugs and incoming work

- **Hard, intermittent, or performance bug:** `/diagnosing-bugs` establishes a feedback loop that reproduces the failure, investigates, fixes it, and adds regression coverage. Follow with `/retro` to identify prevention opportunities. Use `/improve-codebase-architecture` if the underlying issue is a missing design seam.
- **Untriaged incoming issue or request:** `/triage` verifies and classifies incoming work, then prepares agent-ready issues. Do not triage tickets that `/to-tickets` already created.
- **Large, unclear effort spanning sessions:** `/wayfinder` maps unresolved decisions as linked decision tickets. It plans the route; it does not implement the feature. Once the map is clear, continue with `/to-spec`, `/to-tickets`, then an implementation path above.

## Skill reference

### Routing, planning, and implementation

- **`ask-matt`** — route yourself to the right skill or workflow.
- **`grill-with-docs`** — interview through a feature idea and maintain `GLOSSARY.md` and ADRs as decisions settle.
- **`grill-me`** — the same kind of interview without repository documents.
- **`grilling`** — the interview discipline used by the grilling and triage workflows.
- **`prototype`** — build a throwaway, shareable prototype to answer one design question.
- **`to-spec`** — synthesize the agreed idea into a spec in the configured issue tracker.
- **`to-tickets`** — split a spec or plan into dependency-aware, tracer-bullet tickets.
- **`implement`** — implement a ticket with test-driven slices, then review the result.
- **`implement-spec`** — implement all tickets for a spec across the dependency graph, using parallel subagents and a shared integration branch.
- **`tdd`** — guide a red-green test-first implementation at agreed public seams.
- **`code-review`** — review changes against repository standards and the originating issue/spec.
- **`pr`** — draft a PR body with a visual summary, evidence, and merge-risk assessment.
- **`retro`** — suggest ranked improvements to the coding agent’s environment after a session.

### Incoming work, bugs, and codebase health

- **`triage`** — move incoming issues through verification and triage roles into agent-ready work.
- **`diagnosing-bugs`** — run a disciplined diagnosis and regression-fix loop for hard bugs.
- **`wayfinder`** — map decisions for a large effort too broad to settle in one session.
- **`improve-codebase-architecture`** — survey for high-leverage opportunities to deepen modules and improve agent navigation.
- **`domain-modeling`** — sharpen domain terms and capture the glossary and consequential decisions.
- **`codebase-design`** — shared vocabulary and guidance for module boundaries, interfaces, depth, and seams.

### Research, communication, and setup

- **`research`** — delegate investigation against primary sources and capture cited findings in a Markdown document.
- **`to-questionnaire`** — prepare questions for another person when they hold information needed to decide.
- **`handoff`** — write a portable context document for work moving to another session, harness, directory, or colleague.
- **`wizard`** — generate an interactive guide for steps that require a human, such as credentials or dashboard setup.
- **`teach`** — teach a concept through a stateful, multi-session learning workspace.
- **`wait-what`** — re-explain a message that did not land, using plain language and the project glossary.
- **`writing-for-agents`** — guidance for writing skills, `AGENTS.md`, and other documents consumed by agents.
- **`setup-matt-pocock-skills`** — configure the issue tracker, labels, and domain-document conventions once per repository.

## Notes for this repository

- The domain document is `GLOSSARY.md` (not `CONTEXT.md`); architectural decisions live in `docs/adr/`.
- The project uses GitHub Issues and the default triage labels, as documented in `AGENTS.md` and `docs/agents/`.
- `implement-spec`, `pr`, and `retro` are the recently added skills. The upstream `resolving-merge-conflicts` skill has been retired; resolve conflicts using the normal repository workflow.
- Read the individual `SKILL.md` before relying on a workflow detail, because this guide is an orientation and may not include every rule or precondition.
