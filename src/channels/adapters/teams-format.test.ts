import { afterEach, describe, expect, test } from 'bun:test'

import { TeamsClient } from 'agent-messenger/teams'

import { createOutboundCallback, type TeamsAdapterLogger } from './teams'
import { normalizeTeamsText } from './teams-classify'
import { encodeTeamsChannelKey } from './teams-key'

// The fake-client tests lock which format argument TypeClaw passes; this locks
// what that argument puts on the wire, by driving a real TeamsClient with an
// intercepted fetch. The channel path is the one agent-messenger 2.37.2 changed
// (2.35.0 posted it raw), so it is the one worth pinning against the dependency
// rather than against our own stub.
const MARKUP_TEXT = '<at id="0">Alice</at> compare 1 < 2 && 3 > 2'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('teams outbound wire format', () => {
  test('escapes Teams markup and bare angle brackets on a channel send', async () => {
    const bodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({ id: 'sent-ch' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const client = await new TeamsClient().login({ token: 'skype-token', region: 'emea' })
    const logger: TeamsAdapterLogger = { info: () => {}, warn: () => {}, error: () => {} }
    const cb = createOutboundCallback({ client, logger })

    const result = await cb({
      adapter: 'teams',
      workspace: 'teams',
      chat: encodeTeamsChannelKey('team-guid', '19:abc@thread.tacv2'),
      text: MARKUP_TEXT,
    })

    expect(result.ok).toBe(true)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.content).toBe('&lt;at id=&quot;0&quot;&gt;Alice&lt;/at&gt; compare 1 &lt; 2 &amp;&amp; 3 &gt; 2')
  })

  // Escaping is only safe for the adapter if it survives the return trip: the
  // self-echo ledger fingerprints the RAW outbound text, while the platform
  // hands our own message back through the SDK's HTML strip. Replay the escaped
  // wire bytes back through the SDK rather than hand-modelling the decode, so
  // this fails if either half of the round trip drifts and the agent starts
  // routing its own channel posts back in as inbound.
  test('escaped markup survives the round trip, so the self-echo fingerprint still matches', async () => {
    let escaped = ''
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') {
        escaped = String((JSON.parse(String(init.body)) as { content: string }).content)
        return Response.json({ id: 'sent-ch' })
      }
      expect(url).toContain('/messages')
      return Response.json({ messages: [{ id: 'm1', content: escaped, from: 'u', composetime: '' }] })
    }) as typeof fetch
    const client = await new TeamsClient().login({ token: 'skype-token', region: 'emea' })
    const logger: TeamsAdapterLogger = { info: () => {}, warn: () => {}, error: () => {} }

    await createOutboundCallback({ client, logger })({
      adapter: 'teams',
      workspace: 'teams',
      chat: encodeTeamsChannelKey('team-guid', '19:abc@thread.tacv2'),
      text: MARKUP_TEXT,
    })
    const [echoed] = await client.getChatMessages('19:abc@thread.tacv2', 1)

    expect(escaped).not.toBe(MARKUP_TEXT)
    expect(normalizeTeamsText(echoed!.content)).toBe(normalizeTeamsText(MARKUP_TEXT))
  })
})
