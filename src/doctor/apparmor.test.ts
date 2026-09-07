import { describe, expect, test } from 'bun:test'

import { apparmorSandbox } from './apparmor'
import { buildStaticChecks } from './checks'
import type { CheckContext } from './types'

const ctx: CheckContext = { cwd: '/agent', hasAgentFolder: true }

const APPARMOR_ON = {
  '/sys/module/apparmor/parameters/enabled': 'Y\n',
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n',
}
const APPARMOR_ON_UNRESTRICTED = {
  '/sys/module/apparmor/parameters/enabled': 'Y\n',
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n',
}

function check(files: Record<string, string | undefined>, apparmorProfile = 'unconfined') {
  return apparmorSandbox({
    readHostFile: async (path) => files[path] ?? null,
    loadApparmorProfile: () => apparmorProfile,
  })
}

describe('AppArmor sandbox doctor check', () => {
  test('is registered in the static check set', () => {
    expect(buildStaticChecks().some((candidate) => candidate.name === 'container.apparmor-bwrap')).toBe(true)
  })

  test('errors when restricted unprivileged user namespaces meet the unconfined profile', async () => {
    const result = await check(APPARMOR_ON).run(ctx)

    expect(result.status).toBe('error')
    expect(result.message).toContain('sandboxed bash')
    expect(result.fix?.description).toContain('sudo apparmor_parser -r -W /etc/apparmor.d/typeclaw-bwrap')
    expect(result.fix?.description).toContain('sandbox.apparmorProfile')
    expect(result.fix?.description).toContain('typeclaw restart')
  })

  test('errors on docker-default even when unprivileged user namespaces are unrestricted', async () => {
    const result = await check(APPARMOR_ON_UNRESTRICTED, 'docker-default').run(ctx)

    expect(result.status).toBe('error')
    expect(result.message).toContain('docker-default')
    expect(result.fix?.description).toContain('sudo apparmor_parser -r -W /etc/apparmor.d/typeclaw-bwrap')
  })

  test('is ok when AppArmor is absent', async () => {
    const result = await check({
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n',
    }).run(ctx)

    expect(result.status).toBe('ok')
  })

  test('is ok for unconfined when unprivileged user namespaces are unrestricted', async () => {
    const result = await check(APPARMOR_ON_UNRESTRICTED).run(ctx)

    expect(result.status).toBe('ok')
  })

  test('is ok when the operator selected the shipped profile', async () => {
    const result = await check(APPARMOR_ON, 'typeclaw-bwrap').run(ctx)

    expect(result.status).toBe('ok')
  })

  test('reports an unknown custom profile as unverified rather than working', async () => {
    const result = await check(APPARMOR_ON, 'acme-hardened').run(ctx)

    expect(result.status).toBe('info')
    expect(result.message).toContain('acme-hardened')
    expect(result.message).toContain('cannot verify')
  })

  test('does not throw when AppArmor host files are missing', async () => {
    const result = await check({}).run(ctx)

    expect(result.status).toBe('ok')
  })
})
