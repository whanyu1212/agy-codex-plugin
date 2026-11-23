#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";

const cwdProperty = { type: "string", minLength: 1, description: "Working directory for Codex." };
const promptProperty = { type: "string", minLength: 1, description: "Prompt to send to Codex on stdin." };
const activeChildren = new Set();

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
        sandbox: { type: "string", enum: ["read-only", "workspace-write"], default: "read-only" },
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
    description: "Continue a Codex session by ID, or resume the most recent session in the working directory.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: cwdProperty,
        prompt: promptProperty,
        sessionId: { type: "string", minLength: 1, description: "Session to resume. Omit to use --last." }
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

function runCodex(args, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let stdinError;

    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", (error) => { stdinError = error; });
    child.on("error", (error) => {
      const message = error.code === "ENOENT"
        ? "Could not start codex. Check that Codex is installed and available on PATH and cwd still exists."
        : `Could not start codex: ${error.message}`;
      reject(new Error(message, { cause: error }));
    });
    child.on("close", (code, signal) => {
      activeChildren.delete(child);
      if (code !== 0) {
        const status = signal ? `was terminated by ${signal}` : `exited with code ${code}`;
        const details = [cleanOutput(stderr), cleanOutput(stdout)].filter(Boolean).join("\n");
        reject(new Error(`Codex ${status}.${details ? `\n${details}` : ""}`));
      } else if (stdinError) {
        reject(new Error(`Could not send prompt to codex: ${stdinError.message}`, { cause: stdinError }));
      } else {
        resolve({ stdout, stderr });
      }
    });
    child.stdin.end(input);
  });
}

function commandOutput({ stdout, stderr }) {
  return cleanOutput(stdout) || cleanOutput(stderr);
}

function parseExecOutput(stdout) {
  const cleaned = cleanOutput(stdout);
  let sessionId = null;
  let finalMessage;
  const plainLines = [];
  for (const line of cleaned.split(/\r?\n/)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      plainLines.push(line);
      continue;
    }
    if (typeof event?.type !== "string") {
      plainLines.push(line);
      continue;
    }
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
  const fallback = plainLines.join("\n").trim() || cleaned;
  return { sessionId, finalMessage: finalMessage ?? fallback };
}

async function review({ cwd, target = "uncommitted", base, commit, prompt }) {
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
  if (prompt !== undefined) {
    const header = ref === undefined ? target : `${target} ${ref}`;
    return commandOutput(await runCodex(["review", "-"], { cwd, input: `Target: ${header}\n\n${prompt}` }));
  }
  const args = ["review", `--${target}`];
  if (ref !== undefined) {
    args.push(ref);
  }
  return commandOutput(await runCodex(args, { cwd }));
}

async function exec({ cwd, prompt, sandbox = "read-only", model, worktree, ephemeral }) {
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
  const { stdout } = await runCodex([...args, "-"], { input: prompt });
  return JSON.stringify(parseExecOutput(stdout));
}

async function resume({ cwd, prompt, sessionId }) {
  const args = ["exec", "resume", "--json"];
  if (sessionId === undefined) {
    args.push("--last");
  } else {
    // A thread name can begin with a dash. Keep it in the positional arguments.
    if (sessionId.startsWith("-")) {
      args.push("--");
    }
    args.push(sessionId);
  }
  const { stdout } = await runCodex([...args, "-"], { cwd, input: prompt });
  return JSON.stringify(parseExecOutput(stdout));
}

async function doctor({ cwd }) {
  const version = await runCodex(["--version"], { cwd });
  let report;
  try {
    report = await runCodex(["doctor", "--summary"], { cwd });
  } catch (error) {
    const unsupportedSummary = /\b(?:unexpected|unknown|unrecognized|unsupported)\s+(?:argument|option|flag)s?[\s:'"`]*--summary\b/i;
    if (!unsupportedSummary.test(error.message)) {
      throw error;
    }
    report = await runCodex(["doctor"], { cwd });
  }
  return [commandOutput(version), commandOutput(report)].filter(Boolean).join("\n\n");
}

function toolResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(tool, args = {}) {
  try {
    await validateArguments(args, tool.inputSchema);
    return toolResult(await tool.run(args));
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
  if (!line.trim()) {
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
          protocolVersion,
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
      respond(id, { result: await callTool(tool, params.arguments) });
      break;
    }
    default:
      rpcError(id, -32601, "Method not found");
  }
}

function shutdown(exitCode) {
  for (const child of activeChildren) {
    child.kill();
  }
  process.exit(exitCode);
}

process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));
process.stdout.on("error", () => shutdown(1));

const input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
input.on("line", (line) => {
  // Keep reading requests while Codex is running so that pings can still be answered.
  handleLine(line).catch((error) => process.stderr.write(`MCP server error: ${error.message}\n`));
});
