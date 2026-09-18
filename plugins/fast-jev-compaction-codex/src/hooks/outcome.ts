/**
 * The wire payloads a hook may return, per the Codex hook output schemas:
 * every field is optional and unknown fields are rejected by the host, so
 * we only ever emit exactly what each event supports.
 */
export interface HookOutcome {
  readonly continue?: boolean
  readonly stopReason?: string
  readonly suppressOutput?: boolean
  readonly systemMessage?: string
  readonly hookSpecificOutput?: {
    readonly hookEventName: 'SessionStart'
    readonly additionalContext: string
  }
  /** Internal, never serialized: human-readable reason logged to stderr. */
  readonly note?: string
}

/** Strip internal fields before writing the payload to stdout. */
export function wirePayload(outcome: HookOutcome): Record<string, unknown> {
  const { note: _note, ...wire } = outcome
  return wire
}
