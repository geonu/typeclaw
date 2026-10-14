---
name: typeclaw-omo-cli
description: Use for explicit OmO Native delegation, substantial coding or analysis suited to OmO, a second opinion, or an attempt to invoke omo. Runs the brokered coding_agent tool in a persistent isolated worktree through a background operator, with brokered internal subagents and no credential transfer.
---

# Delegate to OmO Native

Brief the repository, task, constraints, and acceptance checks. Use the existing background `operator` for substantial work; its `coding_agent` invocation stays foreground while the main conversation remains responsive.

## Prerequisites

The host operator enables `docker.file.omoCli:true`, configures `anthropic` or `openai-codex` through `typeclaw provider add <provider>`, and runs `typeclaw start` to rebuild the image. OmO Native 5.1.19 requires the supported Linux/bwrap profile. Use the tool's safe readiness diagnostic, never credential-file or environment inspection. See [auth-flow.md](references/auth-flow.md).

## Run and continue

```json
{
  "action": "run",
  "engine": "omo",
  "repo": "/agent/mounts/project",
  "modelRef": "anthropic/claude-sonnet-4-6",
  "mode": "code",
  "prompt": "Implement the requested change and run its tests.",
  "timeoutSeconds": 1800
}
```

Select a configured/curated `anthropic/...` or `openai-codex/...` model. One provider/model serves the parent, internal categories, named agents, and compaction. Other providers and model fallback are unavailable. `openai-codex` uses ChatGPT subscription OAuth, not an OpenAI API key.

Record `taskId`, `baseSha`, and `worktreePath`. The baseline is committed HEAD; dirty source changes are excluded. Never create a WIP commit to satisfy delegation. Use `mode:"plan"` for a read-only worktree and Git database. Implementation requires an explicit authorized transition:

```json
{
  "action": "run",
  "engine": "omo",
  "taskId": "<returned UUID>",
  "mode": "code",
  "prompt": "Implement the agreed plan and run the checks."
}
```

The runtime retains the exact session UUID and checks that its saved session exists before resume. Do not select recent sessions, invent IDs, or rewrite OmO configuration. Engine, provider, model, and version remain fixed. See [headless-sessions.md](references/headless-sessions.md).

## Review and recovery

Inspect `state`, `finalMessage`, `exitCode`, and the complete patch, including untracked and binary files. A JSON-mode provider failure can exit zero; the runner checks structured stop reasons. A question in any language needs a follow-up prompt, not keyword detection or polling. A claim that tests passed is not independent evidence.

Run acceptance checks and apply reviewed changes through ordinary tools. The tool never merges, pushes, or creates a PR in the source repository. Timeout, cancellation, and failure preserve partial work. Retrieve it with `{"action":"result","taskId":"<returned UUID>"}`. Discard a stopped task only when its work is no longer needed: `{"action":"dispose","taskId":"<returned UUID>","discard":true}`. See [results-and-worktrees.md](references/results-and-worktrees.md).

## Credential boundary

OmO receives only a fresh local inference capability. Task-local HOME, sessions, and generated provider config contain no real provider credential. Do not run login flows, copy profiles, pass tokens, or disable TypeClaw sandboxing. OmO's native approvals are disabled only inside the outer sandbox; a bare `omo` shell invocation has no broker authority.
