import { afterEach, describe, expect, test } from 'bun:test'

import { __resetForwardRequestBus, publishForwardRequest, subscribeForwardRequest } from './forward-request-bus'

afterEach(() => {
  __resetForwardRequestBus()
})

describe('forward request bus', () => {
  test('publish reaches a subscriber', () => {
    const events: unknown[] = []
    subscribeForwardRequest((event) => events.push(event))

    publishForwardRequest({ targetPort: 4848, hostCandidates: [4848, 4849], reason: 'agent-browser-dashboard' })

    expect(events).toEqual([{ targetPort: 4848, hostCandidates: [4848, 4849], reason: 'agent-browser-dashboard' }])
  })
})
