---
name: g-commit
description: Git commit current changes using a structured, high-detail commit message explaining all modifications.
---

# `g-commit`

Commit all working tree changes with a thorough, well-structured conventional commit message.

## Workflow

1. **Inspect Working Tree & Staged Changes**:
   - Run `git status -s` to inspect all tracked and untracked modifications.
   - Run `git diff` (and `git diff --staged`) to analyze every code, test, documentation, and configuration delta.

2. **Validate Before Committing**:
   - Verify formatting and linting (`bun run format && bun run lint`).
   - Run typecheck (`bun x tsc --noEmit`).
   - Run test suite (`bun test`).
   - If validations fail, stop and fix before committing.

3. **Stage Changes**:
   - Stage relevant files using `git add <files>` (or `git add -A` for complete changesets).

4. **Craft Commit Message**:
   - Follow Conventional Commits: `<type>(<scope>): <short summary>` (e.g. `feat(tcp): ...`, `refactor(common): ...`, `fix(node): ...`).
   - Provide a detailed multiline body explaining:
     - **Why**: The problem being solved or architectural motivation.
     - **What**: Concrete changes made across files and components.
     - **Impact**: Any behavioral changes, newly exported APIs, or configuration updates.

5. **Commit & Confirm**:
   - Run `git commit -m "<title>" -m "<body>"`.
   - Run `git status` and `git log -n 1 --stat` to verify the commit succeeded.
