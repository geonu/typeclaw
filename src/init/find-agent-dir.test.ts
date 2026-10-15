import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The whole point of this module's existence is that the host CLI entry can
// import it WITHOUT dragging in the ~190ms init/config/container/plugin graph.
// A future contributor adding a heavy import here would silently undo the
// startup win while every behavioral test still passes — so guard the
// dependency direction explicitly.
describe('find-agent-dir dependency isolation', () => {
  test('imports nothing beyond node:fs and node:path', () => {
    const source = readFileSync(join(import.meta.dir, 'find-agent-dir.ts'), 'utf8')
    // Catch every static dependency form: `import ... from 'spec'`, bare
    // side-effect `import 'spec'`, and re-exports `export ... from 'spec'` /
    // `export * from 'spec'` — any of these would drag in the heavy graph.
    const specifiers = [...source.matchAll(/^(?:import|export)\s+(?:[^'"]*\sfrom\s+)?['"]([^'"]+)['"]/gm)].map(
      (m) => m[1],
    )
    expect(specifiers.sort()).toEqual(['node:fs', 'node:path'])
  })
})
