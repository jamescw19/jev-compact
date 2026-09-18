// src/config.ts
import os from "node:os";
import path from "node:path";
var PLUGIN_DATA_KEYS = ["PLUGIN_DATA", "CLAUDE_PLUGIN_DATA"];
function resolveDataDir(env = process.env) {
  for (const key of PLUGIN_DATA_KEYS) {
    const value = env[key];
    if (value && value.trim() !== "") return value;
  }
  return path.join(resolveCodexHome(env), "fast-jev-compaction-data");
}
function resolveCodexHome(env = process.env) {
  const value = env["CODEX_HOME"];
  if (value && value.trim() !== "") return value;
  return path.join(os.homedir(), ".codex");
}

// src/probe.ts
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path2 from "node:path";

// src/stdin.ts
var DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
async function readStdin(maxBytes = DEFAULT_MAX_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      chunks.push(buf.subarray(0, buf.length - (total - maxBytes)));
      break;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// src/probe.ts
var ENV_KEYS = [
  "PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "PLUGIN_DATA",
  "CLAUDE_PLUGIN_DATA",
  "CODEX_HOME",
  "HOME",
  "PATH"
];
function sanitizeEventName(event) {
  return event.replace(/[^A-Za-z0-9_-]/g, "-") || "unknown";
}
function snapshotEnv(env) {
  const snapshot = {};
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== void 0) snapshot[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (/^(PLUGIN|CODEX|CLAUDE|FAST_JEV)/i.test(key) && !(key in snapshot)) {
      snapshot[key] = env[key] ?? "";
    }
  }
  return snapshot;
}
async function record(event) {
  const stdinRaw = await readStdin();
  const record2 = {
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    event,
    argv: process.argv.slice(2),
    env: snapshotEnv(process.env),
    stdinRaw,
    stdinJson: parseSafeJson(stdinRaw)
  };
  const dir = path2.join(resolveDataDir(), "probe");
  await mkdir(dir, { recursive: true });
  const stamp = record2.capturedAt.replace(/[:.]/g, "-");
  const file = path2.join(dir, `${stamp}-${sanitizeEventName(event)}-${process.pid}.json`);
  await writeFile(file, JSON.stringify(record2, null, 2) + "\n", "utf8");
  process.stderr.write(`fast-jev probe: captured ${event} -> ${file}
`);
  return 0;
}
function parseSafeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
async function inspect(files) {
  for (const file of files) {
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      process.stderr.write(`fast-jev probe: cannot read ${file}: ${String(error)}
`);
      continue;
    }
    const parsed = parseSafeJson(raw);
    if (parsed === null) {
      process.stderr.write(`fast-jev probe: ${file} is not JSON
`);
      continue;
    }
    process.stdout.write(`=== ${path2.basename(file)} ===
`);
    process.stdout.write(`event: ${parsed.event}
`);
    process.stdout.write(`capturedAt: ${parsed.capturedAt}
`);
    process.stdout.write(`cwd: ${parsed.cwd}
`);
    process.stdout.write(
      `env: ${JSON.stringify(Object.fromEntries(Object.entries(parsed.env ?? {}).filter(([k]) => k !== "PATH")), null, 2)}
`
    );
    process.stdout.write(`stdin:
${JSON.stringify(parsed.stdinJson, null, 2)}
`);
    const stdin = parsed.stdinJson;
    const transcriptPath = stdin?.transcript_path;
    if (typeof transcriptPath === "string" && transcriptPath !== "") {
      try {
        const info = await stat(transcriptPath);
        process.stdout.write(
          `transcript: exists (${info.size} bytes) at capture time? (checked now)
`
        );
      } catch {
        process.stdout.write(`transcript: NOT FOUND now (${transcriptPath})
`);
      }
    }
  }
  return 0;
}
async function list() {
  const dir = path2.join(resolveDataDir(), "probe");
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    process.stdout.write("(no probe captures yet)\n");
    return 0;
  }
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const full = path2.join(dir, entry);
    const info = await stat(full);
    process.stdout.write(`${entry}  (${info.size} bytes)
`);
  }
  return 0;
}
async function runProbe(args) {
  const [action, ...rest] = args;
  switch (action) {
    case "record":
      return record(rest[0] ?? "unknown");
    case "inspect":
      return inspect(rest);
    case "ls":
      return list();
    default:
      process.stderr.write("usage: fast-jev.mjs probe record <Event> | inspect <file...> | ls\n");
      return 0;
  }
}

// src/cli.ts
function isHookEvent(value) {
  return value === "pre-compact" || value === "session-start";
}
async function runHook(event) {
  if (process.env["FAST_JEV_RECORD"] === "1") {
    return runProbe(["record", event]);
  }
  await readStdin();
  process.stdout.write("{}\n");
  return 0;
}
function usage() {
  return [
    "fast-jev-compaction-codex",
    "",
    "usage:",
    "  fast-jev.mjs pre-compact          PreCompact hook entrypoint",
    "  fast-jev.mjs session-start        SessionStart hook entrypoint",
    "  fast-jev.mjs probe record <Event> capture stdin+env to the data dir",
    "  fast-jev.mjs probe inspect <file> normalize a captured record",
    "  fast-jev.mjs probe ls             list captured records",
    "",
    `data dir: ${resolveDataDir()}`
  ].join("\n");
}
async function main(argv) {
  const [command, ...rest] = argv;
  if (isHookEvent(command)) return runHook(command);
  if (command === "probe") return runProbe(rest);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  process.stderr.write(`${usage()}

unknown command: ${command ?? "(none)"}
`);
  return 0;
}
var invokedDirectly = process.argv[1]?.includes("fast-jev");
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
export {
  main
};
