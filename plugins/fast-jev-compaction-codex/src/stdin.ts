const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

/** Read all of stdin as a UTF-8 string, capped to avoid runaway memory. */
export async function readStdin(maxBytes: number = DEFAULT_MAX_BYTES): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of process.stdin) {
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
