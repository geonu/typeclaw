import { describe, expect, test } from 'bun:test'

import { applyJq, JqError } from './jq'

describe('applyJq', () => {
  test('extracts a top-level field', async () => {
    const json = JSON.stringify({ name: 'typeclaw', version: '0.1' })
    const result = await applyJq(json, '.name')
    expect(result).toBe('"typeclaw"')
  })

  test('rejects non-JSON input with a JqError', async () => {
    await expect(applyJq('<html>not json</html>', '.foo')).rejects.toThrow(JqError)
  })

  test('reports jq syntax errors as JqError', async () => {
    await expect(applyJq('{}', '.[invalid')).rejects.toThrow(JqError)
  })
})
