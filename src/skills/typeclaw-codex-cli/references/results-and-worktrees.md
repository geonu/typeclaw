# Results and worktrees

Container-stage tasks live under `/agent/workspace/coding-agents/<task-id>/` on the persistent agent bind mount:

```text
git/          task-private Git database
worktree/     detached checkout of the recorded source base SHA
codex/        non-secret CLI config and conversation state
output/       invocation JSONL/stderr, result.json, changes.patch, changes.json
```

The runtime copies the selected committed source snapshot without hardlinks or alternates and creates an actual worktree against its private Git database. Source files, index, refs, and Git administration are read-only to the delegate. A read-only configured source mount works; a linked source worktree with external Git administration or authenticated recursive submodules needs a supported source snapshot first.

## Baseline and artifacts

The receipt records `baseSha`, source/model identity, CLI version, and excluded dirty-source changes. Uncommitted source files are not included; do not create an automatic WIP commit. Revisions containing protected canonical credential paths are rejected for that task. This is not a scanner for credentials already leaked under arbitrary filenames.

`changes.patch` compares the recorded base against all current work, including staged, unstaged, untracked, deleted, binary, executable-mode, and symlink changes. `changes.json` inventories paths and kinds. Artifact collection uses a temporary index rather than changing the CLI's index. An oversized artifact is explicitly incomplete; no truncated patch is offered as a complete result.

Review both the final message and diff, run the required checks, and apply reviewed changes through normal tools. The tool never automatically commits, merges, pushes, creates PRs, or publishes a channel message.

## Recover and dispose

Read a retained receipt with `{"action":"result","taskId":"<returned UUID>"}`. Timeout, failure, cancellation, and container recreation retain useful partial work. Result files are model-writable artifacts, not authorization: the masked runtime task registry owns provenance and recorded thread identity.

Do not force-remove worktrees on failure or prune other tasks. After review, explicitly discard a stopped task with `{"action":"dispose","taskId":"<returned UUID>","discard":true}`. The runtime removes only that task's worktree and directory.

Tasks remain outside the system-managed `memory/` and `sessions/` backup roots. People already authorized to read the shared workspace can inspect their non-secret artifacts; task IDs do not provide cross-tenant isolation.
