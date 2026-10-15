import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// When the GitHub adapter was last known alive. Reconcile replays only PRs
// opened since then: those are the deliveries a downtime or tunnel change could
// have dropped, while anything older was either seen live or predates the repo
// being watched.

const FILE = 'github-last-alive.json'

export async function readGithubLastAlive(agentDir: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(join(agentDir, 'channels', FILE), 'utf8')) as { at?: unknown }
    return typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : null
  } catch {
    return null
  }
}

export async function writeGithubLastAlive(agentDir: string, at: number): Promise<void> {
  const dir = join(agentDir, 'channels')
  await mkdir(dir, { recursive: true })
  const path = join(dir, FILE)
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify({ at }))
  await rename(tmp, path)
}
