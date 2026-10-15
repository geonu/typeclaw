import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import { styled } from './style-text'

describe('styled', () => {
  test('leaves the wrapped text intact', () => {
    expect(styled('dim', '사당동 27°C')).toContain('사당동 27°C')
  })

  // The behavior this helper exists to pin only diverges when stdout is not a
  // color-capable TTY, and the runner's own descriptors depend on how the suite
  // was launched. Drive a child with a piped stdout so the non-TTY case is
  // controlled here rather than assumed from the environment.
  test('still emits escapes when stdout is a pipe', async () => {
    const helper = path.join(import.meta.dir, 'style-text.ts')
    const source = `import { styled } from ${JSON.stringify(helper)}
process.stdout.write(JSON.stringify({ isTTY: Boolean(process.stdout.isTTY), out: styled('green', 'x') }))`

    const proc = Bun.spawn({ cmd: [process.execPath, '-e', source], stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ isTTY: false, out: '\u001b[32mx\u001b[39m' })
  })
})
