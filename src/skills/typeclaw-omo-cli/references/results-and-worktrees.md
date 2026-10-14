# OmO results and worktrees

Container-stage task state persists under `/agent/workspace/coding-agents/<task-id>/`:

```text
git/                   private Git object database
worktree/              detached checkout of recorded committed HEAD
omo/home/.omo/         generated orchestration config and provisioned native runtime
omo/agent/             generated models/settings and engine state
omo/sessions/          exact-session conversation files
omo/task-state/        internal OmO child-task records
omo/tmp/               task scratch
omo/config/ cache/ data/ state/  redirected XDG state
output/                JSONL, stderr, receipt, complete patch and change inventory
```

The live source worktree and credential write directory are not mounted into the child. Snapshot bootstrap reads only source Git metadata; execution and artifact collection use task-private files. Ordinary project instructions remain available, while existing project/ancestor OmO config operands are masked so they cannot replace the generated model chains at launch.

The complete patch includes staged, unstaged, untracked, deleted, binary, executable-mode, and symlink changes against the recorded base. Capture does not mutate the CLI's index. Oversized artifacts are marked incomplete rather than presented as complete truncated patches.

Review the diff and run checks before applying it through normal tools. Timeout/failure preserves state; `result` retrieves it after restart. The private runtime registry, not editable CLI output, owns task authority and session identity.

Use explicit `dispose` with `discard:true` only for a stopped task whose work is no longer needed. Never prune sibling tasks or force-delete useful partial work. Task files stay outside system-managed memory/session backups. Shared workspace readers may inspect these non-secret artifacts; task IDs are not a separate tenant boundary.
