import { constants } from 'node:fs'
import { mkdir, open, readdir, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { createAndOpenAnchoredDirectory } from '@/agent/tool-file-safety'
import { assertCodingDirectory } from '@/sandbox/coding-agent'

const DIRECTORIES = [
  'home',
  'home/.omo',
  'agent',
  'sessions',
  'task-state',
  'tmp',
  'config',
  'cache',
  'data',
  'state',
] as const

export async function prepareOmoDirectories(configDir: string): Promise<void> {
  for (const part of ['', ...DIRECTORIES]) {
    const path = join(configDir, part)
    if (process.platform === 'linux') {
      const directory = await createAndOpenAnchoredDirectory(path)
      await directory.close()
    } else {
      // Dev-stage fixtures only; production execution still requires Linux bwrap.
      await mkdir(path, { recursive: true, mode: 0o700 })
      await assertCodingDirectory(path)
    }
  }
}

export async function hasOmoSession(configDir: string, sessionId: string, cwd: string): Promise<boolean> {
  const directory = join(configDir, 'sessions')
  let anchor: FileHandle | undefined
  try {
    if (process.platform === 'linux') anchor = await createAndOpenAnchoredDirectory(directory, false)
    else await assertCodingDirectory(directory)
    const root = anchor ? `/proc/self/fd/${anchor.fd}` : directory
    const files = (await readdir(root)).filter((name) => name.endsWith(`_${sessionId}.jsonl`))
    if (files.length !== 1 || !files[0]) return false
    const file = await open(join(root, files[0]), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1) return false
      // Read only the bounded session header, never the model-controlled body.
      const buffer = Buffer.alloc(16 * 1024)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      const text = buffer.subarray(0, bytesRead).toString('utf8')
      const newline = text.indexOf('\n')
      if (newline < 0) return false
      const header = z
        .object({ type: z.literal('session'), version: z.literal(3), id: z.string().uuid(), cwd: z.string() })
        .parse(JSON.parse(text.slice(0, newline)))
      return header.id === sessionId && header.cwd === cwd
    } finally {
      await file.close()
    }
  } catch {
    // Unsafe or missing state must never silently start a new conversation.
    return false
  } finally {
    await anchor?.close()
  }
}
