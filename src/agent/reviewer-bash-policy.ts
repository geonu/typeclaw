// Per-subagent bash capability policy. This is NOT the bwrap filesystem
// sandbox (src/sandbox/) — that is role-derived and returns early for
// trusted/owner callers. This is a subagent-capability boundary that must hold
// regardless of who spawned the subagent, so it is enforced as a standalone
// pre-check at the bash-wrap site before applyBashSandbox runs.
//
// Design (issue #452): the `reviewer` subagent is read-only by contract, but
// its legitimate workflows use pipes (`gh api … | base64 -d | nl -ba`), `&&`
// chains, and writes to a throwaway `/tmp` scratch checkout. A prefix
// allowlist plus a metacharacter ban (the SandboxCommandFilter primitive)
// cannot express "a pipeline of read-only commands", so this policy instead:
//   1. fails closed on shell constructs that defeat static analysis
//      (command/process substitution, heredocs, `eval`/`sh -c` wrappers,
//      redirects to non-/tmp paths, unbalanced quotes);
//   2. splits the remaining command on top-level `|` `&&` `||` `;` with a
//      quote/escape-aware scanner;
//   3. classifies each segment's leading verb against a read-only allowlist and
//      a mutating-subcommand denylist, with path-sensitive handling for the few
//      verbs (git checkout/clone, file writers) that are safe only under /tmp.
// It is defense-in-depth layered on top of the global exfil guards, not the
// sole fence — so "deny what we cannot prove safe" is the correct bias.

export type SubagentBashPolicy = { kind: 'readonly-reviewer' }

export class SubagentBashPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubagentBashPolicyError'
  }
}

// Constructs that let a benign-looking string smuggle an arbitrary command past
// segment/verb analysis. `$(`/backtick = command substitution; `<(`/`>(` =
// process substitution; `<<` = heredoc; `${` is allowed (plain var expansion is
// harmless for our denylist) but `$((` arithmetic and `$(` are not. We reject
// the whole command if any appear — the reviewer's documented workflows need
// none of them.
const FAIL_CLOSED_CONSTRUCTS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\$\(/, reason: 'command substitution `$(…)`' },
  { pattern: /`/, reason: 'backtick command substitution' },
  { pattern: /<\(/, reason: 'process substitution `<(…)`' },
  { pattern: />\(/, reason: 'process substitution `>(…)`' },
  { pattern: /<</, reason: 'heredoc `<<`' },
]

// Wrapper verbs that re-enter a shell or hand execution to another command,
// defeating verb analysis (`bash -c "git push"`, `xargs rm`, `find … -exec`).
// Denied outright as a leading verb.
const FORBIDDEN_WRAPPER_VERBS = new Set([
  'eval',
  'exec',
  'source',
  '.',
  'sh',
  'bash',
  'zsh',
  'dash',
  'env',
  'command',
  'xargs',
  'find',
  'parallel',
  'time',
  'nohup',
  'sudo',
  'doas',
  'ssh',
])

// Leading verbs that are read-only and need no further inspection.
const READONLY_VERBS = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'nl',
  'base64',
  'jq',
  'yq',
  'grep',
  'rg',
  'egrep',
  'fgrep',
  'ls',
  'pwd',
  'echo',
  'printf',
  'true',
  'false',
  'test',
  'which', // read-only tool-availability probe; does not execute the queried command
  'type', // shell builtin lookup; read-only. `type -a foo` reports, never runs
  'dirname',
  'basename',
  'realpath',
  'date',
  'sed', // read-only as used (no -i); -i is denied below
  'awk',
  'diff',
  'comm',
  'column',
  'fold',
  'rev',
  'tee', // path-checked below
])

// `git` subcommands that never mutate the working tree or remote.
const GIT_READONLY_SUBCOMMANDS = new Set([
  'log',
  'diff',
  'show',
  'blame',
  'status',
  'grep',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'cat-file',
  'describe',
  'shortlog',
  'config', // read form only; --add/--set caught by the write-flag check
  'remote', // `git remote -v` is read; mutating forms caught below
  'branch', // `git branch` (list) is read; create/delete caught below
  'tag', // `git tag` (list) is read; create/delete caught below
  'name-rev',
  'merge-base',
  'symbolic-ref',
  'for-each-ref',
  'show-ref',
  'reflog',
  'whatchanged',
])

// `git` subcommands that mutate the working tree, index, or remote. Denied
// unless the whole git invocation is scoped to a /tmp working dir (scratch
// clone): `clone`/`fetch`/`checkout` into /tmp are the reviewer's acquisition
// path; everything else stays denied even under /tmp because it has no
// legitimate reviewer use.
const GIT_MUTATING_ALWAYS_DENIED = new Set([
  'add',
  'commit',
  'push',
  'rebase',
  'reset',
  'merge',
  'cherry-pick',
  'revert',
  'am',
  'apply',
  'stash',
  'clean',
  'rm',
  'mv',
  'restore',
  'switch',
  'gc',
  'prune',
  'update-ref',
  'update-index',
  'write-tree',
  'commit-tree',
  'hash-object',
])

// git subcommands permitted only when the effective working dir is /tmp.
const GIT_TMP_SCOPED = new Set(['init', 'sparse-checkout', 'worktree'])

// `gh` subcommands/objects that mutate remote state. The reviewer reads PRs and
// repos; it never merges, reviews, comments, edits, or creates. We allow the
// read objects explicitly and deny the rest, because `gh` is the highest-value
// mutation surface (it can approve PRs, which the reviewer must NEVER do — the
// parent owns posting).
const GH_READONLY_BY_OBJECT: Record<string, Set<string>> = {
  pr: new Set(['view', 'diff', 'list', 'checks', 'status']),
  issue: new Set(['view', 'list', 'status']),
  repo: new Set(['view', 'list']),
  release: new Set(['view', 'list']),
  run: new Set(['view', 'list']),
  api: new Set(['__any__']), // gh api is method-checked below
  search: new Set(['__any__']),
  browse: new Set(['__any__']),
}

// Filesystem mutators that are safe only when every path operand is under /tmp.
const FS_WRITERS = new Set(['rm', 'mv', 'cp', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'rmdir', 'truncate'])

const TMP_PREFIXES = ['/tmp/', '/private/tmp/']

function isTmpPath(token: string): boolean {
  const unquoted = stripQuotes(token)
  return unquoted === '/tmp' || TMP_PREFIXES.some((p) => unquoted.startsWith(p))
}

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0]
    const last = token[token.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1)
    }
  }
  return token
}

// Quote/escape-aware tokenizer that ALSO surfaces top-level operators and
// redirects. Returns the token list plus the set of redirect targets so the
// caller can fail closed on a redirect to a non-/tmp path. Throws on unbalanced
// quotes (fail closed — an unterminated quote means we cannot trust the split).
type Segment = { tokens: string[]; redirectTargets: string[] }

function splitIntoSegments(command: string): Segment[] {
  const segments: Segment[] = []
  let tokens: string[] = []
  let redirectTargets: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let expectingRedirectTarget = false

  const pushToken = () => {
    if (current.length === 0) return
    if (expectingRedirectTarget) {
      redirectTargets.push(current)
      expectingRedirectTarget = false
    } else {
      tokens.push(current)
    }
    current = ''
  }
  const pushSegment = () => {
    pushToken()
    segments.push({ tokens, redirectTargets })
    tokens = []
    redirectTargets = []
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '\\') {
      current += ch
      if (i + 1 < command.length) {
        current += command[i + 1]
        i++
      }
      continue
    }
    if (ch === '|' || ch === '&' || ch === ';' || ch === '\n' || ch === '\r') {
      const next = command[i + 1]
      // `|`, `||`, `&&`, `;`, and a NEWLINE all start a new top-level segment.
      // bash treats an unquoted newline as a command separator exactly like `;`,
      // so failing to split on it would let `git status\ngit push` parse as one
      // allowed `git status` segment while bash runs `git push` separately. A
      // lone `&` (background) is treated the same — we don't run backgrounded jobs.
      if ((ch === '|' && next === '|') || (ch === '&' && next === '&')) i++
      pushSegment()
      continue
    }
    if (ch === '>' || ch === '<') {
      // Redirect operator. The following word is a path target we must
      // path-check. `2>`, `&>` handled by the trailing-fd char already being in
      // `current` — flush it as a token first.
      pushToken()
      // consume an optional second char (>>, 2>, &>)
      if (command[i + 1] === '>') i++
      expectingRedirectTarget = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      pushToken()
      continue
    }
    current += ch
  }
  if (quote !== null) {
    throw new SubagentBashPolicyError('command has an unbalanced quote; refusing to run what cannot be parsed safely.')
  }
  pushSegment()
  return segments.filter((s) => s.tokens.length > 0 || s.redirectTargets.length > 0)
}

function hasWriteFlag(tokens: string[]): boolean {
  return tokens.some((t) => t === '-i' || t === '--in-place' || t.startsWith('-i') || t === '--set' || t === '--add')
}

function classifyGit(tokens: string[]): void {
  // Resolve `git -C <dir>` and global flags to find the subcommand and the
  // effective working directory.
  let workdir: string | null = null
  let idx = 1
  while (idx < tokens.length) {
    const t = tokens[idx]!
    if (t === '-C') {
      workdir = tokens[idx + 1] ?? null
      idx += 2
      continue
    }
    if (t === '-c') {
      // `git -c key=val` config override — skip the pair. A core.hooksPath
      // override is a mutation vector, so deny it outright.
      const kv = tokens[idx + 1] ?? ''
      if (/hookspath|core\.editor|alias\./i.test(stripQuotes(kv))) {
        throw new SubagentBashPolicyError('git -c override of hooks/editor/alias is not permitted for the reviewer.')
      }
      idx += 2
      continue
    }
    if (t.startsWith('-')) {
      idx++
      continue
    }
    break
  }
  const sub = tokens[idx]
  if (sub === undefined) return // bare `git` — harmless
  const subcommand = stripQuotes(sub)

  if (GIT_MUTATING_ALWAYS_DENIED.has(subcommand)) {
    throw new SubagentBashPolicyError(
      `git ${subcommand} mutates repository state, which the read-only reviewer may not do.`,
    )
  }
  if (GIT_TMP_SCOPED.has(subcommand)) {
    assertGitTmpScoped(subcommand, workdir, tokens.slice(idx + 1))
    return
  }
  if (GIT_READONLY_SUBCOMMANDS.has(subcommand)) {
    if (
      (subcommand === 'config' || subcommand === 'remote' || subcommand === 'branch' || subcommand === 'tag') &&
      tokens.slice(idx + 1).some((t) => isGitWriteForm(subcommand, stripQuotes(t)))
    ) {
      throw new SubagentBashPolicyError(`git ${subcommand} is being used in a mutating form, which is not permitted.`)
    }
    return
  }
  throw new SubagentBashPolicyError(`git ${subcommand} is not on the reviewer's read-only allowlist.`)
}

// A /tmp-scoped git subcommand is safe only when the path it WRITES is under
// /tmp — not merely when some operand mentions /tmp. The earlier `.some(isTmpPath)`
// let `git clone /tmp/src /agent/evil` through because the source token matched
// while git wrote the destination at /agent/evil. Validate the actual write
// target per subcommand: clone writes its destination operand (or, when omitted,
// a directory derived from the repo under cwd — which we cannot prove is /tmp,
// so we require an explicit /tmp destination); -C-scoped operations write the
// -C workdir; a bare fetch/checkout without -C writes the ambient repo, which
// is not /tmp.
function assertGitTmpScoped(subcommand: string, workdir: string | null, rest: string[]): void {
  const deny = (detail: string): never => {
    throw new SubagentBashPolicyError(`git ${subcommand} is permitted only against a /tmp scratch checkout; ${detail}.`)
  }
  if (workdir !== null) {
    if (!isTmpPath(workdir)) deny('the -C working directory is not under /tmp')
    return
  }
  if (subcommand === 'clone') {
    // `git clone [flags] <repo> [<dir>]`: the write target is the explicit
    // <dir> operand when present, else a repo-derived dir under cwd (unprovable
    // as /tmp). Extracting operands requires skipping value-taking flags
    // (`--depth 1`, `-b main`, `--branch x`, …) whose VALUE is a bare word that
    // would otherwise be miscounted as the repo or destination.
    const operands = cloneOperands(rest)
    const dest = operands[1]
    if (dest === undefined) deny('clone needs an explicit /tmp destination directory')
    if (!isTmpPath(dest!)) deny('the clone destination is not under /tmp')
    return
  }
  // fetch/checkout/init/sparse-checkout/worktree without -C operate on the
  // ambient repo (the agent checkout), which is never /tmp. Require -C /tmp.
  deny(`${subcommand} without -C operates on the ambient repo; scope it with -C /tmp/review-*`)
}

// `git clone` flags that consume the NEXT token as their value (separated form,
// e.g. `--depth 1`). Their value is a bare word, so it must be skipped when
// counting positional operands (<repo> [<dir>]). Attached forms (`--depth=1`,
// `-b=x`) carry their own value and need no skip. Unknown long flags are treated
// as boolean (no skip); if a future value-taking flag is missed, the worst case
// is a stricter deny (a real operand shifts), never a looser allow.
const GIT_CLONE_VALUE_FLAGS = new Set([
  '--depth',
  '-b',
  '--branch',
  '-o',
  '--origin',
  '-u',
  '--upload-pack',
  '--reference',
  '--reference-if-able',
  '--separate-git-dir',
  '-c',
  '--config',
  '--shallow-since',
  '--shallow-exclude',
  '-j',
  '--jobs',
  '--filter',
  '--template',
])

function cloneOperands(rest: string[]): string[] {
  const operands: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    if (t.startsWith('-')) {
      if (GIT_CLONE_VALUE_FLAGS.has(t)) i++
      continue
    }
    operands.push(t)
  }
  return operands
}

function isGitWriteForm(sub: string, arg: string): boolean {
  if (sub === 'config') return arg === '--add' || arg === '--unset' || arg === '--replace-all' || arg === '--set'
  if (sub === 'remote')
    return arg === 'add' || arg === 'remove' || arg === 'rm' || arg === 'set-url' || arg === 'rename'
  if (sub === 'branch') return arg === '-d' || arg === '-D' || arg === '--delete' || arg === '-m' || arg === '-M'
  if (sub === 'tag') return arg === '-d' || arg === '--delete' || arg === '-a' || arg === '-s'
  return false
}

function classifyGh(tokens: string[]): void {
  // Find the object (pr/issue/repo/api/…) skipping global flags.
  let idx = 1
  while (idx < tokens.length && tokens[idx]!.startsWith('-')) idx++
  const objRaw = tokens[idx]
  if (objRaw === undefined) return
  const obj = stripQuotes(objRaw)
  const allowed = GH_READONLY_BY_OBJECT[obj]
  if (allowed === undefined) {
    throw new SubagentBashPolicyError(
      `gh ${obj} is not on the reviewer's read-only allowlist (it may mutate remote state).`,
    )
  }
  if (obj === 'api') {
    assertGhApiReadOnly(tokens.slice(idx + 1))
    return
  }
  if (allowed.has('__any__')) return
  // Find the verb after the object.
  let vIdx = idx + 1
  while (vIdx < tokens.length && tokens[vIdx]!.startsWith('-')) vIdx++
  const verbRaw = tokens[vIdx]
  if (verbRaw === undefined) return // bare `gh pr` — harmless listing-ish
  const verb = stripQuotes(verbRaw)
  if (!allowed.has(verb)) {
    throw new SubagentBashPolicyError(`gh ${obj} ${verb} is not a read-only operation; the reviewer may not run it.`)
  }
}

// `gh api` does NOT always default to GET. Per `gh api --help`: "adding request
// parameters will automatically switch the request method to POST". So any of
// `-f/--field`, `-F/--raw-field`, or `--input` flips the call to POST unless an
// explicit `--method GET/HEAD` overrides it. We mirror that inference, and we
// deny the `graphql` endpoint outright unless it is provably a query (a `mutation`
// operation is a write; even a query we cannot statically prove safe is denied
// for the reviewer because graphql can mutate through a GET-shaped call).
// Separated forms (flag and value are two tokens, e.g. `--field body=x`).
const GH_API_BODY_FLAGS = new Set(['-f', '--field', '-F', '--raw-field', '--input', '-d', '--data'])
// Attached long forms (`--field=body=x`, `--input=/tmp/x`). Each must be matched
// with its trailing `=` so `--field` proper still routes through the separated
// set above, and so an unrelated flag that merely starts with the same letters
// is not misread. Attached SHORT forms (`-fbody=x`, `-Fx`) are caught by the
// `-f`/`-F` prefix check at the call site.
const GH_API_BODY_FLAG_PREFIXES = ['--field=', '--raw-field=', '--input=', '--data=']

function isGhApiBodyParam(token: string): boolean {
  if (GH_API_BODY_FLAGS.has(token)) return true
  if (token.startsWith('-f') || token.startsWith('-F')) return true
  return GH_API_BODY_FLAG_PREFIXES.some((p) => token.startsWith(p))
}

function assertGhApiReadOnly(rest: string[]): void {
  let explicitMethod: string | null = null
  let hasBodyParam = false
  let isGraphql = false
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    if (t === '-X' || t === '--method') {
      explicitMethod = stripQuotes(rest[i + 1] ?? '').toUpperCase()
      continue
    }
    if (t.startsWith('-X')) {
      explicitMethod = stripQuotes(t.slice(2)).toUpperCase()
      continue
    }
    if (t.startsWith('--method=')) {
      explicitMethod = stripQuotes(t.slice('--method='.length)).toUpperCase()
      continue
    }
    if (isGhApiBodyParam(t)) hasBodyParam = true
    if (stripQuotes(t) === 'graphql') isGraphql = true
  }
  if (isGraphql) {
    throw new SubagentBashPolicyError(
      'gh api graphql can mutate (a `mutation` operation is a write, and a GET-shaped call can still mutate); the reviewer may not use the graphql endpoint.',
    )
  }
  const method = explicitMethod ?? (hasBodyParam ? 'POST' : 'GET')
  if (method !== 'GET' && method !== 'HEAD') {
    throw new SubagentBashPolicyError(
      `gh api resolves to ${method} (explicit or inferred from request parameters), which mutates remote state; the reviewer may only GET/HEAD.`,
    )
  }
}

// `command` normally re-enters execution (`command git push` runs `git push`),
// so it is a forbidden wrapper by default. The sole read-only exception is the
// lookup form `command -v NAME` / `command -V NAME`, which only *reports* whether
// NAME resolves and never executes it — the reviewer's legitimate "is this tool
// available?" probe.
//
// The parse must respect POSIX `command [-pVv] name [arg...]` operand semantics:
// only options BEFORE the first operand are `command`'s own; the first non-option
// token is the command NAME, and everything after it is that command's arguments.
// So `command git push -v` is NOT a lookup — `git` is the operand and the trailing
// `-v` belongs to `git push` (a real verbose push). Scanning every position for a
// `-v` (the earlier bug) would misread that as a lookup and authorize a mutation.
// We therefore require a `-v`/`-V` among the LEADING options, reject `-p` (forces a
// PATH exec) and `--` (ends option parsing → execution), and — since a lookup takes
// exactly one NAME and never runs it — reject any operand beyond that single name.
function classifyCommandBuiltin(tokens: string[]): void {
  const args = tokens.slice(1)
  const leadingOptions: string[] = []
  let i = 0
  while (i < args.length && args[i]!.startsWith('-') && args[i] !== '--') {
    leadingOptions.push(args[i]!)
    i++
  }
  const operands = args.slice(i).filter((t) => t !== '--')
  const endsOptionParsing = i < args.length && args[i] === '--'

  const isLookup = leadingOptions.some((f) => f === '-v' || f === '-V' || f === '-vV' || f === '-Vv')
  const forcesExecution = leadingOptions.some((f) => f === '-p' || f.includes('p')) || endsOptionParsing
  // A lookup resolves exactly one NAME and never executes it; a second operand
  // means the extra tokens are arguments to an executed command, not a lookup.
  const isSingleNameLookup = isLookup && !forcesExecution && operands.length <= 1

  if (isSingleNameLookup) return
  throw new SubagentBashPolicyError(
    '`command` re-enters execution (only the read-only lookup form `command -v NAME` is allowed); it is not permitted.',
  )
}

function classifyFsWriter(verb: string, tokens: string[], redirectTargets: string[]): void {
  const operands = tokens.slice(1).filter((t) => !t.startsWith('-'))
  const allUnderTmp = operands.length > 0 && operands.every(isTmpPath) && redirectTargets.every(isTmpPath)
  if (!allUnderTmp) {
    throw new SubagentBashPolicyError(
      `${verb} may only write under /tmp for the reviewer; a non-/tmp path operand is not permitted.`,
    )
  }
}

function classifySegment(segment: Segment): void {
  const { tokens, redirectTargets } = segment
  // A redirect to any non-/tmp path is a write to the persistent tree.
  for (const target of redirectTargets) {
    if (!isTmpPath(target)) {
      throw new SubagentBashPolicyError(
        `redirect to ${stripQuotes(target)} writes outside /tmp, which the read-only reviewer may not do.`,
      )
    }
  }
  if (tokens.length === 0) return
  const verb = stripQuotes(tokens[0]!)

  if (verb === 'command') return classifyCommandBuiltin(tokens)
  if (FORBIDDEN_WRAPPER_VERBS.has(verb)) {
    throw new SubagentBashPolicyError(`\`${verb}\` can re-enter a shell or hand off execution; it is not permitted.`)
  }
  if (verb === 'git') return classifyGit(tokens)
  if (verb === 'gh') return classifyGh(tokens)
  if (FS_WRITERS.has(verb)) return classifyFsWriter(verb, tokens, redirectTargets)
  if (verb === 'sed' && hasWriteFlag(tokens)) {
    throw new SubagentBashPolicyError('sed -i edits files in place; the reviewer is read-only.')
  }
  if (verb === 'tee') return classifyFsWriter('tee', tokens, redirectTargets)
  if (READONLY_VERBS.has(verb)) return
  // Package managers and anything unknown: deny. Unknown verbs are the most
  // likely bypass channel, so fail closed.
  throw new SubagentBashPolicyError(
    `\`${verb}\` is not on the reviewer's read-only command allowlist; refusing to run it.`,
  )
}

export function enforceReviewerReadonlyBashPolicy(command: string): void {
  if (typeof command !== 'string' || command.trim().length === 0) return
  // Single-quoted text is literal to bash, so backticks or `$(` inside a quoted
  // jq filter or markdown review body are not substitutions. Double quotes stay
  // in the scan because bash still substitutes inside them.
  const scanned = stripSingleQuotedText(command)
  for (const { pattern, reason } of FAIL_CLOSED_CONSTRUCTS) {
    if (pattern.test(scanned)) {
      throw new SubagentBashPolicyError(`command uses ${reason}, which the reviewer policy cannot analyze safely.`)
    }
  }
  const segments = splitIntoSegments(command)
  for (const segment of segments) classifySegment(segment)
}

// A `'` inside double quotes or after a backslash does not open a quote, so a
// plain regex would let `"it's `id`" 'x'` hide a live substitution.
function stripSingleQuotedText(command: string): string {
  let out = ''
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (ch === '\\') {
      out += command.slice(i, i + 2)
      i++
      continue
    }
    if (ch === '"') inDouble = !inDouble
    // Bash ignores an unquoted `#` comment through the newline, so quotes inside
    // it would mis-pair here and in splitIntoSegments and hide the next line.
    if (ch === '#' && !inDouble && (i === 0 || /[\s;&|()]/.test(command[i - 1] as string))) {
      const newline = command.indexOf('\n', i)
      const comment = command.slice(i, newline === -1 ? undefined : newline)
      if (/['"]/.test(comment)) {
        throw new SubagentBashPolicyError(
          'a shell comment containing quotes cannot be analyzed safely; drop the comment.',
        )
      }
    }
    if (ch === "'" && !inDouble) {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return command
      out += "''"
      i = end
      continue
    }
    out += ch
  }
  return out
}

export function enforceSubagentBashPolicy(policy: SubagentBashPolicy, command: string): void {
  if (policy.kind === 'readonly-reviewer') enforceReviewerReadonlyBashPolicy(command)
}
