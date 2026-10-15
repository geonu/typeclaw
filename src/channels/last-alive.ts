import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import type { AdapterId } from './schema'

const markerSchema = z.object({ at: z.number().finite() })

export async function readLastAlive(agentDir: string, adapter: AdapterId): Promise<number | null> {
  const dir = join(agentDir, 'channels')
  const paths = [join(dir, `${adapter}-catch-up-last-alive.json`)]
  if (adapter === 'github') paths.push(join(dir, 'github-last-alive.json'))
  for (const path of paths) {
    try {
      const marker = markerSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
      if (marker.success) return marker.data.at
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw error
    }
  }
  return null
}

export async function writeLastAlive(agentDir: string, adapter: AdapterId, at: number): Promise<void> {
  const dir = join(agentDir, 'channels')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${adapter}-catch-up-last-alive.json`)
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify({ at }))
  await rename(tmp, path)
}
