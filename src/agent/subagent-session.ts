import { SessionManager } from '@earendil-works/pi-coding-agent'

/** Plugin-owned privacy choice; model payloads cannot enable or disable persistence. */
export function createSubagentSessionManager(cwd: string, sessionDir: string, ephemeral = false): SessionManager {
  return ephemeral ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, sessionDir)
}
