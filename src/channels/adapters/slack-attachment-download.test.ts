import { expect, test } from 'bun:test'

import { downloadSlackAttachment } from './slack-attachment-download'

const url = 'https://files.slack.com/files-pri/T0-F0/email.html'

test('HTML email is an original attachment, not a login error; language and login prose are irrelevant', async () => {
  const bytes = '<html><body>발주 수량 80개 / ログイン 안내 / sign in instructions</body></html>'
  const result = await downloadSlackAttachment({
    metadata: { mimetype: 'text/html', url_private_download: url },
    token: 'synthetic',
    maxBytes: 1024,
    fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  })
  expect(result.buffer.toString()).toBe(bytes)
})

test('HTML served in place of a declared PDF or image is refused', async () => {
  for (const mimetype of ['application/pdf', 'image/png']) {
    await expect(
      downloadSlackAttachment({
        metadata: { mimetype, url_private_download: url },
        token: 'synthetic',
        maxBytes: 1024,
        fetchImpl: async () => new Response('<html>認証</html>', { headers: { 'content-type': 'text/html' } }),
      }),
    ).rejects.toThrow()
  }
})

test('a real authentication form is refused even for an HTML original', async () => {
  await expect(
    downloadSlackAttachment({
      metadata: { mimetype: 'text/html', url_private_download: url },
      token: 'synthetic',
      maxBytes: 1024,
      fetchImpl: async () =>
        new Response('<form action="https://example.slack.com/signin"><input type="password"></form>', {
          headers: { 'content-type': 'text/html' },
        }),
    }),
  ).rejects.toThrow()
})

test('private PDF download retains bearer authorization across a trusted Slack redirect', async () => {
  const bytes = Buffer.from('%PDF-synthetic')
  const requests: string[] = []
  const result = await downloadSlackAttachment({
    metadata: { mimetype: 'application/pdf', url_private_download: url },
    token: 'synthetic',
    maxBytes: 1024,
    fetchImpl: async (input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic')
      expect(init?.redirect).toBe('manual')
      requests.push(String(input))
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://downloads.slack-edge.com/original.pdf' } })
        : new Response(bytes, { headers: { 'content-type': 'application/pdf' } })
    },
  })
  expect(result.buffer).toEqual(bytes)
  expect(requests).toEqual([url, 'https://downloads.slack-edge.com/original.pdf'])
})

test('an untrusted redirect never receives credentials and HTML originals retain the body bound', async () => {
  let calls = 0
  await expect(
    downloadSlackAttachment({
      metadata: { mimetype: 'text/html', url_private_download: url },
      token: 'synthetic',
      maxBytes: 8,
      fetchImpl: async () => {
        calls++
        return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/file' } })
      },
    }),
  ).rejects.toThrow()
  expect(calls).toBe(1)
  await expect(
    downloadSlackAttachment({
      metadata: { mimetype: 'text/html', url_private_download: url },
      token: 'synthetic',
      maxBytes: 8,
      fetchImpl: async () => new Response('<html>too big</html>', { headers: { 'content-type': 'text/html' } }),
    }),
  ).rejects.toThrow()
})
