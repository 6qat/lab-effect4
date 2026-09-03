---
name: g-commit
description: Git commit current changes using a structured, high-detail commit message explaining all modifications.
---

# `g-commit`

Commit all working tree changes with a thorough, well-structured conventional commit message using the GitKraken MCP server.

> [!IMPORTANT]
> **Always use GitKraken MCP server tools** (`git_status`, `git_log_or_diff`, `git_add`, `git_commit`) for Git operations instead of Bash shell `git` commands. Only non-git steps (such as `bun run format`, `bun test`, etc.) should be run in shell commands.

## Workflow

1. **Inspect Working Tree & Staged Changes (GitKraken MCP)**:
   - Call `GitKraken:git_status` (passing `directory`) to inspect tracked and untracked modifications.
   - Call `GitKraken:git_log_or_diff` (with `action: "diff"`, `directory`) to analyze every code, test, documentation, and configuration delta.

2. **Validate Before Committing (Shell)**:
   - Verify formatting and linting (`bun run format && bun run lint`).
   - Run typecheck (`bun x tsc --noEmit`).
   - Run test suite (`bun test`).
   - If validations fail, stop and fix before committing.

3. **Stage Changes (GitKraken MCP)**:
   - Stage relevant files using `GitKraken:git_add` (passing `directory` and `files: [...]`, or omit `files` to add all).

4. **Craft Commit Message**:
   - Follow Conventional Commits: `<type>(<scope>): <short summary>` (e.g. `feat(tcp): ...`, `refactor(common): ...`, `fix(node): ...`).
   - Provide a detailed multiline body explaining:
     - **Why**: The problem being solved or architectural motivation.
     - **What**: Concrete changes made across files and components.
     - **Impact**: Any behavioral changes, newly exported APIs, or configuration updates.

5. **Commit & Confirm (GitKraken MCP)**:
   - Call `GitKraken:git_commit` with:
     - `directory`: Path to working directory
     - `message`: Title following Conventional Commits format
     - `description`: Detailed multiline body (Why, What, Impact)
   - Call `GitKraken:git_status` and `GitKraken:git_log_or_diff` (`action: "log"`, `revision_range: "HEAD~1..HEAD"`) to verify the commit succeeded and report the resulting commit hash and status.
