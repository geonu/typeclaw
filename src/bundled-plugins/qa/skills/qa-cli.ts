import type { LoadableSkill } from '@/plugin'

export const CLI_QA_SKILL: LoadableSkill = {
  name: 'qa-cli',
  description:
    'QA a command-line tool or terminal UI: run the real binary with representative, edge, and invalid arguments, capture stdout/stderr and exit codes, and drive interactive prompts or TUIs through tmux with captured panes.',
  content: `# qa-cli

You are QAing a command-line tool or terminal UI. Apply this on top of the QA loop and the \`<qa>\` output contract.

## Run the real binary

- Build it from the project's documented command, then invoke the built artifact (or the documented \`bun run\`/\`npx\`-style entry) exactly as a user would.
- Record the version (\`--version\`) in \`<target>\`.
- Run each scenario from a clean scratch working directory so leftover state cannot mask a bug. Use a scratch \`HOME\` (\`HOME=/tmp/qa/<run-id>/home\`) when the tool writes config there.

## Capture

For every invocation keep the exact command, stdout, stderr, and exit code. Save long output to \`/tmp/qa/<run-id>/<scenario>.log\` and quote the decisive lines in \`<observed>\`.

## What to cover

1. **Happy path** of each command the request names, with the resulting files or state checked (\`ls\`, \`cat\`, a second command that reads it back).
2. **Help and discovery**: \`--help\` lists the new or changed flag; the description matches behavior.
3. **Invalid input**: unknown flag, missing required argument, bad value. Expect a non-zero exit and a message that names the problem. A stack trace or exit 0 on failure is a finding.
4. **Edge input**: empty file, very long argument, paths with spaces, non-ASCII (Korean or Japanese) text.
5. **Idempotency and re-runs** where it matters: running the same command twice does not corrupt state.
6. **Non-TTY behavior**: output piped to a file has no broken escape codes when the tool claims to support that.

## Interactive prompts and TUIs

Drive them in a real pseudo-terminal with tmux, scripted so the whole session (start, every step, capture, kill) runs inside ONE \`bash\` call; a tmux server started in one call does not survive to the next:

- \`tmux new-session -d -s qa -x 120 -y 40 '<command>'\`
- \`tmux send-keys -t qa 'input' Enter\` (and \`Down\`, \`C-c\`, etc.)
- \`tmux capture-pane -t qa -p > /tmp/qa/<run-id>/<scenario>-<step>.txt\` after each step
- Wait for a prompt by polling \`capture-pane\` for the expected text with a bounded loop, never a fixed sleep.
- \`tmux kill-session -t qa\` when done.

Check that lines fit the terminal width, borders align, and wide (CJK) characters do not shift columns. If tmux is not installed, fall back to non-interactive flags when the tool has them and record the TUI as a coverage gap.

## Severity

- **blocker** — a named command fails or produces wrong output, data is destroyed, a crash on common input.
- **concern** — bad error message or exit code on invalid input, a broken edge case, help text that lies.
- **nit** — formatting.

Return everything inside the \`<qa>\` block.
`,
}
