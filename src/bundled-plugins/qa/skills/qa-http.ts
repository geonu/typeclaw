import type { LoadableSkill } from '@/plugin'

export const HTTP_QA_SKILL: LoadableSkill = {
  name: 'qa-http',
  description:
    'QA an HTTP or JSON API: exercise endpoints with curl, capture status, headers, and bodies, chain requests through realistic workflows, and cover validation errors, auth failures, and idempotency.',
  content: `# qa-http

You are QAing an HTTP API. Apply this on top of the QA loop and the \`<qa>\` output contract.

## Reach the API

- **A deployed endpoint** — use it as given. Never send destructive requests (DELETE, bulk updates) to production unless the caller explicitly asked and named a test resource.
- **A repo or PR** — write one script that starts the server from the documented command, waits for its health endpoint or port with a bounded retry loop, runs your requests, and stops the server; run it in a single \`bash\` call (a server backgrounded in one call does not survive to the next). Record the start command.
- Credentials come from the caller or from env vars the operator already exposed. Never print a token into evidence; redact it as \`<redacted>\`.

## Capture

Use \`curl -sS -i\` so the status line and headers are kept with the body. Save each response to \`/tmp/qa/<run-id>/<scenario>.http\`. If \`hurl\` is installed, a \`.hurl\` file with assertions is a fine way to make a flow repeatable; keep its report.

## What to cover

1. **Happy path** for each endpoint the request names: correct status, response shape, and the field values the contract promises.
2. **Workflow chain**: create → read back → update → read back → delete → confirm gone. Capture ids from earlier responses rather than hardcoding them.
3. **Validation**: missing field, wrong type, out-of-range value. Expect a 4xx with a message that names the field, never a 500.
4. **Auth**: no credentials and wrong credentials return 401/403, never data.
5. **Not found and method errors**: an unknown id returns 404; a wrong method returns 405 or the documented behavior.
6. **Idempotency and retries** where the API promises them: the same PUT twice leaves the same state; a retried create with an idempotency key does not duplicate.
7. **Non-ASCII payloads**: Korean or Japanese strings round-trip unchanged.

## Severity

- **blocker** — wrong data, a 5xx on valid input, auth bypass, a broken contract field.
- **concern** — a 5xx on invalid input, a vague error, an undocumented status code.
- **nit** — header or formatting inconsistencies.

Return everything inside the \`<qa>\` block.
`,
}
