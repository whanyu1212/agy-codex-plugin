import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { envWithPath, fakeCodexPath, writeFakeCodex } from "./fixtures/fake-codex.mjs";

const SERVER = fileURLToPath(new URL("../scripts/mcp-server.mjs", import.meta.url));
const isWindows = process.platform === "win32";
const FAKE_CODEX = String.raw`const fs = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
const log = process.env.FAKE_CODEX_LOG;
const mode = process.env.FAKE_CODEX_MODE;
const invocation = { argv, cwd: process.cwd(), input };
const holding = ["hold", "group-hold", "trap-term"].includes(mode) && argv[0] === "exec" && !argv.includes("review");
if (holding) {
  process.on("SIGTERM", () => {
    if (mode === "trap-term") {
      fs.appendFileSync(log, '"trapped"\n');
      return;
    }
    fs.appendFileSync(log, '"stopped"\n');
    process.exit(0);
  });
  invocation.pid = process.pid;
}
const recordInvocation = () => fs.appendFileSync(log, JSON.stringify(invocation) + "\n");
const emit = (event) => console.log(JSON.stringify(event));

function start() {
  recordInvocation();
  switch (argv.includes("review") ? "review" : argv[0]) {
    case "review":
      console.log("Review complete.");
      break;
    case "exec":
      if (holding) {
        setInterval(() => {}, 60_000);
        break;
      }
      if (argv.includes("--worktree") && argv.includes("--ephemeral")) {
        console.error("--worktree cannot be combined with --ephemeral");
        process.exit(1);
      }
      if (mode === "fallback" || mode === "events-and-text") {
        console.log("\x1b[32mPlain output.\x1b[0m");
        if (mode === "fallback") break;
      }
      if (mode === "events-only" || mode === "events-and-text") {
        emit({ type: "session.started", session_id: "session-456" });
        emit({ type: "turn.completed" });
        break;
      }
      if (mode === "large-output") {
        process.stderr.write("stderr: " + "e".repeat(2 ** 21) + "\nstderr tail");
        process.stdout.write("stdout: " + "o".repeat(2 ** 21) + "\nstdout tail");
        process.exitCode = 3;
        break;
      }
      if (mode === "large-plain") {
        console.log('{ "notice": "' + "x".repeat(2 ** 21) + '" }');
        break;
      }
      if (mode === "large-event") {
        emit({ type: "item.completed", item: { type: "command_execution", aggregated_output: "x".repeat(2 ** 21) } });
      }
      emit({ type: "thread.started", thread_id: "thread-123" });
      emit({ type: "item.completed", item: { type: "agent_message", text: "Working on it." } });
      console.log("CLI notice.");
      emit({ type: "item.completed", item: { type: "agent_message", text: "Done.\nAll set." } });
      if (mode === "large-final") {
        emit({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: "x".repeat(2 ** 21) } });
      }
      if (mode === "large-mcp-call") {
        emit({ type: "item.completed", item: {
          id: "item_3", type: "mcp_tool_call", arguments: { type: "agent_message", text: "x".repeat(2 ** 21) }
        } });
      }
      emit({ type: "item.completed", item: { type: "reasoning", text: "Private reasoning." } });
      emit({ type: "turn.completed" });
      break;
    case "--version":
      console.log("codex-cli 0.test");
      break;
    case "doctor":
      if (argv[1] === "--summary") {
        if (mode === "legacy") {
          console.error("error: unexpected argument '--summary' found");
          process.exit(2);
        }
        if (mode === "unhealthy") {
          console.error("Codex startup warning.");
          console.log("Doctor login check failed.");
          process.exit(3);
        }
        console.log("Summary checks passed.");
      } else {
        console.log("Detailed checks passed.");
      }
      break;
    default:
      console.error("Unexpected Codex arguments.");
      process.exit(4);
  }
}

if (mode === "lingering-pipe") {
  const descendant = spawn(
    process.execPath,
    ["-e", 'setInterval(() => {}, 60_000); process.send("ready");'],
    { cwd: require("node:os").tmpdir(), stdio: ["ignore", "inherit", "inherit", "ipc"], detached: true, windowsHide: true }
  );
  invocation.descendantPid = descendant.pid;
  const onEarlyExit = (code, signal) => {
    console.error("lingering-pipe descendant exited before ready:", { code, signal });
    process.exit(1);
  };
  descendant.once("exit", onEarlyExit);
  descendant.once("message", () => {
    descendant.removeListener("exit", onEarlyExit);
    descendant.disconnect();
    descendant.unref();
    start();
  });
} else if (mode === "group-hold" && holding) {
  const code = [
    'const fs = require("node:fs");',
    'process.on("SIGTERM", () => fs.appendFileSync(process.argv[1], JSON.stringify("descendant trapped") + "\\n"));',
    'setInterval(() => {}, 60_000);',
    'process.send("ready");'
  ].join("\n");
  const descendant = spawn(process.execPath, ["-e", code, log], {
    cwd: require("node:os").tmpdir(),
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  invocation.descendantPid = descendant.pid;
  descendant.once("message", () => {
    descendant.disconnect();
    start();
  });
} else {
  start();
}
`;

function fixture(t, { mode = "", withCodex = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcp-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = fs.realpathSync(temp);
  const cwd = path.join(root, "project with spaces");
  const bin = path.join(root, "bin");
  const log = path.join(root, "codex.jsonl");
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin);
  fs.writeFileSync(log, "");
  if (!isWindows) {
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
  }
  if (withCodex) {
    writeFakeCodex(bin, FAKE_CODEX);
  }
  return { cwd, root, bin, log, mode };
}

function rpc(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

function serverOptions({ root, bin, log, mode, withGit, pathPrefix = [] }) {
  const searchPath = [...pathPrefix, fakeCodexPath(bin, withGit)].join(path.delimiter);
  return {
    cwd: root,
    env: envWithPath(searchPath, { FAKE_CODEX_LOG: log, FAKE_CODEX_MODE: mode })
  };
}

function git(f, ...args) {
  return execFileSync("git", args, { cwd: f.cwd, encoding: "utf8", timeout: 3_000 }).trim();
}

function initGit(f) {
  f.withGit = true;
  git(f, "init", "-q", "-b", "main");
  git(f, "-c", "user.name=MCP test", "-c", "user.email=mcp@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-qm", "Initial commit", "--allow-empty");
  return git(f, "rev-parse", "HEAD");
}

function expectsReply(request) {
  if (typeof request === "string") {
    return true;
  }
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return true;
  }
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return true;
  }
  return request.id !== undefined;
}

async function runServer(f, ...requests) {
  const expectedReplies = requests.filter(expectsReply).length;
  const input = requests.map((request) => typeof request === "string" ? request : JSON.stringify(request));
  const signal = AbortSignal.timeout(10_000);
  const server = spawn(process.execPath, [SERVER], serverOptions(f));
  const exited = once(server, "close", { signal });
  const replies = [];
  let stdoutBuffer = "";
  let stderr = "";
  let ended = false;

  const maybeEnd = () => {
    if (!ended && replies.length >= expectedReplies) {
      ended = true;
      server.stdin.end();
    }
  };

  server.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) {
        replies.push(JSON.parse(line));
      }
    }
    maybeEnd();
  });
  server.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    for (const line of input) {
      server.stdin.write(`${line}\n`);
    }
    maybeEnd();
    const [status, exitSignal] = await exited;
    assert.equal(exitSignal, null, stderr);
    assert.equal(status, 0, stderr);
    assert.equal(stderr, "");
    const parseLines = (text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return {
      replies,
      invocations: parseLines(fs.readFileSync(f.log, "utf8"))
    };
  } finally {
    server.kill("SIGKILL");
  }
}

async function invoke(f, name, args) {
  const { replies, invocations } = await runServer(f, rpc(1, "tools/call", { name, arguments: args }));
  assert.equal(replies.length, 1);
  const { result, ...envelope } = replies[0];
  assert.deepEqual(envelope, { jsonrpc: "2.0", id: 1 });
  assert.equal(result.content.length, 1);
  const [{ type, text }] = result.content;
  assert.equal(type, "text");
  assert.equal(typeof text, "string");
  return { text, isError: result.isError, invocations };
}

test("initializes and lists typed tools", async (t) => {
  const { replies, invocations } = await runServer(
    fixture(t),
    rpc("init", "initialize", { protocolVersion: "2025-06-18" }),
    rpc(undefined, "notifications/initialized"),
    rpc(2, "ping"),
    rpc(3, "tools/list"),
    rpc(4, "initialize", { protocolVersion: "2024-11-05" }),
    rpc(5, "initialize", { protocolVersion: "2025-03-26" }),
    rpc(6, "initialize", { protocolVersion: "unknown" }),
    rpc(7, "initialize")
  );
  const initialize = {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "codex-cli", version: "0.2.1" }
  };
  assert.deepEqual(invocations, []);
  assert.deepEqual(replies.map(({ jsonrpc, id }) => [jsonrpc, id]), [
    ["2.0", "init"], ["2.0", 2], ["2.0", 3], ["2.0", 4], ["2.0", 5], ["2.0", 6], ["2.0", 7]
  ]);
  assert.deepEqual(replies[0].result, initialize);
  assert.deepEqual(replies[1].result, {});
  assert.deepEqual(replies[3].result, { ...initialize, protocolVersion: "2024-11-05" });
  assert.deepEqual(replies[4].result, initialize);
  assert.deepEqual(replies[5].result, initialize);
  assert.deepEqual(replies[6].result, replies[3].result);

  const expected = {
    codex_review: [["cwd"], {
      cwd: "string", target: "string", base: "string", commit: "string", prompt: "string",
      effort: "string", timeoutMs: "integer"
    }],
    codex_exec: [["cwd", "prompt"], {
      cwd: "string", prompt: "string", sandbox: "string", model: "string", worktree: "boolean", ephemeral: "boolean",
      effort: "string", timeoutMs: "integer"
    }],
    codex_resume: [["cwd", "prompt"], {
      cwd: "string", prompt: "string", sessionId: "string", sandbox: "string", effort: "string", timeoutMs: "integer"
    }],
    codex_doctor: [[], { cwd: "string", timeoutMs: "integer" }]
  };
  const { tools } = replies[2].result;
  assert.deepEqual(tools.map(({ name }) => name).sort(), Object.keys(expected).sort());
  for (const { name, description, inputSchema } of tools) {
    const [required, properties] = expected[name];
    assert.ok(description);
    assert.equal(inputSchema.type, "object");
    assert.equal(inputSchema.additionalProperties, false);
    assert.deepEqual(inputSchema.required ?? [], required);
    assert.deepEqual(
      Object.fromEntries(Object.entries(inputSchema.properties).map(([key, { type }]) => [key, type])),
      properties
    );
  }
  const inputs = Object.fromEntries(tools.map(({ name, inputSchema }) => [name, inputSchema]));
  assert.deepEqual(inputs.codex_review.properties.target.enum, ["uncommitted", "base", "commit"]);
  assert.equal(inputs.codex_review.properties.target.default, "uncommitted");
  for (const name of ["codex_exec", "codex_resume"]) {
    assert.deepEqual(inputs[name].properties.sandbox.enum, ["read-only", "workspace-write"]);
    assert.equal(inputs[name].properties.sandbox.default, "read-only");
  }
  for (const [name, { properties }] of Object.entries(inputs)) {
    assert.equal(properties.timeoutMs.minimum, 1_000);
    assert.equal(properties.timeoutMs.maximum, 1_800_000);
    assert.equal(properties.timeoutMs.default, name === "codex_doctor" ? 60_000 : 600_000);
    if (name !== "codex_doctor") {
      assert.deepEqual(properties.effort.enum, ["low", "medium", "high"]);
    }
  }
});

for (const [label, options] of [
  ["uncommitted", {}],
  ["base", { target: "base", base: "main" }],
  ["commit", { target: "commit", commit: "HEAD" }]
]) {
  test(`reviews ${label} changes`, async (t) => {
    const f = fixture(t);
    const sha = options.target ? initGit(f) : null;
    const header = sha ? `${label} ${sha}` : label;
    const targetArgs = [`--${label}`];
    if (sha) {
      targetArgs.push(label === "commit" ? sha : options.base);
    }
    const prompt = "Check framing.\nKeep the answer short.";
    const { replies, invocations } = await runServer(
      f,
      rpc(1, "tools/call", { name: "codex_review", arguments: { cwd: f.cwd, ...options } }),
      rpc(2, "tools/call", { name: "codex_review", arguments: { cwd: f.cwd, ...options, prompt } })
    );
    assert.deepEqual(replies.map(({ id }) => id).sort(), [1, 2]);
    for (const { result } of replies) {
      assert.deepEqual(result, { content: [{ type: "text", text: "Review complete." }], isError: false });
    }
    assert.deepEqual(invocations.sort((left, right) => left.input.length - right.input.length), [
      { argv: ["exec", "-s", "read-only", "review", ...targetArgs], cwd: f.cwd, input: "" },
      { argv: ["exec", "-s", "read-only", "review", "-"], cwd: f.cwd, input: `Target: ${header}\n\n${prompt}` }
    ]);
  });
}

for (const [target, ref] of [["base", "missing-branch"], ["commit", "--help"], ["commit", "HEAD^{tree}"]]) {
  test(`rejects invalid ${target} ref ${ref}`, async (t) => {
    const f = fixture(t);
    initGit(f);
    const args = { cwd: f.cwd, target, [target]: ref };
    const { replies, invocations } = await runServer(
      f,
      rpc(1, "tools/call", { name: "codex_review", arguments: args }),
      rpc(2, "tools/call", { name: "codex_review", arguments: { ...args, prompt: "Check framing." } })
    );
    for (const { result } of replies) {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Cannot resolve Git ref/);
    }
    assert.deepEqual(invocations, []);
  });
}

test("pins dash-prefixed base refs", async (t) => {
  const f = fixture(t);
  const sha = initGit(f);
  git(f, "update-ref", "refs/tags/-review", sha);

  const { isError, invocations } = await invoke(f, "codex_review", { cwd: f.cwd, target: "base", base: "-review" });
  assert.equal(isError, false);
  assert.deepEqual(invocations.map(({ argv }) => argv), [["exec", "-s", "read-only", "review", "--base", sha]]);
});

test("ignores relative PATH entries", async (t) => {
  const f = fixture(t);
  const sha = initGit(f);
  const relativeBin = "relative-bin";
  f.pathPrefix = [relativeBin];
  if (isWindows) {
    const currentDriveBin = path.relative(path.parse(f.root).root, path.join(f.root, relativeBin));
    f.pathPrefix.push(path.join(path.sep, currentDriveBin));
  }
  for (const parent of [f.root, f.cwd]) {
    const bin = path.join(parent, relativeBin);
    fs.mkdirSync(bin);
    if (isWindows) {
      fs.writeFileSync(path.join(bin, "git.exe"), "not an executable");
      fs.writeFileSync(path.join(bin, "codex.exe"), "not an executable");
    } else {
      fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    }
  }

  const { isError, invocations } = await invoke(f, "codex_review", { cwd: f.cwd, target: "commit", commit: "HEAD" });
  assert.equal(isError, false);
  assert.deepEqual(invocations.map(({ argv }) => argv), [["exec", "-s", "read-only", "review", "--commit", sha]]);
});

const execResult = { sessionId: "thread-123", finalMessage: "Done.\nAll set." };
for (const [name, effort, subcommand, timeoutMs] of [
  ["codex_review", "low", "review", 1_800_000],
  ["codex_exec", "medium", "-", 1_000],
  ["codex_resume", "high", "resume", 60_000]
]) {
  test(`sets effort for ${name}`, async (t) => {
    const f = fixture(t);
    const { isError, invocations } = await invoke(f, name, { cwd: f.cwd, prompt: "Check this.", effort, timeoutMs });
    assert.equal(isError, false);
    assert.equal(invocations.length, 1);
    const { argv } = invocations[0];
    const configIndex = argv.indexOf("-c");
    assert.ok(configIndex > 0 && configIndex + 1 < argv.indexOf(subcommand));
    assert.equal(argv[configIndex + 1], `model_reasoning_effort=${effort}`);
  });
}

for (const [label, options, flags] of [
  ["with default sandbox", {}, ["-s", "read-only"]],
  ["with worktree and model", { sandbox: "workspace-write", model: "test-model", worktree: true },
    ["-s", "workspace-write", "-m", "test-model", "--worktree"]],
  ["with ephemeral session", { worktree: false, ephemeral: true }, ["-s", "read-only", "--ephemeral"]]
]) {
  test(`executes ${label}`, async (t) => {
    const f = fixture(t);
    const prompt = "Describe `$(echo literal)`\nInclude both lines.";
    const { text, isError, invocations } = await invoke(f, "codex_exec", {
      cwd: path.basename(f.cwd), prompt, ...options
    });
    const [sandboxFlag, sandbox, ...optionalFlags] = flags;
    assert.equal(isError, false);
    assert.deepEqual(JSON.parse(text), execResult);
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0].argv, ["exec", "--json", sandboxFlag, sandbox, "-C", f.cwd, ...optionalFlags, "-"]);
    assert.equal(invocations[0].input, prompt);
  });
}

for (const [label, mode, expected] of [
  ["uses plain output fallback", "fallback", { sessionId: null, finalMessage: "Plain output." }],
  ["omits events from result", "events-only", { sessionId: "session-456", finalMessage: null }],
  ["ignores mixed CLI notices", "events-and-text", { sessionId: "session-456", finalMessage: null }],
  ["parses after oversized event", "large-event", execResult],
  ["ignores nested event types", "large-mcp-call", execResult],
  ["marks oversized final message", "large-final", { sessionId: "thread-123", finalMessage: "[output truncated]" }]
]) {
  test(label, async (t) => {
    const f = fixture(t, { mode });
    const { text, isError } = await invoke(f, "codex_exec", { cwd: f.cwd, prompt: "Report results." });
    assert.equal(isError, false);
    assert.deepEqual(JSON.parse(text), expected);
  });
}

for (const [label, sessionId, sandbox, selection] of [
  ["a specific session", "thread-123", undefined, ["thread-123"]],
  ["the latest session", undefined, "workspace-write", ["--last"]],
  ["a dash-prefixed name", "--last", undefined, ["--", "--last"]]
]) {
  test(`resumes ${label}`, async (t) => {
    const f = fixture(t);
    const prompt = "Continue from the previous message.";
    const { text, isError, invocations } = await invoke(f, "codex_resume", { cwd: f.cwd, prompt, sessionId, sandbox });
    assert.equal(isError, false);
    assert.deepEqual(JSON.parse(text), execResult);
    assert.deepEqual(invocations, [
      { argv: ["exec", "-s", sandbox ?? "read-only", "resume", "--json", ...selection, "-"], cwd: f.cwd, input: prompt }
    ]);
  });
}

for (const [label, mode, commands, report] of [
  ["with a summary", "", [["doctor", "--summary"]], "Summary checks passed."],
  ["with legacy fallback", "legacy", [["doctor", "--summary"], ["doctor"]], "Detailed checks passed."]
]) {
  test(`diagnoses ${label}`, async (t) => {
    const f = fixture(t, { mode });
    const cwd = mode === "legacy" ? f.cwd : f.root;
    const { text, isError, invocations } = await invoke(f, "codex_doctor", mode === "legacy" ? { cwd } : undefined);
    assert.equal(isError, false);
    assert.equal(text, `codex-cli 0.test\n\n${report}`);
    assert.deepEqual(invocations, [["--version"], ...commands].map((argv) => ({ argv, cwd, input: "" })));
  });
}

test("rejects invalid tool arguments", async (t) => {
  const f = fixture(t);
  const requests = [
    ["codex_review", {}, /cwd is required/],
    ["codex_review", { cwd: path.join(f.cwd, "missing") }, /Cannot access cwd/],
    ["codex_review", { cwd: f.log }, /cwd must be a directory/],
    ["codex_review", { cwd: f.cwd, target: "base" }, /base is required/],
    ["codex_review", { cwd: f.cwd, target: "commit" }, /commit is required/],
    ["codex_review", { cwd: f.cwd, base: "main" }, /base can only be used when target is base/],
    ["codex_review", { cwd: f.cwd, commit: "abc123" }, /commit can only be used when target is commit/],
    ["codex_review", { cwd: f.cwd, target: "base", base: "main", commit: "abc123" }, /commit can only be used when target is commit/],
    ["codex_review", { cwd: f.cwd, prompt: "" }, /prompt must not be empty/],
    ["codex_exec", { cwd: f.cwd, prompt: "" }, /prompt must not be empty/],
    ["codex_exec", { cwd: f.cwd, prompt: "Hello", sandbox: "danger-full-access" }, /sandbox must be one of/],
    ["codex_exec", { cwd: f.cwd, prompt: "Hello", worktree: "true" }, /worktree must be a boolean/],
    ["codex_resume", { cwd: f.cwd }, /prompt is required/],
    ["codex_resume", { cwd: f.cwd, prompt: "" }, /prompt must not be empty/],
    ["codex_resume", { cwd: f.cwd, prompt: "Hello", sandbox: "danger-full-access" }, /sandbox must be one of/],
    ["codex_doctor", null, /arguments must be an object/],
    ["codex_review", { cwd: f.cwd, effort: "extra-high" }, /effort must be one of: low, medium, high/],
    ["codex_exec", { cwd: f.cwd, prompt: "Hello", effort: 1 }, /effort must be a string/],
    ["codex_review", { cwd: f.cwd, timeoutMs: "1000" }, /timeoutMs must be an integer/],
    ["codex_exec", { cwd: f.cwd, prompt: "Hello", timeoutMs: 1_000.5 }, /timeoutMs must be an integer/],
    ["codex_resume", { cwd: f.cwd, prompt: "Hello", timeoutMs: 999 }, /timeoutMs must be at least 1000/],
    ["codex_doctor", { timeoutMs: 1_800_001 }, /timeoutMs must be at most 1800000/]
  ];
  const { replies, invocations } = await runServer(f, ...requests.map(([name, args], index) => (
    rpc(index, "tools/call", { name, arguments: args })
  )));
  assert.deepEqual(invocations, []);
  assert.equal(replies.length, requests.length);
  for (const { id, result } of replies) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, requests[id][2]);
  }
});

test("reports missing Codex binary", async (t) => {
  const f = fixture(t, { withCodex: false });
  const { text, isError, invocations } = await invoke(f, "codex_review", { cwd: f.cwd });
  assert.equal(isError, true);
  assert.match(text, /Codex.*PATH/);
  assert.deepEqual(invocations, []);
});

test("reports Codex exit details", async (t) => {
  const f = fixture(t, { mode: "unhealthy" });
  const { text, isError, invocations } = await invoke(f, "codex_doctor");
  assert.equal(isError, true);
  assert.match(text, /exited with code 3.*\nCodex startup warning\.\nDoctor login check failed/);
  assert.deepEqual(invocations.map(({ argv }) => argv), [["--version"], ["doctor", "--summary"]]);
});

test("bounds both diagnostic streams", async (t) => {
  const f = fixture(t, { mode: "large-output" });
  const { text, isError } = await invoke(f, "codex_exec", { cwd: f.cwd, prompt: "Report results." });
  assert.equal(isError, true);
  assert.match(text, /exited with code 3/);
  assert.match(text, /stderr: e+/);
  assert.match(text, /stdout: o+/);
  assert.equal(text.match(/\[output truncated\]/g)?.length, 2);
  assert.ok(Buffer.byteLength(text) < 2 * (2 ** 20) + 100);
});

test("retains oversized plain output", async (t) => {
  const f = fixture(t, { mode: "large-plain" });
  const { text, isError } = await invoke(f, "codex_exec", { cwd: f.cwd, prompt: "Report results." });
  assert.equal(isError, false);
  const { sessionId, finalMessage } = JSON.parse(text);
  assert.equal(sessionId, null);
  assert.match(finalMessage, /^\{ "notice": "x+\n\[output truncated\]$/);
  assert.equal(Buffer.byteLength(finalMessage), 2 ** 20 + "\n[output truncated]".length);
});

function forceKill(pid) {
  if (pid !== undefined) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

test("bounds inherited pipe draining", async (t) => {
  const f = fixture(t, { mode: "lingering-pipe" });
  try {
    const { text, isError, invocations } = await invoke(f, "codex_exec", { cwd: f.cwd, prompt: "Report results." });
    assert.equal(isError, false);
    assert.deepEqual(JSON.parse(text), execResult);
    assert.doesNotThrow(() => process.kill(invocations[0].descendantPid, 0));
  } finally {
    const line = fs.readFileSync(f.log, "utf8").trim();
    if (line) {
      const pid = JSON.parse(line).descendantPid;
      forceKill(pid);
      await waitForProcessDeath(pid, AbortSignal.timeout(5_000));
    }
  }
});

function waitForLog(f, signal, match) {
  const updates = fs.promises.watch(f.log, { signal });
  return (async () => {
    try {
      let value = match(fs.readFileSync(f.log, "utf8"));
      if (value) return value;
      for await (const { eventType } of updates) {
        if (eventType === "change") value = match(fs.readFileSync(f.log, "utf8"));
        if (value) return value;
      }
    } finally {
      await updates.return();
    }
  })();
}

function waitForStatus(f, signal, status) {
  return waitForLog(f, signal, (log) => log.includes(`${JSON.stringify(status)}\n`));
}

function runHeldCall(f, options = {}) {
  const signal = AbortSignal.timeout(5_000);
  const server = spawn(process.execPath, [SERVER], serverOptions(f));
  const exited = once(server, "close", { signal });
  const output = createInterface({ input: server.stdout, crlfDelay: Infinity });
  const replies = [];
  output.on("line", (line) => replies.push(JSON.parse(line)));
  const send = (request) => server.stdin.write(`${JSON.stringify(request)}\n`);
  const started = waitForLog(f, signal, (log) => {
    const [line] = log.split("\n");
    return line && log.includes("\n") && JSON.parse(line);
  });
  send(rpc(1, "tools/call", { name: "codex_exec", arguments: { cwd: f.cwd, prompt: "Hold.", ...options } }));
  return { server, signal, exited, output, replies, send, started };
}

test("cancels a running request", async (t) => {
  const f = fixture(t, { mode: "hold" });
  const { server, signal, exited, output, replies, send, started } = runHeldCall(f);
  let pid;
  try {
    ({ pid } = await started);
    const stopped = isWindows ? undefined : waitForStatus(f, signal, "stopped");
    send(rpc(undefined, "notifications/cancelled", { requestId: 1 }));
    await stopped;
    await waitForProcessDeath(pid, signal);

    const next = once(output, "line", { signal });
    send(rpc(2, "tools/call", { name: "codex_doctor" }));
    await next;
    server.stdin.end();
    assert.deepEqual(await exited, [0, null]);
    assert.deepEqual(replies.map(({ id }) => id), [2]);
    assert.equal(replies[0].result.isError, false);
  } finally {
    server.kill("SIGKILL");
    forceKill(pid);
  }
});

async function waitForProcessDeath(pid, signal) {
  for (;;) {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        // A container's init process may leave a killed orphan as a zombie.
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        if (stat[stat.lastIndexOf(") ") + 2] === "Z") return;
      }
    } catch (error) {
      if (error.code === "ESRCH" || error.code === "ENOENT") return;
      throw error;
    }
    await delay(25, undefined, { signal });
  }
}

test("cancels a lingering descendant", async (t) => {
  const f = fixture(t, { mode: "group-hold" });
  const { server, signal, exited, output, replies, send, started } = runHeldCall(f);
  let invocation;
  try {
    invocation = await started;
    const trapped = isWindows ? undefined : waitForStatus(f, signal, "descendant trapped");
    send(rpc(undefined, "notifications/cancelled", { requestId: 1 }));
    await trapped;
    await waitForProcessDeath(invocation.descendantPid, signal);
    await waitForProcessDeath(invocation.pid, signal);

    const pong = once(output, "line", { signal });
    send(rpc(2, "ping"));
    await pong;
    assert.deepEqual(replies, [{ jsonrpc: "2.0", id: 2, result: {} }]);
    server.stdin.end();
    assert.deepEqual(await exited, [0, null]);
  } finally {
    server.kill("SIGKILL");
    forceKill(invocation?.pid);
    forceKill(invocation?.descendantPid);
  }
});

test("escalates shutdown for SIGTERM traps", { skip: isWindows && "POSIX signal handlers only" }, async (t) => {
  const f = fixture(t, { mode: "trap-term" });
  const { server, exited, started } = runHeldCall(f);
  let pid;
  try {
    ({ pid } = await started);
    server.kill("SIGTERM");
    assert.deepEqual(await exited, [143, null]);
    assert.match(fs.readFileSync(f.log, "utf8"), /"trapped"/);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    server.kill("SIGKILL");
    forceKill(pid);
  }
});

for (const [label, trigger, expectedStatus, skipReason] of [
  ["on SIGTERM", (server) => server.kill("SIGTERM"), 143, isWindows && "POSIX signal handlers only"],
  ["when stdin closes", (server) => server.stdin.end(), 0, false]
]) {
  test(`terminates active Codex child ${label}`, { skip: skipReason }, async (t) => {
    const f = fixture(t, { mode: "hold" });
    const { server, signal, exited, started } = runHeldCall(f);
    let pid;
    try {
      ({ pid } = await started);
      const stopped = isWindows ? undefined : waitForStatus(f, signal, "stopped");
      trigger(server);
      const [exitStatus] = await Promise.all([exited, stopped]);
      assert.deepEqual(exitStatus, [expectedStatus, null]);
      await waitForProcessDeath(pid, signal);
    } finally {
      server.kill("SIGKILL");
      forceKill(pid);
    }
  });
}

for (const [label, options, message] of [
  ["worktree with ephemeral", { worktree: true, ephemeral: true, sandbox: "workspace-write" },
    "worktree and ephemeral cannot be combined."],
  ["read-only worktree", { worktree: true, sandbox: "read-only" }, 'worktree requires sandbox "workspace-write".'],
  ["dash-prefixed model", { model: "--help" }, "model must not start with '-'."]
]) {
  test(`rejects ${label}`, async (t) => {
    const f = fixture(t);
    const { text, isError, invocations } = await invoke(f, "codex_exec", { cwd: f.cwd, prompt: "Hello", ...options });
    assert.equal(isError, true);
    assert.equal(text, message);
    assert.deepEqual(invocations, []);
  });
}

test("times out and terminates Codex", async (t) => {
  const f = fixture(t, { mode: "hold" });
  const timeoutMs = 1_500;
  const { server, signal, exited, output, replies, started } = runHeldCall(f, { timeoutMs });
  let pid;
  try {
    const reply = once(output, "line", { signal }).then(() => {
      assert.deepEqual(replies, [{
        jsonrpc: "2.0", id: 1,
        result: { isError: true, content: [{ type: "text", text: `codex_exec timed out after ${timeoutMs} ms.` }] }
      }]);
    });
    await Promise.all([started.then((invocation) => { pid = invocation.pid; }), reply]);
    await waitForProcessDeath(pid, signal);
    server.stdin.end();
    assert.deepEqual(await exited, [0, null]);
  } finally {
    server.kill("SIGKILL");
    forceKill(pid);
  }
});

test("answers ping while Codex child is running", async (t) => {
  const f = fixture(t, { mode: "hold" });
  const { server, signal, exited, output, replies, send, started } = runHeldCall(f);
  let pid;
  try {
    ({ pid } = await started);
    const pong = once(output, "line", { signal });
    send(rpc(2, "ping"));
    await pong;
    assert.deepEqual(replies, [{ jsonrpc: "2.0", id: 2, result: {} }]);
    const stopped = isWindows ? undefined : waitForStatus(f, signal, "stopped");
    server.stdin.end();
    const [exitStatus] = await Promise.all([exited, stopped]);
    assert.deepEqual(exitStatus, [0, null]);
    await waitForProcessDeath(pid, signal);
  } finally {
    server.kill("SIGKILL");
    forceKill(pid);
  }
});

test("recovers after protocol errors", async (t) => {
  const { replies, invocations } = await runServer(
    fixture(t),
    "{",
    {},
    rpc(0, "unknown"),
    rpc(1, "tools/call", { name: "unknown" }),
    rpc(2, "initialize", { protocolVersion: 123 }),
    rpc(3, "ping", []),
    rpc(4, "ping")
  );
  assert.deepEqual(invocations, []);
  assert.deepEqual(replies.map(({ id, error }) => [id, error?.code]), [
    [null, -32700], [null, -32600], [0, -32601], [1, -32602], [2, -32602], [3, -32602], [4, undefined]
  ]);
  assert.deepEqual(replies[6].result, {});
});
