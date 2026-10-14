# Headless sessions

`coding_agent` invokes `claude -p --output-format stream-json --verbose` with a concrete model and the prompt on stdin. Print mode runs the agent loop, tools, and subagents. No TTY, tmux server, sleep loop, or Stop sentinel is needed.

The runtime waits for a terminal result **and process exit**, draining bounded stdout and stderr throughout. Intermediate results do not terminate the child. Malformed output, nonzero exit, missing terminal results, and permission denials produce failed or incomplete receipts, not invented success. The protocol works independently of the language in the final answer.

First turns use a new UUID; subsequent invocations resume the recorded emitted session with `--resume`. The same task keeps its private Git database, worktree, and Claude conversation directory. Never use `--continue` or select the latest session under concurrency.

Code mode pre-approves useful coding tools with `dontAsk`. Plan mode uses Claude plan permission mode **and** read-only sandbox mounts for the worktree/Git database. Native permission flags do not replace TypeClaw's outer sandbox. A denied operation needs a revised task or explicit authorized mode transition, not a TUI confirmation workaround.

Each invocation defaults to 1800 seconds. Cancellation or timeout kills and reaps the sandbox process group and closes its broker. Partial edits and session state remain available. A later run obtains a new capability; an old one never becomes valid again. If no resumable session was emitted, inspect the partial diff rather than silently replacing the conversation.
