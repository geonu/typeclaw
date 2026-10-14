# Headless Codex sessions

Each `coding_agent` invocation runs one foreground `codex exec --json` process inside TypeClaw's outer bwrap. The main conversation stays responsive because an existing background operator owns that invocation. A terminal event is not permission to kill the process early: the supervisor drains stdout/stderr and waits for process exit.

## Stdout protocol

The runtime reads bounded JSONL from stdout:

- `thread.started` supplies the thread UUID stored in the private task registry.
- `item.completed` with `item.type:"agent_message"` supplies the final text; intermediate reasoning and tool items are not the answer.
- `turn.completed` indicates turn completion, subject to process status and parser errors.
- `turn.failed` or top-level `error` indicates failure. A declined command is incomplete.

Malformed/truncated output, missing terminal events, and nonzero exits are not success. Do not parse private Codex rollout files as if they had this stdout schema. Do not infer success from English phrases: a completed turn can contain a question in any language.

## Continue by task ID

Send a new `run` with `engine:"codex"`, the returned `taskId`, and the next prompt. The runtime preserves `CODEX_HOME` and worktree, resumes the recorded thread explicitly, and generates a fresh broker capability and local endpoint configuration. It never selects `--last` or disables persistence.

Task ownership and current authority are rechecked. Engine, repository, and model cannot change on resume. Concurrent resumes are rejected rather than allowing two CLI processes to write one conversation. A version mismatch or missing thread ID is reported with retained artifacts, not silently replaced with a new session.

## Plan and interruption

`mode:"plan"` adds a planning prompt and makes the worktree and private Git database read-only. Conversation state, output, and scratch remain writable. It stays read-only on subsequent turns unless an authorized invocation explicitly selects `mode:"code"`. CLI-native flags are not the filesystem boundary.

Timeout/cancellation closes the broker, revokes the capability, kills/reaps the sandbox process group, and preserves partial work. After runtime restart, tasks left running are marked interrupted. Retrieve their result and resume explicitly. There is no detached daemon to reconnect, no terminal picker to answer, and no sentinel file to poll.
