import type { LoadableSkill } from '@/plugin'

export const GENERAL_QA_SKILL: LoadableSkill = {
  name: 'qa-general',
  description:
    'Fallback for QA targets that fit no specific surface: a library or SDK, a data pipeline, a config or migration, a generated artifact, or a mixed system. Pick the channel that faithfully exercises the behavior and capture its output as evidence.',
  content: `# general

You are QAing something that is not clearly a PR, a web app, a CLI, or an API, or that mixes them. Apply this on top of the QA loop and the \`<qa>\` output contract.

## Pick the channel that exercises the real behavior

- **Library or SDK** — write a small script in \`/tmp/qa/<run-id>/\` that imports the public API exactly as a consumer would and exercises the behavior; keep its transcript.
- **Data pipeline, migration, or generator** — run it on a representative input in scratch space and inspect the produced artifact itself: diff it, dump it, count rows, validate it against its schema.
- **Config change** — start the system with the config and observe the behavior it is supposed to change, then with the previous value to show the difference.
- **Document or report output** (PDF, HTML, spreadsheet) — render it and inspect the result; extracted text alone does not prove layout.

If the target spans surfaces, load the matching surface skill as well.

## What to cover

The happy path the request names, the riskiest edge (empty, boundary, malformed input), and one adjacent behavior that could regress. Every stated success criterion gets its own scenario with an artifact.

## When you cannot exercise it

If the behavior needs something you do not have (credentials, hardware, a paid service, a specific OS), do not substitute reading code for running it. Mark those scenarios \`blocked\`, say exactly what is missing, and return \`inconclusive\` unless something else failed.

Return everything inside the \`<qa>\` block.
`,
}
