import type { IncomingMessage } from 'node:http'
import { promisify } from 'node:util'
import { constants, zstdDecompress } from 'node:zlib'

const MAX_BODY = 32 * 1024 * 1024
const decompress = promisify(zstdDecompress)

export async function readCodingBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<{ body: Buffer } | { status: number; code: string }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    signal.throwIfAborted()
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY) return { status: 413, code: 'request_too_large' }
    chunks.push(bytes)
  }
  const compressed = Buffer.concat(chunks)
  if (!request.headers['content-encoding']) return { body: compressed }
  try {
    // Both the output allocation and decoder window are bounded. Checking only
    // compressed bytes would allow a tiny expansion bomb to exhaust the runtime.
    const body = await decompress(compressed, {
      maxOutputLength: MAX_BODY,
      params: { [constants.ZSTD_d_windowLogMax]: 25 },
    })
    signal.throwIfAborted()
    return { body }
  } catch (error) {
    if (signal.aborted) throw error
    return error instanceof Error && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE'
      ? { status: 413, code: 'request_too_large' }
      : { status: 400, code: 'invalid_compression' }
  }
}
