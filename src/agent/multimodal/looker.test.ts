import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildMultimodalLookerSystemPrompt, resolveImage } from './looker'

describe('buildMultimodalLookerSystemPrompt', () => {
  test('with prompt → focused answer instructions including the question', () => {
    const out = buildMultimodalLookerSystemPrompt('What error message is shown?')
    expect(out).toContain('ANSWER the question below')
    expect(out).toContain('Question: What error message is shown?')
  })

  test('trims whitespace around the prompt', () => {
    const out = buildMultimodalLookerSystemPrompt('  what is this?  ')
    expect(out).toContain('Question: what is this?')
  })
})

describe('resolveImage', () => {
  test('base64 input passes through verbatim', async () => {
    const result = await resolveImage({ kind: 'base64', data: 'aGVsbG8=', mimeType: 'image/png' })
    expect(result).toEqual({ data: 'aGVsbG8=', mimeType: 'image/png' })
  })

  test('base64 rejects non-image mimeType', async () => {
    expect(resolveImage({ kind: 'base64', data: 'aGVsbG8=', mimeType: 'text/plain' })).rejects.toThrow(
      /mimeType must be image/,
    )
  })

  test('file input reads bytes and infers MIME from extension', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-looker-'))
    try {
      // 8-byte PNG signature header is enough to exercise the read path
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const path = join(cwd, 'pic.png')
      await writeFile(path, png)

      const result = await resolveImage({ kind: 'file', path })
      expect(result.mimeType).toBe('image/png')
      expect(Buffer.from(result.data, 'base64')).toEqual(png)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('file input infers image/jpeg from .jpg and .jpeg', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-looker-'))
    try {
      const bytes = Buffer.from([0xff, 0xd8, 0xff])
      const jpg = join(cwd, 'a.jpg')
      const jpeg = join(cwd, 'b.jpeg')
      await writeFile(jpg, bytes)
      await writeFile(jpeg, bytes)

      const jpgResult = await resolveImage({ kind: 'file', path: jpg })
      const jpegResult = await resolveImage({ kind: 'file', path: jpeg })
      expect(jpgResult.mimeType).toBe('image/jpeg')
      expect(jpegResult.mimeType).toBe('image/jpeg')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('file input rejects relative paths', async () => {
    expect(resolveImage({ kind: 'file', path: 'relative/pic.png' })).rejects.toThrow(/absolute/)
  })

  test('file input rejects missing files', async () => {
    expect(resolveImage({ kind: 'file', path: '/nonexistent/path/pic.png' })).rejects.toThrow(/not found/)
  })

  test('file input rejects unsupported extensions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-looker-'))
    try {
      const path = join(cwd, 'pic.bmp')
      await writeFile(path, 'x')
      expect(resolveImage({ kind: 'file', path })).rejects.toThrow(/unsupported image extension/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
