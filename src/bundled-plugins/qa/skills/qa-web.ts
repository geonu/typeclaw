import type { LoadableSkill } from '@/plugin'

export const WEB_QA_SKILL: LoadableSkill = {
  name: 'qa-web',
  description:
    'QA a web app or URL in a real browser: drive user flows with a browser engine (agent-browser by default), capture screenshots and console/network errors per step, and cover happy path, a negative path, and mobile plus desktop widths.',
  content: `# qa-web

You are QAing something that renders in a browser. Apply this on top of the QA loop and the \`<qa>\` output contract.

## Get a page to test

- **A deployed URL** — use it directly. Do not log in to accounts, submit payments, or send messages on a production site unless the caller explicitly asked you to and provided a test account.
- **A repo or PR** — install, then write one script that starts the dev or preview server from the project's documented command, waits until the port answers (\`curl -sf http://localhost:<port>\` in a bounded retry loop), runs your browser steps, and stops the server. Run it in a single \`bash\` call: a server backgrounded in one call does not survive to the next. Record the start command.

## Drive the browser

The \`agent-browser\` CLI is always installed and is used below. If the operator enabled another engine (\`omowright\`, \`browser-use\`, \`browserskill\`), its skill is loaded and you may use it instead with the same loop. When TypeClaw's shared browser is running, agent-browser attaches to it automatically. The loop is observe → act → observe:

- \`agent-browser open <url>\` to load the page.
- \`agent-browser snapshot -i\` to get the interactive elements with \`@e\` refs; act on refs, not guessed selectors.
- \`agent-browser click @e3\`, \`agent-browser fill @e5 "text"\`, \`agent-browser press Enter\` to interact.
- \`agent-browser screenshot /tmp/qa/<run-id>/<scenario>-<step>.png\` after each meaningful step.
- Read console errors and failed requests after each flow; an uncaught exception or a 4xx/5xx on a load-bearing request is a finding even when the page looks fine.
- \`agent-browser close\` when done.

If the project already ships Playwright tests, running them is a check scenario, not a replacement for driving the flow yourself.

## What to cover

1. **Happy path** of every flow the request names, end to end, with the resulting state verified (the item appears in the list, the URL changes, the success message shows).
2. **A negative path**: empty or invalid form input, a missing resource, an unauthorized action. The UI must say what went wrong.
3. **Widths**: at least one desktop (about 1440 wide) and one phone-sized (about 390 wide) pass of the main screen. Clipped text, overlapping elements, or horizontal scroll of primary content are findings.
4. **Reload and back**: state that should persist survives a reload; the back button does not break the flow.
5. **Non-English text** when the product is used internationally: Korean or Japanese input renders and wraps without clipping.

## Evidence

Every scenario cites its screenshots and the console/network excerpt. Describe what each screenshot shows in \`<observed>\`; the parent may not be able to open images.

## Severity

- **blocker** — a named flow cannot complete, data is lost or wrong, an uncaught error breaks the page.
- **concern** — a negative path gives no feedback, layout breaks at one width, a console error that does not yet break the flow.
- **nit** — visual polish.

Return everything inside the \`<qa>\` block.
`,
}
