#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";
import { terminateActiveCommands } from "./codex-command.mjs";
import {
  defaultSandbox, defaultTimeoutMs, doctorTimeoutMs, efforts, maxTimeoutMs, minTimeoutMs,
  runDoctor, runExec, runOperation, runResume, runReview, sandboxes
} from "./codex-ops.mjs";

const cwdProperty = { type: "string", minLength: 1, description: "Working directory for Codex." };
const promptProperty = { type: "string", minLength: 1, description: "Prompt to send to Codex on stdin." };
const sandboxProperty = { type: "string", enum: sandboxes, default: defaultSandbox };
const effortProperty = {
  type: "string", enum: efforts, description: "Override Codex model reasoning effort."
};
const timeoutProperty = {
  type: "integer", minimum: minTimeoutMs, maximum: maxTimeoutMs, default: defaultTimeoutMs,
  description: "Time limit in milliseconds for the tool's commands."
};
const supportedProtocolVersions = ["2025-06-18", "2024-11-05"];
const version = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")).version;
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
        prompt: promptProperty,
        effort: effortProperty,
        timeoutMs: timeoutProperty
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
    run: runReview
  },
  {
    name: "codex_exec",
    description: "Run a Codex prompt and return sessionId, resumable, repoRoot, worktreePath, and finalMessage.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: cwdProperty,
        prompt: promptProperty,
        sandbox: sandboxProperty,
        model: { type: "string", minLength: 1 },
        worktree: { type: "boolean", description: "Run in a new managed Git worktree." },
        ephemeral: { type: "boolean", description: "Run without persisting session files." },
        effort: effortProperty,
        timeoutMs: timeoutProperty
      },
      required: ["cwd", "prompt"],
      additionalProperties: false
    },
    run: runExec
  },
  {
    name: "codex_resume",
    description: "Continue a specific Codex session by explicit sessionId (recommended), or pass last: true to opt into "
      + "resuming the most recent session in cwd. If the prior run returned worktreePath, pass it as cwd (or codex_resume "
      + "routes to the owned worktree when discoverable in the repo). Requires fresh write authorization before upgrading "
      + "a read-only session to workspace-write. Returns sessionId, resumable, repoRoot, worktreePath, and finalMessage.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: cwdProperty,
        prompt: promptProperty,
        sessionId: {
          type: "string",
          minLength: 1,
          description: "Exact session ID (or thread name) from a prior run. Required unless last is true."
        },
        last: {
          type: "boolean",
          description: "Explicitly opt in to resuming the most recent session in cwd instead of a specific sessionId."
        },
        sandbox: sandboxProperty,
        effort: effortProperty,
        timeoutMs: timeoutProperty
      },
      required: ["cwd", "prompt"],
      additionalProperties: false
    },
    run: runResume
  },
  {
    name: "codex_doctor",
    description: "Show the installed Codex version and local diagnostic results.",
    inputSchema: {
      type: "object",
      properties: { cwd: cwdProperty, timeoutMs: { ...timeoutProperty, default: doctorTimeoutMs } },
      additionalProperties: false
    },
    run: runDoctor
  }
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateArguments(args, schema) {
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
    const validType = property.type === "integer" ? Number.isInteger(value) : typeof value === property.type;
    if (!validType) {
      const typeName = property.type === "integer" ? "an integer" : `a ${property.type}`;
      throw new Error(`${name} must be ${typeName}.`);
    }
    if (property.minLength && value.length < property.minLength) {
      throw new Error(`${name} must not be empty.`);
    }
    if (property.enum && !property.enum.includes(value)) {
      throw new Error(`${name} must be one of: ${property.enum.join(", ")}.`);
    }
    if (property.minimum !== undefined && value < property.minimum) {
      throw new Error(`${name} must be at least ${property.minimum}.`);
    }
    if (property.maximum !== undefined && value > property.maximum) {
      throw new Error(`${name} must be at most ${property.maximum}.`);
    }
  }
}

function toolResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function callTool(tool, args = {}, signal, onEvent) {
  try {
    validateArguments(args, tool.inputSchema);
    const timeoutMs = args.timeoutMs ?? tool.inputSchema.properties.timeoutMs.default;
    return toolResult(await runOperation(tool.run, args, { name: tool.name, signal, onEvent, timeoutMs }));
  } catch (error) {
    return toolResult(error.message, true);
  }
}

function notify(method, params) {
  if (!shuttingDown) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
}

function progressReporter(id, controller, progressToken) {
  let progress = 0;
  let lastItem = -Infinity;
  return (event) => {
    if (controller.signal.aborted || activeCalls.get(id) !== controller) {
      return;
    }
    let message;
    if (event.kind === "session") {
      message = `Codex session started: ${event.sessionId}`;
    } else if (event.kind === "item") {
      const now = performance.now();
      if (now - lastItem < 1_000) {
        return;
      }
      lastItem = now;
      message = `Codex completed step (${event.itemType})`;
    } else {
      return;
    }
    notify("notifications/progress", { progressToken, progress: ++progress, message });
  };
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
          serverInfo: { name: "codex-cli", version }
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
      const progressToken = params?._meta?.progressToken;
      const onEvent = typeof progressToken === "string" || Number.isSafeInteger(progressToken)
        ? progressReporter(id, controller, progressToken)
        : undefined;
      try {
        const result = await callTool(tool, params.arguments, controller.signal, onEvent);
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
  await terminateActiveCommands();
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
