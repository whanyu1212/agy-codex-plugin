import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../scripts/mcp-server.mjs", import.meta.url));
const FAKE_CODEX = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
const log = process.env.FAKE_CODEX_LOG;
const mode = process.env.FAKE_CODEX_MODE;
const invocation = { argv, cwd: process.cwd(), input };
if (mode === "hold") {
  process.on("SIGTERM", () => {
    fs.appendFileSync(log, '"stopped"\n');
    process.exit(0);
  });
  invocation.pid = process.pid;
}
fs.appendFileSync(log, JSON.stringify(invocation) + "\n");
const emit = (event) => console.log(JSON.stringify(event));

switch (argv[0]) {
  case "review":
    console.log("Review complete.");
    break;
  case "exec":
    if (mode === "hold") {
      setInterval(() => {}, 60_000);
      break;
    }
    if (argv.includes("--worktree") && argv.includes("--ephemeral")) {
      console.error("--worktree cannot be combined with --ephemeral");
      process.exit(1);
    }
    if (mode === "fallback" || mode === "events-only") {
      emit({ type: "session.started", session_id: "session-456" });
      emit({ type: "turn.completed" });
      if (mode === "fallback") console.log("\x1b[32mPlain output.\x1b[0m");
      break;
    }
    emit({ type: "thread.started", thread_id: "thread-123" });
    emit({ type: "item.completed", item: { type: "agent_message", text: "Working on it." } });
    console.log("CLI notice.");
    emit({ type: "item.completed", item: { type: "agent_message", text: "Done.\nAll set." } });
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
`;

function fixture(t, { mode = "", withCodex = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcp-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = fs.realpathSync(temp);
  const cwd = path.join(root, "project with spaces");
  const bin = path.join(root, "bin");
  const log = path.join(root, "codex.jsonl");
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin);
  fs.writeFileSync(log, "");
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  if (withCodex) {
    fs.writeFileSync(path.join(bin, "codex"), FAKE_CODEX, { mode: 0o755 });
  }
  return { cwd, root, bin, log, mode };
}

function rpc(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

function serverOptions({ root, bin, log, mode }) {
  return {
    cwd: root,
    env: { ...process.env, PATH: bin, FAKE_CODEX_LOG: log, FAKE_CODEX_MODE: mode }
  };
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
    rpc(4, "initialize")
  );
  const initialize = {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "codex-cli", version: "0.2.0" }
  };
  assert.deepEqual(invocations, []);
  assert.deepEqual(replies.map(({ jsonrpc, id }) => [jsonrpc, id]), [
    ["2.0", "init"], ["2.0", 2], ["2.0", 3], ["2.0", 4]
  ]);
  assert.deepEqual(replies[0].result, initialize);
  assert.deepEqual(replies[1].result, {});
  assert.deepEqual(replies[3].result, { ...initialize, protocolVersion: "2024-11-05" });

  const expected = {
    codex_review: [["cwd"], { cwd: "string", target: "string", base: "string", commit: "string", prompt: "string" }],
    codex_exec: [["cwd", "prompt"], {
      cwd: "string", prompt: "string", sandbox: "string", model: "string", worktree: "boolean", ephemeral: "boolean"
    }],
    codex_resume: [["cwd", "prompt"], { cwd: "string", prompt: "string", sessionId: "string" }],
    codex_doctor: [[], { cwd: "string" }]
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
  assert.deepEqual(inputs.codex_exec.properties.sandbox.enum, ["read-only", "workspace-write"]);
  assert.equal(inputs.codex_exec.properties.sandbox.default, "read-only");
});

for (const [label, options, targetArgs, header] of [
  ["uncommitted", {}, ["--uncommitted"], "uncommitted"],
  ["base", { target: "base", base: "main" }, ["--base", "main"], "base main"],
  ["commit", { target: "commit", commit: "abc123" }, ["--commit", "abc123"], "commit abc123"]
]) {
  test(`reviews ${label} changes`, async (t) => {
    const f = fixture(t);
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
      { argv: ["review", ...targetArgs], cwd: f.cwd, input: "" },
      { argv: ["review", "-"], cwd: f.cwd, input: `Target: ${header}\n\n${prompt}` }
    ]);
  });
}

const execResult = { sessionId: "thread-123", finalMessage: "Done.\nAll set." };
for (const [label, options, flags] of [
  ["with default sandbox", {}, ["-s", "read-only"]],
  ["with worktree and model", { sandbox: "workspace-write", model: "test-model", worktree: true },
    ["-s", "workspace-write", "-m", "test-model", "--worktree"]],
  ["with ephemeral session", { worktree: false, ephemeral: true }, ["-s", "read-only", "--ephemeral"]]
]) {
  test(`executes ${label}`, async (t) => {
    const f = fixture(t);
    const prompt = "Describe `$(echo literal)`\nInclude both lines.";
    const { text, isError, invocations } = await invoke(f, "codex_exec", { cwd: f.cwd, prompt, ...options });
    const [sandboxFlag, sandbox, ...optionalFlags] = flags;
    assert.equal(isError, false);
    assert.deepEqual(JSON.parse(text), execResult);
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0].argv, ["exec", "--json", sandboxFlag, sandbox, "-C", f.cwd, ...optionalFlags, "-"]);
    assert.equal(invocations[0].input, prompt);
  });
}

for (const [label, mode, finalMessage] of [
  ["plain text", "fallback", "Plain output."],
  ["cleaned events", "events-only", '{"type":"session.started","session_id":"session-456"}\n{"type":"turn.completed"}']
]) {
  test(`falls back to ${label}`, async (t) => {
    const f = fixture(t, { mode });
    const { text, isError } = await invoke(f, "codex_exec", { cwd: f.cwd, prompt: "Report results." });
    assert.equal(isError, false);
    assert.deepEqual(JSON.parse(text), { sessionId: "session-456", finalMessage });
  });
}

for (const [label, sessionId, selection] of [
  ["a specific session", "thread-123", ["thread-123"]],
  ["the latest session", undefined, ["--last"]],
  ["a dash-prefixed name", "--last", ["--", "--last"]]
]) {
  test(`resumes ${label}`, async (t) => {
    const f = fixture(t);
    const prompt = "Continue from the previous message.";
    const { text, isError, invocations } = await invoke(f, "codex_resume", { cwd: f.cwd, prompt, sessionId });
    assert.equal(isError, false);
    assert.deepEqual(JSON.parse(text), execResult);
    assert.deepEqual(invocations, [{ argv: ["exec", "resume", "--json", ...selection, "-"], cwd: f.cwd, input: prompt }]);
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
    ["codex_doctor", null, /arguments must be an object/]
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

for (const [label, trigger, expectedStatus] of [
  ["on SIGTERM", (server) => server.kill("SIGTERM"), 143],
  ["when stdin closes", (server) => server.stdin.end(), 0]
]) {
  test(`terminates active Codex child ${label}`, async (t) => {
    const f = fixture(t, { mode: "hold" });
    const signal = AbortSignal.timeout(5_000);
    const updates = fs.promises.watch(f.log, { signal });
    const server = spawn(process.execPath, [SERVER], serverOptions(f));
    const exited = once(server, "close", { signal });
    let codexPid;
    let codexStopped = false;

    async function stopOnStart() {
      for await (const update of updates) {
        if (update.eventType !== "change") continue;
        const [invocation, status] = fs.readFileSync(f.log, "utf8").trimEnd().split("\n");
        if (invocation && codexPid === undefined) {
          codexPid = JSON.parse(invocation).pid;
          trigger(server);
        }
        if (status === '"stopped"') {
          codexStopped = true;
          return;
        }
      }
    }

    try {
      const request = rpc(1, "tools/call", {
        name: "codex_exec",
        arguments: { cwd: f.cwd, prompt: "Hold.", sandbox: "workspace-write" }
      });
      const stopped = stopOnStart();
      server.stdin.write(`${JSON.stringify(request)}\n`);
      const [exitStatus] = await Promise.all([exited, stopped]);
      assert.ok(codexStopped);
      assert.deepEqual(exitStatus, [expectedStatus, null]);
    } finally {
      server.kill("SIGKILL");
      if (codexPid && !codexStopped) {
        try {
          process.kill(codexPid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
  });
}

test("surfaces incompatible exec flags", async (t) => {
  const f = fixture(t);
  const { text, isError, invocations } = await invoke(f, "codex_exec", {
    cwd: f.cwd, prompt: "Hello", ephemeral: true, worktree: true
  });
  assert.equal(isError, true);
  assert.match(text, /--worktree cannot be combined with --ephemeral/);
  assert.deepEqual(invocations[0].argv.slice(-3), ["--worktree", "--ephemeral", "-"]);
});

test("answers ping while Codex child is running", async (t) => {
  const f = fixture(t, { mode: "hold" });
  const signal = AbortSignal.timeout(5_000);
  const updates = fs.promises.watch(f.log, { signal });
  const server = spawn(process.execPath, [SERVER], serverOptions(f));
  const exited = once(server, "close", { signal });
  let codexPid;
  let pingReplied = false;
  let codexStopped = false;

  server.stdout.setEncoding("utf8").on("data", (chunk) => {
    for (const line of chunk.trim().split("\n").filter(Boolean)) {
      const msg = JSON.parse(line);
      if (msg.id === 2) {
        assert.deepEqual(msg, { jsonrpc: "2.0", id: 2, result: {} });
        pingReplied = true;
        server.kill("SIGTERM");
      }
    }
  });

  async function runHoldAndPing() {
    for await (const update of updates) {
      if (update.eventType !== "change") continue;
      const [invocation, status] = fs.readFileSync(f.log, "utf8").trimEnd().split("\n");
      if (invocation && codexPid === undefined) {
        codexPid = JSON.parse(invocation).pid;
        server.stdin.write(`${JSON.stringify(rpc(2, "ping"))}\n`);
      }
      if (status === '"stopped"') {
        codexStopped = true;
        return;
      }
    }
  }

  try {
    const request = rpc(1, "tools/call", {
      name: "codex_exec",
      arguments: { cwd: f.cwd, prompt: "Hold." }
    });
    const completed = runHoldAndPing();
    server.stdin.write(`${JSON.stringify(request)}\n`);
    const [exitStatus] = await Promise.all([exited, completed]);
    assert.equal(pingReplied, true);
    assert.equal(codexStopped, true);
    assert.deepEqual(exitStatus, [143, null]);
  } finally {
    server.kill("SIGKILL");
    if (codexPid && !codexStopped) {
      try {
        process.kill(codexPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
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
