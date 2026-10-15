import { describe, expect, test } from 'bun:test'

import type { ChannelRouter } from '@/channels/router'
import type { ChannelKey } from '@/channels/types'

import { createChannelDisengageTool, type ChannelDisengageOrigin } from './channel-disengage'

function fakeRouter(clearSticky: (key: ChannelKey) => { keyId: string; cleared: number }): ChannelRouter {
  return {
    clearSticky,
  } as unknown as ChannelRouter
}

const origin: ChannelDisengageOrigin = {
  adapter: 'slack-bot',
  workspace: 'T1',
  chat: 'C1',
  thread: '1700000000.000100',
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelDisengageTool>['execute']>[4]
const run = (tool: ReturnType<typeof createChannelDisengageTool>) =>
  tool.execute('id', {}, undefined, undefined, fakeCtx)

function firstText(result: Awaited<ReturnType<ReturnType<typeof createChannelDisengageTool>['execute']>>): string {
  const first = result.content[0]
  if (first === undefined || first.type !== 'text') throw new Error('expected text content')
  return first.text
}

describe('createChannelDisengageTool', () => {
  test('forwards the origin channel key to router.clearSticky', async () => {
    let captured: ChannelKey | undefined
    const tool = createChannelDisengageTool({
      router: fakeRouter((key) => {
        captured = key
        return { keyId: 'slack-bot:T1:C1:1700000000.000100', cleared: 2 }
      }),
      origin,
    })

    await run(tool)

    expect(captured).toEqual({
      adapter: 'slack-bot',
      workspace: 'T1',
      chat: 'C1',
      thread: '1700000000.000100',
    })
  })

  test('reports the number of engagements dropped', async () => {
    const tool = createChannelDisengageTool({
      router: fakeRouter(() => ({ keyId: 'k', cleared: 3 })),
      origin,
    })

    const result = await run(tool)

    expect(result.details).toEqual({ ok: true, cleared: 3 })
    expect(firstText(result)).toContain('3 active engagements dropped')
  })

  test('says nothing was held when not auto-engaged', async () => {
    const tool = createChannelDisengageTool({
      router: fakeRouter(() => ({ keyId: 'k', cleared: 0 })),
      origin,
    })

    const result = await run(tool)

    expect(result.details).toEqual({ ok: true, cleared: 0 })
    expect(firstText(result)).toContain('not auto-engaged')
  })
})
