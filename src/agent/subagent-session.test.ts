import { expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSubagentSessionManager } from './subagent-session'

test('ephemeral document sessions retain usable context without writing raw content to the session directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ephemeral-source-'))
  try {
    for (const ephemeral of [true, false]) {
      const directory = join(root, ephemeral ? 'private' : 'ordinary')
      const manager = createSubagentSessionManager(root, directory, ephemeral)
      manager.appendMessage({ role: 'user', content: 'SYNTHETIC_PRIVATE_ORDER_PAGE', timestamp: Date.now() })
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'Read the source.' }],
        api: 'openai-responses',
        provider: 'openai',
        model: 'synthetic',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      })
      expect(manager.buildSessionContext().messages[0]).toMatchObject({
        role: 'user',
        content: 'SYNTHETIC_PRIVATE_ORDER_PAGE',
      })
      if (ephemeral) {
        expect(manager.getSessionFile()).toBeUndefined()
        expect(await readdir(directory).catch(() => [])).toEqual([])
      } else {
        expect(await readFile(manager.getSessionFile()!, 'utf8')).toContain('SYNTHETIC_PRIVATE_ORDER_PAGE')
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
