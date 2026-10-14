# Results and worktrees

Container task files live under `/agent/workspace/coding-agents/<task-id>/`: `git/`, `worktree/`, `claude/`, and `output/`. They survive container recreation through the agent bind mount and do not enter session/memory backups.

The source revision is committed HEAD. Every receipt warns that uncommitted source edits are excluded; dirty-input snapshots and authenticated submodule imports are not supported. Never auto-commit the source to prepare a task. Bootstrap reads only the source's Git metadata; the live source worktree and credential write directory are never mounted or inspected for dirty status. The task uses copied objects and an actual detached worktree in a private Git database.

The receipt records the task, source, base SHA, worktree, terminal state, final message, exit status, changed and untracked files, patch path, and safe diagnostic. `changes.patch` is binary-capable and covers staged/unstaged edits, untracked files, deletions, executable modes, and symlinks. `changes.json` records the inventory. Oversized artifacts are explicitly incomplete, not silently truncated.

Review the complete patch and relevant tests before applying through normal tools. A CLI saying "done" does not prove acceptance checks passed. The tool never commits, pushes, merges, opens a PR, or posts to a channel.

`result` reads runtime-owned authority; writable `output/result.json` is only an artifact. Task IDs do not authorize other speakers or sibling operators. After restart, formerly running tasks are interrupted and require explicit resume. Do not delete failure evidence automatically.

`dispose` requires `discard:true` and a stopped task. It removes only that task's worktree/private directory. Never run global `git worktree prune`, delete source branches, or glob other tasks.
