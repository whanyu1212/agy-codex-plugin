import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { cleanOutput, collectExecEvents, runCodex, runGit, withAbort } from "./codex-command.mjs";

export const defaultSandbox = "read-only";
export const sandboxes = Object.freeze([defaultSandbox, "workspace-write"]);
export const efforts = Object.freeze(["low", "medium", "high"]);
export const minTimeoutMs = 1_000;
export const maxTimeoutMs = 1_800_000;
export const defaultTimeoutMs = 600_000;
export const doctorTimeoutMs = 60_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missingSessionPattern = /(?:no rollout found\b|(?:session|thread|conversation|rollout)\b[^\n]*\b(?:not found|does not exist|missing|expired|ephemeral|unavailable)|no (?:such|recent|recorded|previous|matching) (?:session|thread|conversation)|unknown (?:session|thread)|(?:cannot|failed to) resume\b[^\n]*(?:session|thread)?)/i;

export async function runOperation(run, args, { name, signal, onEvent, timeoutMs }) {
  signal.throwIfAborted();
  const timeout = new AbortController();
  const executionSignal = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => {
    timeout.abort(new Error(`${name} timed out after ${timeoutMs} ms.`));
  }, timeoutMs).unref();
  try {
    const toolArgs = args.cwd === undefined ? args : { ...args, cwd: await validateCwd(args.cwd, executionSignal) };
    const report = onEvent && ((event) => {
      if (!executionSignal.aborted) onEvent(event);
    });
    return await run(toolArgs, executionSignal, report);
  } finally {
    clearTimeout(timer);
  }
}

async function validateCwd(cwd, signal) {
  let canonicalCwd;
  let info;
  try {
    canonicalCwd = await withAbort(signal, () => fs.realpath(cwd));
    info = await withAbort(signal, () => fs.stat(canonicalCwd));
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`Cannot access cwd ${JSON.stringify(cwd)}: ${error.message}`, { cause: error });
  }
  if (!info.isDirectory()) {
    throw new Error(`cwd must be a directory: ${JSON.stringify(cwd)}.`);
  }
  return canonicalCwd;
}

function effortArgs(effort) {
  return effort === undefined ? [] : ["-c", `model_reasoning_effort=${effort}`];
}

function commandOutput({ stdout, stderr }) {
  return cleanOutput(stdout) || cleanOutput(stderr);
}

export async function runReview({ cwd, target = "uncommitted", base, commit, prompt, effort }, signal) {
  if (target !== "base" && base !== undefined) {
    throw new Error("base can only be used when target is base.");
  }
  if (target !== "commit" && commit !== undefined) {
    throw new Error("commit can only be used when target is commit.");
  }
  const ref = { base, commit }[target];
  if (target !== "uncommitted" && ref === undefined) {
    throw new Error(`${target} is required when target is ${target}.`);
  }
  let sha;
  if (ref !== undefined) {
    try {
      const { stdout } = await runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd, signal });
      sha = stdout.trim();
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(`Cannot resolve Git ref ${JSON.stringify(ref)} to a commit. ${error.message}`, { cause: error });
    }
  }
  const args = ["exec", "-s", defaultSandbox, ...effortArgs(effort), "review"];
  if (prompt !== undefined) {
    const header = sha === undefined ? target : `${target} ${sha}`;
    return commandOutput(await runCodex([...args, "-"], { cwd, input: `Target: ${header}\n\n${prompt}`, signal }));
  }
  args.push(`--${target}`);
  if (ref !== undefined) {
    args.push(target === "commit" || ref.startsWith("-") ? sha : ref);
  }
  return commandOutput(await runCodex(args, { cwd, signal }));
}

async function verifyDirectory(candidatePath, signal) {
  if (typeof candidatePath !== "string" || !candidatePath.trim()) {
    return null;
  }
  try {
    const canonical = await withAbort(signal, () => fs.realpath(candidatePath));
    const info = await withAbort(signal, () => fs.stat(canonical));
    return info.isDirectory() ? canonical : null;
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

async function listGitWorktrees(cwd, signal) {
  let stdout;
  try {
    ({ stdout } = await runGit(["worktree", "list", "--porcelain", "-z"], { cwd, signal }));
  } catch {
    signal.throwIfAborted();
    return null;
  }
  const worktrees = [];
  for (const record of stdout.split("\0")) {
    const match = /^worktree ([\s\S]+)$/.exec(record);
    if (!match) {
      continue;
    }
    const rawPath = match[1];
    const canonical = await verifyDirectory(rawPath, signal);
    if (canonical !== null) {
      worktrees.push({ path: canonical, exists: true });
    } else {
      worktrees.push({ path: path.resolve(rawPath), exists: false });
    }
  }
  return { repoRoot: worktrees[0]?.path ?? null, worktrees };
}

function isSameOrChildPath(candidate, parent) {
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const normalizedParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  const rel = path.relative(normalizedParent, normalizedCandidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function findContainingWorktree(cwd, gitInfo) {
  if (!gitInfo) {
    return null;
  }
  for (const entry of gitInfo.worktrees.slice(1)) {
    if (entry.exists && isSameOrChildPath(cwd, entry.path)) {
      return entry.path;
    }
  }
  return null;
}

async function readWorktreeOwner(worktreePath, signal) {
  try {
    const dotGit = await withAbort(signal, () => fs.readFile(path.join(worktreePath, ".git"), "utf8"));
    const match = /^gitdir:[ \t]*([^\r\n]+)$/m.exec(dotGit);
    if (!match) {
      return null;
    }
    const adminDir = path.resolve(worktreePath, match[1].trim());
    const raw = await withAbort(signal, () => fs.readFile(path.join(adminDir, "codex-thread.json"), "utf8"));
    const data = JSON.parse(raw);
    return typeof data?.ownerThreadId === "string" && data.ownerThreadId.trim() ? data.ownerThreadId.trim() : null;
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

async function findOwnedWorktrees(sessionId, gitInfo, signal) {
  if (!sessionId || !gitInfo) {
    return [];
  }
  const target = sessionId.toLowerCase();
  const owned = [];
  for (const entry of gitInfo.worktrees.slice(1)) {
    if (!entry.exists) {
      continue;
    }
    const owner = await readWorktreeOwner(entry.path, signal);
    if (owner && owner.toLowerCase() === target) {
      owned.push(entry.path);
    }
  }
  return owned;
}

const compactUuidPattern = /^[0-9a-f]{32}$/i;

function normalizeUuid(value) {
  if (typeof value !== "string") {
    return null;
  }
  if (uuidPattern.test(value)) {
    return value.toLowerCase();
  }
  if (compactUuidPattern.test(value)) {
    const lower = value.toLowerCase();
    return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
  }
  return null;
}

function resolveCodexHome() {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

function resolveCodexEnv(codexHome, sqliteHome) {
  let env = null;
  if (process.env.CODEX_HOME?.trim()) {
    env ??= { ...process.env };
    env.CODEX_HOME = codexHome;
  }
  if (process.env.CODEX_SQLITE_HOME?.trim()) {
    env ??= { ...process.env };
    env.CODEX_SQLITE_HOME = sqliteHome;
  }
  return env ?? undefined;
}

async function openReadHandle(filePath, signal) {
  signal.throwIfAborted();
  let aborted = false;
  const openPromise = fs.open(filePath, "r");
  const onAbort = () => {
    aborted = true;
    openPromise.then((handle) => handle.close().catch(() => {}), () => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let handle;
  try {
    handle = await withAbort(signal, () => openPromise);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (aborted || signal.aborted) {
    await handle.close().catch(() => {});
    signal.throwIfAborted();
  }
  return handle;
}

const maxRolloutLineBytes = 1024 * 1024;
const rolloutFilenameUuidPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.jsonl(?:\.zst)?$/i;

function extractThreadIdFromFilename(filePath) {
  return rolloutFilenameUuidPattern.exec(filePath)?.[1] ?? null;
}

function createRolloutScanner(onLine) {
  let carry = Buffer.alloc(0);
  let skippingOversized = false;

  return {
    pushChunk(chunk) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        if (skippingOversized) {
          if (newline === -1) {
            return;
          }
          skippingOversized = false;
          carry = Buffer.alloc(0);
          start = newline + 1;
          continue;
        }
        const end = newline === -1 ? chunk.length : newline;
        const segmentLength = carry.length + (end - start);
        if (segmentLength > maxRolloutLineBytes) {
          carry = Buffer.alloc(0);
          if (newline === -1) {
            skippingOversized = true;
            return;
          }
          start = newline + 1;
          continue;
        }
        if (newline !== -1) {
          const lineBuffer = carry.length > 0
            ? Buffer.concat([carry, chunk.subarray(start, newline)])
            : chunk.subarray(start, newline);
          carry = Buffer.alloc(0);
          onLine(lineBuffer.toString("utf8").replace(/\r$/, ""));
          start = newline + 1;
        } else {
          carry = carry.length > 0
            ? Buffer.concat([carry, chunk.subarray(start)])
            : Buffer.from(chunk.subarray(start));
          return;
        }
      }
    },
    finish() {
      if (!skippingOversized && carry.length > 0) {
        onLine(carry.toString("utf8").replace(/\r$/, ""));
      }
      carry = Buffer.alloc(0);
    }
  };
}

async function readRolloutSummary(filePath, signal) {
  let seenMeta = false;
  let metaId = null;
  let metaCwd = null;
  let lastTurnCwd = null;
  let isSubagent = false;
  let modelProvider = null;
  let accountId = null;
  let userId = null;

  const processLine = (line) => {
    if (!line || (!line.includes('"session_meta"') && !line.includes('"turn_context"'))) {
      return;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (entry?.type === "session_meta" && !seenMeta) {
      seenMeta = true;
      const payload = entry.payload;
      if (typeof payload?.id === "string" && payload.id.trim()) {
        metaId = payload.id.trim();
      }
      if (typeof payload?.cwd === "string" && payload.cwd.trim()) {
        metaCwd = payload.cwd;
      }
      isSubagent = Boolean(
        payload?.parent_thread_id
        || payload?.attached_thread_parent_id
        || payload?.attached_thread === true
        || (typeof payload?.source === "object" && payload.source !== null && "subagent" in payload.source)
      );
      if (typeof payload?.model_provider === "string" && payload.model_provider.trim()) {
        modelProvider = payload.model_provider.trim();
      }
      if (payload?.account_scoped) {
        if (typeof payload?.creator_account_id === "string" && payload.creator_account_id.trim()) {
          accountId = payload.creator_account_id.trim();
        }
        if (typeof payload?.creator_user_id === "string" && payload.creator_user_id.trim()) {
          userId = payload.creator_user_id.trim();
        }
      }
    } else if (entry?.type === "turn_context") {
      if (typeof entry.payload?.cwd === "string" && entry.payload.cwd.trim()) {
        lastTurnCwd = entry.payload.cwd;
      }
    }
  };

  if (filePath.endsWith(".jsonl.zst")) {
    if (typeof zlib.createZstdDecompress !== "function") {
      return { id: null, cwd: null, isSubagent: false, modelProvider: null, accountId: null, userId: null };
    }
    const scanner = createRolloutScanner(processLine);
    const source = createReadStream(filePath);
    const decompressor = zlib.createZstdDecompress();
    const abortStreams = () => {
      source.destroy();
      decompressor.destroy();
    };
    signal.addEventListener("abort", abortStreams, { once: true });
    const stream = source.pipe(decompressor);
    source.on("error", (error) => decompressor.destroy(error));
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        scanner.pushChunk(chunk);
      }
      signal.throwIfAborted();
      scanner.finish();
      return { id: metaId, cwd: lastTurnCwd ?? metaCwd, isSubagent, modelProvider, accountId, userId };
    } finally {
      signal.removeEventListener("abort", abortStreams);
      abortStreams();
    }
  }

  let handle;
  try {
    handle = await openReadHandle(filePath, signal);
    const chunkSize = 65_536;
    const buffer = Buffer.allocUnsafe(chunkSize);
    const headScanner = createRolloutScanner(processLine);
    const maxHeadBytes = 512 * 1024;
    let position = 0;

    while (!seenMeta && position < maxHeadBytes) {
      signal.throwIfAborted();
      const toRead = Math.min(chunkSize, maxHeadBytes - position);
      const { bytesRead } = await withAbort(signal, () => handle.read(buffer, 0, toRead, position));
      if (bytesRead === 0) {
        headScanner.finish();
        break;
      }
      position += bytesRead;
      headScanner.pushChunk(buffer.subarray(0, bytesRead));
    }

    const { size } = await withAbort(signal, () => handle.stat());
    let tailEnd = size;
    let tailCarry = Buffer.alloc(0);
    const inspectTailLine = (line) => {
      if (!line || !line.includes('"turn_context"')) {
        return false;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return false;
      }
      if (entry?.type === "turn_context" && typeof entry.payload?.cwd === "string" && entry.payload.cwd.trim()) {
        lastTurnCwd = entry.payload.cwd;
        return true;
      }
      return false;
    };

    lastTurnCwd = null;
    while (tailEnd > 0) {
      signal.throwIfAborted();
      const tailStart = Math.max(0, tailEnd - chunkSize);
      const length = tailEnd - tailStart;
      const { bytesRead } = await withAbort(signal, () => handle.read(buffer, 0, length, tailStart));
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      const combined = tailCarry.length > 0 ? Buffer.concat([chunk, tailCarry]) : chunk;
      let scanFrom = 0;
      if (tailStart > 0) {
        const firstNewline = combined.indexOf(10);
        if (firstNewline === -1) {
          tailCarry = combined.length > maxRolloutLineBytes ? Buffer.alloc(0) : Buffer.from(combined);
          tailEnd = tailStart;
          continue;
        }
        tailCarry = firstNewline > maxRolloutLineBytes ? Buffer.alloc(0) : Buffer.from(combined.subarray(0, firstNewline));
        scanFrom = firstNewline + 1;
      } else {
        tailCarry = Buffer.alloc(0);
      }
      let end = combined.length;
      while (end > scanFrom) {
        const prevNewline = combined.lastIndexOf(10, end - 1);
        const lineStart = prevNewline >= scanFrom ? prevNewline + 1 : scanFrom;
        if (end - lineStart <= maxRolloutLineBytes) {
          const line = combined.subarray(lineStart, end).toString("utf8").replace(/\r$/, "");
          if (inspectTailLine(line)) {
            tailEnd = 0;
            break;
          }
        }
        end = prevNewline >= scanFrom ? prevNewline : scanFrom;
      }
      if (tailEnd === 0) {
        break;
      }
      tailEnd = tailStart;
    }

    return { id: metaId, cwd: lastTurnCwd ?? metaCwd, isSubagent, modelProvider, accountId, userId };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function collectSessionFiles(dir, signal, results = []) {
  let entries;
  try {
    entries = await withAbort(signal, () => fs.readdir(dir, { withFileTypes: true }));
  } catch {
    signal.throwIfAborted();
    return results;
  }
  for (const entry of entries) {
    signal.throwIfAborted();
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(fullPath, signal, results);
    } else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))) {
      try {
        const info = await withAbort(signal, () => fs.stat(fullPath));
        results.push({ filePath: fullPath, mtimeMs: info.mtimeMs });
      } catch {
        signal.throwIfAborted();
      }
    }
  }
  return results;
}

async function listSessionFilesByUpdated(codexHome, signal) {
  const files = await collectSessionFiles(path.join(codexHome, "sessions"), signal);
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || right.filePath.localeCompare(left.filePath));
  return files;
}

let sqliteLoadPromise;

async function loadSqliteDatabaseSync() {
  sqliteLoadPromise ??= (async () => {
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
      const text = typeof warning === "string" ? warning : warning?.message ?? "";
      if (/SQLite/i.test(text)) {
        return;
      }
      return originalEmitWarning.call(process, warning, ...rest);
    };
    try {
      const mod = await import("node:sqlite");
      return typeof mod?.DatabaseSync === "function" ? mod.DatabaseSync : null;
    } catch {
      return null;
    } finally {
      process.emitWarning = originalEmitWarning;
    }
  })();
  return sqliteLoadPromise;
}

function parseTomlQuotedValue(raw) {
  const match = /^(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*(?:#.*)?$/.exec(raw);
  if (!match) {
    return null;
  }
  if (match[1] !== undefined) {
    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1].replace(/\\(.)/g, "$1");
    }
  }
  return match[2];
}

async function readTopLevelTomlString(filePath, key, signal) {
  let content;
  try {
    content = await withAbort(signal, () => fs.readFile(filePath, "utf8"));
  } catch {
    signal.throwIfAborted();
    return null;
  }
  const keyPattern = new RegExp(`^${key}\\s*=\\s*(.+)$`);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      break;
    }
    const match = keyPattern.exec(line);
    if (!match) {
      continue;
    }
    const parsed = parseTomlQuotedValue(match[1].trim());
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

async function readProjectTrustLevels(codexHome, signal) {
  let content;
  try {
    content = await withAbort(signal, () => fs.readFile(path.join(codexHome, "config.toml"), "utf8"));
  } catch {
    signal.throwIfAborted();
    return [];
  }
  const entries = [];
  let currentProject = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      const section = /^\[projects\.(?:"((?:\\.|[^"\\])*)"|'([^']*)')\]$/.exec(line);
      if (section) {
        const rawPath = section[1] !== undefined
          ? parseTomlQuotedValue(`"${section[1]}"`)
          : section[2];
        currentProject = rawPath ? ((await verifyDirectory(rawPath, signal)) ?? path.resolve(rawPath)) : null;
      } else {
        currentProject = null;
      }
      continue;
    }
    if (currentProject) {
      const trustMatch = /^trust_level\s*=\s*(.+)$/.exec(line);
      const trustLevel = trustMatch ? parseTomlQuotedValue(trustMatch[1].trim()) : null;
      if (trustLevel) {
        entries.push({ path: currentProject, trustLevel });
      }
    }
  }
  return entries;
}

function isProjectTrusted(dir, trustEntries) {
  let best = null;
  for (const entry of trustEntries) {
    if (isSameOrChildPath(dir, entry.path) && (!best || entry.path.length > best.path.length)) {
      best = entry;
    }
  }
  return best?.trustLevel === "trusted";
}

async function resolveSqliteHome(codexHome, cwd, signal) {
  const configured = await readTopLevelTomlString(path.join(codexHome, "config.toml"), "sqlite_home", signal);
  if (configured?.trim()) {
    return path.resolve(codexHome, configured.trim());
  }
  const envHome = process.env.CODEX_SQLITE_HOME?.trim();
  if (envHome) {
    return path.resolve(cwd, envHome);
  }
  return codexHome;
}

async function openCodexStateDb(codexHome, cwd, signal) {
  const sqliteHome = await resolveSqliteHome(codexHome, cwd, signal);
  let entries;
  try {
    entries = await withAbort(signal, () => fs.readdir(sqliteHome));
  } catch {
    signal.throwIfAborted();
    return null;
  }
  let bestVersion = -1;
  let bestFile = null;
  for (const name of entries) {
    const match = /^state_(\d+)\.sqlite$/.exec(name);
    if (!match) {
      continue;
    }
    const version = Number(match[1]);
    if (version > bestVersion) {
      bestVersion = version;
      bestFile = path.join(sqliteHome, name);
    }
  }
  if (!bestFile) {
    return null;
  }
  const DatabaseSync = await loadSqliteDatabaseSync();
  signal.throwIfAborted();
  if (!DatabaseSync) {
    return null;
  }
  try {
    return new DatabaseSync(bestFile, { readOnly: true });
  } catch {
    return null;
  }
}

async function readConfiguredProvider(cwd, repoRoot, codexHome, signal) {
  const trustEntries = await readProjectTrustLevels(codexHome, signal);
  let dir = cwd;
  for (;;) {
    if (isProjectTrusted(dir, trustEntries)) {
      const localProvider = await readTopLevelTomlString(path.join(dir, ".codex", "config.toml"), "model_provider", signal);
      if (localProvider?.trim()) {
        return localProvider.trim();
      }
    }
    if (repoRoot && samePath(dir, repoRoot)) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    if (repoRoot && !isSameOrChildPath(parent, repoRoot)) {
      break;
    }
    dir = parent;
  }
  const userProvider = await readTopLevelTomlString(path.join(codexHome, "config.toml"), "model_provider", signal);
  return userProvider?.trim() || "openai";
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function readActiveIdentity(codexHome, signal) {
  let content;
  try {
    content = await withAbort(signal, () => fs.readFile(path.join(codexHome, "auth.json"), "utf8"));
  } catch {
    signal.throwIfAborted();
    return { accountId: null, userId: null };
  }
  try {
    const data = JSON.parse(content);
    const claims = decodeJwtPayload(data?.tokens?.id_token)?.["https://api.openai.com/auth"];
    const rawAccountId = data?.tokens?.account_id ?? data?.account_id ?? claims?.chatgpt_account_id;
    const rawUserId = data?.tokens?.user_id ?? data?.user_id ?? claims?.user_id ?? claims?.chatgpt_user_id;
    return {
      accountId: typeof rawAccountId === "string" && rawAccountId.trim() ? rawAccountId.trim() : null,
      userId: typeof rawUserId === "string" && rawUserId.trim() ? rawUserId.trim() : null
    };
  } catch {
    return { accountId: null, userId: null };
  }
}

async function resolveWorktreeSubdir(wtRoot, cwd, sourceRoot, signal) {
  if (sourceRoot && isSameOrChildPath(cwd, sourceRoot)) {
    const rel = path.relative(sourceRoot, cwd);
    if (rel) {
      const subdir = await verifyDirectory(path.join(wtRoot, rel), signal);
      if (subdir && isSameOrChildPath(subdir, wtRoot)) {
        return subdir;
      }
    }
  }
  return wtRoot;
}

async function resolveRowEffectiveCwd(row, signal) {
  if (typeof row?.rollout_path === "string" && row.rollout_path.trim()) {
    try {
      const summary = await readRolloutSummary(row.rollout_path, signal);
      if (summary.cwd) {
        return (await verifyDirectory(summary.cwd, signal)) ?? path.resolve(summary.cwd);
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  if (typeof row?.cwd === "string" && row.cwd.trim()) {
    return (await verifyDirectory(row.cwd, signal)) ?? path.resolve(row.cwd);
  }
  return null;
}

async function findSessionCwdById(sessionId, cwd, codexHome, signal, { raw = false } = {}) {
  const target = sessionId.toLowerCase();
  const db = await openCodexStateDb(codexHome, cwd, signal);
  if (db) {
    try {
      let row;
      try {
        row = db.prepare("SELECT cwd, rollout_path FROM threads WHERE lower(id) = ?").get(target);
      } catch {
        row = db.prepare("SELECT cwd FROM threads WHERE lower(id) = ?").get(target);
      }
      if (raw) {
        if (typeof row?.rollout_path === "string" && row.rollout_path.trim()) {
          try {
            const summary = await readRolloutSummary(row.rollout_path, signal);
            if (summary.cwd) {
              return summary.cwd;
            }
          } catch {
            signal.throwIfAborted();
          }
        }
        if (typeof row?.cwd === "string" && row.cwd.trim()) {
          return row.cwd;
        }
      }
      const effectiveCwd = await resolveRowEffectiveCwd(row, signal);
      if (effectiveCwd) {
        return await verifyDirectory(effectiveCwd, signal);
      }
    } catch {
      signal.throwIfAborted();
    } finally {
      db.close();
    }
  }
  const files = await listSessionFilesByUpdated(codexHome, signal);
  for (const { filePath } of files) {
    signal.throwIfAborted();
    const filenameUuid = extractThreadIdFromFilename(filePath);
    if (filenameUuid && filenameUuid.toLowerCase() !== target) {
      continue;
    }
    let summary;
    try {
      summary = await readRolloutSummary(filePath, signal);
    } catch {
      signal.throwIfAborted();
      continue;
    }
    if (summary.id && summary.id.toLowerCase() === target && summary.cwd) {
      return raw ? summary.cwd : await verifyDirectory(summary.cwd, signal);
    }
  }
  return null;
}

async function resolveGitAdminWorktreesDir(repoRoot, signal) {
  if (!repoRoot) {
    return null;
  }
  const dotGitPath = path.join(repoRoot, ".git");
  try {
    const stat = await withAbort(signal, () => fs.stat(dotGitPath));
    if (stat.isDirectory()) {
      return path.join(dotGitPath, "worktrees");
    }
    const content = await withAbort(signal, () => fs.readFile(dotGitPath, "utf8"));
    const match = /^gitdir:[ \t]*([^\r\n]+)$/m.exec(content);
    if (match) {
      const common = path.resolve(repoRoot, match[1].trim());
      return path.join(common, "worktrees");
    }
  } catch {
    signal.throwIfAborted();
  }
  return null;
}

async function findMissingOwnedWorktree(sessionId, cwd, gitInfo, codexHome, signal) {
  if (!sessionId) {
    return null;
  }
  const target = sessionId.toLowerCase();
  const worktreesDir = await resolveGitAdminWorktreesDir(gitInfo?.repoRoot, signal);
  if (worktreesDir) {
    let entries = [];
    try {
      entries = await withAbort(signal, () => fs.readdir(worktreesDir, { withFileTypes: true }));
    } catch {
      signal.throwIfAborted();
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const adminDir = path.join(worktreesDir, entry.name);
      try {
        const raw = await withAbort(signal, () => fs.readFile(path.join(adminDir, "codex-thread.json"), "utf8"));
        const data = JSON.parse(raw);
        const owner = typeof data?.ownerThreadId === "string" ? data.ownerThreadId.trim() : "";
        if (!owner || owner.toLowerCase() !== target) {
          continue;
        }
        const gitdirRaw = await withAbort(signal, () => fs.readFile(path.join(adminDir, "gitdir"), "utf8"));
        const wtDotGit = path.resolve(adminDir, gitdirRaw.trim());
        const wtPath = path.dirname(wtDotGit);
        const verifiedWt = await verifyDirectory(wtPath, signal);
        const activeOwner = verifiedWt ? await readWorktreeOwner(verifiedWt, signal) : null;
        if (!activeOwner || activeOwner.toLowerCase() !== target) {
          return wtPath;
        }
      } catch {
        signal.throwIfAborted();
      }
    }
  }
  const rawRecordedCwd = await findSessionCwdById(sessionId, cwd, codexHome, signal, { raw: true });
  if (rawRecordedCwd && !(await verifyDirectory(rawRecordedCwd, signal))) {
    const resolvedRecorded = path.resolve(rawRecordedCwd);
    const canonicalCodexHome = (await verifyDirectory(codexHome, signal)) ?? path.resolve(codexHome);
    const managedRoots = [
      path.join(path.resolve(codexHome), "worktrees"),
      path.join(canonicalCodexHome, "worktrees")
    ];
    if (managedRoots.some((root) => isSameOrChildPath(resolvedRecorded, root))) {
      return rawRecordedCwd;
    }
  }
  return null;
}

async function resolveNamedSession(name, cwd, codexHome, signal) {
  let db = await openCodexStateDb(codexHome, cwd, signal);
  let knownThreadLookup = null;
  try {
    if (db) {
      try {
        let rows;
        try {
          rows = db.prepare(
            "SELECT id, cwd, rollout_path FROM threads WHERE archived = 0 AND (name = ? OR (name IS NULL AND title = ?)) ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC"
          ).all(name, name, name);
        } catch {
          rows = db.prepare(
            "SELECT id, cwd FROM threads WHERE archived = 0 AND name = ? ORDER BY updated_at DESC, id DESC"
          ).all(name);
        }
        for (const row of rows) {
          signal.throwIfAborted();
          if (typeof row?.id === "string" && row.id.trim()) {
            const rowCwd = await resolveRowEffectiveCwd(row, signal);
            if (rowCwd && samePath(rowCwd, cwd)) {
              return row.id.trim();
            }
          }
        }
        let stmt;
        try {
          stmt = db.prepare("SELECT archived, name, title FROM threads WHERE lower(id) = ?");
        } catch {
          stmt = db.prepare("SELECT archived, name FROM threads WHERE lower(id) = ?");
        }
        knownThreadLookup = (id) => stmt.get(id.toLowerCase());
      } catch {
        signal.throwIfAborted();
      }
    }

    let content;
    try {
      content = await withAbort(signal, () => fs.readFile(path.join(codexHome, "session_index.jsonl"), "utf8"));
    } catch {
      signal.throwIfAborted();
      return null;
    }
    const latestById = new Map();
    let order = 0;
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry?.id === "string" && entry.id.trim()) {
        latestById.set(entry.id.trim(), { name: entry.thread_name, order: order++ });
      }
    }
    const matchingIds = [...latestById.entries()]
      .filter(([id, record]) => {
        if (record.name !== name) {
          return false;
        }
        if (knownThreadLookup) {
          const known = knownThreadLookup(id);
          if (known) {
            if (known.archived !== 0) {
              return false;
            }
            if (known.name !== null && known.name !== name) {
              return false;
            }
            if (known.name === null && typeof known.title === "string" && known.title !== name) {
              return false;
            }
          }
        }
        return true;
      })
      .sort(([, left], [, right]) => right.order - left.order)
      .map(([id]) => id);
    if (matchingIds.length === 0) {
      return null;
    }
    const candidateIds = new Set(matchingIds.map((id) => id.toLowerCase()));
    const files = await listSessionFilesByUpdated(codexHome, signal);
    for (const { filePath } of files) {
      signal.throwIfAborted();
      const filenameUuid = extractThreadIdFromFilename(filePath);
      if (filenameUuid && !candidateIds.has(filenameUuid.toLowerCase())) {
        continue;
      }
      let summary;
      try {
        summary = await readRolloutSummary(filePath, signal);
      } catch {
        signal.throwIfAborted();
        continue;
      }
      if (summary.id && candidateIds.has(summary.id.toLowerCase()) && summary.cwd) {
        const effectiveCwd = (await verifyDirectory(summary.cwd, signal)) ?? path.resolve(summary.cwd);
        if (samePath(effectiveCwd, cwd)) {
          return summary.id;
        }
      }
    }
    return null;
  } finally {
    db?.close();
    db = null;
  }
}

async function resolveLatestSessionForCwd(cwd, repoRoot, codexHome, signal) {
  const effectiveProvider = await readConfiguredProvider(cwd, repoRoot, codexHome, signal);
  const { accountId: activeAccountId, userId: activeUserId } = await readActiveIdentity(codexHome, signal);
  const hasActiveIdentity = Boolean(activeAccountId || activeUserId);
  const excludedIds = new Set();
  const distinctIdentities = new Set();
  let firstMatchedId = null;

  const recordCandidateMatch = (candidateId, accountId, userId) => {
    firstMatchedId ??= candidateId;
    if (hasActiveIdentity) {
      return candidateId;
    }
    if (accountId || userId) {
      distinctIdentities.add(`${accountId ?? ""}\0${userId ?? ""}`);
      if (distinctIdentities.size > 1) {
        throw new Error(
          `Multiple Codex accounts or users have sessions in ${JSON.stringify(cwd)}, and active credentials could not be read from auth.json. Pass an explicit sessionId instead of last (CLI: --last).`
        );
      }
    }
    return null;
  };

  const db = await openCodexStateDb(codexHome, cwd, signal);
  if (db) {
    try {
      for (const archivedRow of db.prepare("SELECT id FROM threads WHERE archived != 0").all()) {
        if (typeof archivedRow?.id === "string" && archivedRow.id.trim()) {
          excludedIds.add(archivedRow.id.trim().toLowerCase());
        }
      }
      let rows;
      try {
        rows = db.prepare(
          "SELECT id, cwd, rollout_path, model_provider, source, creator_account_id, creator_user_id, attached_thread_parent_id FROM threads WHERE archived = 0 ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC"
        ).all();
      } catch {
        try {
          rows = db.prepare(
            "SELECT id, cwd, rollout_path, model_provider, source, creator_account_id, attached_thread_parent_id FROM threads WHERE archived = 0 ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC"
          ).all();
        } catch {
          rows = db.prepare(
            "SELECT id, cwd, model_provider, source, creator_account_id, attached_thread_parent_id FROM threads WHERE archived = 0 ORDER BY updated_at DESC, id DESC"
          ).all();
        }
      }
      for (const row of rows) {
        signal.throwIfAborted();
        const rowId = typeof row?.id === "string" && row.id.trim() ? row.id.trim() : null;
        if (!rowId) {
          continue;
        }
        if (
          row?.attached_thread_parent_id
          || (typeof row?.source === "string" && row.source.toLowerCase().includes("subagent"))
        ) {
          excludedIds.add(rowId.toLowerCase());
          continue;
        }
        if (row?.model_provider && row.model_provider !== effectiveProvider) {
          excludedIds.add(rowId.toLowerCase());
          continue;
        }
        if (activeAccountId && row?.creator_account_id && row.creator_account_id !== activeAccountId) {
          excludedIds.add(rowId.toLowerCase());
          continue;
        }
        if (activeUserId && row?.creator_user_id && row.creator_user_id !== activeUserId) {
          excludedIds.add(rowId.toLowerCase());
          continue;
        }
        let rowCwd = null;
        let rowAccountId = typeof row?.creator_account_id === "string" && row.creator_account_id.trim()
          ? row.creator_account_id.trim()
          : null;
        let rowUserId = typeof row?.creator_user_id === "string" && row.creator_user_id.trim()
          ? row.creator_user_id.trim()
          : null;
        if (typeof row?.rollout_path === "string" && row.rollout_path.trim()) {
          let summary;
          try {
            summary = await readRolloutSummary(row.rollout_path, signal);
          } catch {
            signal.throwIfAborted();
            excludedIds.add(rowId.toLowerCase());
            continue;
          }
          if (!summary.id || summary.id.toLowerCase() !== rowId.toLowerCase() || summary.isSubagent) {
            excludedIds.add(rowId.toLowerCase());
            continue;
          }
          rowAccountId ??= summary.accountId;
          rowUserId ??= summary.userId;
          if (activeAccountId && rowAccountId && rowAccountId !== activeAccountId) {
            excludedIds.add(rowId.toLowerCase());
            continue;
          }
          if (activeUserId && rowUserId && rowUserId !== activeUserId) {
            excludedIds.add(rowId.toLowerCase());
            continue;
          }
          const rawCwd = summary.cwd ?? row.cwd;
          if (typeof rawCwd === "string" && rawCwd.trim()) {
            rowCwd = (await verifyDirectory(rawCwd, signal)) ?? path.resolve(rawCwd);
          }
        } else {
          rowCwd = await resolveRowEffectiveCwd(row, signal);
        }
        if (rowCwd && samePath(rowCwd, cwd)) {
          const immediate = recordCandidateMatch(rowId, rowAccountId, rowUserId);
          if (immediate) {
            return immediate;
          }
        }
        excludedIds.add(rowId.toLowerCase());
      }
    } catch (error) {
      signal.throwIfAborted();
      if (/Multiple Codex accounts or users/.test(error.message)) {
        throw error;
      }
    } finally {
      db.close();
    }
  }

  const files = await listSessionFilesByUpdated(codexHome, signal);
  for (const { filePath } of files) {
    signal.throwIfAborted();
    let summary;
    try {
      summary = await readRolloutSummary(filePath, signal);
    } catch {
      signal.throwIfAborted();
      continue;
    }
    if (!summary.id || !summary.cwd || summary.isSubagent) {
      continue;
    }
    if (excludedIds.has(summary.id.toLowerCase())) {
      continue;
    }
    if (summary.modelProvider && summary.modelProvider !== effectiveProvider) {
      continue;
    }
    if (activeAccountId && summary.accountId && summary.accountId !== activeAccountId) {
      continue;
    }
    if (activeUserId && summary.userId && summary.userId !== activeUserId) {
      continue;
    }
    const effectiveCwd = (await verifyDirectory(summary.cwd, signal)) ?? path.resolve(summary.cwd);
    if (samePath(effectiveCwd, cwd)) {
      const immediate = recordCandidateMatch(summary.id, summary.accountId, summary.userId);
      if (immediate) {
        return immediate;
      }
    }
  }
  return firstMatchedId;
}

export async function runExec({ cwd, prompt, sandbox = defaultSandbox, model, worktree, ephemeral, effort }, signal, onEvent) {
  if (worktree && ephemeral) {
    throw new Error("worktree and ephemeral cannot be combined.");
  }
  if (worktree && sandbox !== "workspace-write") {
    throw new Error('worktree requires sandbox "workspace-write".');
  }
  if (model !== undefined && model.startsWith("-")) {
    throw new Error("model must not start with '-'.");
  }
  const codexHome = resolveCodexHome();
  const sqliteHome = await resolveSqliteHome(codexHome, cwd, signal);
  const codexEnv = resolveCodexEnv(codexHome, sqliteHome);
  const beforeGit = await listGitWorktrees(cwd, signal);
  const args = ["exec", "--json", "-s", sandbox, "-C", cwd, ...effortArgs(effort)];
  if (model !== undefined) {
    args.push("-m", model);
  }
  if (worktree) {
    args.push("--worktree");
  }
  if (ephemeral) {
    args.push("--ephemeral");
  }
  const { result } = await runCodex([...args, "-"], {
    input: prompt, signal, env: codexEnv, events: collectExecEvents({ fallbackToStdout: true, onEvent })
  });
  let worktreePath = null;
  if (worktree) {
    let wtRoot = null;
    const afterGit = beforeGit ? await listGitWorktrees(cwd, signal) : null;
    const owned = await findOwnedWorktrees(result.sessionId, afterGit, signal);
    if (owned.length === 1) {
      wtRoot = owned[0];
    } else if (owned.length > 1 && beforeGit) {
      const beforeSet = new Set(beforeGit.worktrees.map((entry) => entry.path));
      const addedOwned = owned.filter((entry) => !beforeSet.has(entry));
      if (addedOwned.length === 1) {
        wtRoot = addedOwned[0];
      }
    }
    if (!wtRoot && owned.length === 0 && result.worktreePath) {
      wtRoot = await verifyDirectory(result.worktreePath, signal);
    }
    if (!wtRoot && owned.length === 0 && beforeGit && afterGit) {
      const beforeSet = new Set(beforeGit.worktrees.map((entry) => entry.path));
      const added = afterGit.worktrees.filter((entry) => entry.exists && !beforeSet.has(entry.path));
      const eligibleAdded = [];
      for (const entry of added) {
        const owner = await readWorktreeOwner(entry.path, signal);
        if (owner !== null && (!result.sessionId || owner.toLowerCase() !== result.sessionId.toLowerCase())) {
          continue;
        }
        eligibleAdded.push(entry);
      }
      if (eligibleAdded.length === 1) {
        wtRoot = eligibleAdded[0].path;
      }
    }
    if (wtRoot) {
      const sourceRoot = findContainingWorktree(cwd, beforeGit) ?? beforeGit?.repoRoot ?? null;
      worktreePath = await resolveWorktreeSubdir(wtRoot, cwd, sourceRoot, signal);
    }
  } else if (findContainingWorktree(cwd, beforeGit) !== null) {
    worktreePath = cwd;
  }
  const repoRoot = beforeGit?.repoRoot ?? null;
  const resumable = Boolean(result.sessionId) && !ephemeral;
  return JSON.stringify({
    sessionId: result.sessionId,
    finalMessage: result.finalMessage,
    resumable,
    repoRoot,
    worktreePath
  });
}

export async function runResume({ cwd, prompt, sessionId, last = false, sandbox = defaultSandbox, effort }, signal, onEvent) {
  if (sessionId !== undefined && last) {
    throw new Error(
      "sessionId and last cannot be combined. Pass sessionId to resume a specific session or last to resume the most recent session."
    );
  }
  if (sessionId === undefined && !last) {
    throw new Error(
      "sessionId is required to resume a specific Codex session. Pass sessionId from the prior run, or explicitly opt in with last (CLI: --last) to resume the most recent session in cwd."
    );
  }
  const codexHome = resolveCodexHome();
  const sqliteHome = await resolveSqliteHome(codexHome, cwd, signal);
  const codexEnv = resolveCodexEnv(codexHome, sqliteHome);
  const gitInfo = await listGitWorktrees(cwd, signal);

  let targetSessionId;
  let normalizedRequestedUuid = null;
  if (last) {
    const projectRoot = findContainingWorktree(cwd, gitInfo) ?? gitInfo?.repoRoot ?? null;
    targetSessionId = await resolveLatestSessionForCwd(cwd, projectRoot, codexHome, signal);
    if (!targetSessionId) {
      throw new Error(
        `No resumable Codex session found in ${JSON.stringify(cwd)}. Start a fresh task with codex_exec (CLI: exec) first.`
      );
    }
    normalizedRequestedUuid = normalizeUuid(targetSessionId);
  } else {
    normalizedRequestedUuid = normalizeUuid(sessionId);
    if (!normalizedRequestedUuid) {
      targetSessionId = await resolveNamedSession(sessionId, cwd, codexHome, signal);
      if (!targetSessionId) {
        throw new Error(
          `Cannot resume Codex session ${JSON.stringify(sessionId)} in ${JSON.stringify(cwd)}. No recorded session with that current name was found for this working directory. Pass the exact sessionId UUID from a prior run or start a fresh task with codex_exec (CLI: exec).`
        );
      }
      normalizedRequestedUuid = normalizeUuid(targetSessionId);
    } else {
      targetSessionId = normalizedRequestedUuid;
    }
  }

  let effectiveCwd = cwd;
  let resolvedWorktreePath = null;
  const ownedWorktrees = await findOwnedWorktrees(targetSessionId, gitInfo, signal);
  const containingOwned = ownedWorktrees.find((wt) => isSameOrChildPath(cwd, wt)) ?? null;
  if (containingOwned) {
    resolvedWorktreePath = cwd;
  } else if (ownedWorktrees.length === 1) {
    const wtRoot = ownedWorktrees[0];
    const recordedCwd = await findSessionCwdById(targetSessionId, cwd, codexHome, signal);
    const sourceRoot = findContainingWorktree(cwd, gitInfo) ?? gitInfo?.repoRoot ?? null;
    const targetDir = recordedCwd && isSameOrChildPath(recordedCwd, wtRoot)
      ? recordedCwd
      : await resolveWorktreeSubdir(wtRoot, cwd, sourceRoot, signal);
    effectiveCwd = targetDir;
    resolvedWorktreePath = targetDir;
  } else if (ownedWorktrees.length > 1) {
    throw new Error(
      `Codex session ${JSON.stringify(targetSessionId)} owns multiple worktrees (${ownedWorktrees.join(", ")}). Pass the intended worktree path explicitly as cwd (CLI: --cwd).`
    );
  } else {
    const missingWorktree = await findMissingOwnedWorktree(targetSessionId, cwd, gitInfo, codexHome, signal);
    if (missingWorktree) {
      throw new Error(
        `Managed worktree ${JSON.stringify(missingWorktree)} for Codex session ${JSON.stringify(targetSessionId)} is no longer available on disk. Refusing to resume in ${JSON.stringify(cwd)}. Restore the worktree or start a fresh task with codex_exec (CLI: exec).`
      );
    }
  }

  const args = ["exec", "-s", sandbox, ...effortArgs(effort), "resume", "--json"];
  // A resolved session identifier can begin with a dash. Keep it in the positional arguments.
  if (targetSessionId.startsWith("-")) {
    args.push("--");
  }
  args.push(targetSessionId);

  let result;
  try {
    ({ result } = await runCodex([...args, "-"], {
      cwd: effectiveCwd, input: prompt, signal, env: codexEnv, events: collectExecEvents({ fallbackToStdout: true, onEvent })
    }));
  } catch (error) {
    signal.throwIfAborted();
    if (missingSessionPattern.test(error.message)) {
      if (sessionId !== undefined) {
        throw new Error(
          `Cannot resume Codex session ${JSON.stringify(sessionId)}. It may be missing, expired, created in another repository, or started with --ephemeral. Verify the sessionId or start a fresh task with codex_exec (CLI: exec).\n${error.message}`,
          { cause: error }
        );
      }
      if (last) {
        throw new Error(
          `No resumable Codex session found in ${JSON.stringify(cwd)}. Start a fresh task with codex_exec (CLI: exec) first.\n${error.message}`,
          { cause: error }
        );
      }
    }
    throw error;
  }
  const normalizedReturnedUuid = normalizeUuid(result.sessionId);
  if (
    normalizedRequestedUuid
    && result.sessionId
    && normalizedReturnedUuid !== normalizedRequestedUuid
  ) {
    throw new Error(
      `Codex did not resume requested session ${JSON.stringify(targetSessionId)}; it started ${JSON.stringify(result.sessionId)} instead. Verify the original sessionId and repository, or start a fresh task with codex_exec (CLI: exec).`
    );
  }
  const resumable = Boolean(result.sessionId);
  const repoRoot = gitInfo?.repoRoot ?? null;
  const worktreePath = resolvedWorktreePath
    ?? (result.worktreePath ? await verifyDirectory(result.worktreePath, signal) : null)
    ?? (findContainingWorktree(effectiveCwd, gitInfo) !== null ? effectiveCwd : null);
  return JSON.stringify({
    sessionId: result.sessionId,
    finalMessage: result.finalMessage,
    resumable,
    repoRoot,
    worktreePath
  });
}

export async function runDoctor({ cwd }, signal) {
  const version = await runCodex(["--version"], { cwd, signal });
  let report;
  try {
    report = await runCodex(["doctor", "--summary"], { cwd, signal });
  } catch (error) {
    const unsupportedSummary = /\b(?:unexpected|unknown|unrecognized|unsupported)\s+(?:argument|option|flag)s?[\s:'"`]*--summary\b/i;
    if (!unsupportedSummary.test(error.message)) {
      throw error;
    }
    report = await runCodex(["doctor"], { cwd, signal });
  }
  return [commandOutput(version), commandOutput(report)].filter(Boolean).join("\n\n");
}
