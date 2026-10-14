import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'

import { readOomEvents, toolOomNote } from '@/container/oom-events'
import { withToolOomPriorityArgv } from '@/container/tool-oom-priority'
import { prepareCodingCommand } from '@/sandbox/coding-agent'
import type { CodingAgentAuthResolver, CodingAgentProvider } from '@/secrets/coding-agent-auth'

import { SecretScrubber, startCodingBroker, type CodingBroker } from './broker'
import { ClaudeStreamParser, claudeArguments, claudeEnvironment, type CodingMode } from './claude'
import { CodexStreamParser, codexArguments, codexConfig, codexEnvironment } from './codex'
import { omoArguments, omoConfiguration, omoEnvironment, type OmoModel } from './omo'
import { hasOmoSession, prepareOmoDirectories } from './omo-state'
import { OmoStreamParser } from './omo-stream'
import type { CodingWorkspace } from './worktree'

export type CodingRunResult = {
  readonly state: 'completed' | 'incomplete' | 'failed' | 'cancelled'
  readonly finalMessage: string
  readonly sessionId?: string
  readonly exitCode: number | null
  readonly diagnostic: string
}

export type CodingRunOptions = {
  readonly engine?: 'claude' | 'codex' | 'omo'
  readonly provider?: CodingAgentProvider
  readonly modelMetadata?: OmoModel
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
  const cwd = join(options.workspace.taskRoot, 'worktree')
  const parser =
    engine === 'claude'
      ? new ClaudeStreamParser()
      : engine === 'codex'
        ? new CodexStreamParser()
        : new OmoStreamParser({ sessionId: options.sessionId, cwd })
  let stdout = ''
  let stdoutTail = ''
  let stderr = ''
  let exitCode: number | null = null
  let failure = false
  let missingSession = false
  const oom = readOomEvents()
  try {
    signal.throwIfAborted()
    const provider = options.provider ?? (engine === 'claude' ? 'anthropic' : 'openai-codex')
    const configDir = join(options.workspace.taskRoot, engine)
    if (engine === 'omo') {
      if (!options.provider || options.modelMetadata?.id !== options.model)
        throw new Error('Missing OmO model metadata.')
      if (options.resume && !(await hasOmoSession(configDir, options.sessionId, cwd))) {
        missingSession = true
        throw new Error('OmO session is missing or unsafe.')
      }
      await prepareOmoDirectories(configDir)
    }
    broker = await (testDependencies?.broker ?? startCodingBroker)({
      engine,
      provider,
      auth: options.auth,
      allowedModels: options.allowedModels,
      deadline,
      signal,
    })
    if (engine === 'codex') {
      await options.writeArtifact(join(configDir, 'config.toml'), codexConfig(options.model, broker.baseUrl))
    }
    if (engine === 'omo' && options.modelMetadata) {
      const config = omoConfiguration({ configDir, baseUrl: broker.baseUrl, provider, model: options.modelMetadata })
      for (const [path, value] of [
        ['agent/models.json', config.models],
        ['agent/settings.json', config.settings],
        ['home/.omo/omo.jsonc', config.orchestration],
      ] as const)
        await options.writeArtifact(join(configDir, path), JSON.stringify(value, null, 2))
    }
    const env =
      engine === 'claude'
        ? claudeEnvironment(configDir, broker.baseUrl, broker.capability)
        : engine === 'codex'
          ? codexEnvironment(configDir, broker.capability)
          : omoEnvironment(configDir, broker.capability)
    const args =
      engine === 'claude'
        ? claudeArguments(options)
        : engine === 'codex'
          ? codexArguments(options)
          : omoArguments({ ...options, configDir })
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
          engine,
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
        stdoutTail = final
      } else stderr += final
    }
    // Observe pipe/parser failures immediately, including the decoder's final
    // flush. Waiting for process exit before attaching a rejection handler can
    // leave an oversized final JSONL record as an unhandled rejection.
    const reads = [consume(child.stdout, true), consume(child.stderr, false)].map((read) =>
      read.catch(() => {
        failure = true
        kill()
      }),
    )
    signal.addEventListener('abort', kill, { once: true })
    child.stdin.on('error', () => {
      failure = true
    })
    try {
      if (signal.aborted) kill()
      else
        child.stdin.end(
          engine !== 'claude' && options.mode === 'plan'
            ? `Plan this task without modifying the repository. The worktree and Git database are read-only.\n\n${options.prompt}`
            : options.prompt,
        )
      const [code, killedBy] = await closed
      exitCode = typeof code === 'number' ? code : killedBy === 'SIGKILL' ? 137 : null
      await Promise.all(reads)
      // The decoder/scrubber tail is available only at EOF. Validate it after
      // reaping, rather than attempting to kill a process already exiting.
      parser.push(stdoutTail)
      parser.finish()
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
      : missingSession
        ? 'incomplete'
        : failure || exitCode !== 0 || parser.failed || parser.malformed
          ? 'failed'
          : !parser.terminal || parser.permissionDenied || (engine !== 'claude' && !parser.sessionId)
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
        : missingSession
          ? 'The recorded OmO session is missing or unsafe. Restore its task-local session file before resuming; partial work is preserved.'
          : timedOut
            ? 'Invocation timed out; partial work is preserved.'
            : parser.permissionDenied
              ? 'The coding CLI reported a permission denial; review the task and continue explicitly.'
              : 'Invocation did not complete. Inspect the saved output and partial diff; verify the installed CLI and sandbox.'),
  }
}
