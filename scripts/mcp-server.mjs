#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const cwdProperty = { type: "string", minLength: 1, description: "Working directory for Codex." };
const promptProperty = { type: "string", minLength: 1, description: "Prompt to send to Codex on stdin." };
const sandboxProperty = { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" };
const supportedProtocolVersions = ["2025-06-18", "2024-11-05"];
const outputLimit = 1024 * 1024;
const truncationMarker = "[output truncated]";
const pipeDrainMs = 250;
const terminationGraceMs = 500;
const useProcessGroups = process.platform !== "win32";
const activeChildren = new Set();
const activeCalls = new Map();

const tools = [
  {
    name: "codex_review",
    description: "Run a read-only code review of uncommitted changes, a branch diff, or a commit.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: cwdProperty,
        target: { type: "string", enum: ["uncommitted", "base", "commit"], default: "uncommitted" },
        base: { type: "string", minLength: 1, description: "Required when target is base." },
        commit: { type: "string", minLength: 1, description: "Required when target is commit." },
        prompt: promptProperty
      },
      required: ["cwd"],
      allOf: [
        {
          if: { properties: { target: { const: "base" } }, required: ["target"] },
          then: { required: ["base"] }
        },
        {
          if: { properties: { target: { const: "commit" } }, required: ["target"] },
          then: { required: ["commit"] }
        }
      ],
      additionalProperties: false
    },
    run: review
  },
  {
    name: "codex_exec",
    description: "Run a Codex prompt and return the session ID and final agent message.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: cwdProperty,
        prompt: promptProperty,
        sandbox: sandboxProperty,
        model: { type: "string", minLength: 1 },
        worktree: { type: "boolean", description: "Run in a new managed Git worktree." },
        ephemeral: { type: "boolean", description: "Run without persisting session files." }
      },
      required: ["cwd", "prompt"],
      additionalProperties: false
    },
    run: exec
  },
  {
    name: "codex_resume",
    description: "Continue a Codex session by ID or name, or resume the most recent session in the working directory. "
      + "In Codex 0.171.0, a missing UUID returns an error. An unknown name or no recent session starts a new session.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: cwdProperty,
        prompt: promptProperty,
        sessionId: { type: "string", minLength: 1, description: "Session to resume. Omit to use --last." },
        sandbox: sandboxProperty
      },
      required: ["cwd", "prompt"],
      additionalProperties: false
    },
    run: resume
  },
  {
    name: "codex_doctor",
    description: "Show the installed Codex version and local diagnostic results.",
    inputSchema: {
      type: "object",
      properties: { cwd: cwdProperty },
      additionalProperties: false
    },
    run: doctor
  }
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function validateArguments(args, schema) {
  if (!isObject(args)) {
    throw new Error("Tool arguments must be an object.");
  }
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(args, name)) {
      throw new Error(`${name} is required.`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, name)) {
      throw new Error(`Unknown argument: ${name}.`);
    }
    const property = schema.properties[name];
    if (typeof value !== property.type) {
      throw new Error(`${name} must be a ${property.type}.`);
    }
    if (property.minLength && value.length < property.minLength) {
      throw new Error(`${name} must not be empty.`);
    }
    if (property.enum && !property.enum.includes(value)) {
      throw new Error(`${name} must be one of: ${property.enum.join(", ")}.`);
    }
  }
  if (args.cwd !== undefined) {
    const info = await fs.stat(args.cwd).catch((error) => {
      throw new Error(`Cannot access cwd ${JSON.stringify(args.cwd)}: ${error.message}`, { cause: error });
    });
    if (!info.isDirectory()) {
      throw new Error(`cwd must be a directory: ${JSON.stringify(args.cwd)}.`);
    }
  }
}

function cleanOutput(text) {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

function boundedOutput() {
  let buffer;
  let size = 0;
  let truncated = false;
  return {
    get truncated() { return truncated; },
    append(chunk) {
      const length = Math.min(chunk.length, outputLimit - size);
      if (length > 0) {
        if (size + length > (buffer?.length ?? 0)) {
          const capacity = Math.min(outputLimit, Math.max(256, size + length, 2 * (buffer?.length ?? 0)));
          const grown = Buffer.allocUnsafe(capacity);
          buffer?.copy(grown, 0, 0, size);
          buffer = grown;
        }
        chunk.copy(buffer, size, 0, length);
        size += length;
      }
      truncated ||= length < chunk.length;
    },
    text() {
      return (buffer?.toString("utf8", 0, size) ?? "") + (truncated ? `\n${truncationMarker}` : "");
    }
  };
}

function collectExecEvents() {
  let line = boundedOutput();
  let sawEvents = false;
  let sessionId = null;
  let finalMessage = null;

  function parseLine() {
    const text = cleanOutput(line.text());
    if (line.truncated) {
      // Codex writes the event type before the payload, including oversized items.
      const event = /^\{\s*"type"\s*:\s*"([^"]+)"/.exec(text);
      if (!event) {
        return;
      }
      sawEvents = true;
      const [prefix, type] = event;
      const completedAgentMessage = /^\s*,\s*"item"\s*:\s*\{(?:\s*"id"\s*:\s*"[^"]*"\s*,)?\s*"type"\s*:\s*"agent_message"/;
      if (type === "agent_message" || (type === "item.completed" && completedAgentMessage.test(text.slice(prefix.length)))) {
        finalMessage = truncationMarker;
      }
      return;
    }
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof event?.type !== "string") {
      return;
    }
    sawEvents = true;
    if (event.type === "thread.started" || event.type === "session.started") {
      const id = event.thread_id ?? event.session_id;
      if (typeof id === "string") {
        sessionId = id;
      }
    }
    const item = event.type === "item.completed" ? event.item : event;
    if (item?.type === "agent_message" && typeof item.text === "string") {
      finalMessage = item.text;
    }
  }

  return {
    append(chunk) {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        line.append(chunk.subarray(start, end));
        parseLine();
        line = boundedOutput();
        start = end + 1;
      }
      line.append(chunk.subarray(start));
    },
    finish(stdout) {
      parseLine();
      return { sessionId, finalMessage: sawEvents ? finalMessage : cleanOutput(stdout) };
    }
  };
}

async function isFile(file) {
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() ?? false;
}

async function resolveWindowsCodex(args) {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const executable = path.resolve(directory.replace(/^"|"$/g, ""), "codex.exe");
    if (await isFile(executable)) {
      return [executable, args];
    }
  }
  for (const directory of directories) {
    const shim = path.resolve(directory.replace(/^"|"$/g, ""), "codex.cmd");
    const contents = await fs.readFile(shim, "utf8").catch(() => "");
    // Read npm's generated Node entrypoint without evaluating the batch file.
    const target = contents.match(/"%_prog%"[ \t]+"%dp0%\\([^"\r\n]+\.js)"[ \t]+%\*[ \t]*$/im)?.[1];
    if (target) {
      const entrypoint = path.resolve(path.dirname(shim), target);
      if (await isFile(entrypoint)) {
        return [process.execPath, [entrypoint, ...args]];
      }
    }
  }
  throw new Error("Could not start codex. Check PATH for codex.exe or an npm-generated codex.cmd.");
}

function signalGroup(pid, signal) {
  if (useProcessGroups && pid !== undefined) {
    try {
      return process.kill(-pid, signal);
    } catch (error) {
      return signal === 0 && error.code === "EPERM";
    }
  }
  return false;
}

async function waitForProcessTree(child, isRunning, graceMs) {
  const deadline = performance.now() + graceMs;
  while (isRunning() || signalGroup(child.pid, 0)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return false;
    }
    await delay(Math.min(remaining, 25));
  }
  return true;
}

async function terminateProcessTree(child, isRunning) {
  if (!useProcessGroups) {
    if (isRunning()) {
      // Killing the npm launcher alone would leave its native Codex subprocess running.
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
      const args = ["/PID", String(child.pid), "/T", "/F"];
      await new Promise((done) => execFile(taskkill, args, { timeout: terminationGraceMs, windowsHide: true }, done));
      if (isRunning()) {
        child.kill("SIGKILL");
        await waitForProcessTree(child, isRunning, pipeDrainMs);
      }
    }
    return;
  }
  if (!signalGroup(child.pid, "SIGTERM") && isRunning()) {
    child.kill("SIGTERM");
  }
  if (!await waitForProcessTree(child, isRunning, terminationGraceMs)) {
    if (!signalGroup(child.pid, "SIGKILL") && isRunning()) {
      child.kill("SIGKILL");
    }
    await waitForProcessTree(child, isRunning, pipeDrainMs);
  }
}

function runCommand(command, args, { cwd, input, signal, jsonl, label }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, stdio: ["pipe", "pipe", "pipe"], detached: useProcessGroups, windowsHide: true
    });
    const stdout = boundedOutput();
    const stderr = boundedOutput();
    const events = jsonl ? collectExecEvents() : undefined;
    let running = child.pid !== undefined;
    let settled = false;
    let drainTimer;
    let stdinError;
    let spawnError;
    let termination;
    const terminate = () => termination ??= terminateProcessTree(child, () => running);

    activeChildren.add(terminate);
    signal.addEventListener("abort", terminate, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
      events?.append(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.stdin.on("error", (error) => { stdinError = error; });
    child.on("error", (error) => {
      spawnError = error;
    });

    function finish(code, exitSignal) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(drainTimer);
      const complete = () => {
        activeChildren.delete(terminate);
        signal.removeEventListener("abort", terminate);
        signal.throwIfAborted();
        const output = { stdout: stdout.text(), stderr: stderr.text() };
        if (spawnError) {
          const message = spawnError.code === "ENOENT"
            ? `Could not start ${label}. Check that ${label} is installed and available on PATH and cwd still exists.`
            : `Could not start ${label}: ${spawnError.message}`;
          throw new Error(message, { cause: spawnError });
        }
        if (code !== 0) {
          const status = exitSignal ? `was terminated by ${exitSignal}` : `exited with code ${code}`;
          const details = [cleanOutput(output.stderr), cleanOutput(output.stdout)].filter(Boolean).join("\n");
          throw new Error(`${label} ${status}.${details ? `\n${details}` : ""}`);
        }
        if (stdinError) {
          throw new Error(`Could not send input to ${label}: ${stdinError.message}`, { cause: stdinError });
        }
        return { ...output, result: events?.finish(output.stdout) };
      };
      Promise.resolve(termination).then(complete).then(resolve, reject);
    }

    child.once("exit", (code, exitSignal) => {
      running = false;
      drainTimer = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, exitSignal);
      }, pipeDrainMs);
    });
    child.once("close", (code, exitSignal) => {
      running = false;
      finish(code, exitSignal);
    });
    child.stdin.end(input);
  });
}

async function runCodex(args, options) {
  const [command, argv] = useProcessGroups ? ["codex", args] : await resolveWindowsCodex(args);
  return runCommand(command, argv, { ...options, label: "Codex" });
}

function commandOutput({ stdout, stderr }) {
  return cleanOutput(stdout) || cleanOutput(stderr);
}

async function review({ cwd, target = "uncommitted", base, commit, prompt }, signal) {
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
  const args = ["exec", "-s", "read-only", "review"];
  if (prompt !== undefined) {
    let header = target;
    if (ref !== undefined) {
      try {
        const { stdout } = await runCommand("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
          cwd, signal, label: "Git"
        });
        header += ` ${stdout.trim()}`;
      } catch (error) {
        signal.throwIfAborted();
        throw new Error(`Cannot resolve Git ref ${JSON.stringify(ref)} to a commit. ${error.message}`, { cause: error });
      }
    }
    return commandOutput(await runCodex([...args, "-"], { cwd, input: `Target: ${header}\n\n${prompt}`, signal }));
  }
  args.push(`--${target}`);
  if (ref !== undefined) {
    args.push(ref);
  }
  return commandOutput(await runCodex(args, { cwd, signal }));
}

async function exec({ cwd, prompt, sandbox = "read-only", model, worktree, ephemeral }, signal) {
  const args = ["exec", "--json", "-s", sandbox, "-C", cwd];
  if (model !== undefined) {
    args.push("-m", model);
  }
  if (worktree) {
    args.push("--worktree");
  }
  if (ephemeral) {
    args.push("--ephemeral");
  }
  const { result } = await runCodex([...args, "-"], { input: prompt, signal, jsonl: true });
  return JSON.stringify(result);
}

async function resume({ cwd, prompt, sessionId, sandbox = "read-only" }, signal) {
  const args = ["exec", "-s", sandbox, "resume", "--json"];
  if (sessionId === undefined) {
    args.push("--last");
  } else {
    // A thread name can begin with a dash. Keep it in the positional arguments.
    if (sessionId.startsWith("-")) {
      args.push("--");
    }
    args.push(sessionId);
  }
  const { result } = await runCodex([...args, "-"], { cwd, input: prompt, signal, jsonl: true });
  return JSON.stringify(result);
}

async function doctor({ cwd }, signal) {
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

function toolResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(tool, args = {}, signal) {
  try {
    await validateArguments(args, tool.inputSchema);
    signal.throwIfAborted();
    return toolResult(await tool.run(args, signal));
  } catch (error) {
    return toolResult(error.message, true);
  }
}

function respond(id, payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...payload })}\n`);
}

function rpcError(id, code, message) {
  respond(id, { error: { code, message } });
}

async function handleLine(line) {
  if (shuttingDown || !line.trim()) {
    return;
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    rpcError(null, -32700, "Parse error");
    return;
  }
  if (!isObject(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    rpcError(null, -32600, "Invalid request");
    return;
  }

  const { id, method, params } = request;
  if (id === undefined) {
    if (method === "notifications/cancelled" && isObject(params)) {
      activeCalls.get(params.requestId)?.abort();
    }
    return;
  }
  if (typeof id !== "string" && !Number.isFinite(id)) {
    rpcError(null, -32600, "Invalid request ID");
    return;
  }
  if (params !== undefined && !isObject(params)) {
    rpcError(id, -32602, "Invalid params");
    return;
  }

  switch (method) {
    case "initialize": {
      const { protocolVersion = "2024-11-05" } = params ?? {};
      if (typeof protocolVersion !== "string") {
        rpcError(id, -32602, "protocolVersion must be a string");
        return;
      }
      respond(id, {
        result: {
          protocolVersion: supportedProtocolVersions.includes(protocolVersion)
            ? protocolVersion
            : supportedProtocolVersions[0],
          capabilities: { tools: {} },
          serverInfo: { name: "codex-cli", version: "0.2.0" }
        }
      });
      break;
    }
    case "ping":
      respond(id, { result: {} });
      break;
    case "tools/list": {
      const definitions = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      respond(id, { result: { tools: definitions } });
      break;
    }
    case "tools/call": {
      const tool = tools.find(({ name }) => name === params?.name);
      if (!tool) {
        rpcError(id, -32602, "Unknown or missing tool name");
        return;
      }
      if (activeCalls.has(id)) {
        return;
      }
      const controller = new AbortController();
      activeCalls.set(id, controller);
      try {
        const result = await callTool(tool, params.arguments, controller.signal);
        if (!controller.signal.aborted) {
          respond(id, { result });
        }
      } finally {
        activeCalls.delete(id);
      }
      break;
    }
    default:
      rpcError(id, -32601, "Method not found");
  }
}

let shuttingDown = false;

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const controller of activeCalls.values()) {
    controller.abort();
  }
  await Promise.allSettled([...activeChildren].map((terminate) => terminate()));
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));
process.stdout.on("error", () => shutdown(1));

const input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
input.on("line", (line) => {
  // Keep reading requests while Codex is running so that pings can still be answered.
  handleLine(line).catch((error) => process.stderr.write(`MCP server error: ${error.message}\n`));
});
input.once("close", () => shutdown(0));
