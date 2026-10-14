# Headless OmO sessions

The runtime invokes pinned OmO with `-p --mode json`, a concrete brokered model, an exact `--session-id`, and a task-local `--session-dir`. Prompt text travels over stdin. No terminal, tmux process, picker, or Stop-hook polling is involved.

The session header must match the recorded UUID and worktree. The runner extracts text from the last assistant in the final settled `agent_end.messages`, excluding custom messages, tools, and thinking. It resets completion on a new main `agent_start` and ignores retrying boundaries. It drains both pipes and waits for process exit.

Success requires clean JSONL, exit zero, a matching session header, a settled final run, and assistant `stopReason:"stop"`. `length` and `toolUse` are incomplete. `error` and `aborted` cannot become success even when OmO exits zero. Individual recoverable tool errors remain visible in the saved structured events.

A new tool call with the same TypeClaw `taskId` resumes the exact session. Runtime ownership checks, invocation locking, provider/model/version pinning, and fresh capabilities apply on every turn. Missing or unsafe session files do not trigger OmO's implicit fresh-session behavior.

Plan mode makes worktree and Git storage read-only, regardless of native approval policy. Task-local conversation state remains writable. Internal OmO children run in-process under the same outer sandbox; its task IDs are not TypeClaw authority. Processes do not survive invocation teardown. After interruption, preserve the diff and resume explicitly.
