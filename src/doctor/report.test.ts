import { describe, expect, test } from 'bun:test'

import { formatJson, formatReport } from './report'
import type { DoctorReport } from './types'

function makeReport(): DoctorReport {
  return {
    cwd: '/agent',
    stage: 'host',
    hasAgentFolder: true,
    entries: [
      {
        name: 'docker.daemon-reachable',
        category: 'docker',
        description: 'Docker daemon is reachable',
        source: 'static',
        status: 'ok',
        message: 'docker info responded',
      },
      {
        name: 'daily-stream-current',
        category: 'plugin:memory',
        description: "today's daily stream file exists",
        source: 'plugin',
        pluginName: 'memory',
        status: 'warning',
        message: 'memory/streams/today.jsonl missing',
        fix: { description: 'create the file', canAutoFix: true },
      },
    ],
    summary: { ok: 1, warning: 1, error: 0, info: 0, skipped: 0 },
    ok: false,
  }
}

describe('formatReport', () => {
  test('groups by category and surfaces fix hints', () => {
    const out = formatReport(makeReport(), { useColor: false })
    expect(out).toContain('typeclaw doctor')
    expect(out).toContain('[✓] docker')
    expect(out).toContain('[!] plugin:memory')
    expect(out).toContain('→ Fix (auto): create the file')
    expect(out).toContain('Summary: 1 ok, 1 warning')
  })

  test('omits details unless verbose', () => {
    const report = makeReport()
    report.entries[0]!.details = ['this is a detail']
    const compact = formatReport(report, { useColor: false })
    const verbose = formatReport(report, { useColor: false, verbose: true })
    expect(compact).not.toContain('this is a detail')
    expect(verbose).toContain('this is a detail')
  })
})

describe('formatJson', () => {
  test('returns valid JSON of the report', () => {
    const report = makeReport()
    const parsed = JSON.parse(formatJson(report)) as DoctorReport
    expect(parsed.entries.length).toBe(2)
    expect(parsed.ok).toBe(false)
  })
})
