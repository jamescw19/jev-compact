#!/bin/sh
# Launcher for fast-jev-compaction-codex hook handlers.
# Prefers node, falls back to bun. All failure paths exit 0 so a broken
# hook can never block the host Codex session.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$ROOT/dist/fast-jev.mjs"

if [ ! -f "$ENTRY" ]; then
  echo "fast-jev-compaction-codex: missing $ENTRY (run: bun run build)" >&2
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  exec node "$ENTRY" "$@"
fi

if command -v bun >/dev/null 2>&1; then
  exec bun "$ENTRY" "$@"
fi

echo "fast-jev-compaction-codex: no node or bun runtime found" >&2
exit 0
