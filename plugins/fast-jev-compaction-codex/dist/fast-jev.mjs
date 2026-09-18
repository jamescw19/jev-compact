var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/jev/types.ts
var SYSTEM_ONE_URL, DEFAULT_JEV_MODEL;
var init_types = __esm({
  "src/jev/types.ts"() {
    "use strict";
    SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
    DEFAULT_JEV_MODEL = "jev-latest";
  }
});

// src/config.ts
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
function resolveCodexHome(env = process.env) {
  const value = env["CODEX_HOME"];
  if (value === void 0 || value.trim() === "") return path.join(os.homedir(), ".codex");
  return value;
}
function configPath(env = process.env) {
  return path.join(resolveCodexHome(env), "fast-jev-compaction.json");
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function coerceNumber(value, fallback, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}
function parseConfigJson(text, base = DEFAULT_CONFIG) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return base;
  }
  if (typeof raw !== "object" || raw === null) return base;
  const record2 = raw;
  const logLevel = record2["logLevel"];
  return {
    apiKey: optionalString(record2["apiKey"]),
    model: optionalString(record2["model"]) ?? base.model,
    baseUrl: optionalString(record2["baseUrl"]),
    keepThreshold: coerceNumber(record2["keepThreshold"], base.keepThreshold, 0.01, 1),
    preserveRecentItems: Math.round(
      coerceNumber(record2["preserveRecentItems"], base.preserveRecentItems, 0, 500)
    ),
    maxStateTokens: Math.round(coerceNumber(record2["maxStateTokens"], base.maxStateTokens, 1e3, 2e5)),
    maxRequestTokens: Math.round(
      coerceNumber(record2["maxRequestTokens"], base.maxRequestTokens, 2e3, 32e3)
    ),
    jevRequestTimeoutMs: Math.round(
      coerceNumber(record2["jevRequestTimeoutMs"], base.jevRequestTimeoutMs, 1e3, 6e5)
    ),
    jevDeadlineMs: Math.round(coerceNumber(record2["jevDeadlineMs"], base.jevDeadlineMs, 1e3, 59e4)),
    maxBackfillChars: Math.round(coerceNumber(record2["maxBackfillChars"], base.maxBackfillChars, 0, 6e4)),
    perItemChars: Math.round(coerceNumber(record2["perItemChars"], base.perItemChars, 0, 3e4)),
    archiveTtlHours: coerceNumber(record2["archiveTtlHours"], base.archiveTtlHours, 0.1, 168),
    dataDir: optionalString(record2["dataDir"]),
    logLevel: logLevel === "debug" || logLevel === "silent" ? logLevel : "info"
  };
}
async function loadConfig(env = process.env) {
  let config = DEFAULT_CONFIG;
  try {
    config = parseConfigJson(await readFile(configPath(env), "utf8"));
  } catch {
  }
  const envKey = env["TYPESAFE_API_KEY"];
  if (envKey !== void 0 && envKey.trim() !== "") {
    config = { ...config, apiKey: envKey.trim() };
  }
  const stateCeiling = config.maxRequestTokens - 1024;
  if (config.maxStateTokens > stateCeiling) {
    config = { ...config, maxStateTokens: Math.max(1e3, stateCeiling) };
  }
  return config;
}
function resolveDataDir(config, env = process.env) {
  if (config !== void 0 && config.dataDir !== null) return config.dataDir;
  for (const key of PLUGIN_DATA_KEYS) {
    const value = env[key];
    if (value !== void 0 && value.trim() !== "") return value;
  }
  return path.join(resolveCodexHome(env), "fast-jev-compaction-data");
}
var PLUGIN_DATA_KEYS, DEFAULT_CONFIG;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    init_types();
    PLUGIN_DATA_KEYS = ["PLUGIN_DATA", "CLAUDE_PLUGIN_DATA"];
    DEFAULT_CONFIG = {
      apiKey: null,
      model: DEFAULT_JEV_MODEL,
      baseUrl: null,
      keepThreshold: 0.5,
      preserveRecentItems: 8,
      maxStateTokens: 25e3,
      maxRequestTokens: 3e4,
      jevRequestTimeoutMs: 6e4,
      jevDeadlineMs: 24e4,
      maxBackfillChars: 8e3,
      perItemChars: 4e3,
      archiveTtlHours: 2,
      dataDir: null,
      logLevel: "info"
    };
  }
});

// src/stdin.ts
async function readStream(stream, maxBytes = DEFAULT_MAX_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
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
function readStdin(maxBytes = DEFAULT_MAX_BYTES) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return readStream(process.stdin, maxBytes);
}
var DEFAULT_MAX_BYTES;
var init_stdin = __esm({
  "src/stdin.ts"() {
    "use strict";
    DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
  }
});

// src/probe.ts
var probe_exports = {};
__export(probe_exports, {
  runProbe: () => runProbe,
  writeCapture: () => writeCapture
});
import { mkdir as mkdir3, readdir as readdir2, readFile as readFile3, stat as stat2, writeFile as writeFile2 } from "node:fs/promises";
import path4 from "node:path";
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
      if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) continue;
      snapshot[key] = env[key] ?? "";
    }
  }
  return snapshot;
}
async function writeCapture(event, stdinRaw) {
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
  const dir = path4.join(resolveDataDir(), "probe");
  await mkdir3(dir, { recursive: true });
  const stamp = record2.capturedAt.replace(/[:.]/g, "-");
  const file = path4.join(dir, `${stamp}-${sanitizeEventName(event)}-${process.pid}.json`);
  await writeFile2(file, JSON.stringify(record2, null, 2) + "\n", { encoding: "utf8", mode: 384 });
  process.stderr.write(`fast-jev probe: captured ${event} -> ${file}
`);
  return file;
}
async function record(event) {
  const stdinRaw = await readStdin();
  await writeCapture(event, stdinRaw);
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
      raw = await readFile3(file, "utf8");
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
    process.stdout.write(`=== ${path4.basename(file)} ===
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
        const info = await stat2(transcriptPath);
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
  const dir = path4.join(resolveDataDir(), "probe");
  let entries;
  try {
    entries = await readdir2(dir);
  } catch {
    process.stdout.write("(no probe captures yet)\n");
    return 0;
  }
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const full = path4.join(dir, entry);
    const size = await stat2(full).then((info) => info.size).catch(() => 0);
    process.stdout.write(`${entry}  (${size} bytes)
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
var ENV_KEYS;
var init_probe = __esm({
  "src/probe.ts"() {
    "use strict";
    init_config();
    init_stdin();
    ENV_KEYS = [
      "PLUGIN_ROOT",
      "CLAUDE_PLUGIN_ROOT",
      "PLUGIN_DATA",
      "CLAUDE_PLUGIN_DATA",
      "CODEX_HOME",
      "HOME",
      "PATH"
    ];
  }
});

// src/cli.ts
init_config();
import { pathToFileURL } from "node:url";

// src/hooks/outcome.ts
function wirePayload(outcome) {
  const { note: _note, ...wire } = outcome;
  return wire;
}

// src/hooks/pre-compact.ts
import { stat } from "node:fs/promises";

// src/archive.ts
import { mkdir, readdir, readFile as readFile2, rename, rm, writeFile } from "node:fs/promises";
import path2 from "node:path";
var ARCHIVE_VERSION = 1;
var FILE_MODE = 384;
function archiveDirFor(dataDir, transcriptPath) {
  return path2.join(dataDir, "decisions", path2.basename(transcriptPath));
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function isAction(value) {
  return value === "keep" || value === "drop_result" || value === "drop_call";
}
function parseItem(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const record2 = raw;
  if (typeof record2["callId"] !== "string" || record2["callId"] === "") return null;
  if (record2["kind"] !== "function_call" && record2["kind"] !== "custom_tool_call") return null;
  if (typeof record2["name"] !== "string") return null;
  if (typeof record2["argumentsJson"] !== "string") return null;
  if (typeof record2["outputText"] !== "string") return null;
  if (!isFiniteNumber(record2["outputChars"])) return null;
  if (!isFiniteNumber(record2["callOrdinal"]) || !isFiniteNumber(record2["resultOrdinal"])) return null;
  if (!isFiniteNumber(record2["keepCall"]) || !isFiniteNumber(record2["keepResult"])) return null;
  if (!isAction(record2["action"])) return null;
  if (typeof record2["pinned"] !== "boolean") return null;
  return {
    callId: record2["callId"],
    kind: record2["kind"],
    name: record2["name"],
    argumentsJson: record2["argumentsJson"],
    outputText: record2["outputText"],
    outputChars: record2["outputChars"],
    isError: record2["isError"] === true,
    callOrdinal: record2["callOrdinal"],
    resultOrdinal: record2["resultOrdinal"],
    keepCall: record2["keepCall"],
    keepResult: record2["keepResult"],
    action: record2["action"],
    pinned: record2["pinned"]
  };
}
function parseArchive(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record2 = parsed;
  if (record2["version"] !== ARCHIVE_VERSION) return null;
  if (typeof record2["sessionId"] !== "string") return null;
  if (typeof record2["transcriptPath"] !== "string") return null;
  if (typeof record2["scoredAt"] !== "string" || Number.isNaN(Date.parse(record2["scoredAt"]))) return null;
  if (!Array.isArray(record2["items"])) return null;
  const items = [];
  for (const raw of record2["items"]) {
    const item = parseItem(raw);
    if (item === null) return null;
    items.push(item);
  }
  return {
    version: ARCHIVE_VERSION,
    sessionId: record2["sessionId"],
    turnId: typeof record2["turnId"] === "string" ? record2["turnId"] : void 0,
    trigger: record2["trigger"] === "auto" ? "auto" : "manual",
    transcriptPath: record2["transcriptPath"],
    transcriptBytesAtScore: isFiniteNumber(record2["transcriptBytesAtScore"]) ? record2["transcriptBytesAtScore"] : 0,
    scoredAt: record2["scoredAt"],
    model: typeof record2["model"] === "string" ? record2["model"] : "",
    stateStage: typeof record2["stateStage"] === "string" ? record2["stateStage"] : "",
    config: {
      keepThreshold: isFiniteNumber(record2["keepThreshold"]) ? record2["keepThreshold"] : 0.5,
      preserveRecentItems: isFiniteNumber(record2["preserveRecentItems"]) ? record2["preserveRecentItems"] : 8
    },
    items
  };
}
async function writeArchive(dataDir, archive) {
  const dir = archiveDirFor(dataDir, archive.transcriptPath);
  await mkdir(dir, { recursive: true });
  const stamp = archive.scoredAt.replace(/[:.]/g, "-");
  const finalPath = path2.join(dir, `${stamp}-${process.pid}.json`);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(archive, null, 2) + "\n", { encoding: "utf8", mode: FILE_MODE });
  await rename(tmpPath, finalPath);
  return finalPath;
}
function isFresh(archive, ttlHours, now) {
  const scoredAt = Date.parse(archive.scoredAt);
  if (Number.isNaN(scoredAt)) return false;
  return now - scoredAt <= ttlHours * 36e5;
}
async function listArchiveFiles(dataDir, transcriptPath) {
  const candidates = [];
  const collect = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path2.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".json")) candidates.push(full);
    }
  };
  await collect(archiveDirFor(dataDir, transcriptPath));
  const root = path2.join(dataDir, "decisions");
  const dirEntries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of dirEntries) {
    if (entry.isDirectory()) await collect(path2.join(root, entry.name));
  }
  return [...new Set(candidates)];
}
async function findLatestArchive(dataDir, sessionId, transcriptPath, ttlHours, now = Date.now()) {
  let best = null;
  for (const candidate of await listArchiveFiles(dataDir, transcriptPath)) {
    const archive = parseArchive(await readFile2(candidate, "utf8").catch(() => ""));
    if (archive === null || !isFresh(archive, ttlHours, now)) continue;
    const sameTranscript = archive.transcriptPath === transcriptPath;
    const sameSession = archive.sessionId === sessionId && sessionId !== "unknown" && archive.sessionId !== "unknown";
    if (!sameTranscript && !sameSession) continue;
    if (await isConsumed(candidate)) continue;
    if (best !== null) {
      const bestTier = best.archive.transcriptPath === transcriptPath ? 1 : 0;
      const candidateTier = sameTranscript ? 1 : 0;
      if (candidateTier < bestTier) continue;
      if (candidateTier === bestTier && Date.parse(archive.scoredAt) <= Date.parse(best.archive.scoredAt))
        continue;
    }
    best = { archive, path: candidate };
  }
  return best;
}
async function isConsumed(archivePath) {
  return readFile2(`${archivePath}.consumed`).then(
    () => true,
    () => false
  );
}
async function claimArchive(archivePath) {
  try {
    await writeFile(`${archivePath}.consumed`, `${(/* @__PURE__ */ new Date()).toISOString()}
`, {
      encoding: "utf8",
      mode: FILE_MODE,
      flag: "wx"
    });
    return true;
  } catch (error) {
    return error.code !== "EEXIST";
  }
}
async function cleanupExpired(dataDir, ttlHours, now = Date.now()) {
  const root = path2.join(dataDir, "decisions");
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = path2.join(root, entry.name);
    const files = await readdir(dir).catch(() => []);
    for (const file of files) {
      const full = path2.join(dir, file);
      if (file.includes(".tmp-")) {
        await rm(full, { force: true }).catch(() => void 0);
        continue;
      }
      if (file.endsWith(".consumed")) {
        if (!files.includes(file.replace(/\.consumed$/, ".json"))) {
          await rm(full, { force: true }).catch(() => void 0);
        }
        continue;
      }
      if (!file.endsWith(".json")) continue;
      const archive = parseArchive(await readFile2(full, "utf8").catch(() => ""));
      if (archive !== null && !isFresh(archive, ttlHours, now)) {
        await rm(full, { force: true }).catch(() => void 0);
        await rm(`${full}.consumed`, { force: true }).catch(() => void 0);
      }
    }
  }
}

// src/hooks/pre-compact.ts
init_config();

// src/ir.ts
function effectiveHistory(transcript) {
  const last = transcript.segments[transcript.segments.length - 1];
  return last === void 0 ? [] : last.items;
}
function liveItems(transcript) {
  const last = transcript.segments[transcript.segments.length - 1];
  if (last === void 0) return [];
  const compactedAt = transcript.lastCompacted?.ordinal ?? Number.NEGATIVE_INFINITY;
  return last.items.filter((stamped) => stamped.ordinal > compactedAt);
}
function recentOrdinals(items, count) {
  const pinned = /* @__PURE__ */ new Set();
  for (let index = Math.max(0, items.length - count); index < items.length; index += 1) {
    const ordinal = items[index]?.ordinal;
    if (ordinal !== void 0) pinned.add(ordinal);
  }
  return pinned;
}
function itemText(item) {
  switch (item.kind) {
    case "message":
      return item.contents.map((part) => part.text).join("\n");
    case "function_call":
      return `${item.name} ${item.argumentsJson}`;
    case "function_call_output":
    case "custom_tool_call_output":
      return item.outputs.map((part) => part.text).filter((text) => text !== "").join("\n");
    case "custom_tool_call":
      return item.input;
    case "reasoning":
      return "";
    case "other":
      return item.text;
  }
}

// src/rollout/calls.ts
function isCallKind(item) {
  return item.kind === "function_call" || item.kind === "custom_tool_call";
}
function isOutputKind(item) {
  return item.kind === "function_call_output" || item.kind === "custom_tool_call_output";
}
function pairToolCalls(items) {
  const pending = /* @__PURE__ */ new Map();
  const observations = [];
  for (const { ordinal, item } of items) {
    if (isCallKind(item)) {
      if (!pending.has(item.callId)) {
        pending.set(item.callId, {
          kind: item.kind,
          name: item.name,
          argumentsJson: item.kind === "function_call" ? item.argumentsJson : item.input,
          callOrdinal: ordinal
        });
      }
      continue;
    }
    if (isOutputKind(item)) {
      const call = pending.get(item.callId);
      if (call === void 0) continue;
      pending.delete(item.callId);
      const outputText = itemText(item);
      observations.push({
        callId: item.callId,
        kind: call.kind,
        name: call.name,
        argumentsJson: call.argumentsJson,
        outputText,
        outputChars: outputText.length,
        isError: detectError(outputText),
        callOrdinal: call.callOrdinal,
        resultOrdinal: ordinal
      });
    }
  }
  return observations;
}
var NONZERO_EXIT_PATTERNS = [
  /"exit_code"\s*:\s*-?[1-9]\d*/i,
  /\bexit code\s*[:=]\s*-?[1-9]\d*/i
];
function detectError(outputText) {
  return NONZERO_EXIT_PATTERNS.some((pattern) => pattern.test(outputText));
}

// src/rollout/items.ts
var MESSAGE_ROLES = ["user", "assistant", "developer"];
var MAX_OTHER_TEXT = 2e3;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asText(value) {
  return typeof value === "string" ? value : "";
}
function normalizeContent(value) {
  if (typeof value === "string") {
    return value === "" ? [] : [{ type: "input_text", text: value }];
  }
  const entries = Array.isArray(value) ? value : isRecord(value) ? [value] : [];
  const parts = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      parts.push({ type: "input_text", text: entry });
    } else if (isRecord(entry)) {
      parts.push({ type: asText(entry["type"]) || "text", text: asText(entry["text"]) });
    }
  }
  return parts;
}
function narrowItem(payload) {
  if (!isRecord(payload)) {
    return { kind: "other", payloadType: "non-object", text: JSON.stringify(payload) ?? "" };
  }
  switch (payload["type"]) {
    case "message": {
      const role = asText(payload["role"]);
      if (!MESSAGE_ROLES.includes(role)) {
        return other(payload);
      }
      return {
        kind: "message",
        role,
        contents: normalizeContent(payload["content"])
      };
    }
    case "function_call":
      return {
        kind: "function_call",
        callId: asText(payload["call_id"]),
        name: asText(payload["name"]),
        argumentsJson: typeof payload["arguments"] === "string" ? payload["arguments"] : JSON.stringify(payload["arguments"] ?? null)
      };
    case "function_call_output":
      return {
        kind: "function_call_output",
        callId: asText(payload["call_id"]),
        outputs: normalizeContent(payload["output"])
      };
    case "custom_tool_call":
      return {
        kind: "custom_tool_call",
        callId: asText(payload["call_id"]),
        name: asText(payload["name"]),
        input: typeof payload["input"] === "string" ? payload["input"] : JSON.stringify(payload["input"] ?? null),
        status: typeof payload["status"] === "string" ? payload["status"] : void 0
      };
    case "custom_tool_call_output":
      return {
        kind: "custom_tool_call_output",
        callId: asText(payload["call_id"]),
        outputs: normalizeContent(payload["output"])
      };
    case "reasoning":
      return {
        kind: "reasoning",
        id: typeof payload["id"] === "string" ? payload["id"] : void 0
      };
    default:
      return other(payload);
  }
}
function other(payload) {
  return {
    kind: "other",
    payloadType: asText(payload["type"]) || "unknown",
    text: (JSON.stringify(payload) ?? "").slice(0, MAX_OTHER_TEXT)
  };
}

// src/rollout/parse.ts
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
function initialState() {
  return {
    meta: {},
    segments: [],
    current: [],
    currentStart: 1,
    currentIsLive: true,
    lastCompacted: void 0,
    lines: 0,
    parsedItems: 0,
    skippedLines: 0,
    compactions: 0
  };
}
var IGNORED_LINE_TYPES = /* @__PURE__ */ new Set([
  "event_msg",
  "token_usage_record",
  "turn_context",
  "world_state"
]);
async function parseTranscriptFile(path5) {
  const state = initialState();
  const reader = createInterface({
    input: createReadStream(path5, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line of reader) consumeLine(state, line);
  closeSegment(state);
  return { transcript: finalize(state), stats: statsOf(state) };
}
function consumeLine(state, line) {
  state.lines += 1;
  if (line.trim() === "") return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    state.skippedLines += 1;
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    state.skippedLines += 1;
    return;
  }
  const record2 = parsed;
  if (record2["type"] === "session_meta") {
    state.meta = readMeta(record2["payload"]);
    return;
  }
  if (IGNORED_LINE_TYPES.has(String(record2["type"]))) return;
  if (record2["type"] === "compacted") {
    consumeCompacted(state, state.lines, record2["payload"]);
    return;
  }
  if (record2["type"] !== "response_item") {
    state.skippedLines += 1;
    return;
  }
  appendItem(state, state.lines, narrowItem(record2["payload"]));
}
function consumeCompacted(state, ordinal, payload) {
  state.compactions += 1;
  closeSegment(state);
  const record2 = typeof payload === "object" && payload !== null ? payload : {};
  state.lastCompacted = {
    ordinal,
    windowId: typeof record2["window_id"] === "string" ? record2["window_id"] : void 0,
    message: typeof record2["message"] === "string" ? record2["message"] : ""
  };
  state.currentStart = ordinal;
  state.currentIsLive = false;
  const history = Array.isArray(record2["replacement_history"]) ? record2["replacement_history"] : [];
  for (const entry of history) appendItem(state, ordinal, narrowItem(entry));
}
function appendItem(state, ordinal, item) {
  if (state.current.length === 0) state.currentStart = ordinal;
  state.current.push({ ordinal, item });
  state.parsedItems += 1;
}
function closeSegment(state) {
  if (state.current.length === 0) return;
  state.segments = [
    ...state.segments,
    {
      items: [...state.current],
      firstOrdinal: state.currentStart,
      survivorPrefix: !state.currentIsLive
    }
  ];
  state.current = [];
  state.currentIsLive = true;
}
function readMeta(payload) {
  if (typeof payload !== "object" || payload === null) return {};
  const record2 = payload;
  return {
    sessionId: typeof record2["session_id"] === "string" ? record2["session_id"] : typeof record2["id"] === "string" ? record2["id"] : void 0,
    cwd: typeof record2["cwd"] === "string" ? record2["cwd"] : void 0
  };
}
function statsOf(state) {
  return {
    lines: state.lines,
    parsedItems: state.parsedItems,
    skippedLines: state.skippedLines,
    compactions: state.compactions
  };
}
function finalize(state) {
  return {
    meta: state.meta,
    segments: state.segments,
    lastCompacted: state.lastCompacted
  };
}

// src/log.ts
import { appendFile, mkdir as mkdir2 } from "node:fs/promises";
import path3 from "node:path";
async function appendLog(dataDir, entry) {
  try {
    const dir = path3.join(dataDir, "log");
    await mkdir2(dir, { recursive: true });
    const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), pid: process.pid, ...entry });
    await appendFile(path3.join(dir, "fast-jev.log"), line + "\n", { encoding: "utf8", mode: 384 });
  } catch {
  }
}

// src/jev/request.ts
init_types();
function buildJevRequest(params, state, questions) {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ model: params.model ?? DEFAULT_JEV_MODEL, state, questions })
  };
}
function parseJevResponse(status, ok, text) {
  if (!ok) throw new Error(`jev: HTTP ${status}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("jev: response is not JSON");
  }
  const answers = parsed?.["answers"];
  if (typeof answers !== "object" || answers === null) {
    throw new Error("jev: response has no answers object");
  }
  return { answers };
}
function noulAnswer(response, name) {
  const answer = response.answers[name];
  if (answer === void 0) return void 0;
  const value = answer["noul"];
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}

// src/jev/client.ts
var DEFAULT_TIMEOUT_MS = 6e4;
var DEFAULT_RETRIES = 1;
var DEFAULT_RETRY_BACKOFF_MS = 2e3;
function isRetryable(status) {
  return status === 429 || status >= 500;
}
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var JevClient = class {
  options;
  constructor(options = {}) {
    this.options = options;
  }
  apiKey() {
    const key = this.options.apiKey ?? process.env["TYPESAFE_API_KEY"];
    if (key === void 0 || key.trim() === "") {
      throw new Error("TYPESAFE_API_KEY is not configured");
    }
    return key;
  }
  async ask(state, questions) {
    const request = buildJevRequest(
      { apiKey: this.apiKey(), model: this.options.model, baseUrl: this.options.baseUrl },
      state,
      questions
    );
    const doFetch = this.options.fetchImpl ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = this.options.retries ?? DEFAULT_RETRIES;
    const backoffMs = this.options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    let lastError = new Error("jev: request never ran");
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let status;
      let ok;
      let text;
      try {
        const response = await doFetch(request.url, {
          method: request.method,
          headers: { ...request.headers },
          body: request.body,
          signal: controller.signal
        });
        status = response.status;
        ok = response.ok;
        text = await response.text();
      } catch (error) {
        lastError = error;
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (ok) return parseJevResponse(status, true, text);
      if (!isRetryable(status)) return parseJevResponse(status, false, text);
      lastError = new Error(`jev: HTTP ${status}`);
    }
    throw lastError;
  }
};

// src/jev/questions.ts
var PER_CALL_QUESTION_TOKENS = 48;
var REQUEST_OVERHEAD_TOKENS = 64;
function questionsFor(call) {
  return {
    [`call_${call.callId}`]: {
      type: "noul",
      instructions: `Tool call ${call.name} (${call.callId}) should stay in the history: knowing this call was made, with its input ${call.argumentsJson.slice(0, 200)}, still matters for what comes next`,
      criteria: { true: "still matters", false: "droppable together with its output" }
    },
    [`result_${call.callId}`]: {
      type: "noul",
      instructions: `The full output of the ${call.name} call (${call.callId}, ${call.outputChars} chars) should stay in the history verbatim: its contents are still needed and re-running the tool would not reproduce them`,
      criteria: { true: "needed verbatim", false: "droppable, re-running can recover it" }
    }
  };
}
function batchCalls(calls, stateTokenCount, maxRequestTokens) {
  if (calls.length === 0) return [];
  const budget = maxRequestTokens - stateTokenCount - REQUEST_OVERHEAD_TOKENS;
  const perBatch = Math.max(1, Math.floor(budget / PER_CALL_QUESTION_TOKENS));
  const batches = [];
  for (let index = 0; index < calls.length; index += perBatch) {
    batches.push(calls.slice(index, index + perBatch));
  }
  return batches;
}

// src/text.ts
var ELLIPSIS = "\u2026";
function cap(text, maxChars) {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + ELLIPSIS;
}
function headTail(text, maxChars) {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${text.slice(0, head)}${ELLIPSIS}[${text.length - maxChars} chars omitted]${text.slice(text.length - tail)}`;
}

// src/jev/state.ts
var STATE_CONTEXT = "A coding session is being compacted to free context. `history` lists the conversation oldest first; tool outputs are replaced by short notes and long texts may be shortened. Each question asks whether one tool call \u2014 or that call\u2019s full output \u2014 still needs to remain available verbatim. Whatever is dropped is gone permanently, though the assistant can re-run tools or re-read files.";
var STAGE_INPUT_LIMITS = [
  { stage: "inputs-1000", maxInputChars: 1e3 },
  { stage: "inputs-200", maxInputChars: 200 },
  { stage: "inputs-60", maxInputChars: 60 }
];
var ABRIDGED_TEXT_CHARS = 400;
var COLLAPSED_TEXT_CHARS = 80;
function estimateTokens(text) {
  let wide = 0;
  let letters = 0;
  let digits = 0;
  let other2 = 0;
  for (const char of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char)) wide += 1;
    else if (/[A-Za-z]/.test(char)) letters += 1;
    else if (/[0-9]/.test(char)) digits += 1;
    else other2 += 1;
  }
  return Math.ceil(wide + letters / 6 + digits / 2 + other2 * 0.9);
}
function stateTokens(state) {
  return estimateTokens(JSON.stringify(state));
}
function goalFromItems(items) {
  const prompts = [];
  for (let index = items.length - 1; index >= 0 && prompts.length < 3; index -= 1) {
    const stamped = items[index];
    const item = stamped?.item;
    if (item === void 0 || item.kind !== "message" || item.role !== "user") continue;
    const text = itemText(item).trim();
    if (text === "") continue;
    prompts.unshift(text.slice(0, 500));
  }
  return prompts.join("\n---\n");
}
function buildState(items, goal) {
  const history = [];
  for (const { ordinal, item } of items) {
    switch (item.kind) {
      case "message":
      case "other":
        history.push({
          i: ordinal,
          role: item.kind === "message" ? item.role : "developer",
          text: itemText(item)
        });
        break;
      case "function_call":
      case "custom_tool_call":
        history.push({
          i: ordinal,
          role: "assistant",
          text: "",
          call: {
            id: item.callId,
            name: item.name,
            input: item.kind === "function_call" ? item.argumentsJson : item.input
          }
        });
        break;
      case "function_call_output":
      case "custom_tool_call_output": {
        const text = itemText(item);
        history.push({
          i: ordinal,
          role: "tool",
          text: `output present, ${text.length} chars (omitted)`,
          result: { id: item.callId, chars: text.length }
        });
        break;
      }
      case "reasoning":
        break;
    }
  }
  return {
    context: STATE_CONTEXT,
    goal: goal ?? goalFromItems(items),
    history
  };
}
function transform(state, pinned, mutate) {
  return { ...state, history: state.history.map((entry) => pinned.has(entry.i) ? entry : mutate(entry)) };
}
function fitState(items, options) {
  const pinned = recentOrdinals(items, options.preserveRecentItems);
  let stage = "full";
  let state = buildState(items);
  const overBudget = () => stateTokens(state) > options.maxStateTokens;
  for (const { stage: nextStage, maxInputChars } of STAGE_INPUT_LIMITS) {
    if (!overBudget()) return { state, stage };
    stage = nextStage;
    state = transform(
      state,
      pinned,
      (entry) => entry.call === void 0 ? entry : { ...entry, call: { ...entry.call, input: cap(entry.call.input, maxInputChars) } }
    );
  }
  if (overBudget()) {
    stage = "texts-abridged";
    state = transform(
      state,
      pinned,
      (entry) => entry.text.length <= ABRIDGED_TEXT_CHARS ? entry : { ...entry, text: headTail(entry.text, ABRIDGED_TEXT_CHARS) }
    );
  }
  if (overBudget()) {
    stage = "old-collapsed";
    state = transform(
      state,
      pinned,
      (entry) => entry.call !== void 0 || entry.result !== void 0 || entry.text.length <= COLLAPSED_TEXT_CHARS ? entry : { ...entry, text: cap(entry.text, COLLAPSED_TEXT_CHARS) }
    );
  }
  if (overBudget()) {
    stage = "old-calls-compacted";
    state = transform(state, pinned, (entry) => {
      if (entry.call !== void 0) {
        return { ...entry, text: `called ${entry.call.name} (input omitted)`, call: void 0 };
      }
      if (entry.result !== void 0) {
        return { ...entry, text: `output present, ${entry.result.chars} chars (omitted)` };
      }
      return entry;
    });
  }
  if (overBudget()) {
    stage = "old-dropped";
    state = { ...state, history: state.history.filter((entry) => pinned.has(entry.i) || entry.call !== void 0 || entry.result !== void 0) };
  }
  if (overBudget()) stage = "over-budget";
  return { state, stage };
}

// src/score.ts
var DEFAULT_SCORE_OPTIONS = {
  keepThreshold: 0.5,
  preserveRecentItems: 8,
  maxStateTokens: 25e3,
  maxRequestTokens: 3e4
};
function decideAction(keepCall, keepResult, threshold) {
  if (keepResult >= threshold) return "keep";
  if (keepCall >= threshold) return "drop_result";
  return "drop_call";
}
async function scoreCalls(items, asker, partial) {
  const options = { ...DEFAULT_SCORE_OPTIONS, ...partial };
  const calls = pairToolCalls(items);
  if (calls.length === 0) {
    return { decisions: [], stateStage: "full", requests: 0, failedBatches: 0, asked: false };
  }
  const pinned = recentOrdinals(items, options.preserveRecentItems);
  const isPinned = (call) => pinned.has(call.resultOrdinal);
  const pinnedDecisions = calls.filter(isPinned).map((call) => ({ call, keepCall: 1, keepResult: 1, action: "keep", pinned: true, reason: "pinned" }));
  const candidates = calls.filter((call) => !isPinned(call));
  if (candidates.length === 0) {
    return { decisions: pinnedDecisions, stateStage: "full", requests: 0, failedBatches: 0, asked: false };
  }
  const fitted = fitState(items, {
    maxStateTokens: options.maxStateTokens,
    preserveRecentItems: options.preserveRecentItems
  });
  const tokens = stateTokens(fitted.state);
  const batches = batchCalls(candidates, tokens, options.maxRequestTokens);
  const deadline = options.deadlineMs === void 0 ? void 0 : Date.now() + options.deadlineMs;
  let requests = 0;
  let failedBatches = 0;
  const decisions = [];
  for (const batch of batches) {
    if (deadline !== void 0 && Date.now() > deadline) {
      failedBatches += 1;
      decisions.push(...batch.map((call) => unanswered(call)));
      continue;
    }
    requests += 1;
    const scored = await scoreBatch(batch, fitted.state, asker, options.keepThreshold);
    if (scored === null) failedBatches += 1;
    decisions.push(...scored ?? batch.map(unanswered));
  }
  return {
    decisions: [...pinnedDecisions, ...decisions],
    stateStage: fitted.stage,
    requests,
    failedBatches,
    asked: true
  };
}
function unanswered(call) {
  return { call, keepCall: 1, keepResult: 1, action: "keep", pinned: false, reason: "unanswered" };
}
async function scoreBatch(batch, state, asker, threshold) {
  const questions = batch.reduce(
    (all, call) => ({ ...all, ...questionsFor(call) }),
    {}
  );
  try {
    const response = await asker.ask(state, questions);
    return batch.map((call) => {
      const keepCall = noulAnswer(response, `call_${call.callId}`) ?? 1;
      const keepResult = noulAnswer(response, `result_${call.callId}`) ?? 1;
      return {
        call,
        keepCall,
        keepResult,
        action: decideAction(keepCall, keepResult, threshold),
        pinned: false,
        reason: noulAnswer(response, `call_${call.callId}`) === void 0 ? "unanswered" : "scored"
      };
    });
  } catch {
    return null;
  }
}

// src/hooks/pre-compact.ts
function decodeTrigger(value) {
  return value === "auto" ? "auto" : "manual";
}
function parsePreCompactInput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record2 = parsed;
  const transcriptPath = record2["transcript_path"];
  if (typeof transcriptPath !== "string" || transcriptPath === "") return null;
  return {
    sessionId: typeof record2["session_id"] === "string" ? record2["session_id"] : "unknown",
    turnId: typeof record2["turn_id"] === "string" ? record2["turn_id"] : void 0,
    trigger: decodeTrigger(record2["trigger"]),
    transcriptPath
  };
}
async function runPreCompact(input, config, env = process.env, asker) {
  const { transcript, stats } = await parseTranscriptFile(input.transcriptPath);
  const items = liveItems(transcript);
  const transport = asker ?? (config.apiKey === null ? null : new JevClient({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl ?? void 0,
    timeoutMs: config.jevRequestTimeoutMs
  }));
  if (transport === null) {
    return {
      continue: true,
      note: "fast-jev: TYPESAFE_API_KEY not configured; letting built-in compaction proceed"
    };
  }
  if (items.length === 0) {
    return { continue: true, note: "fast-jev: nothing new to score" };
  }
  const bytesAtScore = await stat(input.transcriptPath).then((info) => info.size).catch(() => 0);
  const scored = await scoreCalls(items, transport, {
    keepThreshold: config.keepThreshold,
    preserveRecentItems: config.preserveRecentItems,
    maxStateTokens: config.maxStateTokens,
    maxRequestTokens: config.maxRequestTokens,
    deadlineMs: config.jevDeadlineMs
  });
  const archivedItems = scored.decisions.map((decision) => ({
    callId: decision.call.callId,
    kind: decision.call.kind,
    name: decision.call.name,
    argumentsJson: decision.call.argumentsJson,
    outputText: decision.call.outputText,
    outputChars: decision.call.outputChars,
    isError: decision.call.isError,
    callOrdinal: decision.call.callOrdinal,
    resultOrdinal: decision.call.resultOrdinal,
    keepCall: decision.keepCall,
    keepResult: decision.keepResult,
    action: decision.action,
    pinned: decision.pinned
  }));
  const archive = {
    version: 1,
    sessionId: input.sessionId,
    turnId: input.turnId,
    trigger: input.trigger,
    transcriptPath: input.transcriptPath,
    transcriptBytesAtScore: bytesAtScore,
    scoredAt: (/* @__PURE__ */ new Date()).toISOString(),
    model: config.model,
    stateStage: scored.stateStage,
    config: { keepThreshold: config.keepThreshold, preserveRecentItems: config.preserveRecentItems },
    items: archivedItems
  };
  const dataDir = resolveDataDir(config, env);
  void appendLog(dataDir, {
    event: "pre-compact",
    phase: "scored",
    trigger: input.trigger,
    calls: archive.items.length,
    stateStage: scored.stateStage,
    failedBatches: scored.failedBatches,
    liveItems: items.length,
    dataDirBasis: "PLUGIN_DATA" in env ? "plugin-data" : "codex-home"
  });
  const archivePath = await writeArchive(dataDir, archive);
  void cleanupExpired(dataDir, config.archiveTtlHours).catch(() => void 0);
  const keeps = archive.items.filter((item) => item.action === "keep").length;
  const resultDrops = archive.items.filter((item) => item.action === "drop_result").length;
  const callDrops = archive.items.filter((item) => item.action === "drop_call").length;
  void archivePath;
  const failedNote = scored.failedBatches > 0 ? `; ${scored.failedBatches} batch(es) unanswered` : "";
  return {
    continue: true,
    systemMessage: `fast-jev: scored ${archive.items.length} tool calls (${keeps} keep / ${resultDrops} result-drop / ${callDrops} call-drop) over ${items.length} live items` + failedNote
  };
}

// src/backfill.ts
import { createHash } from "node:crypto";
var FINGERPRINT_HEAD = 200;
function fingerprint(text) {
  return createHash("sha256").update(text).digest("hex");
}
function indexHistory(history) {
  const callIds = /* @__PURE__ */ new Set();
  for (const { item } of history) {
    if (item.kind === "function_call" || item.kind === "custom_tool_call") callIds.add(item.callId);
  }
  const texts = history.map(({ item }) => itemText(item));
  return { callIds, texts, hashes: new Set(texts.map(fingerprint)) };
}
function textInHistory(needle, index) {
  if (needle === "") return true;
  if (index.hashes.has(fingerprint(needle))) return true;
  if (needle.length >= FINGERPRINT_HEAD) {
    const head = needle.slice(0, FINGERPRINT_HEAD);
    return index.texts.some((text) => text.includes(head));
  }
  return false;
}
function membershipIn(item, index) {
  if (index.callIds.has(item.callId)) return "present_by_call_id";
  return textInHistory(item.outputText, index) ? "present_by_fingerprint" : "missing";
}
function collectCandidates(archive, history, noteChars) {
  const index = indexHistory(history);
  const candidates = [];
  for (const item of archive.items) {
    if (item.action === "drop_call") continue;
    if (membershipIn(item, index) !== "missing") continue;
    if (item.action === "keep") {
      candidates.push({
        item,
        reason: "verbatim_missing",
        content: item.outputText,
        score: Math.max(item.keepResult, item.keepCall)
      });
    } else {
      const input = item.argumentsJson.slice(0, Math.max(0, noteChars));
      candidates.push({
        item,
        reason: "call_note",
        content: input,
        score: item.keepCall
      });
    }
  }
  return candidates;
}
function rankAndFit(candidates, maxTotalChars, perItemChars) {
  const ranked = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.reason !== b.reason) return a.reason === "call_note" ? -1 : 1;
    return a.content.length - b.content.length;
  });
  const fitted = [];
  let used = 0;
  for (const candidate of ranked) {
    const content = headTail(candidate.content, perItemChars);
    if (used + content.length > maxTotalChars) continue;
    fitted.push({ ...candidate, content });
    used += content.length;
  }
  return fitted;
}
function buildAdditionalContext(candidates, droppedCount) {
  const shown = candidates.length;
  const intro = `<fast-jev-compaction: the built-in summary lost ${droppedCount} tool result(s) that were scored as still required; showing ${shown}. Verbatim content follows; treat it as part of the earlier conversation.>`;
  const lines = [intro];
  candidates.forEach((candidate, index) => {
    const { item } = candidate;
    const label = `[${index + 1}] tool ${item.name} (call ${item.callId}, score ${candidate.score.toFixed(2)})`;
    if (candidate.reason === "call_note") {
      lines.push(
        label,
        `    input: ${candidate.content}`,
        "    output was dropped intentionally; re-run the tool if needed"
      );
      return;
    }
    lines.push(label, "    output:", ...candidate.content.split("\n").map((line) => `    ${line}`));
  });
  lines.push("</fast-jev-compaction>");
  return lines.join("\n");
}

// src/hooks/session-start.ts
init_config();
var CALL_NOTE_CHARS = 300;
function parseSessionStartInput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record2 = parsed;
  const sessionId = typeof record2["session_id"] === "string" ? record2["session_id"] : "unknown";
  const source = typeof record2["source"] === "string" ? record2["source"] : "unknown";
  const transcriptPath = typeof record2["transcript_path"] === "string" && record2["transcript_path"] !== "" ? record2["transcript_path"] : void 0;
  return { sessionId, source, transcriptPath };
}
async function runSessionStart(raw, config, env = process.env) {
  const input = parseSessionStartInput(raw);
  if (input === null) {
    return { note: "fast-jev: unrecognized SessionStart payload" };
  }
  const dataDir = resolveDataDir(config, env);
  void appendLog(dataDir, { event: "session-start", phase: "invoked", source: input.source, sessionId: input.sessionId, transcriptPath: input.transcriptPath });
  if (input.source !== "compact") {
    void appendLog(dataDir, { event: "session-start", phase: "skipped", reason: "source not compact" });
    return { note: "fast-jev: session start without compaction; nothing to do" };
  }
  const hit = await findLatestArchive(
    dataDir,
    input.sessionId,
    input.transcriptPath ?? "",
    config.archiveTtlHours
  );
  if (hit === null) {
    void appendLog(dataDir, { event: "session-start", phase: "no-archive", sessionId: input.sessionId });
    return { note: "fast-jev: no fresh archive for this compaction" };
  }
  void appendLog(dataDir, { event: "session-start", phase: "archive-found", path: hit.path, items: hit.archive.items.length });
  let history = [];
  if (input.transcriptPath !== void 0) {
    const { transcript } = await parseTranscriptFile(input.transcriptPath);
    if (transcript.lastCompacted === void 0) {
      void appendLog(dataDir, { event: "session-start", phase: "stale-transcript", path: input.transcriptPath });
      return { note: "fast-jev: transcript has no compaction record yet; skipping to avoid false negatives" };
    }
    history = effectiveHistory(transcript);
  } else {
    history = [];
  }
  const candidates = collectCandidates(hit.archive, history, CALL_NOTE_CHARS);
  void appendLog(dataDir, { event: "session-start", phase: "candidates", count: candidates.length, historyItems: history.length });
  if (candidates.length === 0) {
    await claimArchive(hit.path);
    return { note: "fast-jev: archive processed; the summary kept everything that mattered" };
  }
  const fitted = rankAndFit(candidates, config.maxBackfillChars, config.perItemChars);
  if (fitted.length === 0) {
    await claimArchive(hit.path);
    return { note: "fast-jev: backfill candidates exceeded the character budget" };
  }
  const outcome = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: buildAdditionalContext(fitted, candidates.length)
    }
  };
  const claimed = await claimArchive(hit.path);
  void appendLog(dataDir, { event: "session-start", phase: "backfill", claimed, shown: fitted.length, dropped: candidates.length });
  return outcome;
}

// src/cli.ts
init_probe();
init_stdin();
function isHookEvent(value) {
  return value === "pre-compact" || value === "session-start";
}
function writeOutcome(outcome) {
  process.stdout.write(JSON.stringify(wirePayload(outcome)) + "\n");
}
async function runHook(event) {
  process.stdout.on("error", () => process.exit(0));
  let raw = "";
  try {
    raw = await readStdin();
  } catch (error) {
    process.stderr.write(`fast-jev: ${event} stdin unreadable: ${String(error)}
`);
    writeOutcome({});
    return 0;
  }
  try {
    if (process.env["FAST_JEV_RECORD"] === "1") {
      await writeCapture(event, raw).catch((error) => {
        process.stderr.write(`fast-jev: probe capture failed: ${String(error)}
`);
      });
    }
    const config = await loadConfig();
    let outcome;
    if (event === "pre-compact") {
      const input = parsePreCompactInput(raw);
      outcome = input === null ? { note: "fast-jev: unrecognized PreCompact payload" } : await runPreCompact(input, config);
    } else {
      outcome = await runSessionStart(raw, config);
    }
    if (outcome.note !== void 0 && config.logLevel !== "silent") {
      process.stderr.write(`${outcome.note}
`);
    }
    writeOutcome(outcome);
    return 0;
  } catch (error) {
    process.stderr.write(`fast-jev: ${event} degraded to no-op: ${String(error)}
`);
    writeOutcome({});
    return 0;
  }
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
    "  fast-jev.mjs probe ls             list captured records"
  ].join("\n");
}
async function main(argv) {
  const [command, ...rest] = argv;
  if (isHookEvent(command)) return runHook(command);
  if (command === "probe") {
    const { runProbe: runProbe2 } = await Promise.resolve().then(() => (init_probe(), probe_exports));
    return runProbe2(rest);
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  process.stderr.write(`${usage()}

unknown command: ${command ?? "(none)"}
`);
  return 0;
}
var entryPath = process.argv[1];
if (entryPath !== void 0 && import.meta.url === pathToFileURL(entryPath).href) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
export {
  main
};
