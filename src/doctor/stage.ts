import type { DoctorStage } from './types'

const CONTAINER_AGENT_DIR = '/agent'

// `docker run` sets TYPECLAW_CONTAINER_NAME, so a `docker exec` doctor run
// sees it. Model bash does not: the bwrap sandbox clears the container
// env (src/sandbox/policy.ts DEFAULT_SANDBOX_ENV) and hides /.dockerenv. Its
// cwd still resolves to the agent folder at its container mount point, so the
// /agent agent folder is the marker that survives the sandbox.
export function detectDoctorStage(agentDir: string, env: NodeJS.ProcessEnv = process.env): DoctorStage {
  if (env.TYPECLAW_CONTAINER_NAME !== undefined) return 'container'
  if (agentDir === CONTAINER_AGENT_DIR) return 'container'
  return 'host'
}
