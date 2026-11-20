# jev-compact — Gemini Decisions fork

Gemini-scored context compaction for [OpenAI Codex CLI](https://developers.openai.com/codex).
Fork of [fatelei/jev-compact](https://github.com/fatelei/jev-compact), using the
[Google Gemini Decisions API](https://aistudio.google.com/docs/decisions-api)
instead of TypeSafe Jev. No Jev account or key required.

Before Codex compacts a session, every tool call and result is scored by the
**gemini-decision-1** model (`noul` probability questions: "does this call still
matter?", "is this output still needed verbatim?"). Codex then compacts with
its built-in summary as usual. Afterwards, any output Gemini scored as *still
required* that the summary actually dropped is **re-injected verbatim** into
the next model request.

## How it works

```
        ┌─────────────────────┐
        │ PreCompact hook     │  read rollout JSONL → live segment
        │ (manual + auto)     │  → pair tool calls by call_id
        │                     │  → Gemini noul scoring (batched)
        │                     │  → three-level decision per call:
        │                     │     keep / drop_result / drop_call
        │                     │  → archive decisions (atomic, TTL)
        └─────────┬───────────┘
                  │ continue: true (always — never blocks compaction)
                  ▼
        ┌─────────────────────┐
        │ Codex built-in      │  produces the summary + replacement history
        │ compaction          │
        └─────────┬───────────┘
                  ▼
        ┌─────────────────────┐
        │ SessionStart hook   │  membership check per archived call:
        │ (source=compact)    │  call_id present? sha256 fingerprint?
        │                     │  head-200 substring? else MISSING
        │                     │  → rank by score, fit char budget
        │                     │  → additionalContext: verbatim content
        └─────────────────────┘
```

**Honest scope note:** Codex 0.155 hook outputs cannot *replace* compaction
results (unlike Claude Code's `session.compact` function hooks, which return a
full message list). This plugin therefore guides + repairs the built-in
compaction instead of replacing it: the summary still runs, but content Gemini
judged critical survives verbatim.

## Install

Requires: Codex CLI ≥ 0.155 with `[features] hooks = true` (default on), and
`node` or `bun` on PATH.

```bash
# from a local checkout
codex plugin marketplace add /path/to/jev-compact
# or straight from git
codex plugin marketplace add https://github.com/jamescw19/jev-compact.git

codex plugin add jev-compact@fast-jev
codex plugin list   # expect: installed, enabled
```

**First run:** Codex asks you to review and trust the plugin's hooks in the
TUI (`New hook - review required`, or `/hooks`). Untrusted hooks are silently
skipped — if nothing happens, that's why.

### API key

The hook reads `GEMINI_API_KEY` from its environment, falling back to
`apiKey` in the config file. An existing exported `GEMINI_API_KEY` needs no
configuration. Launch Codex from a shell that exports it.

Optional settings (no key needs to be saved here):

```jsonc
// ~/.codex/fast-jev-compaction.json
{
  "keepThreshold": 0.5,
  "maxBackfillChars": 8000
}
```

Without a key the plugin is a no-op: compaction proceeds untouched.
`TYPESAFE_API_KEY` is ignored. Scoring sends the fitted session context and
tool questions to Google over HTTPS. API failures keep calls conservatively
and allow built-in compaction to continue.

### Existing installations

Plugin ID `jev-compact@fast-jev`, config filename, data paths, and the
`jevRequestTimeoutMs` / `jevDeadlineMs` settings retain their upstream names.
The display name is **Gemini Compact**. These names do not select Jev.
Remove any old `model: "jev-latest"`, TypeSafe `baseUrl`, or TypeSafe `apiKey`
from the config before using this fork.

If the upstream `fast-jev` marketplace is already registered, remove its
plugin and marketplace before adding this fork so Codex loads the right source.

## Configuration

`$CODEX_HOME/fast-jev-compaction.json` (env `GEMINI_API_KEY` overrides `apiKey`).
All values are range-clamped; unknown keys are ignored.

| Key | Default | Meaning |
|---|---|---|
| `model` | `gemini-decision-1` | Gemini Decisions model name |
| `baseUrl` | `https://generativelanguage.googleapis.com/v1beta/decisions` | full endpoint override; receives the API key, so use only trusted endpoints |
| `keepThreshold` | `0.5` | noul probability ≥ threshold → keep |
| `preserveRecentItems` | `8` | most recent items are pinned (never dropped, never re-injected) |
| `maxStateTokens` | `25000` | state budget before staged compression |
| `maxRequestTokens` | `30000` | conservative estimated request budget (config cap: 32,000) |
| `jevRequestTimeoutMs` | `60000` | per-request timeout |
| `jevDeadlineMs` | `240000` | total scoring deadline (hook timeout is 600s) |
| `maxBackfillChars` | `8000` | total additionalContext budget |
| `perItemChars` | `4000` | per-item head+tail trim |
| `archiveTtlHours` | `2` | decision archive freshness window |
| `dataDir` | `$PLUGIN_DATA` | archive/probe/log storage |
| `logLevel` | `info` | `debug` / `info` / `silent` (stderr) |

Requests use `x-goog-api-key`, serialized context in `input`, and native
`true_description` / `false_description` criteria. Batches contain at most
1,000 questions. Long or non-ASCII tool call IDs receive stable hashed question
keys to satisfy Gemini's 64-character key limit; archived call IDs stay intact.

## Development

```bash
cd plugins/jev-compact
bun install
bun run build        # esbuild → dist/fast-jev.mjs (committed, zero runtime deps)
bun run test         # vitest, ~87% line coverage
bun run typecheck
```

Local iteration on an installed plugin: bump the version cachebuster
(`0.2.0+codex.<timestamp>` in `plugins/jev-compact/.codex-plugin/plugin.json`)
and re-run `codex plugin add jev-compact@fast-jev`.

### Capturing real hook payloads

```bash
FAST_JEV_RECORD=1 codex    # run a session, use tools, /compact, then quit
node dist/fast-jev.mjs probe ls
node dist/fast-jev.mjs probe inspect <file>
```

### Verified platform facts (Codex 0.155.0)

- Hook events include `PreCompact` / `PostCompact` / `SessionStart`; PreCompact
  input carries `session_id, turn_id, trigger("manual"|"auto"), transcript_path`;
  SessionStart input carries `source("startup"|"resume"|"clear"|"compact"|"fork")`.
- Compact hooks can only `continue: false` (block) — they cannot replace the
  summary. `SessionStart(source=compact)` runs after compaction and before the
  next model request, and its `hookSpecificOutput.additionalContext` (single
  string) is the official re-injection channel used here.
- Rollout JSONL keeps appending after a `compacted` record; effective history =
  last `compacted.replacement_history` + subsequent `response_item`s.
- Plugin hooks require one-time trust approval in the TUI; untrusted hooks are
  skipped silently in non-interactive runs.
- Hook stdout is read through a **pipe**: a Node process that calls
  `process.exit()` right after writing can hand the host a truncated payload,
  which Codex then reports as `invalid … JSON output`. This plugin therefore
  sets `process.exitCode` and exits naturally (flush first, then exit).
- `$PLUGIN_DATA` for an installed plugin resolves to
  `~/.codex/plugins/data/<plugin>-<marketplace>`; decision archives live there.

## License

MIT
