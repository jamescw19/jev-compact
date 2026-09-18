const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

/** Read an async-iterable byte stream to a UTF-8 string, capped to avoid runaway memory. */
export async function readStream(
  stream: AsyncIterable<unknown>,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buf.length
    if (total > maxBytes) {
      chunks.push(buf.subarray(0, buf.length - (total - maxBytes)))
      break
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Read all of stdin as a UTF-8 string, capped to avoid runaway memory.
 * A TTY (manual debugging) would block forever on EOF, so it yields ''.
 */
export function readStdin(maxBytes: number = DEFAULT_MAX_BYTES): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('')
  return readStream(process.stdin, maxBytes)
}
