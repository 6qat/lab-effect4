---
description: Review the current changes and create a clear, high-quality Git commit.
agent: code
---

# Commit code to Git

Follow these steps:

1. Inspect the repository status and review all staged and unstaged changes. Do not modify files unless explicitly requested.
2. Check the relevant diff, including staged changes, to understand exactly what is being committed.
3. If there are no changes, report that there is nothing to commit and stop.
4. If changes are unstaged, ask whether they should be staged, or stage only the files relevant to the requested change. Never stage secrets, credentials, generated artifacts, or unrelated files.
5. Review the final staged diff. If it contains unrelated or suspicious changes, stop and report them instead of committing.
6. Write a concise commit message that accurately describes the change:
	- Use the imperative mood (for example, `Add`, `Fix`, `Update`, or `Remove`).
	- Keep the subject line specific and preferably under 72 characters.
	- Use Conventional Commits when appropriate: `type(scope): description`.
	- Add a body only when it provides useful context about why the change was made or important implementation details.
7. Create the commit with the reviewed staged changes.
8. Verify the commit and report its hash, message, and any remaining working-tree changes. Do not push to a remote unless explicitly requested.

Use Git MCP tools instead of Bash or shell commands to:

- Inspect the repository status and staged and unstaged diffs.
- Stage only the relevant files.
- Create the commit with the approved message.
- Verify the new commit and remaining working-tree changes.
