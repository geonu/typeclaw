import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'

import { readOomEvents, toolOomNote } from '@/container/oom-events'
import { withToolOomPriorityArgv } from '@/container/tool-oom-priority'
import { prepareCodingCommand } from '@/sandbox/coding-agent'
import type { CodingAgentAuthResolver } from '@/secrets/coding-agent-auth'

import { SecretScrubber, startCodingBroker, type CodingBroker } from './broker'
import { ClaudeStreamParser, claudeArguments, claudeEnvironment, type CodingMode } from './claude'
import { CodexStreamParser, codexArguments, codexConfig, codexEnvironment } from './codex'
import type { CodingWorkspace } from './worktree'

export type CodingRunResult = {
  readonly state: 'completed' | 'incomplete' | 'failed' | 'cancelled'
  readonly finalMessage: string
  readonly sessionId?: string
  readonly exitCode: number | null
  readonly diagnostic: string
}

export type CodingRunOptions = {
  readonly engine?: 'claude' | 'codex'
  readonly workspace: CodingWorkspace
  readonly auth: CodingAgentAuthResolver
  readonly model: string
  readonly allowedModels: readonly string[]
  readonly mode: CodingMode
  readonly sessionId: string
  readonly resume: boolean
  readonly prompt: string
  readonly timeoutSeconds: number
  readonly signal?: AbortSignal
  readonly writeArtifact: (path: string, text: string) => Promise<void>
}

export async function runCodingAgent(
  options: CodingRunOptions,
  testDependencies?: {
    command: (
      argv: readonly string[],
      env: Record<string, string>,
    ) => Promise<{ argv: string[]; env: Record<string, string> }>
    broker?: typeof startCodingBroker
  },
): Promise<CodingRunResult> {
  const engine = options.engine ?? 'claude'
  const deadline = Date.now() + options.timeoutSeconds * 1000
  const timeout = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
  const timer = setTimeout(() => timeout.abort(), options.timeoutSeconds * 1000)
  let broker: CodingBroker | undefined
  let cleanupPrepared: (() => Promise<void>) | undefined
  const parser = engine === 'claude' ? new ClaudeStreamParser() : new CodexStreamParser()
  let stdout = ''
  let stderr = ''
  let exitCode: number | null = null
  let failure = false
  const oom = readOomEvents()
  try {
    signal.throwIfAborted()
    broker = await (testDependencies?.broker ?? startCodingBroker)({
      provider: engine === 'claude' ? 'anthropic' : 'openai-codex',
      auth: options.auth,
      allowedModels: options.allowedModels,
      deadline,
      signal,
    })
    const configDir = join(options.workspace.taskRoot, engine)
    if (engine === 'codex') {
      await options.writeArtifact(join(configDir, 'config.toml'), codexConfig(options.model, broker.baseUrl))
    }
    const env =
      engine === 'claude'
        ? claudeEnvironment(configDir, broker.baseUrl, broker.capability)
        : codexEnvironment(configDir, broker.capability)
    const args = engine === 'claude' ? claudeArguments(options) : codexArguments(options)
    const cwd = join(options.workspace.taskRoot, 'worktree')
    const prepared: {
      argv: string[]
      env: Record<string, string>
      extraFiles?: Array<number | 'ignore'>
      cleanup?: () => Promise<void>
    } = testDependencies
      ? await testDependencies.command(args, env)
      : await prepareCodingCommand(args, {
          source: options.workspace.source,
          taskRoot: options.workspace.taskRoot,
          cwd,
          mode: options.mode,
          env,
        }).then((command) => ({
          argv: ['bash', '-c', `exec ${command.commandString}`],
          env: command.spawnEnv,
          extraFiles: command.extraFiles,
          cleanup: command.cleanup,
        }))
    cleanupPrepared = prepared.cleanup
    signal.throwIfAborted()
    const [executable, ...argv] = withToolOomPriorityArgv(prepared.argv)
    if (!executable) throw new Error('Coding command is empty.')
    const child = spawn(executable, argv, {
      cwd,
      env: prepared.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', ...(prepared.extraFiles ?? [])],
    })
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Coding pipes unavailable.')
    const kill = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
      }
    }
    const closed = once(child, 'close')
    // Attach readers before sending the prompt or cancellation.
    const consume = async (stream: NodeJS.ReadableStream, output: boolean): Promise<void> => {
      const decoder = new TextDecoder()
      const scrubber = new SecretScrubber([broker?.capability ?? ''])
      let total = 0
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        total += bytes.length
        if (total > 16 * 1024 * 1024) {
          failure = true
          kill()
          continue
        }
        const text = scrubber.push(decoder.decode(bytes, { stream: true }))
        if (output) {
          stdout += text
          try {
            parser.push(text)
          } catch {
            failure = true
            kill()
          }
        } else stderr += text
      }
      const final = scrubber.push(decoder.decode(), true)
      if (output) {
        stdout += final
        parser.push(final)
        parser.finish()
      } else stderr += final
    }
    const reads = [consume(child.stdout, true), consume(child.stderr, false)]
    signal.addEventListener('abort', kill, { once: true })
    child.stdin.on('error', () => {
      failure = true
    })
    try {
      if (signal.aborted) kill()
      else
        child.stdin.end(
          engine === 'codex' && options.mode === 'plan'
            ? `Plan this task without modifying the repository. The worktree and Git database are read-only.\n\n${options.prompt}`
            : options.prompt,
        )
      const [code, killedBy] = await closed
      exitCode = typeof code === 'number' ? code : killedBy === 'SIGKILL' ? 137 : null
      await Promise.all(reads)
    } finally {
      signal.removeEventListener('abort', kill)
      kill()
      await Promise.allSettled([closed, ...reads])
    }
  } catch {
    failure = true
  } finally {
    clearTimeout(timer)
    await broker?.close()
    await cleanupPrepared?.()
  }
  const invocation = crypto.randomUUID()
  await options.writeArtifact(join(options.workspace.taskRoot, 'output', `${invocation}.jsonl`), stdout)
  await options.writeArtifact(join(options.workspace.taskRoot, 'output', `${invocation}.stderr`), stderr)
  const timedOut =
    timeout.signal.aborted ||
    (options.signal?.reason instanceof DOMException && options.signal.reason.name === 'TimeoutError')
  const state = timedOut
    ? 'incomplete'
    : options.signal?.aborted
      ? 'cancelled'
      : failure || exitCode !== 0 || parser.failed || parser.malformed
        ? 'failed'
        : !parser.terminal || parser.permissionDenied || (engine === 'codex' && !parser.sessionId)
          ? 'incomplete'
          : 'completed'
  return {
    state,
    finalMessage: parser.finalMessage,
    exitCode,
    ...(parser.sessionId ? { sessionId: parser.sessionId } : {}),
    diagnostic:
      toolOomNote(oom, exitCode ?? 0, 'coding_agent') ??
      (state === 'completed'
        ? ''
        : timedOut
          ? 'Invocation timed out; partial work is preserved.'
          : parser.permissionDenied
            ? 'The coding CLI reported a permission denial; review the task and continue explicitly.'
            : 'Invocation did not complete. Inspect the saved output and partial diff; verify the installed CLI and sandbox.'),
  }
}
