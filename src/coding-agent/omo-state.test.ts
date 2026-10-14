import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hasOmoSession, prepareOmoDirectories } from './omo-state'

let root: string
const id = '0199abcd-1234-7123-8123-123456789abc'
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'omo-state-')))
  await prepareOmoDirectories(join(root, 'omo'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('requires a single exact matching persisted session header', async () => {
  const dir = join(root, 'omo')
  const cwd = join(root, 'worktree')
  const file = join(dir, 'sessions', `fixture_${id}.jsonl`)
  expect(await hasOmoSession(dir, id, cwd)).toBe(false)
  await writeFile(file, `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`)
  expect(await hasOmoSession(dir, id, cwd)).toBe(true)
  expect(await hasOmoSession(dir, crypto.randomUUID(), cwd)).toBe(false)
  expect(await hasOmoSession(dir, id, '/wrong')).toBe(false)
  await writeFile(join(dir, 'sessions', `duplicate_${id}.jsonl`), '{}\n')
  expect(await hasOmoSession(dir, id, cwd)).toBe(false)
})

test.skipIf(process.platform === 'win32')(
  'rejects session file and parent symlinks without reading outside the task',
  async () => {
    const dir = join(root, 'omo')
    const cwd = join(root, 'worktree')
    const external = join(root, 'outside')
    await writeFile(external, `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`)
    const file = join(dir, 'sessions', `fixture_${id}.jsonl`)
    await symlink(external, file)
    expect(await hasOmoSession(dir, id, cwd)).toBe(false)
    await rm(file)
    await rm(join(dir, 'sessions'), { recursive: true })
    await symlink(root, join(dir, 'sessions'))
    expect(await hasOmoSession(dir, id, cwd)).toBe(false)
  },
)
