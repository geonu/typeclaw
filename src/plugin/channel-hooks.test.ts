import { expect, test } from 'bun:test'

import FakeTimers from '@sinonjs/fake-timers'

import { createHookBus } from './hooks'
import type { ChannelMessageObservedEvent, ChannelOutboundBeforeEvent, Hooks } from './types'

const logger = { info() {}, warn() {}, error() {} }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const outbound = (): ChannelOutboundBeforeEvent => ({
  adapter: 'slack-bot',
  workspace: 'T_EXAMPLE',
  chat: 'C_EXAMPLE',
  text: '검토 전 문장입니다.',
  op: 'send',
  source: 'tool',
  origin: { kind: 'cron', jobId: 'example-digest' },
})
const observed = (): ChannelMessageObservedEvent => ({
  adapter: 'slack-bot',
  workspace: 'T_EXAMPLE',
  selfUserId: 'U_BOT',
  receivedAt: 123,
  event: {
    type: 'message',
    channel: 'C_EXAMPLE',
    subtype: 'message_changed',
    event_ts: '123.000002',
    message: { text: '수정된 요청', ts: '123.000001', files: [{ id: 'F_EXAMPLE' }] },
    previous_message: { text: '이전 요청', ts: '123.000001' },
  },
})

test('observers receive an immutable receipt-time snapshot without delaying their caller', async () => {
  const bus = createHookBus()
  const pending = Promise.withResolvers<void>()
  const received: ChannelMessageObservedEvent[] = []
  bus.registerAll('pending-observer', '/agent', logger, {
    'channel.message.observed': (event) => {
      Reflect.set(event.event.message!, 'text', 'injected')
      return pending.promise
    },
  })
  bus.registerAll('healthy-observer', '/agent', logger, {
    'channel.message.observed': (event) => {
      received.push(event)
    },
  })
  const input = observed()
  bus.runChannelMessageObserved(input)
  ;(input.event.message as Record<string, unknown>).text = 'later transport mutation'
  await tick()
  expect(received).toEqual([observed()])
  expect(Object.isFrozen(received[0]!.event.message!.files)).toBe(true)
  pending.resolve()
  await tick()
})

test('observer timeout, late rejection and failing diagnostics cannot stop a sibling or future deliveries', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const logs: string[] = []
    const bus = createHookBus({ observedHandlerTimeoutMs: 5 })
    const pending = Promise.withResolvers<void>()
    let deliveries = 0
    bus.registerAll(
      'slow-observer',
      '/agent',
      { ...logger, error: (line) => logs.push(line) },
      {
        'channel.message.observed': () => pending.promise,
      },
    )
    bus.registerAll(
      'throwing-observer',
      '/agent',
      {
        ...logger,
        error() {
          throw new Error('logger')
        },
      },
      {
        'channel.message.observed': () => {
          throw new Error('SYNTHETIC_PRIVATE_BODY')
        },
      },
    )
    bus.registerAll('healthy-observer', '/agent', logger, {
      'channel.message.observed': () => {
        deliveries++
      },
    })
    bus.runChannelMessageObserved(observed())
    await clock.runAllAsync()
    pending.reject(new Error('SYNTHETIC_PRIVATE_BODY'))
    await tick()
    expect(deliveries).toBe(1)
    expect(logs).toEqual(['hook channel.message.observed timed out (plugin slow-observer)'])
    bus.unregisterAll('slow-observer')
    bus.unregisterAll('throwing-observer')
    bus.runChannelMessageObserved(observed())
    await tick()
    expect(deliveries).toBe(2)
  } finally {
    clock.uninstall()
  }
})

test('no observers means no event inspection, and a broken snapshot does not enter any observer', async () => {
  const bus = createHookBus()
  const input = Object.defineProperty({}, 'event', {
    enumerable: true,
    get() {
      throw new Error('SYNTHETIC_PRIVATE_BODY')
    },
  })
  bus.runChannelMessageObserved(input as ChannelMessageObservedEvent)
  let calls = 0
  const logs: string[] = []
  bus.registerAll(
    'observer',
    '/agent',
    { ...logger, error: (line) => logs.push(line) },
    {
      'channel.message.observed': () => {
        calls++
      },
    },
  )
  bus.runChannelMessageObserved(input as ChannelMessageObservedEvent)
  await tick()
  expect(calls).toBe(0)
  expect(logs).toEqual(['hook channel.message.observed snapshot failed (plugin observer)'])
})

test('outbound transforms compose in registration order without mutating text, target or trusted origin', async () => {
  const bus = createHookBus()
  const input = outbound()
  bus.registerAll('first', '/agent', logger, {
    'channel.outbound.before': (event) => {
      Reflect.set(event, 'chat', 'C_OTHER')
      Reflect.set(event.origin!, 'jobId', 'other-job')
      return { text: '검토한 문장입니다.' }
    },
  })
  bus.registerAll('second', '/agent', logger, {
    'channel.outbound.before': (event) => ({ text: `${event.text} (${event.chat}; ${event.origin?.jobId})` }),
  })
  expect(await bus.runChannelOutboundBefore(input)).toEqual({
    text: '검토한 문장입니다. (C_EXAMPLE; example-digest)',
  })
  expect(input).toEqual(outbound())
  bus.unregisterAll('first')
  expect(await bus.runChannelOutboundBefore(input)).toEqual({
    text: '검토 전 문장입니다. (C_EXAMPLE; example-digest)',
  })
})

test('outbound timeout and late rejection retain the preceding text and continue the chain', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const logs: string[] = []
    const bus = createHookBus({ outboundHandlerTimeoutMs: 5 })
    const pending = Promise.withResolvers<{ text: string }>()
    bus.registerAll('first', '/agent', logger, { 'channel.outbound.before': () => ({ text: 'first review' }) })
    bus.registerAll(
      'slow',
      '/agent',
      { ...logger, error: (line) => logs.push(line) },
      {
        'channel.outbound.before': () => pending.promise,
      },
    )
    bus.registerAll('last', '/agent', logger, {
      'channel.outbound.before': (event) => ({ text: `${event.text}; final review` }),
    })
    const delivery = bus.runChannelOutboundBefore(outbound())
    await clock.runAllAsync()
    expect(await delivery).toEqual({ text: 'first review; final review' })
    pending.reject(new Error('SYNTHETIC_PRIVATE_BODY'))
    await tick()
    expect(logs).toEqual(['hook channel.outbound.before timed out (plugin slow)'])
  } finally {
    clock.uninstall()
  }
})

test('invalid outbound results cannot drop text or smuggle routing/blocking fields', async () => {
  const invalid: unknown[] = [
    null,
    { text: '' },
    { text: '  ' },
    { text: 5 },
    { text: 'replacement', chat: 'C_OTHER' },
    { text: 'replacement', block: true },
    Object.create({ text: 'inherited' }),
    Object.defineProperty({}, 'text', {
      get() {
        throw new Error('SYNTHETIC_PRIVATE_BODY')
      },
    }),
  ]
  for (const value of invalid) {
    const bus = createHookBus()
    const logs: string[] = []
    bus.registerAll(
      'invalid',
      '/agent',
      { ...logger, error: (line) => logs.push(line) },
      {
        'channel.outbound.before': (() => value) as Hooks['channel.outbound.before'],
      },
    )
    expect(await bus.runChannelOutboundBefore(outbound())).toEqual({ text: outbound().text })
    expect(logs).toEqual(['hook channel.outbound.before invalid result (plugin invalid)'])
  }
})

test('a throwing hook/logger fails open, concurrent sends stay independent, and captionless sends stay captionless', async () => {
  const bus = createHookBus()
  bus.registerAll(
    'broken',
    '/agent',
    {
      ...logger,
      error() {
        throw new Error('logger')
      },
    },
    {
      'channel.outbound.before': () => {
        throw new Error('SYNTHETIC_PRIVATE_BODY')
      },
    },
  )
  bus.registerAll('formatter', '/agent', logger, {
    'channel.outbound.before': async (event) => {
      await tick()
      return { text: `reviewed: ${event.text}` }
    },
  })
  expect(
    await Promise.all([
      bus.runChannelOutboundBefore({ ...outbound(), text: 'one' }),
      bus.runChannelOutboundBefore({ ...outbound(), text: 'two' }),
      bus.runChannelOutboundBefore({ ...outbound(), text: '' }),
    ]),
  ).toEqual([{ text: 'reviewed: one' }, { text: 'reviewed: two' }, { text: '' }])
  bus.unregisterAll('broken')
  bus.unregisterAll('formatter')
  expect(await bus.runChannelOutboundBefore(outbound())).toEqual({ text: outbound().text })
})

test('a hook registered during transformation only applies to subsequent logical deliveries', async () => {
  const bus = createHookBus()
  let installed = false
  bus.registerAll('installer', '/agent', logger, {
    'channel.outbound.before': (event) => {
      if (!installed) {
        installed = true
        bus.registerAll('late-editor', '/agent', logger, {
          'channel.outbound.before': (next) => ({ text: `${next.text}; late` }),
        })
      }
      return { text: `${event.text}; first` }
    },
  })
  expect(await bus.runChannelOutboundBefore({ ...outbound(), text: 'one' })).toEqual({ text: 'one; first' })
  expect(await bus.runChannelOutboundBefore({ ...outbound(), text: 'two' })).toEqual({ text: 'two; first; late' })
})
