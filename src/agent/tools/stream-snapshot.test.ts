import { describe, expect, test } from 'bun:test'

import { createStream } from '@/stream'

import { createStreamSnapshotTool } from './stream-snapshot'

const ctx = {} as Parameters<ReturnType<typeof createStreamSnapshotTool>['execute']>[4]

describe('stream_snapshot tool', () => {
  test('returns a friendly message when the stream is empty', async () => {
    const stream = createStream()
    const tool = createStreamSnapshotTool({ stream })

    const result = await tool.execute('id', {}, undefined, undefined, ctx)

    const text = textOf(result)
    expect(text).toMatch(/no stream events/i)
    expect(result.details).toMatchObject({ count: 0, events: [] })
  })

  test('returns recent events with target and payload summary', async () => {
    const stream = createStream()
    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'mood', value: 'happy' } })
    stream.publish({ target: { kind: 'cron', jobId: 'daily' }, payload: 'cron-fired' })
    const tool = createStreamSnapshotTool({ stream })

    const result = await tool.execute('id', {}, undefined, undefined, ctx)

    const text = textOf(result)
    expect(text).toMatch(/2 stream event/)
    expect(text).toMatch(/broadcast/)
    expect(text).toMatch(/cron:daily/)
    expect(text).toMatch(/mood/)
    const details = result.details as { count: number; events: Array<{ target: { kind: string } }> }
    expect(details.count).toBe(2)
  })

  test('filters by target_kind', async () => {
    const stream = createStream()
    stream.publish({ target: { kind: 'broadcast' }, payload: 'b' })
    stream.publish({ target: { kind: 'cron', jobId: 'a' }, payload: 'c1' })
    stream.publish({ target: { kind: 'cron', jobId: 'b' }, payload: 'c2' })
    const tool = createStreamSnapshotTool({ stream })

    const result = await tool.execute('id', { target_kind: 'cron' }, undefined, undefined, ctx)

    const details = result.details as { count: number; events: Array<{ payload: unknown }> }
    expect(details.count).toBe(2)
    expect(details.events.map((e) => e.payload)).toEqual(['c1', 'c2'])
  })

  test('filters by target_kind + target_id (cron jobId)', async () => {
    const stream = createStream()
    stream.publish({ target: { kind: 'cron', jobId: 'job-a' }, payload: 'a-msg' })
    stream.publish({ target: { kind: 'cron', jobId: 'job-b' }, payload: 'b-msg' })
    const tool = createStreamSnapshotTool({ stream })

    const result = await tool.execute('id', { target_kind: 'cron', target_id: 'job-a' }, undefined, undefined, ctx)

    const details = result.details as { count: number; events: Array<{ payload: unknown }> }
    expect(details.count).toBe(1)
    expect(details.events[0]?.payload).toBe('a-msg')
  })

  test('filters by target_kind + target_id (session sessionId)', async () => {
    const stream = createStream()
    stream.publish({ target: { kind: 'session', sessionId: 'alice' }, payload: 'a-msg' })
    stream.publish({ target: { kind: 'session', sessionId: 'bob' }, payload: 'b-msg' })
    const tool = createStreamSnapshotTool({ stream })

    const result = await tool.execute('id', { target_kind: 'session', target_id: 'alice' }, undefined, undefined, ctx)

    const details = result.details as { count: number; events: Array<{ payload: unknown }> }
    expect(details.count).toBe(1)
    expect(details.events[0]?.payload).toBe('a-msg')
  })

  test('respects since_ms_ago to filter out older events', async () => {
    let clock = 1_000
    const stream = createStream({ now: () => clock })
    stream.publish({ target: { kind: 'broadcast' }, payload: 'old' })
    clock = 1_030
    stream.publish({ target: { kind: 'broadcast' }, payload: 'new' })
    clock = 1_040
    const tool = createStreamSnapshotTool({ stream, now: () => clock })

    const result = await tool.execute('id', { since_ms_ago: 20 }, undefined, undefined, ctx)

    const details = result.details as { count: number; events: Array<{ payload: unknown }> }
    expect(details.events.map((e) => e.payload)).toEqual(['new'])
  })

  test('respects limit to cap the number of returned events', async () => {
    const stream = createStream()
    for (let i = 0; i < 10; i++) stream.publish({ target: { kind: 'broadcast' }, payload: `m${i}` })
    const tool = createStreamSnapshotTool({ stream })

    const result = await tool.execute('id', { limit: 3 }, undefined, undefined, ctx)

    const details = result.details as { count: number; events: Array<{ payload: unknown }> }
    expect(details.count).toBe(3)
    expect(details.events.map((e) => e.payload)).toEqual(['m7', 'm8', 'm9'])
  })

  test('truncates very long payloads in the human-readable summary', async () => {
    const stream = createStream()
    const big = 'x'.repeat(500)
    stream.publish({ target: { kind: 'broadcast' }, payload: big })
    const tool = createStreamSnapshotTool({ stream })

    const result = await tool.execute('id', {}, undefined, undefined, ctx)

    const text = textOf(result)
    expect(text).toMatch(/…/)
    expect(text).toMatch(/chars\)/)
    const details = result.details as { events: Array<{ payload: unknown }> }
    expect(details.events[0]?.payload).toBe(big)
  })

  test('preserves replyTo correlation in the output', async () => {
    const stream = createStream()
    const requestId = stream.publish({ target: { kind: 'broadcast' }, payload: 'request' })
    stream.reply(requestId, 'response')
    const tool = createStreamSnapshotTool({ stream })

    const result = await tool.execute('id', {}, undefined, undefined, ctx)

    const text = textOf(result)
    expect(text).toMatch(/reply→/)
    const details = result.details as { events: Array<{ payload: unknown; replyTo?: string }> }
    const reply = details.events.find((e) => e.replyTo !== undefined)
    expect(reply).toBeDefined()
    expect(reply?.replyTo).toBe(requestId)
  })
})

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0]
  return first?.type === 'text' ? (first.text ?? '') : ''
}
