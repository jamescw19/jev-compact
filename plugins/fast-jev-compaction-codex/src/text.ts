const ELLIPSIS = '…'

/** Cap text to `maxChars`, appending an ellipsis when truncated. */
export function cap(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + ELLIPSIS
}

/**
 * Keep both ends of over-long text: head 70%, tail 30%, with an explicit
 * omission marker in between so readers know content was elided.
 */
export function headTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 0) return ''
  const head = Math.floor(maxChars * 0.7)
  const tail = maxChars - head
  return `${text.slice(0, head)}${ELLIPSIS}[${text.length - maxChars} chars omitted]${text.slice(text.length - tail)}`
}
