import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import { resolveTodoScope } from '@/agent/todo/scope'
import { readTodos } from '@/agent/todo/store'

import { createTodoTools } from './index'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-todo-tool-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

function toolsFor(origin: SessionOrigin | undefined) {
  const [write, read, clear] = createTodoTools({ agentDir, getOrigin: () => origin })
  return { write: write!, read: read!, clear: clear! }
}

const TUI: SessionOrigin = { kind: 'tui', sessionId: 'ses_x' }
const CHANNEL: SessionOrigin = { kind: 'channel', adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: null }

describe('todo tools', () => {
  test('todo_write reports remaining incomplete count', async () => {
    const { write } = toolsFor(TUI)
    const res = await write.execute(
      'call-1',
      {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' },
        ],
      },
      undefined,
      undefined,
      {} as never,
    )
    expect(res.details).toMatchObject({ ok: true, total: 2, remaining: 1 })
  })

  test('todo_write auto-clears a list with no incomplete items left', async () => {
    const { write } = toolsFor(TUI)
    const res = await write.execute(
      'c1',
      {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'cancelled' },
        ],
      },
      undefined,
      undefined,
      {} as never,
    )
    expect(res.details).toMatchObject({ ok: true, total: 2, remaining: 0 })
    expect(await readTodos(agentDir, resolveTodoScope(TUI)!)).toEqual([])
  })

  test('todo_write persists a list that still has incomplete items', async () => {
    const { write } = toolsFor(TUI)
    await write.execute(
      'c1',
      {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' },
        ],
      },
      undefined,
      undefined,
      {} as never,
    )
    expect(await readTodos(agentDir, resolveTodoScope(TUI)!)).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ])
  })

  test('channel and tui origins write to different scope files', async () => {
    await toolsFor(TUI).write.execute(
      'c1',
      { todos: [{ content: 'tui-task', status: 'pending' }] },
      undefined,
      undefined,
      {} as never,
    )
    await toolsFor(CHANNEL).write.execute(
      'c2',
      { todos: [{ content: 'chan-task', status: 'pending' }] },
      undefined,
      undefined,
      {} as never,
    )
    expect(await readTodos(agentDir, resolveTodoScope(TUI)!)).toEqual([{ content: 'tui-task', status: 'pending' }])
    expect(await readTodos(agentDir, resolveTodoScope(CHANNEL)!)).toEqual([{ content: 'chan-task', status: 'pending' }])
  })

  test('todo_read returns the current list', async () => {
    const { write, read } = toolsFor(TUI)
    await write.execute('c1', { todos: [{ content: 'x', status: 'in_progress' }] }, undefined, undefined, {} as never)
    const res = await read.execute('c2', {}, undefined, undefined, {} as never)
    expect(res.details).toMatchObject({ ok: true, total: 1 })
    const part = res.content[0]
    expect(part?.type).toBe('text')
    expect(part?.type === 'text' ? part.text : '').toContain('in_progress')
  })

  test('todo_clear empties the list', async () => {
    const { write, clear } = toolsFor(TUI)
    await write.execute('c1', { todos: [{ content: 'x', status: 'pending' }] }, undefined, undefined, {} as never)
    await clear.execute('c2', {}, undefined, undefined, {} as never)
    expect(await readTodos(agentDir, resolveTodoScope(TUI)!)).toEqual([])
  })

  test('subagent origin no-ops without writing a file', async () => {
    const origin: SessionOrigin = { kind: 'subagent', subagent: 'scout', parentSessionId: 'ses_p' }
    const { write } = toolsFor(origin)
    const res = await write.execute(
      'c1',
      { todos: [{ content: 'x', status: 'pending' }] },
      undefined,
      undefined,
      {} as never,
    )
    expect(res.details).toMatchObject({ ok: false, reason: 'no-scope' })
  })

  test('undefined origin no-ops (does not fall back to the shared tui scope)', async () => {
    const { write } = toolsFor(undefined)
    const res = await write.execute(
      'c1',
      { todos: [{ content: 'x', status: 'pending' }] },
      undefined,
      undefined,
      {} as never,
    )
    expect(res.details).toMatchObject({ ok: false, reason: 'no-scope' })
    // The tui scope must remain untouched — no cross-scope leak.
    expect(await readTodos(agentDir, resolveTodoScope(TUI)!)).toEqual([])
  })
})
