---
name: typeclaw-codex-cli
description: Use for explicit Codex CLI delegation, substantial coding or code analysis suited to Codex, a second opinion, or any attempt to invoke codex. Runs TypeClaw's brokered headless coding_agent tool in a persistent isolated worktree through a background operator; no TUI or credential transfer.
---

# Delegate to Codex

Use Codex for substantial implementations, investigations, refactors, and second opinions. Brief the repository, task, constraints, and acceptance checks before delegating. Do trivial edits directly.

## Prerequisites

The host operator enables `docker.file.codexCli:true`, configures `providers.openai-codex` through `typeclaw provider add openai-codex`, and runs `typeclaw start` to rebuild the changed image. Codex uses ChatGPT subscription OAuth, not an OpenAI API key. The pinned CLI needs the supported outer bwrap profile. Use the coding tool's safe diagnostic for missing auth/binary/sandbox problems; never inspect credentials to test readiness. See [auth-flow.md](references/auth-flow.md).

## Run through a background operator

The main agent delegates to the existing background `operator` subagent. Give it the permitted repository path, compatible configured model, task, constraints, and expected checks. The operator runs `coding_agent` in the foreground and returns its result through normal subagent completion. Do not create tmux sessions, drive an auth picker, or poll Stop-hook files.

First invocation:

```json
{
  "action": "run",
  "engine": "codex",
  "repo": "/agent/mounts/project",
  "modelRef": "openai-codex/gpt-6-sol",
  "mode": "code",
  "prompt": "Implement the requested change and run its tests.",
  "timeoutSeconds": 1800
}
```

Select a configured/curated `openai-codex` model. The repository may be the agent root, a configured mount root, or an accessible workspace repository. Record the returned `taskId`, `baseSha`, and `worktreePath`. The baseline is committed HEAD; dirty source edits are excluded and reported. Never make a WIP commit just to satisfy delegation.

For a plan, use `mode:"plan"`. The runtime binds both worktree and Git database read-only and supplies a planning prompt. This is not a native Codex plan flag. To implement an approved plan, explicitly resume in `mode:"code"`.

```json
{
  "action": "run",
  "engine": "codex",
  "taskId": "<returned UUID>",
  "mode": "code",
  "prompt": "Implement the agreed plan and run the checks."
}
```

The runtime uses `codex exec --json` and explicitly resumes the recorded thread with `codex exec resume`. Keep the task ID; do not invent a thread ID, choose the latest session, or rewrite CLI config. Engine, source, and model remain fixed. Read [headless-sessions.md](references/headless-sessions.md) for continuation and interruption behavior.

## Review the result

Inspect structured `state`, `finalMessage`, `exitCode`, and the complete patch. A completed turn may ask a question; answer its meaning with another prompt or ask the parent. Do not classify completion using English phrases or punctuation. A final message claiming tests passed is not test evidence.

Review `changedFiles`, `untrackedFiles`, and `patchPath`, including binary/mode/symlink changes. Run relevant acceptance checks, then apply reviewed changes through ordinary tools. The coding tool does not commit, merge, push, or create a PR on the source repository. See [results-and-worktrees.md](references/results-and-worktrees.md).

Timeout, cancellation, and failure preserve partial work. Retrieve it with `{"action":"result","taskId":"<returned UUID>"}` and resume explicitly if useful. Discard only a stopped task whose work is no longer needed with `{"action":"dispose","taskId":"<returned UUID>","discard":true}`.

## Credential boundary

`CODEX_HOME` holds non-secret conversation/config state. The runtime supplies a custom Responses provider and a short-lived local capability. It never transfers `auth.json`, an account ID, a fake JWT, or provider tokens. TypeClaw alone refreshes canonical credentials. Do not run login/device-auth flows, hand-write proxy/TOML configuration, use `OPENAI_BASE_URL`, or put tokens into chat, files, prompts, tool arguments, or child environments.

The runner's externally sandboxed invocation flags are internal. Never disable TypeClaw sandboxing or copy that invocation onto the host. Ordinary shell execution of `codex` does not receive broker authority.
