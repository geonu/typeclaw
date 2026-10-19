import { join } from 'node:path'

import { definePlugin } from '@/plugin'

// In-container path of the bundled render script, relative to the agent root
// (the bwrap jail ro-binds /agent, so a low-trust sandboxed `bun run` can read
// it here). typeclaw always installs at node_modules/typeclaw and ships src/ to
// npm, so this path is stable across dev and prod. The skill references the same
// path — keep them in lockstep.
export const RENDER_SCRIPT_AGENT_RELATIVE_PATH = 'node_modules/typeclaw/src/bundled-plugins/doc-render/render.ts'

export function renderScriptPath(): string {
  return join(import.meta.dir, 'render.ts')
}

export default definePlugin({
  plugin: async () => ({
    skillsDirs: [join(import.meta.dir, 'skills')],
  }),
})
