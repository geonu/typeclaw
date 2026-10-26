import { readFile } from 'node:fs/promises'

import { incidentsPath, readIncidentLedger } from '@/operations'

import type { DoctorCheck } from './types'

export function buildOperationalIncidentChecks(): DoctorCheck[] {
  return [
    {
      name: 'operations.incidents',
      category: 'operations',
      description: 'deterministic operational incidents are resolved',
      applies: (ctx) => ctx.hasAgentFolder,
      async run(ctx) {
        // Sandboxed bash sees the runtime-private ledger as a 0-byte mask
        // (src/sandbox/runtime-private.ts); the ledger itself is always written
        // as JSON. readIncidentLedger would read that as "no incidents".
        const raw = await readFile(incidentsPath(ctx.cwd), 'utf8').catch(() => null)
        if (raw !== null && raw.trim() === '') {
          return {
            status: 'info',
            message: 'operational incident check deferred: the incident ledger is not readable here',
            details: [
              'Sandboxed bash masks .typeclaw/incidents.json. Run doctor on the host or via `docker exec` to check incidents.',
            ],
          }
        }
        const ledger = await readIncidentLedger(ctx.cwd)
        const unresolved = ledger.incidents.filter((incident) => incident.status === 'unresolved')
        if (unresolved.length === 0) return { status: 'ok', message: 'no unresolved operational incidents' }
        const recurrent = unresolved.filter((incident) => incident.recurrent)
        return {
          status: recurrent.length > 0 ? 'error' : 'warning',
          message:
            recurrent.length > 0
              ? `${recurrent.length} recurrent TypeClaw environment issue(s) require operator repair`
              : `${unresolved.length} unresolved operational incident(s)`,
          details: unresolved.map(
            (incident) =>
              `${incident.fingerprint} count=${incident.count} first=${incident.firstSeenAt} last=${incident.lastSeenAt}`,
          ),
          fix: { description: 'Repair the TypeClaw environment defect, then retry the failed operation.' },
        }
      },
    },
  ]
}
