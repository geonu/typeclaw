import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildQRHtml, displayQR, renderTerminalQR } from './qr'

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-qr-test-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const URL = 'https://line.me/R/au/q/EXAMPLE'

describe('buildQRHtml', () => {
  test('embeds an SVG QR and escapes the title/instruction', async () => {
    const html = await buildQRHtml(URL, {
      title: 'LINE <login>',
      scanInstruction: 'Scan "now" & go',
      brandColor: '#06C755',
    })

    expect(html).toContain('<svg')
    expect(html).toContain('#06C755')
    expect(html).toContain('LINE &lt;login&gt;')
    expect(html).toContain('Scan &quot;now&quot; &amp; go')
    expect(html).not.toContain('<login>')
  })
})

describe('renderTerminalQR', () => {
  test('stays compact enough to scan from an SSH terminal', async () => {
    // A long LINE auth URL must still fit a conventional 24-row terminal so it
    // is scannable over SSH without resizing. The 'L' ECC tuning is what keeps
    // it under that ceiling; a regression to higher ECC would overflow.
    const longUrl = `https://line.me/R/au/q/${'a'.repeat(64)}`
    const rendered = await renderTerminalQR(longUrl)
    expect(rendered.split('\n').length).toBeLessThanOrEqual(24)
  })
})

describe('displayQR', () => {
  test('on a TTY: writes an HTML file, opens it, and includes a terminal QR', async () => {
    await withDir(async (dir) => {
      const opened: string[] = []
      const result = await displayQR(URL, {
        title: 'LINE login',
        scanInstruction: 'Scan with the LINE app',
        isTty: true,
        tmpDir: dir,
        now: () => 1234,
        opener: async (p) => {
          opened.push(p)
        },
      })

      expect(result.qrUrl).toBe(URL)
      expect(result.htmlPath).toBe(join(dir, 'typeclaw-line-login-1234.html'))
      expect(result.opened).toBe(true)
      expect(opened).toEqual([result.htmlPath!])
      expect(result.terminal).not.toBeNull()
      expect(result.terminal!.length).toBeGreaterThan(0)

      const written = await readFile(result.htmlPath!, 'utf8')
      expect(written).toContain('<svg')
    })
  })

  test('non-TTY: still writes the HTML page but omits the terminal QR', async () => {
    await withDir(async (dir) => {
      const result = await displayQR(URL, {
        title: 'LINE login',
        scanInstruction: 'Scan with the LINE app',
        isTty: false,
        tmpDir: dir,
        now: () => 1,
        opener: async () => {},
      })

      expect(result.terminal).toBeNull()
      expect(result.htmlPath).not.toBeNull()
      const written = await readFile(result.htmlPath!, 'utf8')
      expect(written).toContain('<svg')
    })
  })

  test('opener failure degrades to opened=false without throwing', async () => {
    await withDir(async (dir) => {
      const result = await displayQR(URL, {
        title: 'LINE login',
        scanInstruction: 'Scan with the LINE app',
        isTty: true,
        tmpDir: dir,
        now: () => 2,
        opener: async () => {
          throw new Error('no browser')
        },
      })

      expect(result.opened).toBe(false)
      expect(result.htmlPath).not.toBeNull()
      expect(result.terminal).not.toBeNull()
    })
  })

  test('unwritable tmp dir degrades to htmlPath=null and skips the opener', async () => {
    let openerCalled = false
    const result = await displayQR(URL, {
      title: 'LINE login',
      scanInstruction: 'Scan with the LINE app',
      isTty: false,
      tmpDir: join(tmpdir(), 'typeclaw-qr-does-not-exist', 'nested', 'missing'),
      now: () => 3,
      opener: async () => {
        openerCalled = true
      },
    })

    expect(result.htmlPath).toBeNull()
    expect(result.opened).toBe(false)
    expect(openerCalled).toBe(false)
  })
})
