#!/usr/bin/env node

import process from "node:process";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import { terminateActiveCommands } from "./codex-command.mjs";
import {
  defaultTimeoutMs, doctorTimeoutMs, efforts, maxTimeoutMs, minTimeoutMs,
  runDoctor, runExec, runOperation, runResume, runReview, sandboxes
} from "./codex-ops.mjs";

const commonOptions = { cwd: { type: "string" }, "timeout-ms": { type: "string" } };
const effortOption = { effort: { type: "string" } };
const sandboxOption = { sandbox: { type: "string" } };
const commands = {
  review: {
    run: runReview,
    options: {
      ...commonOptions, ...effortOption,
      uncommitted: { type: "boolean" }, base: { type: "string" }, commit: { type: "string" },
      "prompt-stdin": { type: "boolean" }
    }
  },
  exec: {
    run: runExec,
    options: {
      ...commonOptions, ...effortOption, ...sandboxOption,
      model: { type: "string" }, worktree: { type: "boolean" }, ephemeral: { type: "boolean" }
    },
    readsPrompt: true
  },
  resume: {
    run: runResume,
    options: {
      ...commonOptions, ...effortOption, ...sandboxOption,
      session: { type: "string" }, last: { type: "boolean" }
    },
    readsPrompt: true
  },
  doctor: { run: runDoctor, options: commonOptions }
};

const controller = new AbortController();

async function shutdown(exitCode) {
  if (controller.signal.aborted) {
    return;
  }
  controller.abort();
  await terminateActiveCommands();
  process.exit(exitCode);
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

function parseTimeout(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const ms = Number(value);
  if (!/^\d+$/.test(value) || ms < minTimeoutMs || ms > maxTimeoutMs) {
    throw new Error(`--timeout-ms must be an integer from ${minTimeoutMs} to ${maxTimeoutMs}.`);
  }
  return ms;
}

async function main([name, ...args]) {
  if (!Object.hasOwn(commands, name)) {
    throw new Error("Usage: codex-run.mjs <review|exec|resume|doctor> [options]");
  }
  const { run, options, readsPrompt } = commands[name];
  const { values } = parseArgs({ args, options });
  for (const [flag, value] of Object.entries(values)) {
    if (value === "") {
      throw new Error(`--${flag} must not be empty.`);
    }
  }
  const {
    cwd = process.cwd(), "timeout-ms": timeout, "prompt-stdin": promptStdin,
    uncommitted, base, commit, session: sessionId, ...operationArgs
  } = values;
  const { effort, sandbox } = operationArgs;
  if (effort !== undefined && !efforts.includes(effort)) {
    throw new Error(`--effort must be one of: ${efforts.join(", ")}.`);
  }
  if (sandbox !== undefined && !sandboxes.includes(sandbox)) {
    throw new Error(`--sandbox must be one of: ${sandboxes.join(", ")}.`);
  }
  if ([uncommitted, base, commit].filter(Boolean).length > 1) {
    throw new Error("--uncommitted, --base, and --commit are mutually exclusive.");
  }
  const timeoutMs = parseTimeout(timeout, name === "doctor" ? doctorTimeoutMs : defaultTimeoutMs);
  const toolArgs = { cwd, ...operationArgs };
  if (base !== undefined) {
    Object.assign(toolArgs, { target: "base", base });
  }
  if (commit !== undefined) {
    Object.assign(toolArgs, { target: "commit", commit });
  }
  if (sessionId !== undefined) {
    toolArgs.sessionId = sessionId;
  }
  if (readsPrompt || promptStdin) {
    const prompt = await text(process.stdin);
    if (!prompt.trim()) {
      throw new Error("Prompt on stdin must not be empty.");
    }
    toolArgs.prompt = prompt;
  }
  const output = await runOperation(run, toolArgs, { name, signal: controller.signal, timeoutMs });
  if (!controller.signal.aborted) {
    process.stdout.write(`${output}\n`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (!controller.signal.aborted) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
