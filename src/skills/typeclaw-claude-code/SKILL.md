---
name: typeclaw-claude-code
description: Use for explicit Claude Code delegation, substantial coding or analysis suited to Claude Code, and before invoking claude. Uses TypeClaw's brokered headless runner with a persistent isolated worktree, not tmux or credential profiles.
---

# Delegate to Claude Code

Brief the task, repository, constraints, and acceptance checks. Use this for substantial implementations, investigations, refactors, or a second opinion; do trivial edits directly.

## Prerequisites

The host operator enables `docker.file.claudeCode:true`, configures the Anthropic provider, and starts the rebuilt image. Use the tool's safe diagnostic to check readiness; never inspect credential files or environment values. Missing binary: ask for a host rebuild/restart. Missing or revoked authentication: host `typeclaw provider add anthropic`, then retry. See [auth-flow.md](references/auth-flow.md).

## Run through an operator

The main agent spawns a background `operator` with the repository, task, constraints, and expected checks. The operator invokes `coding_agent` in the foreground. The existing subagent completion delivers the report while the main conversation stays responsive.

First run, with a compatible configured model:

```json
{
  "action": "run",
  "engine": "claude",
  "repo": "/agent",
  "modelRef": "anthropic/claude-opus-5-5",
  "mode": "code",
  "prompt": "Implement the requested change and run its tests.",
  "timeoutSeconds": 1800
}
```

Record the returned `taskId`, `baseSha`, and `worktreePath`. The baseline is committed HEAD. Dirty source changes are excluded and reported; do not auto-commit or stage them to satisfy a prerequisite.

For planning use `mode:"plan"`; the worktree and its Git database are read-only. Continue with a new prompt and the same task ID, explicitly using `mode:"code"` for approved implementation. The runtime manages explicit CLI session resume and fresh invocation authority. Never select the latest session or pass your own CLI session identifier. See [headless-sessions.md](references/headless-sessions.md).

## Review, recover, dispose

Inspect structured state, final message, changed-file inventory, and complete patch. A successful CLI turn is not proof that tests passed. If the answer asks a question, provide a follow-up prompt or ask the parent; do not classify completion by English keywords or poll for sentinels.

Read the full diff, including untracked/binary files, and run relevant checks before applying through ordinary tools. No automatic commit, merge, push, PR, or channel publication occurs.

After failure, timeout, cancellation, or restart, retain the partial work. `{"action":"result","taskId":"<returned UUID>"}` retrieves the authoritative receipt. Resume explicitly; do not silently start a replacement conversation. Discard only when no useful work will be lost: `{"action":"dispose","taskId":"<returned UUID>","discard":true}`. See [results-and-worktrees.md](references/results-and-worktrees.md).

## Credential boundary

Only the trusted runtime handles provider credentials. The child receives an invocation-local capability, not a provider token. Never put credentials in chat, prompts, files, tool arguments, or child environment; never run login/setup-token, dump profiles, or use guard acknowledgements as an authentication workaround. Raw bash invocations of `claude` do not acquire broker authority. Codex delegation is not yet available.
