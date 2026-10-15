import { readLastAlive, writeLastAlive } from '../../last-alive'

// When the GitHub adapter was last known alive. Reconcile replays only PRs
// opened since then: those are the deliveries a downtime or tunnel change could
// have dropped, while anything older was either seen live or predates the repo
// being watched.

export async function readGithubLastAlive(agentDir: string): Promise<number | null> {
  // Preserve GitHub's best-effort boot behavior on an unreadable marker.
  return readLastAlive(agentDir, 'github').catch(() => null)
}

export async function writeGithubLastAlive(agentDir: string, at: number): Promise<void> {
  return writeLastAlive(agentDir, 'github', at)
}
