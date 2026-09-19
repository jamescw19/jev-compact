import type { StampedHistory } from '../src/ir.js'
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../src/jev/types.js'

export function stamped(ordinal: number, item: StampedHistory['item']): StampedHistory {
  return { ordinal, item }
}

/** Asker with a per-question-name probability map; records every ask. */
export class FakeAsker implements JevAsker {
  readonly asked: { state: JevState; questions: JevQuestions }[] = []

  constructor(private readonly answers: Record<string, number>) {}

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    this.asked.push({ state, questions })
    const answered: Record<string, { noul: number }> = {}
    for (const [name, value] of Object.entries(this.answers)) {
      if (name in questions) answered[name] = { noul: value }
    }
    return { answers: answered }
  }
}

export function writeJsonl(lines: readonly unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}
