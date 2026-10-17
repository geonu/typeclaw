import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'

import {
  CurlImpersonateError,
  _resetAvailabilityCacheForTest,
  _setCurlBinaryForTest,
  curlImpersonate,
  isCurlExitFilesizeExceeded,
  isCurlExitTimeout,
  isCurlImpersonateAvailable,
} from './curl-impersonate'

const onWindows = isWindows()

// We can't predict the per-request random sentinel from the test, so the
// fake binary reads it out of argv (the value following '-w') and renders
// a fake metadata block back. See fetch.test.ts for the rationale on the
// argv positional-access pattern.
const FAKE_BINARY_BODY = (
  body: string,
  status = 200,
  finalUrl = 'https://example.com',
  contentType = 'text/html',
  headerJson = '{}',
) => `
ARGV_FILE="$SCRATCH_ARGV"
printf '%s\\n' "$@" > "$ARGV_FILE"
WTPL=""
i=1
for arg in "$@"; do
  if [ "$arg" = "-w" ]; then
    j=$((i + 1))
    eval "WTPL=\\"\\\${$j}\\""
    break
  fi
  i=$((i + 1))
done
RENDERED=$(printf '%s' "$WTPL" | sed -e 's/%{http_code}/${status}/' -e 's|%{url_effective}|${finalUrl}|' -e 's|%{content_type}|${contentType}|' -e 's/%{size_download}/${body.length}/' -e 's|%{header_json}|@@HJ@@|')
printf '%s' '${body}'
printf '%s' "$RENDERED" | sed "s|@@HJ@@|$(printf '%s' '${headerJson.replace(/'/g, `'\\''`).replace(/\|/g, '\\\\|')}')|"
`

// POSIX-only fake shell binary without .exe/.cmd; Windows cannot spawn it (#899).
describe.skipIf(onWindows)('curlImpersonate', () => {
  let scratchDir: string
  let argvFile: string

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'curl-impersonate-test-'))
    argvFile = join(scratchDir, 'argv.txt')
    _resetAvailabilityCacheForTest()
  })

  afterEach(() => {
    _setCurlBinaryForTest(null)
    _resetAvailabilityCacheForTest()
    rmSync(scratchDir, { recursive: true, force: true })
  })

  function installFakeBinary(script: string): void {
    const path = join(scratchDir, 'fake-curl')
    // --version short-circuit so that scripts which simulate an error-exit
    // body don't also fail the isCurlImpersonateAvailable() probe.
    writeFileSync(
      path,
      `#!/bin/sh\nSCRATCH_ARGV="${argvFile}"\nif [ "$1" = "--version" ]; then exit 0; fi\n${script}\n`,
      'utf8',
    )
    chmodSync(path, 0o755)
    _setCurlBinaryForTest(path)
  }

  async function argv(): Promise<string[]> {
    return (await Bun.file(argvFile).text()).split('\n')
  }

  test('returns body, status, finalUrl, contentType when curl emits the requested sentinel', async () => {
    installFakeBinary(FAKE_BINARY_BODY('<html>hi</html>', 200, 'https://example.com/final', 'text/html; charset=utf-8'))

    const result = await curlImpersonate({ url: 'https://example.com' })

    expect(result.body).toBe('<html>hi</html>')
    expect(result.httpStatus).toBe(200)
    expect(result.finalUrl).toBe('https://example.com/final')
    expect(result.contentType).toBe('text/html; charset=utf-8')
    expect(result.bytesIn).toBe(15)
  })

  test('spawns the per-request binary when one is given', async () => {
    // given: the fake is reachable only through req.binary, not the default
    installFakeBinary(FAKE_BINARY_BODY('<html>profile</html>'))
    _setCurlBinaryForTest(null)

    // when
    const result = await curlImpersonate({ url: 'https://example.com', binary: join(scratchDir, 'fake-curl') })

    // then
    expect(result.body).toBe('<html>profile</html>')
  })

  test('preserves a 404 body and reports httpStatus=404 (does NOT throw)', async () => {
    installFakeBinary(FAKE_BINARY_BODY('not found', 404, 'https://example.com/missing', 'text/plain'))

    const result = await curlImpersonate({ url: 'https://example.com/missing' })

    expect(result.httpStatus).toBe(404)
    expect(result.body).toBe('not found')
  })

  test('throws when the sentinel is missing (no -w output at all)', async () => {
    // given: fake that emits only a body, no sentinel, no metadata
    installFakeBinary("printf 'raw body without metadata'")

    await expect(curlImpersonate({ url: 'https://example.com' })).rejects.toThrow(/sentinel missing/)
  })

  test('is not spoofable: body containing a literal old-style sentinel does not corrupt parsing', async () => {
    // given: body contains the legacy hard-coded sentinel string (which a
    // malicious page could include verbatim). The real sentinel is now
    // per-request random, and we anchor on the LAST occurrence, so the
    // injected one is treated as part of the body.
    const evilBody = 'attacker\n--TYPECLAW-CURL-META-FAKEFAKEFAKE--\n999\nhttps://evil/\ntext/x\n8\nlegitimate'
    installFakeBinary(FAKE_BINARY_BODY(evilBody, 200, 'https://example.com/real', 'text/html'))

    const result = await curlImpersonate({ url: 'https://example.com' })

    expect(result.httpStatus).toBe(200)
    expect(result.finalUrl).toBe('https://example.com/real')
    expect(result.body).toBe(evilBody)
  })

  test('throws CurlImpersonateError with exitCode and stderr on non-zero exit', async () => {
    installFakeBinary('echo "tls handshake failed" >&2; exit 35')

    try {
      await curlImpersonate({ url: 'https://example.com' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CurlImpersonateError)
      const err = error as CurlImpersonateError
      expect(err.exitCode).toBe(35)
      expect(err.stderr).toContain('tls handshake failed')
      expect(err.message).toMatch(/exited 35/)
    }
  })

  test('reports "no stderr" when the binary fails silently', async () => {
    installFakeBinary('exit 7')

    await expect(curlImpersonate({ url: 'https://example.com' })).rejects.toThrow(/exited 7.*no stderr/)
  })

  test('passes method, url, and form fields through argv', async () => {
    installFakeBinary(FAKE_BINARY_BODY('ok'))

    await curlImpersonate({
      url: 'https://example.com/search',
      method: 'POST',
      formFields: [
        { name: 'q', value: 'hello world' },
        { name: 'lang', value: 'en' },
      ],
    })

    const a = await argv()
    expect(a).toContain('-X')
    expect(a).toContain('POST')
    expect(a).toContain('--data-urlencode')
    expect(a).toContain('q=hello world')
    expect(a).toContain('lang=en')
    expect(a).toContain('https://example.com/search')
  })

  test('passes --disable as the first argument (suppresses .curlrc)', async () => {
    installFakeBinary(FAKE_BINARY_BODY('ok'))

    await curlImpersonate({ url: 'https://example.com' })

    const a = await argv()
    // argv[0] inside the wrapper is the first option curl sees (argv[0] of
    // the spawned process is the binary itself, not visible to the shell's $@).
    expect(a[0]).toBe('--disable')
  })

  test('passes --proto =http,https and --proto-redir =http,https (blocks redirect-to-ftp)', async () => {
    installFakeBinary(FAKE_BINARY_BODY('ok'))

    await curlImpersonate({ url: 'https://example.com' })

    const a = await argv()
    const protoIdx = a.indexOf('--proto')
    const redirIdx = a.indexOf('--proto-redir')
    expect(protoIdx).toBeGreaterThanOrEqual(0)
    expect(a[protoIdx + 1]).toBe('=http,https')
    expect(redirIdx).toBeGreaterThanOrEqual(0)
    expect(a[redirIdx + 1]).toBe('=http,https')
  })

  test('passes -- before the URL so a URL beginning with - is not parsed as a flag', async () => {
    installFakeBinary(FAKE_BINARY_BODY('ok'))

    await curlImpersonate({ url: 'https://example.com' })

    const a = await argv()
    const dashIdx = a.indexOf('--')
    expect(dashIdx).toBeGreaterThanOrEqual(0)
    expect(a[dashIdx + 1]).toBe('https://example.com')
  })

  test('follows redirects by default (passes --location)', async () => {
    installFakeBinary(FAKE_BINARY_BODY('ok'))

    await curlImpersonate({ url: 'https://example.com' })

    const a = await argv()
    expect(a).toContain('--location')
    expect(a).toContain('--max-redirs')
  })

  test('passes maxBytes as --max-filesize when provided', async () => {
    installFakeBinary(FAKE_BINARY_BODY('ok'))

    await curlImpersonate({ url: 'https://example.com', maxBytes: 5_000_000 })

    const a = await argv()
    const idx = a.indexOf('--max-filesize')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(a[idx + 1]).toBe('5000000')
  })

  test('passes -b and -c with the same jar path when cookieJarPath is set', async () => {
    installFakeBinary(FAKE_BINARY_BODY('ok'))

    await curlImpersonate({ url: 'https://example.com', cookieJarPath: '/tmp/jar.txt' })

    const a = await argv()
    const readIdx = a.indexOf('-b')
    const writeIdx = a.indexOf('-c')
    expect(readIdx).toBeGreaterThanOrEqual(0)
    expect(a[readIdx + 1]).toBe('/tmp/jar.txt')
    expect(writeIdx).toBeGreaterThanOrEqual(0)
    expect(a[writeIdx + 1]).toBe('/tmp/jar.txt')
  })

  test('omits cookie-jar flags when cookieJarPath is not set', async () => {
    installFakeBinary(FAKE_BINARY_BODY('ok'))

    await curlImpersonate({ url: 'https://example.com' })

    const a = await argv()
    expect(a).not.toContain('-b')
    expect(a).not.toContain('-c')
  })

  test('parses Set-Cookie names from header_json', async () => {
    const headerJson = '{"set-cookie":["_abck=xyz; Path=/","bm_sz=abc; Path=/"],"content-type":["text/html"]}'
    installFakeBinary(FAKE_BINARY_BODY('blocked', 403, 'https://example.com', 'text/html', headerJson))

    const result = await curlImpersonate({ url: 'https://example.com' })

    expect(result.httpStatus).toBe(403)
    expect(result.setCookieNames).toEqual(['_abck', 'bm_sz'])
  })

  test('returns empty setCookieNames when the server sets no cookies', async () => {
    installFakeBinary(FAKE_BINARY_BODY('ok', 200, 'https://example.com', 'text/html', '{"content-type":["text/html"]}'))

    const result = await curlImpersonate({ url: 'https://example.com' })

    expect(result.setCookieNames).toEqual([])
  })

  test('aborts when the AbortSignal fires', async () => {
    installFakeBinary('sleep 30')
    const controller = new AbortController()

    const promise = curlImpersonate({ url: 'https://example.com', signal: controller.signal })
    setTimeout(() => controller.abort(), 50)

    await expect(promise).rejects.toThrow()
  })
})

describe('isCurlExitTimeout / isCurlExitFilesizeExceeded', () => {
  test('exit 28 = timeout', () => {
    const err = new CurlImpersonateError('curl-impersonate exited 28: Operation timed out', 28, 'Operation timed out')
    expect(isCurlExitTimeout(err)).toBe(true)
    expect(isCurlExitFilesizeExceeded(err)).toBe(false)
  })

  test('exit 63 = filesize exceeded (content-length precheck)', () => {
    const err = new CurlImpersonateError('curl-impersonate exited 63', 63, 'Maximum file size exceeded')
    expect(isCurlExitFilesizeExceeded(err)).toBe(true)
    expect(isCurlExitTimeout(err)).toBe(false)
  })

  test('exit 56 + "maximum allowed file size" stderr = filesize exceeded (transfer-time)', () => {
    const err = new CurlImpersonateError(
      'curl-impersonate exited 56',
      56,
      'Exceeded the maximum allowed file size (1) with 1 bytes',
    )
    expect(isCurlExitFilesizeExceeded(err)).toBe(true)
  })

  test('exit 56 WITHOUT filesize stderr = generic recv failure, not filesize', () => {
    const err = new CurlImpersonateError('curl-impersonate exited 56', 56, 'Recv failure: Connection reset by peer')
    expect(isCurlExitFilesizeExceeded(err)).toBe(false)
  })

  test('other exit codes = neither', () => {
    const err = new CurlImpersonateError('curl-impersonate exited 35', 35, 'TLS handshake failed')
    expect(isCurlExitTimeout(err)).toBe(false)
    expect(isCurlExitFilesizeExceeded(err)).toBe(false)
  })
})

describe('isCurlImpersonateAvailable', () => {
  beforeEach(() => {
    _resetAvailabilityCacheForTest()
  })

  afterEach(() => {
    _setCurlBinaryForTest(null)
    _resetAvailabilityCacheForTest()
  })

  // POSIX-only fake shell binary without .exe/.cmd; Windows cannot spawn it (#899).
  test.skipIf(onWindows)('returns true when the binary exits 0 on --version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'curl-available-test-'))
    try {
      const path = join(dir, 'fake-curl')
      writeFileSync(path, '#!/bin/sh\necho "curl 8.x impersonate"\nexit 0\n', 'utf8')
      chmodSync(path, 0o755)
      _setCurlBinaryForTest(path)

      const available = await isCurlImpersonateAvailable()

      expect(available).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns false when the binary is missing', async () => {
    _setCurlBinaryForTest('/nonexistent/path/to/curl_chrome136')

    const available = await isCurlImpersonateAvailable()

    expect(available).toBe(false)
  })

  // POSIX-only fake shell binary without .exe/.cmd; Windows cannot spawn it (#899).
  test.skipIf(onWindows)('caches the result for the life of the process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'curl-cache-test-'))
    try {
      const path = join(dir, 'fake-curl')
      writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf8')
      chmodSync(path, 0o755)
      _setCurlBinaryForTest(path)

      const first = await isCurlImpersonateAvailable()
      _setCurlBinaryForTest('/nonexistent')
      const second = await isCurlImpersonateAvailable()

      expect(first).toBe(true)
      expect(second).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
