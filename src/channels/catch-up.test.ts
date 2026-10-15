import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { install } from '@sinonjs/fake-timers'

import { CATCH_UP_HEARTBEAT_MS, CHAT_CATCH_UP_MAX_AGE_MS, createInboundCatchUp } from './catch-up'
import { readLastAlive, writeLastAlive } from './last-alive'
import type { InboundMessage } from './types'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'catch-up-'))
  dirs.push(dir)
  return dir
}
const at = 2_000_000
function inbound(id: string, ts = at - 1000): InboundMessage {
  return {
    adapter: 'discord-bot',
    workspace: 'guild',
    chat: 'chat',
    thread: null,
    text: '확인 부탁해요',
    externalMessageId: id,
    authorId: 'alice',
    authorName: 'Alice',
    authorIsBot: false,
    isBotMention: true,
    replyToBotMessageId: null,
    mentionsOthers: false,
    replyToOtherMessageId: null,
    isDm: false,
    ts,
  }
}
const logger = { info: (_message: string) => {}, warn: (_message: string) => {} }

describe('missed inbound catch-up', () => {
  test('composes watermark, listing, filtering and the unchanged inbound route', async () => {
    // Given a persisted downtime boundary and missed messages of several ages.
    const dir = await directory()
    await writeLastAlive(dir, 'discord-bot', at - CHAT_CATCH_UP_MAX_AGE_MS * 2)
    const steps: string[] = []
    const routed: InboundMessage[] = []
    const current = inbound('current')
    const core = createInboundCatchUp({
      agentDir: dir,
      now: () => at,
      logger,
      route: async (message) => {
        steps.push('route')
        routed.push(message)
        return { kind: 'observed' }
      },
    })
    core.register('discord-bot', async (since) => {
      steps.push(`list:${since}`)
      return [
        { message: inbound('stale', at - CHAT_CATCH_UP_MAX_AGE_MS - 1), latestTs: 0 },
        { message: inbound('moved-on'), latestTs: at },
        { message: current, latestTs: current.ts },
      ]
    })
    try {
      // When boot catches up.
      await core.run('discord-bot')
      // Then stale/moved-on messages never route; the original Korean message does.
      expect(steps).toEqual([`list:${at - CHAT_CATCH_UP_MAX_AGE_MS}`, 'route'])
      expect(routed).toEqual([current])
      expect(routed[0]).toBe(current)
      expect(await readLastAlive(dir, 'discord-bot')).toBe(at)
    } finally {
      await core.stop()
    }
  })

  test('does not replay live-observed messages or adapters without capability', async () => {
    const dir = await directory()
    await writeLastAlive(dir, 'discord-bot', at - 2000)
    let routes = 0
    const message = inbound('seen')
    const core = createInboundCatchUp({
      agentDir: dir,
      now: () => at,
      logger,
      route: async () => {
        routes++
        return { kind: 'observed' }
      },
    })
    core.register('discord-bot', async () => [{ message, latestTs: message.ts }])
    core.noteObserved(message)
    try {
      await core.run('discord-bot')
      await core.run('slack')
      expect(routes).toBe(0)
    } finally {
      await core.stop()
    }
  })

  test('heartbeats only while connected and never polls history', async () => {
    const clock = install({ now: at, toFake: ['setInterval', 'clearInterval'] })
    const dir = await directory()
    let now = at
    let lists = 0
    const core = createInboundCatchUp({
      agentDir: dir,
      now: () => now,
      logger,
      route: async () => ({ kind: 'observed' }),
    })
    core.register('discord-bot', async () => {
      lists++
      return []
    })
    try {
      await core.run('discord-bot')
      core.disconnect('discord-bot')
      now += CATCH_UP_HEARTBEAT_MS
      await clock.tickAsync(CATCH_UP_HEARTBEAT_MS)
      expect(await readLastAlive(dir, 'discord-bot')).toBe(at)
      await core.run('discord-bot')
      expect(lists).toBe(2)
      expect(await readLastAlive(dir, 'discord-bot')).toBe(now)
    } finally {
      await core.stop()
      clock.uninstall()
    }
  })

  test('cancels a disconnected lifecycle before routing and reruns on reconnect', async () => {
    const dir = await directory()
    await writeLastAlive(dir, 'discord-bot', at - 2000)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    const routed: string[] = []
    const core = createInboundCatchUp({
      agentDir: dir,
      now: () => at,
      logger,
      route: async (message) => {
        routed.push(message.externalMessageId)
        return { kind: 'observed' }
      },
    })
    core.register('discord-bot', async () => {
      calls++
      if (calls === 1) {
        started.resolve()
        await release.promise
      }
      return [{ message: inbound('missed'), latestTs: at - 1000 }]
    })
    try {
      const boot = core.run('discord-bot')
      await started.promise
      core.disconnect('discord-bot')
      const reconnect = core.run('discord-bot')
      release.resolve()
      await Promise.all([boot, reconnect])
      expect(calls).toBe(2)
      expect(routed).toEqual(['missed'])
    } finally {
      await core.stop()
    }
  })

  test('keeps the old watermark after listing fails', async () => {
    const dir = await directory()
    await writeLastAlive(dir, 'discord-bot', at - 2000)
    const warnings: string[] = []
    const core = createInboundCatchUp({
      agentDir: dir,
      now: () => at,
      logger: { ...logger, warn: (line) => warnings.push(line) },
      route: async () => ({ kind: 'observed' }),
    })
    core.register('discord-bot', async () => {
      throw new Error('history unavailable')
    })
    try {
      await core.run('discord-bot')
      expect(await readLastAlive(dir, 'discord-bot')).toBe(at - 2000)
      expect(warnings).toHaveLength(1)
    } finally {
      await core.stop()
    }
  })

  test('migrates GitHub legacy liveness without sharing another adapter marker', async () => {
    const dir = await directory()
    await mkdir(join(dir, 'channels'))
    await writeFile(join(dir, 'channels', 'github-last-alive.json'), JSON.stringify({ at: 123 }))
    expect(await readLastAlive(dir, 'github')).toBe(123)
    expect(await readLastAlive(dir, 'slack-bot')).toBeNull()
    await writeLastAlive(dir, 'github', 456)
    expect(await readLastAlive(dir, 'github')).toBe(456)
  })
})
