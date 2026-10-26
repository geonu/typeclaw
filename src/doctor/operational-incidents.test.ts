import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IncidentLedger, incidentsPath } from '@/operations'

import { buildOperationalIncidentChecks } from './operational-incidents'

describe('operational incident doctor check', () => {
  test('reports a recurrent unresolved incident as an operator-facing error', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-doctor-incidents-'))
    const ledger = new IncidentLedger(cwd)
    const fact = { kind: 'bash-command-not-found' as const, bin: 'opensoma' }
    await ledger.record(fact, 'session-a', new Date('2026-08-01T00:00:00.000Z'))
    await ledger.record(fact, 'session-b', new Date('2026-08-02T00:00:00.000Z'))

    const result = await buildOperationalIncidentChecks()[0]!.run({ cwd, hasAgentFolder: true })

    expect(result.status).toBe('error')
    expect(result.message).toContain('recurrent TypeClaw environment issue')
    expect(result.details).toEqual([
      'bash:command-not-found:opensoma count=2 first=2026-08-01T00:00:00.000Z last=2026-08-02T00:00:00.000Z',
    ])
  })

  test('defers instead of reporting ok when the ledger is sandbox-masked', async () => {
    // given a ledger with an unresolved incident, seen through the 0-byte bwrap mask
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-doctor-masked-incidents-'))
    const ledger = new IncidentLedger(cwd)
    await ledger.record({ kind: 'bash-command-not-found', bin: 'opensoma' }, 'session-a', new Date())
    await writeFile(incidentsPath(cwd), '')

    // when
    const result = await buildOperationalIncidentChecks()[0]!.run({ cwd, hasAgentFolder: true })

    // then
    expect(result.status).toBe('info')
    expect(result.message).toContain('deferred')
  })

  test('reports ok when no ledger exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-doctor-no-incidents-'))

    const result = await buildOperationalIncidentChecks()[0]!.run({ cwd, hasAgentFolder: true })

    expect(result.status).toBe('ok')
  })

  test.each([
    { sessions: ['session-a'], unhealthyStatus: 'warning' },
    { sessions: ['session-a', 'session-b'], unhealthyStatus: 'error' },
  ])('returns to ok after a $unhealthyStatus incident is repaired', async ({ sessions, unhealthyStatus }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-doctor-repaired-incidents-'))
    const ledger = new IncidentLedger(cwd)
    const fact = { kind: 'bash-command-not-found' as const, bin: 'opensoma' }
    let fingerprint = ''
    for (const [index, sessionId] of sessions.entries()) {
      fingerprint = (await ledger.record(fact, sessionId, new Date(`2026-08-0${index + 1}T00:00:00.000Z`))).fingerprint
    }

    const check = buildOperationalIncidentChecks()[0]!
    expect((await check.run({ cwd, hasAgentFolder: true })).status).toBe(unhealthyStatus)
    expect(await ledger.resolve(fingerprint)).toBe(true)
    expect(await check.run({ cwd, hasAgentFolder: true })).toEqual({
      status: 'ok',
      message: 'no unresolved operational incidents',
    })
  })
})
