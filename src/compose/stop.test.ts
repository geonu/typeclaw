import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Controller } from '@/container'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { composeStop, type ComposeStopEvent } from './stop'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-compose-stop-'))
})

afterEach(async () => {
  await rmTempDir(root)
})

async function makeAgent(parent: string, name: string): Promise<void> {
  await writeAgent(parent, name, '{}\n')
}

async function makeMalformedAgent(parent: string, name: string): Promise<void> {
  await writeAgent(parent, name, 'this is not json\n')
}

async function writeAgent(parent: string, name: string, config: string): Promise<void> {
  const dir = join(parent, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'typeclaw.json'), config)
}

// Replaces the real Docker shell-out so these tests stay deterministic; records
// each cwd it saw for the composition assertions.
function fakeStop(): { stop: Controller['stop']; cwds: string[] } {
  const cwds: string[] = []
  const stop: Controller['stop'] = async ({ cwd }) => {
    cwds.push(cwd)
    return { ok: true, containerName: 'x', running: false }
  }
  return { stop, cwds }
}

describe('composeStop events', () => {
  test('emits agent-start then agent-done for every discovered agent', async () => {
    await makeAgent(root, 'alpha')
    await makeAgent(root, 'bravo')

    const { stop, cwds } = fakeStop()
    const events: ComposeStopEvent[] = []
    const { results } = await composeStop({ rootCwd: root, onProgress: (event) => events.push(event) }, { stop })

    expect(results).toHaveLength(2)
    expect(new Set(cwds)).toEqual(new Set([join(root, 'alpha'), join(root, 'bravo')]))

    const starts = events.filter((e) => e.kind === 'agent-start').map((e) => e.name)
    const dones = events.filter((e) => e.kind === 'agent-done').map((e) => e.name)
    expect(new Set(starts)).toEqual(new Set(['alpha', 'bravo']))
    expect(new Set(dones)).toEqual(new Set(['alpha', 'bravo']))
  })

  test('agent-start precedes agent-done for each agent name', async () => {
    await makeAgent(root, 'solo')

    const { stop } = fakeStop()
    const events: ComposeStopEvent[] = []
    await composeStop({ rootCwd: root, onProgress: (event) => events.push(event) }, { stop })

    const startIdx = events.findIndex((e) => e.kind === 'agent-start' && e.name === 'solo')
    const doneIdx = events.findIndex((e) => e.kind === 'agent-done' && e.name === 'solo')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(doneIdx).toBeGreaterThan(startIdx)
  })

  test('agent-done carries the same AgentResult as the returned results', async () => {
    await makeAgent(root, 'alpha')

    const { stop } = fakeStop()
    const events: ComposeStopEvent[] = []
    const { results } = await composeStop({ rootCwd: root, onProgress: (event) => events.push(event) }, { stop })

    const done = events.find((e) => e.kind === 'agent-done')
    expect(done).toBeDefined()
    if (done?.kind !== 'agent-done') throw new Error('unreachable')
    expect(done.result).toEqual(results[0]!)
  })

  // The cleanup contract: a corrupted typeclaw.json must NOT stop composeStop
  // from reaching the controller, or a broken config strands a container. This
  // locks it in so a future validateConfig short-circuit (as start/restart have)
  // fails here instead of silently regressing the contract.
  test('stops an agent whose typeclaw.json is malformed (no config guard)', async () => {
    await makeMalformedAgent(root, 'broken')

    const { stop, cwds } = fakeStop()
    const { results } = await composeStop({ rootCwd: root }, { stop })

    expect(cwds).toEqual([join(root, 'broken')])
    expect(results).toEqual([
      { name: 'broken', ok: true, data: { ok: true, containerName: 'x', running: false }, warnings: [] },
    ])
  })

  test('maps a controller failure to a failed AgentResult', async () => {
    await makeAgent(root, 'alpha')

    const stop: Controller['stop'] = async () => ({ ok: false, reason: 'docker down' })
    const { results } = await composeStop({ rootCwd: root }, { stop })

    expect(results).toEqual([{ name: 'alpha', ok: false, reason: 'docker down', warnings: [] }])
  })

  test('maps a thrown controller error to a failed AgentResult', async () => {
    await makeAgent(root, 'alpha')

    const stop: Controller['stop'] = async () => {
      throw new Error('boom')
    }
    const { results } = await composeStop({ rootCwd: root }, { stop })

    expect(results).toEqual([{ name: 'alpha', ok: false, reason: 'boom', warnings: [] }])
  })

  test('collects stop warnings in the per-agent result', async () => {
    await makeAgent(root, 'alpha')
    const stop: Controller['stop'] = async (options) => {
      options.onWarning?.('dead logs unavailable')
      return { ok: true, containerName: 'alpha', running: false }
    }

    const { results } = await composeStop({ rootCwd: root }, { stop })

    expect(results[0]?.warnings).toEqual(['dead logs unavailable'])
  })

  test('emits no events when no agents are discovered', async () => {
    const { stop } = fakeStop()
    const events: ComposeStopEvent[] = []
    const { agents, results } = await composeStop(
      { rootCwd: root, onProgress: (event) => events.push(event) },
      { stop },
    )

    expect(agents).toEqual([])
    expect(results).toEqual([])
    expect(events).toEqual([])
  })

  test('runs without onProgress', async () => {
    await makeAgent(root, 'alpha')
    const { stop } = fakeStop()
    const { results } = await composeStop({ rootCwd: root }, { stop })
    expect(results).toHaveLength(1)
  })
})
