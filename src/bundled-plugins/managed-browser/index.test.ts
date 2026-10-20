import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { TYPECLAW_INTERNAL_BASH_ENV } from '@/agent/plugin-tools'
import { createPermissionService } from '@/permissions'

import { browserEnvOverlay, browserSkillDirs, sharedBrowserBashHook } from './index'

const managed = {
  cdpUrl: 'ws://127.0.0.1:4000/devtools/browser/typeclaw?token=t',
  filesDir: '/agent/workspace/.typeclaw-browser/files',
}
const hookContext = { agentDir: '/agent', pluginName: 'managed-browser', logger: { info() {}, warn() {}, error() {} } }

async function runHook(origin: Parameters<ReturnType<typeof createPermissionService>['has']>[0], tool = 'bash') {
  const hook = sharedBrowserBashHook(createPermissionService(), { TYPECLAW_BROWSER_CDP_URL: managed.cdpUrl })
  const args: Record<string, unknown> = { command: 'true', [TYPECLAW_INTERNAL_BASH_ENV]: { GH_REPO: 'acme/app' } }
  await hook({ tool, sessionId: 's', callId: 'c', args, origin }, hookContext)
  return args[TYPECLAW_INTERNAL_BASH_ENV]
}

describe('shared browser bash access', () => {
  test('injects the browser URL for a role holding browser.shared, keeping existing overlay entries', async () => {
    expect(await runHook({ kind: 'tui', sessionId: 's' })).toEqual({
      GH_REPO: 'acme/app',
      TYPECLAW_BROWSER_CDP_URL: managed.cdpUrl,
    })
  })

  test('withholds the browser URL from an unresolved origin, which resolves to guest', async () => {
    expect(await runHook(undefined)).toEqual({ GH_REPO: 'acme/app' })
  })

  test('leaves non-bash tools untouched', async () => {
    expect(await runHook({ kind: 'tui', sessionId: 's' }, 'read')).toEqual({ GH_REPO: 'acme/app' })
  })
})

describe('browser engine wiring', () => {
  test('attaches the always-installed agent-browser to the shared browser even when it is not a listed engine', () => {
    const env = browserEnvOverlay(
      { engines: ['omowright'], extensions: [] },
      { ...managed, bskRelay: undefined, token: 't' },
    )

    expect(env).toMatchObject({ AGENT_BROWSER_CDP: managed.cdpUrl, OMOWRIGHT_CDP_URL: managed.cdpUrl })
    expect(env).not.toHaveProperty('BU_CDP_WS')
  })

  test('exposes each enabled engine and extension env, and BrowserSkill home when loaded', () => {
    const env = browserEnvOverlay(
      { engines: ['agent-browser', 'omowright', 'browser-use'], extensions: ['browserskill'] },
      { ...managed, bskRelay: '127.0.0.1:4100', token: 't' },
    )

    expect(env).toMatchObject({
      TYPECLAW_BROWSER_CDP_URL: managed.cdpUrl,
      TYPECLAW_BROWSER_FILES: managed.filesDir,
      AGENT_BROWSER_CDP: managed.cdpUrl,
      OMOWRIGHT_CDP_URL: managed.cdpUrl,
      BU_CDP_WS: managed.cdpUrl,
      ANONYMIZED_TELEMETRY: 'false',
      TYPECLAW_BSK_RELAY: '127.0.0.1:4100',
      TYPECLAW_BSK_TOKEN: 't',
    })
  })

  test('ships a skill for every non-default engine and extension, and none for disabled ones', () => {
    const dirs = browserSkillDirs({
      engines: ['agent-browser', 'omowright', 'browser-use'],
      extensions: ['browserskill'],
    })

    expect(dirs.map((dir) => basename(dir))).toEqual(['omowright', 'browser-use', 'browserskill'])
    for (const dir of dirs) expect(existsSync(join(dir, basename(dir), 'SKILL.md'))).toBe(true)
    expect(browserSkillDirs({ engines: ['agent-browser'], extensions: [] })).toEqual([])
  })
})
