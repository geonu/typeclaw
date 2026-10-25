import { describe, expect, test } from 'bun:test'

import { resolveExposableEnvNames, resolveFillableEnvNames } from './env-exposure'

const env = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries))

describe('resolveExposableEnvNames', () => {
  test('exposes every operator-declared .env var by default', () => {
    const names = resolveExposableEnvNames(
      env({
        SERVICE_CONFIG_DIR: '/agent/workspace/.config/service',
        DATABASE_URL: 'postgres://u:p@host/db',
        OPENAI_API_KEY: 'sk-x',
      }),
    )
    expect(names).toEqual(['SERVICE_CONFIG_DIR', 'DATABASE_URL', 'OPENAI_API_KEY'])
  })

  test('withholds sandbox-owned names (PATH/HOME/BUN_*/LANG)', () => {
    const names = resolveExposableEnvNames(
      env({ PATH: '/evil', HOME: '/evil', BUN_TMPDIR: '/evil', BUN_INSTALL: '/evil', LANG: 'x', MY_VAR: 'ok' }),
    )
    expect(names).toEqual(['MY_VAR'])
  })

  test('exposes operator-declared GH_TOKEN/GITHUB_TOKEN (.env is the expose surface)', () => {
    const names = resolveExposableEnvNames(env({ GH_TOKEN: 'ghp_x', GITHUB_TOKEN: 'ghp_y', MY_VAR: 'ok' }))
    expect(names).toEqual(['GH_TOKEN', 'GITHUB_TOKEN', 'MY_VAR'])
  })

  test('withholds host/container-injected runtime tokens (TYPECLAW_*)', () => {
    const names = resolveExposableEnvNames(
      env({
        TYPECLAW_TUI_TOKEN: 'a',
        TYPECLAW_HOSTD_TOKEN: 'b',
        TYPECLAW_HOSTD_BROKER_TOKEN: 'c',
        TYPECLAW_MODEL_HTTP_ALLOW_INTERNAL_HOSTS: 'service.corp',
        TYPECLAW_MODEL_HTTP_ALLOW_INTERNAL_CIDRS: '10.20.0.0/16',
        MY_VAR: 'ok',
      }),
    )
    expect(names).toEqual(['MY_VAR'])
  })

  test('withholds outer-shell bash controls and BASH_FUNC_ imports', () => {
    const names = resolveExposableEnvNames(
      env({
        SHELLOPTS: 'xtrace',
        BASHOPTS: 'x',
        PS4: '$(touch /pwned)',
        BASH_XTRACEFD: '2',
        BASH_ENV: '/x',
        'BASH_FUNC_bwrap%%': '() { true; }',
        SAFE: 'ok',
      }),
    )
    expect(names).toEqual(['SAFE'])
  })

  test('withholds loader/interpreter-hijack vars', () => {
    const names = resolveExposableEnvNames(
      env({ LD_PRELOAD: '/x.so', NODE_OPTIONS: '--require /x', GIT_CONFIG_GLOBAL: '/x', SSH_AUTH_SOCK: '/x', OK: 'y' }),
    )
    expect(names).toEqual(['OK'])
  })

  test('exposes runtime-injected Git identity without exposing Git config controls', () => {
    const names = resolveExposableEnvNames(env({ GIT_CONFIG_GLOBAL: '/evil' }), {
      GIT_AUTHOR_NAME: 'Agent Smith',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Agent Smith',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
      GIT_CONFIG_COUNT: '1',
      UNDECLARED: 'hidden',
    })

    expect(names).toEqual(['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'])
  })

  test('an EMPTY .env declaration is ineligible even if secrets.json later fills process.env', () => {
    // .env has `DISCORD_BOT_TOKEN=` (empty); hydrateChannelEnvFromSecrets would
    // populate process.env[DISCORD_BOT_TOKEN] from secrets.json. Eligibility is
    // from the parsed FILE value, so the empty declaration stays withheld.
    const names = resolveExposableEnvNames(env({ DISCORD_BOT_TOKEN: '', REAL: 'v' }))
    expect(names).toEqual(['REAL'])
  })
})

describe('TYPECLAW_SECRET_ tier', () => {
  const declared = env({
    TYPECLAW_SECRET_STRIPE_KEY: 'sk_live_x',
    TYPECLAW_SECRET_EMPTY: '',
    SHOP_ADDRESS: '1 Main St',
    TYPECLAW_HOSTD_TOKEN: 'runtime',
    PATH: '/evil',
  })

  test('withholds TYPECLAW_SECRET_* from bash', () => {
    expect(resolveExposableEnvNames(declared)).toEqual(['SHOP_ADDRESS'])
  })

  test('lets the fill tool type ordinary and secret-tier vars, never runtime controls or empty values', () => {
    expect(resolveFillableEnvNames(declared)).toEqual(['SHOP_ADDRESS', 'TYPECLAW_SECRET_STRIPE_KEY'])
  })
})
