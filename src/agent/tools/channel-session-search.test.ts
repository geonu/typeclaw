import { expect, test } from 'bun:test'

import { buildChannelTools } from '@/agent'
import { handoffFixture, inbound, sourceKey, targetKey } from '@/channels/session-handoff.fixture'

import { createChannelHandoffTool } from './channel-handoff'
import { createChannelSessionSearchTool } from './channel-session-search'

test('registered search results can be handed to the owning session through the tools', async () => {
  // Given
  await using f = await handoffFixture()
  await f.receive(inbound(targetKey, { text: '한국어 프로젝트 진행 상황' }))
  await f.receive(inbound(sourceKey))
  const session = f.session(sourceKey)
  const names = buildChannelTools(f.router, { kind: 'channel', ...sourceKey }, session.id).map((tool) => tool.name)
  expect(names).toContain('channel_session_search')
  expect(names).toContain('channel_handoff')
  const search = createChannelSessionSearchTool({ router: f.router, sessionId: session.id })
  const handoff = createChannelHandoffTool({ router: f.router, sessionId: session.id })
  // When
  const found = await search.execute('search', { query: '프로젝트' }, undefined, undefined, session.context)
  const [match] = found.details.targets
  if (match === undefined) throw new Error('expected an authorized handoff target')
  const result = await handoff.execute(
    'handoff',
    { ...match.target, thread: match.target.thread ?? undefined, text: 'Continue the project.' },
    undefined,
    undefined,
    session.context,
  )
  await f.flush(targetKey)
  // Then
  expect(found.details.targets.map((entry) => entry.target)).toEqual([targetKey])
  expect(result.details.ok).toBe(true)
  expect(f.session(targetKey).prompts.at(-1)).toContain('Continue the project.')
  expect(f.sent).toEqual([])
})

test('search is not exposed without an authenticated channel session binding', async () => {
  // Given
  await using f = await handoffFixture()
  // When
  const tools = buildChannelTools(f.router, { kind: 'tui', sessionId: 'example-session' }, 'example-session')
  // Then
  expect(tools.map((tool) => tool.name)).not.toContain('channel_session_search')
})
