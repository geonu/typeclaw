import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { configSchema as coreConfigSchema } from '@/config/config'
import { cronFileSchema } from '@/cron/schema'
import { buildConfigSchemaWithBundledPlugins } from '@/run/schema-with-plugins'
import { secretsFileSchema } from '@/secrets/schema'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('typeclaw.schema.json', () => {
  test('checked-in typeclaw.schema.json matches the merged (core + bundled plugin) schema (drift guard)', async () => {
    const checkedIn = JSON.parse(await readFile(join(repoRoot, 'typeclaw.schema.json'), 'utf8'))
    // The on-disk file is what generate-schema.ts writes via JSON.stringify, which
    // drops Zod's `~standard` symbol/internals. Compare apples to apples by
    // round-tripping the generated schema through the same serialization path.
    const generated = JSON.parse(
      JSON.stringify(
        z.toJSONSchema(buildConfigSchemaWithBundledPlugins(coreConfigSchema), {
          io: 'input',
          reused: 'inline',
        }),
      ),
    )

    expect(checkedIn).toEqual(generated)
  })

  test('does not expose model HTTP internal exceptions in typeclaw.json', async () => {
    const checkedIn = JSON.parse(await readFile(join(repoRoot, 'typeclaw.schema.json'), 'utf8'))
    expect(checkedIn.properties.network.properties.modelHttp).toBeUndefined()
  })
})

describe('cron.schema.json', () => {
  test('checked-in cron.schema.json matches the current cronFileSchema (drift guard)', async () => {
    const checkedIn = JSON.parse(await readFile(join(repoRoot, 'cron.schema.json'), 'utf8'))
    const generated = z.toJSONSchema(cronFileSchema, { io: 'input', reused: 'inline' })

    expect(checkedIn).toEqual(generated)
  })
})

describe('secrets.schema.json', () => {
  test('checked-in secrets.schema.json matches the current secretsFileSchema (drift guard)', async () => {
    const checkedIn = JSON.parse(await readFile(join(repoRoot, 'secrets.schema.json'), 'utf8'))
    const generated = z.toJSONSchema(secretsFileSchema, { io: 'input', reused: 'inline' })

    expect(checkedIn).toEqual(generated)
  })

  test('auth.schema.json is byte-identical to secrets.schema.json (permanent compatibility alias)', async () => {
    const secrets = await readFile(join(repoRoot, 'secrets.schema.json'), 'utf8')
    const auth = await readFile(join(repoRoot, 'auth.schema.json'), 'utf8')

    expect(auth).toBe(secrets)
  })
})
