import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SandboxMount } from './policy'

const RUNTIME_MODULE_FILE = fileURLToPath(import.meta.url)

// Dev mode (`file:`/`link:` typeclaw dep): files under node_modules/typeclaw
// are symlinks into a checkout outside the agent folder. `typeclaw start`
// mirror-mounts that checkout read-only into the container, but bwrap only
// binds the agent folder, so bundled SKILL.md symlinks dangle inside model
// bash. Bind only the checkout's `src/` (where every bundled skill lives),
// never the checkout root, so a developer's `.env` or `.git` stays out of the
// sandbox. The path comes from the running module's own realpath, which the
// model cannot redirect by rewriting node_modules. Registry installs resolve
// inside the agent folder and get no mount.
export async function resolveDevSourceMount(
  agentDir: string,
  moduleFile: string = RUNTIME_MODULE_FILE,
): Promise<Extract<SandboxMount, { type: 'ro-bind' }> | undefined> {
  const srcDir = dirname(dirname(await realpath(moduleFile)))
  const rel = relative(await realpath(agentDir), srcDir)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return undefined
  return { type: 'ro-bind', source: srcDir, dest: srcDir }
}
