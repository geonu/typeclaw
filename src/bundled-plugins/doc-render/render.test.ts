import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromePath, DEFAULT_CHROME_PATH, loadPlaywright, PLAYWRIGHT_PACKAGE, PLAYWRIGHT_VERSION } from './render'

async function writeFakePackage(
  baseDir: string,
  source: string,
  version = PLAYWRIGHT_VERSION,
  name = PLAYWRIGHT_PACKAGE,
): Promise<void> {
  const pkgDir = join(baseDir, 'node_modules', ...name.split('/'))
  await mkdir(pkgDir, { recursive: true })
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version, type: 'module', exports: './index.js' }),
  )
  await writeFile(join(pkgDir, 'index.js'), source)
}

describe('chromePath', () => {
  test('prefers the operator override, else the image default', () => {
    expect(chromePath({ AGENT_BROWSER_EXECUTABLE_PATH: '/opt/chrome' })).toBe('/opt/chrome')
    expect(chromePath({})).toBe(DEFAULT_CHROME_PATH)
  })
})

describe('render script CLI', () => {
  const scriptPath = fileURLToPath(new URL('./render.ts', import.meta.url))

  test('exits 2 with usage when args are missing', async () => {
    const proc = Bun.spawn(['bun', 'run', scriptPath], { stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
    expect(proc.exitCode).toBe(2)
    expect(await new Response(proc.stderr).text()).toContain('usage:')
  })
})

describe('playwright resolution', () => {
  test('loads playwright-core from the writable scratch runtime', async () => {
    const runtimeDir = join(mkdtempSync(join(tmpdir(), 'doc-render-scratch-')), 'runtime')
    await writeFakePackage(runtimeDir, 'export const chromium = { marker: 2 }')

    const pw = (await loadPlaywright(runtimeDir)) as unknown as { chromium: { marker: number } }

    expect(pw.chromium.marker).toBe(2)
  })

  test('ignores a conflicting playwright-core beneath the document cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-render-shadow-'))
    const docDir = join(root, 'documents')
    const runtimeDir = join(root, 'runtime')
    await writeFakePackage(docDir, 'export const chromium = { marker: 1 }')
    await writeFakePackage(runtimeDir, 'export const chromium = { marker: 2 }')

    expect(Bun.resolveSync(PLAYWRIGHT_PACKAGE, docDir)).toContain(docDir)

    const pw = (await loadPlaywright(runtimeDir)) as unknown as { chromium: { marker: number } }
    expect(pw.chromium.marker).toBe(2)
  })

  test('rejects an ancestor playwright-core when the runtime-local package is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-render-ancestor-'))
    const runtimeDir = join(root, 'scratch', 'runtime')
    const marker = join(root, 'hostile-executed')
    await mkdir(runtimeDir, { recursive: true })
    await writeFakePackage(
      root,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x')`,
    )

    expect(Bun.resolveSync(PLAYWRIGHT_PACKAGE, runtimeDir)).toContain(root)
    await expect(loadPlaywright(runtimeDir)).rejects.toThrow(
      `${PLAYWRIGHT_PACKAGE}@${PLAYWRIGHT_VERSION} is not installed`,
    )
    expect(await Bun.file(marker).exists()).toBeFalse()
  })

  test('rejects a runtime-local playwright-core at a different version', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'doc-render-version-'))
    await writeFakePackage(runtimeDir, 'export const chromium = {}', '0.0.0')

    await expect(loadPlaywright(runtimeDir)).rejects.toThrow(PLAYWRIGHT_VERSION)
  })
})
