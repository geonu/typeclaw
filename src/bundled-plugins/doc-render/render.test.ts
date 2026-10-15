import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMPILER_PACKAGE,
  COMPILER_VERSION,
  isModuleNotFound,
  loadCompilerModule,
  requiredCompilerPlatformPackage,
} from './render'

async function writeFakePackage(
  baseDir: string,
  name: string,
  source: string,
  version = COMPILER_VERSION,
): Promise<void> {
  const pkgDir = join(baseDir, 'node_modules', ...name.split('/'))
  await mkdir(pkgDir, { recursive: true })
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version, type: 'module', exports: './index.js' }),
  )
  await writeFile(join(pkgDir, 'index.js'), source)
}

describe('isModuleNotFound', () => {
  test.each([
    'Cannot find package "@myriaddreamin/typst-ts-node-compiler"',
    'Cannot find module "x"',
    'error: Module not found "y"',
    `something mentioning ${COMPILER_PACKAGE} directly`,
  ])('treats Bun resolution failure %j as a missing module', (message) => {
    expect(isModuleNotFound(message)).toBe(true)
  })

  test('does not flag an unrelated runtime error', () => {
    expect(isModuleNotFound('TypeError: x is not a function')).toBe(false)
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

describe('compiler resolution', () => {
  test('loads the compiler and required platform package from the writable scratch runtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-render-scratch-'))
    const runtimeDir = join(root, 'runtime')
    const platformPackage = await requiredCompilerPlatformPackage()
    await writeFakePackage(
      runtimeDir,
      COMPILER_PACKAGE,
      `import { platformByte } from '${platformPackage}'; export const NodeCompiler = { create() { return { pdf() { return new Uint8Array([platformByte]) } } } }`,
    )
    await writeFakePackage(runtimeDir, platformPackage, 'export const platformByte = 2')

    const compiler = await loadCompilerModule(runtimeDir)
    const pdf = compiler.NodeCompiler.create({ workspace: '.' }).pdf({ mainFilePath: 'main.typ' })

    expect([...pdf]).toEqual([2])
  })

  test('ignores a conflicting compiler beneath the document cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-render-shadow-'))
    const docDir = join(root, 'documents')
    const runtimeDir = join(root, 'runtime')

    for (const [baseDir, byte] of [
      [docDir, 1],
      [runtimeDir, 2],
    ] as const) {
      const pkgDir = join(baseDir, 'node_modules', '@myriaddreamin', 'typst-ts-node-compiler')
      await mkdir(pkgDir, { recursive: true })
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: COMPILER_PACKAGE, version: COMPILER_VERSION, type: 'module', exports: './index.js' }),
      )
      await writeFile(
        join(pkgDir, 'index.js'),
        `export const NodeCompiler = { create() { return { pdf() { return new Uint8Array([${byte}]) } } } }`,
      )
    }
    await writeFakePackage(runtimeDir, await requiredCompilerPlatformPackage(), 'export const platformByte = 2')

    expect(Bun.resolveSync(COMPILER_PACKAGE, docDir)).toContain(docDir)

    const compiler = await loadCompilerModule(runtimeDir)
    const pdf = compiler.NodeCompiler.create({ workspace: '.' }).pdf({ mainFilePath: 'main.typ' })

    expect([...pdf]).toEqual([2])
  })

  test('rejects a hostile ancestor platform package when the runtime-local platform package is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-render-platform-ancestor-'))
    const runtimeDir = join(root, 'scratch', 'runtime')
    const platformPackage = await requiredCompilerPlatformPackage()
    const marker = join(root, 'hostile-platform-executed')
    await writeFakePackage(
      runtimeDir,
      COMPILER_PACKAGE,
      `import '${platformPackage}'; export const NodeCompiler = { create() {} }`,
    )
    await writeFakePackage(
      root,
      platformPackage,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed')`,
    )

    await expect(loadCompilerModule(runtimeDir)).rejects.toThrow(platformPackage)
    expect(await Bun.file(marker).exists()).toBeFalse()
  })

  test('rejects an ancestor compiler when the runtime-local package is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-render-ancestor-'))
    const runtimeDir = join(root, 'scratch', 'runtime')
    const ancestorPkgDir = join(root, 'node_modules', '@myriaddreamin', 'typst-ts-node-compiler')
    await mkdir(runtimeDir, { recursive: true })
    await mkdir(ancestorPkgDir, { recursive: true })
    await writeFile(
      join(ancestorPkgDir, 'package.json'),
      JSON.stringify({ name: COMPILER_PACKAGE, version: COMPILER_VERSION, type: 'module', exports: './index.js' }),
    )
    await writeFile(join(ancestorPkgDir, 'index.js'), 'export const NodeCompiler = { create() {} }')

    expect(Bun.resolveSync(COMPILER_PACKAGE, runtimeDir)).toContain(ancestorPkgDir)
    await expect(loadCompilerModule(runtimeDir)).rejects.toThrow(COMPILER_PACKAGE)
  })

  test('fails when the runtime-local package is absent instead of using global resolution', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'doc-render-absent-'))

    await expect(loadCompilerModule(runtimeDir)).rejects.toThrow(COMPILER_PACKAGE)
  })

  test('rejects a runtime-local compiler at a different version', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'doc-render-version-'))
    const pkgDir = join(runtimeDir, 'node_modules', '@myriaddreamin', 'typst-ts-node-compiler')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: COMPILER_PACKAGE, version: '0.0.0', type: 'module', exports: './index.js' }),
    )
    await writeFile(join(pkgDir, 'index.js'), 'export const NodeCompiler = { create() {} }')

    await expect(loadCompilerModule(runtimeDir)).rejects.toThrow(COMPILER_VERSION)
  })
})
