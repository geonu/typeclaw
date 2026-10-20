import type { LoadableSkill } from '@/plugin'

export const PR_QA_SKILL: LoadableSkill = {
  name: 'qa-pr',
  description:
    'QA a pull request, branch, commit, or whole repository: acquire it at an exact SHA, install and build from a clean scratch clone, run the project’s own checks, then exercise the changed behavior through its real interface and compare against the base when attribution matters.',
  content: `# qa-pr

You are QAing code that lives in a repository: a pull request, a branch, a commit, or an open-source project as a whole. Apply this on top of the QA loop and the \`<qa>\` output contract.

## Acquire the target at an exact revision

- **GitHub PR** — \`gh pr view <n> --repo <owner>/<repo> --json title,body,headRefOid,baseRefOid,files\` gives intent, the head SHA, and the changed files. \`gh pr diff <n> --repo <owner>/<repo>\` gives the diff. Keep each \`gh\` call a single bare invocation (no pipes, \`&&\`, or redirects): the runtime injects a token into its environment.
- **Public repo** — \`git clone <url> /tmp/qa/<run-id>/head\`. A clone does not include pull-request refs, so for a PR (especially from a fork) also run \`git -C /tmp/qa/<run-id>/head fetch origin pull/<n>/head\`. Then \`git -C /tmp/qa/<run-id>/head checkout <headSha>\` and confirm \`git -C /tmp/qa/<run-id>/head rev-parse HEAD\` equals the head SHA.
- **Private GitHub repo** — call \`github_prepare_review_checkout\` with the repo slug, head SHA, and merge-base SHA. Its receipt is a read-only acquisition cache: make your writable tree with \`git clone <receipt-path> /tmp/qa/<run-id>/head\` and work only in the clone.
- **Base comparison** — when you must show the change caused (or fixed) a behavior, make a second clone at the merge base in \`/tmp/qa/<run-id>/base\` and run the same scenario on both.

Record the head SHA (and base SHA if used) in \`<target>\`.

## Derive the acceptance criteria

1. Read the PR title/body and linked issues: what does the author claim the change does? Each claim becomes a scenario.
2. Read the diff to find the user-facing surface it touches: a CLI flag, an endpoint, a page, a library export, a config key.
3. Read \`README\`, \`CONTRIBUTING\`, \`AGENTS.md\`, \`package.json\`/\`Makefile\`/\`pyproject.toml\`/\`Cargo.toml\` for the canonical install, build, test, and run commands. Use the project's commands, not ones you invent.
4. Add one regression scenario on adjacent behavior the diff could break, and one edge case on the changed path.

## Build and run the project's own checks

- Install with the lockfile the repo ships (\`bun install --frozen-lockfile\`, \`npm ci\`, \`pnpm install --frozen-lockfile\`, \`pip install -e .\`, \`cargo build\`, \`go build ./...\`).
- Run the documented typecheck, lint, and test commands. Record pass/fail counts and exit codes as scenarios.
- A check that also fails on the base revision is a **pre-existing failure**: report it in \`<coverage_gaps>\` or as a \`concern\`, never as a defect of this change. Only run the base when a failure needs attribution.
- If install or build cannot work in this environment (needs a GPU, a paid service, a platform you are not on), the run is \`inconclusive\` for those scenarios; say what is missing.

## Exercise the changed behavior for real

Green tests are not the finish line: tests can be too narrow, and the author wrote them. Drive the changed behavior through its real interface:

- CLI change → run the built binary with the new flag/subcommand (load \`qa-cli\`).
- Web change → start the dev server and drive the page (load \`qa-web\`).
- API change → start the server and hit the endpoint (load \`qa-http\`).
- Library change → write a small script in your scratch dir that imports the public API and exercises the new behavior; keep its transcript.

## Severity

- **blocker** — a stated claim of the PR does not hold, the build or the project's own tests break because of this change, or a regression on adjacent behavior.
- **concern** — an edge case on the changed path misbehaves, a missing error message, a docs claim that does not match behavior.
- **nit** — cosmetic output issues that do not affect correctness.

Return everything inside the \`<qa>\` block.
`,
}
