import { constants } from 'node:fs'
import { open, lstat } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import { getConfig, resolveModel } from '@/config'
import { KNOWN_PROVIDERS } from '@/config/providers'
import type { PermissionService } from '@/permissions'
import { resolveHiddenPaths } from '@/sandbox/hidden-paths'
import { createCodingAgentAuthResolver, type CodingAgentAuthResolver } from '@/secrets/coding-agent-auth'

import { CLAUDE_AUXILIARY_MODELS, CLAUDE_CODE_VERSION } from './claude'
import { runCodingAgent, type CodingRunOptions, type CodingRunResult } from './runner'
import {
  captureCodingChanges,
  codingGitExecutor,
  createCodingWorkspace,
  createTaskDirectory,
  disposeCodingWorkspace,
  resolveCodingSource,
  writeCodingArtifact,
  writeTaskRegistry,
  type ChangeArtifacts,
  type CodingExecutor,
  type CodingWorkspace,
} from './worktree'

export const codingRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('run'),
    engine: z.enum(['claude', 'codex']),
    repo: z.string().min(1).optional(),
    modelRef: z.string().min(1).optional(),
    taskId: z.string().uuid().optional(),
    prompt: z.string().min(1).max(1_000_000),
    mode: z.enum(['plan', 'code']).optional(),
    timeoutSeconds: z.number().finite().positive().max(2_147_483.647).default(1800),
  }),
  z.strictObject({ action: z.literal('result'), taskId: z.string().uuid() }),
  z.strictObject({ action: z.literal('dispose'), taskId: z.string().uuid(), discard: z.literal(true) }),
])
export type CodingRequest = z.infer<typeof codingRequestSchema>
const taskSchema = z.object({
  taskId: z.string().uuid(),
  ownerSessionId: z.string(),
  parentSessionId: z.string().optional(),
  principal: z.string(),
  role: z.string(),
  modelRef: z.string(),
  model: z.string(),
  mode: z.enum(['plan', 'code']),
  permissions: z.array(z.string()),
  allowedModels: z.array(z.string()),
  engineVersion: z.string(),
  source: z.string(),
  sourceIdentity: z.string(),
  baseSha: z.string(),
  dirtySource: z.boolean(),
  sessionId: z.string().uuid().optional(),
  state: z.enum(['running', 'completed', 'incomplete', 'failed', 'cancelled', 'interrupted']),
  finalMessage: z.string().default(''),
  exitCode: z.number().nullable().default(null),
  diagnostic: z.string().default(''),
  changedFiles: z.array(z.string()).default([]),
  untrackedFiles: z.array(z.string()).default([]),
  oversized: z.boolean().default(false),
})
type CodingTask = z.infer<typeof taskSchema>
export type CodingCaller = {
  readonly sessionId: string
  readonly origin: SessionOrigin | undefined
  readonly permissions: PermissionService
  readonly onPrepared?: (receipt: Record<string, unknown>) => void
}
type ServiceDependencies = {
  auth?: () => Promise<CodingAgentAuthResolver>
  executor?: (source: string, root: string, signal?: AbortSignal) => CodingExecutor
  run?: (options: CodingRunOptions) => Promise<CodingRunResult>
  writeArtifact?: (path: string, text: string) => Promise<void>
  sourcePath?: (source: string) => string
}

export class CodingAgentService {
  private readonly tasks = new Map<string, CodingTask>()
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private readonly ready: Promise<void>
  private auth: Promise<CodingAgentAuthResolver> | undefined
  private saving: Promise<void> = Promise.resolve()
  private stopped = false
  private registryUnavailable = false

  constructor(
    readonly agentDir: string,
    private readonly dependencies: ServiceDependencies = {},
  ) {
    this.ready = this.load().catch(() => {
      this.registryUnavailable = true
    })
  }

  async execute(request: CodingRequest, caller: CodingCaller, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.ready
    if (this.stopped) throw new Error('Coding delegation is shutting down.')
    if (this.registryUnavailable)
      throw new Error('Coding task registry is unreadable. The host operator must repair it before delegation resumes.')
    authorize(caller, this.agentDir)
    if (request.action === 'run' && request.engine === 'codex') {
      return { ok: false, diagnostic: 'Codex delegation is not yet available. Use the Claude engine.' }
    }
    if (request.action === 'result') {
      const task = this.tasks.get(request.taskId)
      if (!task) throw new Error('Unknown coding task.')
      this.authorizeTask(task, caller)
      if (task.state !== 'interrupted' || this.active.has(task.taskId)) return this.receipt(task)
    }
    const id = request.taskId ?? crypto.randomUUID()
    if (this.active.has(id)) throw new Error('Coding task already running.')
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let finish: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.active.set(id, { controller, done })
    const timer = setTimeout(
      () => controller.abort(new DOMException('Coding invocation timed out', 'TimeoutError')),
      request.action === 'run' ? request.timeoutSeconds * 1000 : 60_000,
    )
    try {
      return await this.executeRequest(request, caller, combined, id)
    } finally {
      clearTimeout(timer)
      this.active.delete(id)
      finish()
    }
  }

  private async executeRequest(
    request: CodingRequest,
    caller: CodingCaller,
    signal?: AbortSignal,
    creationId?: string,
  ): Promise<Record<string, unknown>> {
    if (request.action === 'run' && !request.taskId) {
      if (!creationId) throw new Error('Missing coding task identity.')
      return this.create(request, caller, creationId, signal)
    }
    const task = this.tasks.get(request.taskId ?? '')
    if (!task) throw new Error('Unknown coding task.')
    this.authorizeTask(task, caller)
    if (request.action === 'result') {
      const workspace = this.workspace(task)
      const writeArtifact =
        this.dependencies.writeArtifact ??
        ((path: string, text: string) => writeCodingArtifact(this.agentDir, path, text))
      const execute =
        this.dependencies.executor?.(task.source, workspace.taskRoot, signal) ??
        codingGitExecutor(task.source, workspace.taskRoot, signal, 'plan')
      try {
        Object.assign(task, await captureCodingChanges(workspace, execute, writeArtifact))
        await this.save()
      } catch {
        return {
          ...this.receipt(task),
          diagnostic:
            'Runtime was interrupted. Current diff recovery failed; inspect the retained worktree before resuming.',
        }
      }
      return this.receipt(task)
    }
    switch (request.action) {
      case 'dispose': {
        await disposeCodingWorkspace(this.workspace(task), this.executor(task))
        this.tasks.delete(task.taskId)
        await this.save()
        return { ok: true, taskId: task.taskId, state: 'disposed' }
      }
      case 'run':
        await resolveCodingSource(
          this.agentDir,
          task.source,
          getConfig().mounts.map((mount) => mount.name),
        )
        if (
          (request.modelRef && request.modelRef !== task.modelRef) ||
          (request.repo && request.repo !== task.source)
        ) {
          throw new Error('A resumed task keeps its recorded repository and model.')
        }
        if (task.engineVersion !== CLAUDE_CODE_VERSION)
          throw new Error('Task CLI version changed; preserve and review its diff before migrating.')
        if (!task.sessionId)
          throw new Error('This task has no resumable Claude session. Its partial work remains available.')
        task.mode = request.mode ?? task.mode
        return this.invoke(task, request, signal)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    const runs = [...this.active.values()]
    for (const run of runs) run.controller.abort()
    await Promise.allSettled(runs.map((run) => run.done))
    await this.saving
  }

  private async create(
    request: Extract<CodingRequest, { action: 'run' }>,
    caller: CodingCaller,
    taskId: string,
    signal?: AbortSignal,
  ) {
    if (!request.repo || !request.modelRef)
      throw new Error('A new task requires repo and a concrete anthropic modelRef.')
    const config = getConfig()
    if (!config.docker.file.claudeCode && !this.dependencies.run) {
      throw new Error('Enable docker.file.claudeCode on the host and run `typeclaw start` to rebuild the image.')
    }
    if (
      !request.modelRef.startsWith('anthropic/') ||
      !(
        request.modelRef.slice('anthropic/'.length) in KNOWN_PROVIDERS.anthropic.models ||
        request.modelRef in config.customModels
      )
    )
      throw new Error('Select a configured or curated anthropic modelRef.')
    const model = resolveModel(request.modelRef).id
    const source = await resolveCodingSource(
      this.agentDir,
      request.repo,
      config.mounts.map((mount) => mount.name),
    )
    // Missing auth never creates a task, exits the runtime, or disables another provider.
    await (await this.resolver()).resolve(signal)
    const taskRoot = await createTaskDirectory(this.agentDir, taskId)
    const identity = await lstat(source)
    const task: CodingTask = {
      taskId,
      ownerSessionId: caller.sessionId,
      ...(caller.origin?.kind === 'subagent' ? { parentSessionId: caller.origin.parentSessionId } : {}),
      principal: principal(caller.origin),
      role: caller.permissions.resolveRole(caller.origin),
      permissions: [...caller.permissions.describe(caller.origin).permissions],
      modelRef: request.modelRef,
      model,
      mode: request.mode ?? 'code',
      allowedModels: [...new Set([model, ...CLAUDE_AUXILIARY_MODELS])],
      engineVersion: CLAUDE_CODE_VERSION,
      source,
      sourceIdentity: `${identity.dev}:${identity.ino}`,
      baseSha: '',
      dirtySource: false,
      state: 'running',
      finalMessage: '',
      diagnostic: '',
      changedFiles: [],
      untrackedFiles: [],
      exitCode: null,
      oversized: false,
    }
    this.tasks.set(taskId, task)
    await this.save()
    try {
      const workspace = await createCodingWorkspace(
        source,
        taskRoot,
        (this.dependencies.executor ?? codingGitExecutor)(source, taskRoot, signal),
        this.dependencies.sourcePath?.(source),
      )
      task.baseSha = workspace.baseSha
      task.dirtySource = workspace.dirtySource
      task.sourceIdentity = workspace.sourceIdentity
    } catch (error) {
      task.state = signal?.aborted ? 'incomplete' : 'failed'
      task.diagnostic =
        error instanceof Error ? error.message : 'Source snapshot failed; the task directory is preserved.'
      await this.save()
      return this.receipt(task)
    }
    caller.onPrepared?.(this.receipt(task))
    return this.invoke(task, request, signal)
  }

  private async invoke(task: CodingTask, request: Extract<CodingRequest, { action: 'run' }>, signal?: AbortSignal) {
    const combined = signal ?? new AbortController().signal
    const workspace = this.workspace(task)
    const writeArtifact =
      this.dependencies.writeArtifact ??
      ((path: string, text: string) => writeCodingArtifact(this.agentDir, path, text))
    try {
      const source = await lstat(task.source)
      if (`${source.dev}:${source.ino}` !== task.sourceIdentity) throw new Error('Source repository identity changed.')
      const auth = await this.resolver()
      await auth.resolve(combined)
      task.state = 'running'
      await this.save()
      const result = await (this.dependencies.run ?? runCodingAgent)({
        workspace,
        auth,
        model: task.model,
        allowedModels: task.allowedModels,
        sessionId: task.sessionId ?? crypto.randomUUID(),
        resume: task.sessionId !== undefined,
        mode: task.mode,
        prompt: request.prompt,
        timeoutSeconds: request.timeoutSeconds,
        signal: combined,
        writeArtifact,
      })
      Object.assign(task, result)
      // Collect the diff even after cancellation; the child has already been killed and reaped.
      const artifactExecutor =
        this.dependencies.executor?.(task.source, workspace.taskRoot) ??
        codingGitExecutor(task.source, workspace.taskRoot, undefined, 'plan')
      const artifacts: ChangeArtifacts = await captureCodingChanges(workspace, artifactExecutor, writeArtifact)
      Object.assign(task, artifacts)
      if (artifacts.oversized) {
        task.state = 'incomplete'
        task.diagnostic =
          'Change artifact exceeds 64 MiB; inspect the retained worktree. No truncated patch was produced.'
      }
      await writeArtifact(
        join(workspace.taskRoot, 'output', 'result.json'),
        JSON.stringify(this.receipt(task), null, 2),
      )
      return this.receipt(task)
    } catch (error) {
      task.state = combined.aborted
        ? combined.reason instanceof DOMException && combined.reason.name === 'TimeoutError'
          ? 'incomplete'
          : 'cancelled'
        : 'failed'
      task.diagnostic = error instanceof Error ? error.message : 'Coding task failed; partial work is preserved.'
      return this.receipt(task)
    } finally {
      await this.save()
    }
  }

  private authorizeTask(task: CodingTask, caller: CodingCaller): void {
    const samePrincipal = task.principal === principal(caller.origin)
    const sameScope = task.ownerSessionId === caller.sessionId || task.parentSessionId === caller.sessionId
    const current = caller.permissions.describe(caller.origin).permissions
    if (!samePrincipal || !sameScope || !task.permissions.every((permission) => current.includes(permission))) {
      throw new Error('Coding task belongs to a different caller or authority scope.')
    }
  }

  private workspace(task: CodingTask): CodingWorkspace {
    return {
      source: task.source,
      sourceIdentity: task.sourceIdentity,
      baseSha: task.baseSha,
      dirtySource: task.dirtySource,
      taskRoot: join(this.agentDir, 'workspace', 'coding-agents', task.taskId),
    }
  }

  private executor(task: CodingTask): CodingExecutor {
    return (this.dependencies.executor ?? codingGitExecutor)(task.source, this.workspace(task).taskRoot)
  }

  private receipt(task: CodingTask): Record<string, unknown> {
    const root = this.workspace(task).taskRoot
    return {
      ok: task.state === 'completed',
      taskId: task.taskId,
      state: task.state,
      baseSha: task.baseSha,
      source: task.source,
      modelRef: task.modelRef,
      engineVersion: task.engineVersion,
      worktreePath: join(root, 'worktree'),
      finalMessage: task.finalMessage,
      changedFiles: task.changedFiles,
      untrackedFiles: task.untrackedFiles,
      patchPath: task.oversized ? null : join(root, 'output', 'changes.patch'),
      exitCode: task.exitCode,
      diagnostic: task.diagnostic,
      ...(task.dirtySource
        ? {
            warning: 'Source has uncommitted changes. This task uses committed HEAD only; those changes were excluded.',
          }
        : {}),
      oversized: task.oversized,
    }
  }

  private resolver(): Promise<CodingAgentAuthResolver> {
    this.auth ??= (this.dependencies.auth ?? (() => createCodingAgentAuthResolver(this.agentDir)))().catch((error) => {
      this.auth = undefined
      throw error
    })
    return this.auth
  }

  private async load(): Promise<void> {
    const path = join(this.agentDir, '.typeclaw', 'coding-agent-tasks.json')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (!file) return
    try {
      const text = await file.readFile('utf8')
      if (!text.trim()) return
      for (const task of z.array(taskSchema).parse(JSON.parse(text))) {
        if (task.state === 'running') {
          task.state = 'interrupted'
          task.diagnostic = 'Runtime restarted; resume explicitly with a fresh invocation.'
        }
        this.tasks.set(task.taskId, task)
      }
    } finally {
      await file.close()
    }
  }

  private save(): Promise<void> {
    const text = JSON.stringify([...this.tasks.values()])
    this.saving = this.saving.then(() =>
      writeTaskRegistry(join(this.agentDir, '.typeclaw', 'coding-agent-tasks.json'), text),
    )
    return this.saving
  }
}

function authorize(caller: CodingCaller, agentDir: string): void {
  const origin = caller.origin
  if (
    !origin ||
    (origin.kind !== 'tui' && origin.kind !== 'channel' && origin.kind !== 'subagent') ||
    !caller.permissions.has(origin, 'subagent.spawn') ||
    resolveHiddenPaths(caller.permissions, origin, agentDir).dirs.includes(join(agentDir, 'workspace'))
  ) {
    throw new Error('Coding delegation requires subagent.spawn and private workspace access.')
  }
  principal(origin)
}

function principal(origin: SessionOrigin | undefined): string {
  let root = origin
  for (let depth = 0; root?.kind === 'subagent' && depth < 8; depth++) root = root.spawnedByOrigin
  if (root?.kind === 'tui') return JSON.stringify(['tui', root.sessionId])
  if (root?.kind === 'channel' && root.lastInboundAuthorId) {
    return JSON.stringify([root.adapter, root.workspace, root.chat, root.thread, root.lastInboundAuthorId])
  }
  throw new Error('Coding delegation requires an attributable interactive caller.')
}

const services = new Map<string, { service: CodingAgentService; owners: number }>()
export function getCodingAgentService(agentDir: string): CodingAgentService {
  let entry = services.get(agentDir)
  if (!entry) {
    entry = { service: new CodingAgentService(agentDir), owners: 0 }
    services.set(agentDir, entry)
  }
  return entry.service
}
export function retainCodingAgentService(agentDir: string): () => Promise<void> {
  const service = getCodingAgentService(agentDir)
  const entry = services.get(agentDir)
  if (!entry) throw new Error('Coding service was not initialized.')
  entry.owners++
  let released = false
  return async () => {
    if (released) return
    released = true
    entry.owners--
    if (entry.owners === 0) {
      services.delete(agentDir)
      await service.stop()
    }
  }
}
