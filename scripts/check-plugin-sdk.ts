#!/usr/bin/env bun

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-sdk-'))
const manifest = await Bun.file(join(root, 'package.json')).json()
const bunTypes = await Bun.file(join(root, 'node_modules', '@types', 'bun', 'package.json')).json()

async function run(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${argv.join(' ')} failed (${code})\n${stdout}\n${stderr}`)
  return stdout
}

try {
  // Exercise the real prepack lifecycle. Installing with scripts disabled then
  // proves declaration consumers do not need our dev compiler or install hook.
  await run(['npm', 'pack', '--pack-destination', scratch], root)
  const archiveName = `typeclaw-${manifest.version}.tgz`
  const consumer = join(scratch, 'consumer')
  await mkdir(consumer)
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'example-plugin-consumer',
      private: true,
      type: 'module',
      dependencies: { typeclaw: `file:../${archiveName}`, zod: manifest.dependencies.zod },
      devDependencies: { '@types/bun': bunTypes.version },
    }),
  )
  await run([process.execPath, 'install', '--ignore-scripts'], consumer)
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'Preserve',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ['bun'],
      },
      include: ['plugin.ts'],
    }),
  )
  await writeFile(
    join(consumer, 'plugin.ts'),
    `
import { definePlugin, type Hooks } from 'typeclaw/plugin'
import { z } from 'zod'
const hooks = {
  'tool.before': (event) => {
    const tool: string = event.tool
    // @ts-expect-error tool identifiers must remain strings, not any
    const invalid: number = event.tool
    return tool ? undefined : { block: true as const, reason: 'empty tool' }
  },
} satisfies Hooks
// @ts-expect-error unsupported hook names must not become valid or any
const unsupported: keyof Hooks = 'session.strat'
export default definePlugin({
  configSchema: z.object({ enabled: z.boolean() }),
  plugin: async (ctx) => {
    const enabled: boolean = ctx.config.enabled
    // @ts-expect-error schema-inferred config must not become any
    const invalid: string = ctx.config.enabled
    return enabled ? { hooks } : {}
  },
})
`,
  )
  for (const [module, resolution] of [
    ['Preserve', 'bundler'],
    ['NodeNext', 'NodeNext'],
  ]) {
    const output = await run(
      [
        process.execPath,
        'run',
        'typecheck',
        '--project',
        join(consumer, 'tsconfig.json'),
        '--module',
        module!,
        '--moduleResolution',
        resolution!,
        '--listFiles',
      ],
      root,
    )
    const files = output.split(/\r?\n/).map((file) => file.replaceAll('\\', '/'))
    if (files.some((file) => file.includes('/node_modules/typeclaw/src/')))
      throw new Error('The public SDK pulled TypeClaw implementation sources into the consumer.')
    if (!files.some((file) => file.endsWith('/node_modules/typeclaw/dist/types/plugin/index.d.ts')))
      throw new Error('The packed public SDK declaration entry was not resolved.')
    console.log(`Packed plugin consumer passed ${resolution} resolution without source imports or @/* aliases`)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
