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
import zlib from "node:zlib";
import { envWithPath, fakeCodexPath, writeFakeCodex } from "./fixtures/fake-codex.mjs";

const SERVER = fileURLToPath(new URL("../scripts/mcp-server.mjs", import.meta.url));
const isWindows = process.platform === "win32";
const FAKE_CODEX = String.raw`const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
const log = process.env.FAKE_CODEX_LOG;
const mode = process.env.FAKE_CODEX_MODE;
const invocation = {
  argv,
  cwd: process.cwd(),
  input,
  ...(process.env.FAKE_CODEX_LOG_HOME ? { codexHome: process.env.CODEX_HOME } : {})
};
const holding = ["hold", "group-hold", "trap-term", "cancel-progress"].includes(mode)
  && argv[0] === "exec" && !argv.includes("review");
if (holding) {
  process.on("SIGTERM", () => {
    if (mode === "trap-term") {
      fs.appendFileSync(log, '"trapped"\n');
      return;
    }
    if (mode === "cancel-progress") {
      fs.writeSync(1, JSON.stringify({ type: "session.started", session_id: "late-session" }) + "\n");
      fs.writeSync(1, JSON.stringify({ type: "agent_message", text: "Late item." }) + "\n");
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
        if (mode === "cancel-progress") emit({ type: "thread.started", thread_id: "thread-123" });
        setInterval(() => {}, 60_000);
        break;
      }
      if (mode === "spaced-progress") {
        emit({ type: "session.started", session_id: "session-456" });
        emit({ type: "item.completed", item: { type: "command_execution", aggregated_output: "Private command output." } });
        emit({ type: "item.completed", item: { type: "reasoning", text: "Private reasoning." } });
        setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_message", text: "Done." })), 1_250);
        break;
      }
      if (argv.includes("--worktree") && argv.includes("--ephemeral")) {
        console.error("--worktree cannot be combined with --ephemeral");
        process.exit(1);
      }
      if (mode === "missing-session") {
        console.error("no rollout found for thread id 11111111-1111-4111-8111-111111111111");
        process.exit(1);
      }
      if (mode === "no-recent-session") {
        console.error("No recent session found.");
        process.exit(1);
      }
      if (mode === "model-not-found") {
        console.error("Model gpt-missing not found.");
        process.exit(1);
      }
      if (mode === "uuid-mismatch") {
        emit({ type: "thread.started", thread_id: "22222222-2222-4222-8222-222222222222" });
        emit({ type: "item.completed", item: { type: "agent_message", text: "Started wrong session." } });
        break;
      }
      if (mode === "event-worktree") {
        const wt = path.join(path.dirname(log), "event-wt");
        fs.mkdirSync(wt, { recursive: true });
        emit({ type: "thread.started", thread_id: "thread-123", worktree_path: wt });
        emit({ type: "item.completed", item: { type: "agent_message", text: "Done.\nAll set." } });
        break;
      }
      if (mode === "git-worktree" || mode === "git-worktree-two" || mode === "ambiguous-worktree" || mode === "owned-concurrent-worktrees") {
        const { execFileSync } = require("node:child_process");
        const repoCwd = process.env.FAKE_CODEX_REPO || process.cwd();
        if (mode === "git-worktree-two") {
          execFileSync("git", ["worktree", "add", "--detach", path.join(path.dirname(log), "wt-two"), "HEAD"], {
            cwd: repoCwd, stdio: "ignore"
          });
        } else {
          execFileSync("git", ["worktree", "add", "--detach", path.join(path.dirname(log), "wt-one"), "HEAD"], {
            cwd: repoCwd, stdio: "ignore"
          });
        }
        if (mode === "ambiguous-worktree" || mode === "owned-concurrent-worktrees") {
          execFileSync("git", ["worktree", "add", "--detach", path.join(path.dirname(log), "wt-two"), "HEAD"], {
            cwd: repoCwd, stdio: "ignore"
          });
        }
        if (mode === "owned-concurrent-worktrees") {
          fs.writeFileSync(
            path.join(repoCwd, ".git", "worktrees", "wt-one", "codex-thread.json"),
            JSON.stringify({ version: 1, ownerThreadId: "thread-123" })
          );
          fs.writeFileSync(
            path.join(repoCwd, ".git", "worktrees", "wt-two", "codex-thread.json"),
            JSON.stringify({ version: 1, ownerThreadId: "thread-other" })
          );
        }
      }
      if (mode === "other-owned-worktree") {
        const { execFileSync } = require("node:child_process");
        const repoCwd = process.env.FAKE_CODEX_REPO || process.cwd();
        execFileSync("git", ["worktree", "add", "--detach", path.join(path.dirname(log), "wt-foreign"), "HEAD"], {
          cwd: repoCwd, stdio: "ignore"
        });
        fs.writeFileSync(
          path.join(repoCwd, ".git", "worktrees", "wt-foreign", "codex-thread.json"),
          JSON.stringify({ version: 1, ownerThreadId: "thread-other" })
        );
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
      const resumeArg = argv.includes("resume") ? argv[argv.length - 2] : "";
      const threadId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resumeArg)
        ? resumeArg
        : "thread-123";
      emit({ type: "thread.started", thread_id: threadId });
      if (mode === "malformed-item-type") {
        emit({ type: "item.completed", item: { type: { toString: null, valueOf: null } } });
      }
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
  const root = fs.realpathSync.native(temp);
  const cwd = path.join(root, "project with spaces");
  const bin = path.join(root, "bin");
  const log = path.join(root, "codex.jsonl");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin);
  fs.mkdirSync(codexHome);
  fs.writeFileSync(log, "");
  if (!isWindows) {
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
  }
  if (withCodex) {
    writeFakeCodex(bin, FAKE_CODEX);
  }
  return { cwd, root, bin, log, codexHome, mode };
}

function writeSessionIndex(f, entries) {
  fs.writeFileSync(
    path.join(f.codexHome, "session_index.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
}

function writeSessionRollout(f, id, cwd, stamp = "2026-11-23T21-00-00", extraEvents = [], mtimeSeconds) {
  const dir = path.join(f.codexHome, "sessions", "2026", "11", "23");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { id, cwd } }),
    ...extraEvents.map((event) => JSON.stringify(event))
  ];
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  if (mtimeSeconds !== undefined) {
    fs.utimesSync(filePath, mtimeSeconds, mtimeSeconds);
  }
  return filePath;
}

function rpc(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

function serverOptions({ root, bin, log, codexHome, mode, withGit, pathPrefix = [], extraEnv = {} }) {
  const searchPath = [...pathPrefix, fakeCodexPath(bin, withGit)].join(path.delimiter);
  return {
    cwd: root,
    env: envWithPath(searchPath, { FAKE_CODEX_LOG: log, FAKE_CODEX_MODE: mode, CODEX_HOME: codexHome, ...extraEnv })
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
  let receivedReplies = 0;
  let stdoutBuffer = "";
  let stderr = "";
  let ended = false;

  const maybeEnd = () => {
    if (!ended && receivedReplies >= expectedReplies) {
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
        const message = JSON.parse(line);
        replies.push(message);
        if (Object.hasOwn(message, "id")) receivedReplies++;
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
  const { version } = JSON.parse(fs.readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
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
    serverInfo: { name: "codex-cli", version }
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
      cwd: "string", prompt: "string", sessionId: "string", last: "boolean", sandbox: "string", effort: "string", timeoutMs: "integer"
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

test("exec resolves symlink traversal", async (t) => {
  const f = fixture(t);
  const child = path.join(f.cwd, "child");
  const link = path.join(f.root, "linked");
  fs.mkdirSync(child);
  try {
    fs.symlinkSync(isWindows ? f.cwd : child, link, "dir");
  } catch (error) {
    if (isWindows && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("Creating symlinks requires permission on Windows");
      return;
    }
    throw error;
  }

  // Windows normalizes ".." before following symlinks.
  const cwd = isWindows ? `${link}\\child\\..` : `${link}/..`;
  const { isError, invocations } = await invoke(f, "codex_exec", { cwd, prompt: "Hello" });

  assert.equal(isError, false);
  assert.deepEqual(invocations.map(({ argv }) => argv), [["exec", "--json", "-s", "read-only", "-C", f.cwd, "-"]]);
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

const sessionUuid = "11111111-1111-4111-8111-111111111111";
const execResult = {
  sessionId: "thread-123",
  finalMessage: "Done.\nAll set.",
  resumable: true,
  repoRoot: null,
  worktreePath: null
};

function progressMessage(progressToken, progress, message) {
  return { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress, message } };
}

for (const [name, mode, token, sessionId, itemType, finalMessage] of [
  ["codex_exec", "", 0, "thread-123", "agent_message", execResult.finalMessage],
  ["codex_resume", "spaced-progress", "resume-progress", "session-456", "command_execution", "Done."]
]) {
  test(`reports ordered ${name} progress`, async (t) => {
    const f = fixture(t, { mode });
    if (name === "codex_resume") writeSessionRollout(f, sessionId, f.cwd);
    const { replies } = await runServer(f, rpc(1, "tools/call", {
      name,
      arguments: { cwd: f.cwd, prompt: "Report results.", ...(name === "codex_resume" ? { last: true } : {}) },
      _meta: { progressToken: token }
    }));
    const expected = [
      progressMessage(token, 1, `Codex session started: ${sessionId}`),
      progressMessage(token, 2, `Codex completed step (${itemType})`)
    ];
    if (mode === "spaced-progress") expected.push(progressMessage(token, 3, "Codex completed step (agent_message)"));
    assert.deepEqual(replies, [...expected, {
      jsonrpc: "2.0", id: 1,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({ sessionId, finalMessage, resumable: true, repoRoot: null, worktreePath: null })
        }],
        isError: false
      }
    }]);
  });
}

test("ignores invalid progress tokens", async (t) => {
  const f = fixture(t);
  const tokens = [undefined, null, false, 0.5, Number.MAX_SAFE_INTEGER + 1, {}];
  const { replies } = await runServer(f, ...tokens.map((progressToken, id) => rpc(id, "tools/call", {
    name: "codex_exec",
    arguments: { cwd: f.cwd, prompt: "Report results." },
    ...(progressToken === undefined ? {} : { _meta: { progressToken } })
  })));
  assert.deepEqual(replies.map(({ id }) => id).sort(), tokens.map((_, id) => id));
  assert.ok(replies.every(({ result }) => result?.isError === false));
});

test("handles malformed progress metadata", async (t) => {
  const f = fixture(t, { mode: "malformed-item-type" });
  const token = "malformed-event";
  const { replies } = await runServer(f, rpc(1, "tools/call", {
    name: "codex_exec", arguments: { cwd: f.cwd, prompt: "Report results." }, _meta: { progressToken: token }
  }));
  assert.deepEqual(replies, [
    progressMessage(token, 1, "Codex session started: thread-123"),
    progressMessage(token, 2, "Codex completed step (item.completed)"),
    {
      jsonrpc: "2.0", id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(execResult) }], isError: false }
    }
  ]);
});

for (const [name, effort, subcommand, timeoutMs] of [
  ["codex_review", "low", "review", 1_800_000],
  ["codex_exec", "medium", "-", 1_000],
  ["codex_resume", "high", "resume", 60_000]
]) {
  test(`sets effort for ${name}`, async (t) => {
    const f = fixture(t);
    if (name === "codex_resume") writeSessionRollout(f, sessionUuid, f.cwd);
    const extra = name === "codex_resume" ? { last: true } : {};
    const { isError, invocations } = await invoke(f, name, {
      cwd: f.cwd, prompt: "Check this.", effort, timeoutMs, ...extra
    });
    assert.equal(isError, false);
    assert.equal(invocations.length, 1);
    const { argv } = invocations[0];
    const configIndex = argv.indexOf("-c");
    assert.ok(configIndex > 0 && configIndex + 1 < argv.indexOf(subcommand));
    assert.equal(argv[configIndex + 1], `model_reasoning_effort=${effort}`);
  });
}

for (const [label, options, flags, expectedResumable] of [
  ["with default sandbox", {}, ["-s", "read-only"], true],
  ["with worktree and model", { sandbox: "workspace-write", model: "test-model", worktree: true },
    ["-s", "workspace-write", "-m", "test-model", "--worktree"], true],
  ["with ephemeral session", { worktree: false, ephemeral: true }, ["-s", "read-only", "--ephemeral"], false]
]) {
  test(`executes ${label}`, async (t) => {
    const f = fixture(t);
    const prompt = "Describe `$(echo literal)`\nInclude both lines.";
    const { text, isError, invocations } = await invoke(f, "codex_exec", {
      cwd: path.basename(f.cwd), prompt, ...options
    });
    const [sandboxFlag, sandbox, ...optionalFlags] = flags;
    assert.equal(isError, false);
    assert.deepEqual(JSON.parse(text), { ...execResult, resumable: expectedResumable });
    assert.equal(invocations.length, 1);
    assert.deepEqual(invocations[0].argv, ["exec", "--json", sandboxFlag, sandbox, "-C", f.cwd, ...optionalFlags, "-"]);
    assert.equal(invocations[0].input, prompt);
  });
}

for (const [label, mode, expected] of [
  ["uses plain output fallback", "fallback", {
    sessionId: null, finalMessage: "Plain output.", resumable: false, repoRoot: null, worktreePath: null
  }],
  ["omits events from result", "events-only", {
    sessionId: "session-456", finalMessage: null, resumable: true, repoRoot: null, worktreePath: null
  }],
  ["ignores mixed CLI notices", "events-and-text", {
    sessionId: "session-456", finalMessage: null, resumable: true, repoRoot: null, worktreePath: null
  }],
  ["parses after oversized event", "large-event", execResult],
  ["ignores nested event types", "large-mcp-call", execResult],
  ["marks oversized final message", "large-final", {
    sessionId: "thread-123", finalMessage: "[output truncated]", resumable: true, repoRoot: null, worktreePath: null
  }]
]) {
  test(label, async (t) => {
    const f = fixture(t, { mode });
    const { text, isError } = await invoke(f, "codex_exec", { cwd: f.cwd, prompt: "Report results." });
    assert.equal(isError, false);
    assert.deepEqual(JSON.parse(text), expected);
  });
}

for (const [label, extraArgs, setup, selection, expectedSessionId] of [
  ["a specific session", { sessionId: sessionUuid }, () => {}, [sessionUuid], sessionUuid],
  ["the latest session", { last: true, sandbox: "workspace-write" }, (f) => writeSessionRollout(f, sessionUuid, f.cwd),
    [sessionUuid], sessionUuid],
  ["a dash-prefixed name", { sessionId: "--last" },
    (f) => {
      writeSessionIndex(f, [{ id: "-thread-dash", thread_name: "--last" }]);
      writeSessionRollout(f, "-thread-dash", f.cwd);
    },
    ["--", "-thread-dash"], "thread-123"]
]) {
  test(`resumes ${label}`, async (t) => {
    const f = fixture(t);
    setup(f);
    const prompt = "Continue from the previous message.";
    const { text, isError, invocations } = await invoke(f, "codex_resume", { cwd: f.cwd, prompt, ...extraArgs });
    assert.equal(isError, false);
    assert.deepEqual(JSON.parse(text), { ...execResult, sessionId: expectedSessionId });
    assert.deepEqual(invocations, [
      {
        argv: ["exec", "-s", extraArgs.sandbox ?? "read-only", "resume", "--json", ...selection, "-"],
        cwd: f.cwd, input: prompt
      }
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
    ["codex_resume", { cwd: f.cwd, prompt: "Hello" }, /sessionId is required/],
    ["codex_resume", { cwd: f.cwd, prompt: "Hello", sessionId: "thread-123", last: true }, /cannot be combined/],
    ["codex_resume", { cwd: f.cwd, prompt: "Hello", last: "true" }, /last must be a boolean/],
    ["codex_resume", { cwd: f.cwd, prompt: "Hello", sessionId: "thread-123", sandbox: "danger-full-access" }, /sandbox must be one of/],
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
  const { sessionId, finalMessage, resumable, repoRoot, worktreePath } = JSON.parse(text);
  assert.equal(sessionId, null);
  assert.equal(resumable, false);
  assert.equal(repoRoot, null);
  assert.equal(worktreePath, null);
  assert.match(finalMessage, /^\{ "notice": "x+\n\[output truncated\]$/);
  assert.equal(Buffer.byteLength(finalMessage), 2 ** 20 + "\n[output truncated]".length);
});

test("reports worktreePath from event on codex_exec", async (t) => {
  const f = fixture(t, { mode: "event-worktree" });
  const { text, isError } = await invoke(f, "codex_exec", {
    cwd: f.cwd, prompt: "Work in worktree.", sandbox: "workspace-write", worktree: true
  });
  assert.equal(isError, false);
  assert.deepEqual(JSON.parse(text), {
    ...execResult,
    worktreePath: path.join(f.root, "event-wt")
  });
});

test("discovers unique created git worktree on codex_exec", async (t) => {
  const f = fixture(t, { mode: "git-worktree" });
  initGit(f);
  f.extraEnv = { FAKE_CODEX_REPO: f.cwd };
  const { text, isError } = await invoke(f, "codex_exec", {
    cwd: f.cwd, prompt: "Work in worktree.", sandbox: "workspace-write", worktree: true
  });
  assert.equal(isError, false);
  assert.deepEqual(JSON.parse(text), {
    ...execResult,
    repoRoot: f.cwd,
    worktreePath: path.join(f.root, "wt-one")
  });
});

test("returns null worktreePath when multiple worktrees are created without event", async (t) => {
  const f = fixture(t, { mode: "ambiguous-worktree" });
  initGit(f);
  f.extraEnv = { FAKE_CODEX_REPO: f.cwd };
  const { text, isError } = await invoke(f, "codex_exec", {
    cwd: f.cwd, prompt: "Work in worktree.", sandbox: "workspace-write", worktree: true
  });
  assert.equal(isError, false);
  assert.deepEqual(JSON.parse(text), {
    ...execResult,
    repoRoot: f.cwd,
    worktreePath: null
  });
});

test("resolves owned worktree from codex-thread.json with concurrent worktrees", async (t) => {
  const f = fixture(t, { mode: "owned-concurrent-worktrees" });
  initGit(f);
  f.extraEnv = { FAKE_CODEX_REPO: f.cwd };
  const { text, isError } = await invoke(f, "codex_exec", {
    cwd: f.cwd, prompt: "Work in worktree.", sandbox: "workspace-write", worktree: true
  });
  assert.equal(isError, false);
  assert.deepEqual(JSON.parse(text), {
    ...execResult,
    repoRoot: f.cwd,
    worktreePath: path.join(f.root, "wt-one")
  });
});

test("reports containing git worktree on codex_resume", async (t) => {
  const f = fixture(t);
  initGit(f);
  const wtDir = path.join(f.root, "existing-wt");
  git(f, "worktree", "add", "--detach", wtDir, "HEAD");
  const { text, isError } = await invoke(f, "codex_resume", {
    cwd: wtDir, prompt: "Continue here.", sessionId: sessionUuid
  });
  assert.equal(isError, false);
  assert.deepEqual(JSON.parse(text), {
    ...execResult,
    sessionId: sessionUuid,
    repoRoot: f.cwd,
    worktreePath: wtDir
  });
});

test("routes codex_resume to owned worktree when invoked from main repo", async (t) => {
  const f = fixture(t);
  initGit(f);
  const wtDir = path.join(f.root, "owned-wt");
  git(f, "worktree", "add", "--detach", wtDir, "HEAD");
  fs.writeFileSync(
    path.join(f.cwd, ".git", "worktrees", "owned-wt", "codex-thread.json"),
    JSON.stringify({ version: 1, ownerThreadId: sessionUuid })
  );
  const { text, isError, invocations } = await invoke(f, "codex_resume", {
    cwd: f.cwd, prompt: "Continue in owned worktree.", sessionId: sessionUuid
  });
  assert.equal(isError, false);
  assert.deepEqual(JSON.parse(text), {
    ...execResult,
    sessionId: sessionUuid,
    repoRoot: f.cwd,
    worktreePath: wtDir
  });
  assert.equal(invocations[0].cwd, wtDir);
});

for (const [label, mode, args, expected, expectCodexSpawn] of [
  ["unknown named session", "", { sessionId: "thread-missing" }, /No recorded session with that current name/, false],
  ["missing recent session", "", { last: true }, /No resumable Codex session found/, false],
  ["missing UUID session", "missing-session", { sessionId: sessionUuid },
    /Cannot resume Codex session "11111111-1111-4111-8111-111111111111"/, true],
  ["UUID session mismatch", "uuid-mismatch", { sessionId: sessionUuid },
    /did not resume requested session "11111111-1111-4111-8111-111111111111"; it started "22222222-2222-4222-8222-222222222222"/,
    true]
]) {
  test(`surfaces actionable error for ${label}`, async (t) => {
    const f = fixture(t, { mode });
    const { text, isError, invocations } = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", ...args });
    assert.equal(isError, true);
    assert.match(text, expected);
    assert.equal(invocations.length, expectCodexSpawn ? 1 : 0);
  });
}

test("rejects last resume when only another cwd has sessions", async (t) => {
  const f = fixture(t);
  writeSessionRollout(f, sessionUuid, f.root);
  const { text, isError, invocations } = await invoke(f, "codex_resume", {
    cwd: f.cwd, prompt: "Continue.", last: true
  });
  assert.equal(isError, true);
  assert.match(text, /No resumable Codex session found/);
  assert.deepEqual(invocations, []);
});

test("does not rewrite unrelated errors as missing session", async (t) => {
  const f = fixture(t, { mode: "model-not-found" });
  const { text, isError } = await invoke(f, "codex_resume", {
    cwd: f.cwd, prompt: "Continue.", sessionId: sessionUuid
  });
  assert.equal(isError, true);
  assert.match(text, /Model gpt-missing not found/);
  assert.doesNotMatch(text, /Cannot resume Codex session/);
});

test("scopes named resume to current thread name and cwd", async (t) => {
  const f = fixture(t);
  const otherProjectUuid = "22222222-2222-4222-8222-222222222222";
  const renamedUuid = "33333333-3333-4333-8333-333333333333";
  const localUuid = "44444444-4444-4444-8444-444444444444";
  writeSessionRollout(f, otherProjectUuid, f.root, "2026-11-23T21-00-00");
  writeSessionRollout(f, renamedUuid, f.cwd, "2026-11-23T21-01-00");
  writeSessionIndex(f, [
    { id: renamedUuid, thread_name: "review" },
    { id: renamedUuid, thread_name: "renamed-away" },
    { id: otherProjectUuid, thread_name: "review" }
  ]);
  const rejected = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", sessionId: "review" });
  assert.equal(rejected.isError, true);
  assert.match(rejected.text, /No recorded session with that current name was found for this working directory/);
  assert.deepEqual(rejected.invocations, []);

  writeSessionRollout(f, localUuid, f.cwd, "2026-11-23T20-59-00");
  writeSessionIndex(f, [
    { id: localUuid, thread_name: "review" },
    { id: renamedUuid, thread_name: "review" },
    { id: renamedUuid, thread_name: "renamed-away" },
    { id: otherProjectUuid, thread_name: "review" }
  ]);
  const resolved = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", sessionId: "review" });
  assert.equal(resolved.isError, false);
  assert.equal(JSON.parse(resolved.text).sessionId, localUuid);
});

test("honors explicit owned worktree and rejects ambiguous multi-worktree resume", async (t) => {
  const f = fixture(t);
  initGit(f);
  const wtA = path.join(f.root, "wt-a");
  const wtB = path.join(f.root, "wt-b");
  git(f, "worktree", "add", "--detach", wtA, "HEAD");
  git(f, "worktree", "add", "--detach", wtB, "HEAD");
  for (const name of ["wt-a", "wt-b"]) {
    fs.writeFileSync(
      path.join(f.cwd, ".git", "worktrees", name, "codex-thread.json"),
      JSON.stringify({ version: 1, ownerThreadId: sessionUuid })
    );
  }
  const explicit = await invoke(f, "codex_resume", { cwd: wtB, prompt: "Continue in B.", sessionId: sessionUuid });
  assert.equal(explicit.isError, false);
  assert.equal(explicit.invocations[0].cwd, wtB);
  assert.equal(JSON.parse(explicit.text).worktreePath, wtB);

  const ambiguous = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue from main.", sessionId: sessionUuid });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /owns multiple worktrees/);
  assert.equal(ambiguous.invocations.length, 1);
});

test("filters last resume by last turn_context cwd and preserves eligibility", async (t) => {
  const f = fixture(t);
  const movedDir = path.join(f.root, "moved-checkout");
  fs.mkdirSync(movedDir);
  const movedUuid = "55555555-5555-4555-8555-555555555555";
  const subagentUuid = "66666666-6666-4666-8666-666666666666";
  const providerUuid = "77777777-7777-4777-8777-777777777777";
  const dir = path.join(f.codexHome, "sessions", "2026", "11", "23");
  fs.mkdirSync(dir, { recursive: true });

  writeSessionRollout(f, movedUuid, f.cwd, "2026-11-23T22-00-00", [
    { type: "turn_context", payload: { cwd: movedDir } }
  ]);
  const movedRes = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", last: true });
  assert.equal(movedRes.isError, true);
  assert.match(movedRes.text, /No resumable Codex session found/);

  const inMoved = await invoke(f, "codex_resume", { cwd: movedDir, prompt: "Continue.", last: true });
  assert.equal(inMoved.isError, false);
  assert.deepEqual(inMoved.invocations[0].argv, ["exec", "-s", "read-only", "resume", "--json", movedUuid, "-"]);

  // Without config.toml, default provider is "openai"; custom provider and subagent threads are ineligible.
  fs.writeFileSync(
    path.join(dir, `rollout-2026-11-23T22-01-00-${subagentUuid}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: subagentUuid, cwd: f.cwd, parent_thread_id: movedUuid } }) + "\n"
  );
  fs.writeFileSync(
    path.join(dir, `rollout-2026-11-23T22-02-00-${providerUuid}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: providerUuid, cwd: f.cwd, model_provider: "anthropic" } }) + "\n"
  );
  const ineligibleDefault = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", last: true });
  assert.equal(ineligibleDefault.isError, true);
  assert.match(ineligibleDefault.text, /No resumable Codex session found/);
  assert.equal(ineligibleDefault.invocations.length, 1);

  fs.writeFileSync(path.join(f.codexHome, "config.toml"), 'model_provider = "openai"\n');
  const ineligibleExplicit = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", last: true });
  assert.equal(ineligibleExplicit.isError, true);
  assert.match(ineligibleExplicit.text, /No resumable Codex session found/);
  assert.equal(ineligibleExplicit.invocations.length, 1);
});

test("uses first session_meta for forks, supports zst and reverted rollouts, and ranks by mtime", async (t) => {
  const f = fixture(t);
  const parentUuid = "88888888-8888-4888-8888-888888888888";
  const forkUuid = "99999999-9999-4999-8999-999999999999";
  const zstUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const revertedUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const rolloutSuffixUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const dir = path.join(f.codexHome, "sessions", "2026", "11", "23");
  fs.mkdirSync(dir, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1_000);

  // Fork rollout has parent's session_meta copied as a later line.
  const forkPath = writeSessionRollout(f, forkUuid, f.cwd, "2026-11-23T20-00-00", [
    { type: "session_meta", payload: { id: parentUuid, cwd: f.root } }
  ], nowSec - 10);
  // Compressed zst rollout with newer mtime.
  if (typeof zlib.zstdCompressSync === "function") {
    const zstPath = path.join(dir, `rollout-2026-11-23T19-00-00-${zstUuid}.jsonl.zst`);
    fs.writeFileSync(zstPath, zlib.zstdCompressSync(Buffer.from(
      JSON.stringify({ type: "session_meta", payload: { id: zstUuid, cwd: f.cwd } }) + "\n"
    )));
    fs.utimesSync(zstPath, nowSec + 20, nowSec + 20);

    writeSessionIndex(f, [
      { id: zstUuid, thread_name: "shared" },
      { id: forkUuid, thread_name: "shared" }
    ]);
    const resZst = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", sessionId: "shared" });
    assert.equal(resZst.isError, false);
    assert.equal(JSON.parse(resZst.text).sessionId, zstUuid);

    // Touch forkPath newer than zstPath and verify fork is still identified as forkUuid (not parentUuid).
    fs.utimesSync(forkPath, nowSec + 40, nowSec + 40);
    const resFork = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", sessionId: "shared" });
    assert.equal(resFork.isError, false);
    assert.equal(JSON.parse(resFork.text).sessionId, forkUuid);
  }

  // History-revert rollout filename: rollout-...-<thread-id>_<rollout-id>.jsonl
  const revertedPath = path.join(dir, `rollout-2026-11-23T22-00-00-${revertedUuid}_${rolloutSuffixUuid}.jsonl`);
  fs.writeFileSync(revertedPath, JSON.stringify({ type: "session_meta", payload: { id: revertedUuid, cwd: f.cwd } }) + "\n");
  fs.utimesSync(revertedPath, nowSec + 60, nowSec + 60);
  writeSessionIndex(f, [{ id: revertedUuid, thread_name: "reverted" }]);
  const resReverted = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", sessionId: "reverted" });
  assert.equal(resReverted.isError, false);
  assert.equal(JSON.parse(resReverted.text).sessionId, revertedUuid);
});

test("resolves thread names authoritatively from state sqlite, titles, rollout fallback, and sqlite_home", async (t) => {
  let DatabaseSync;
  const origWarn = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w)) ? undefined : origWarn.call(process, w, ...rest));
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return;
  } finally {
    process.emitWarning = origWarn;
  }
  const f = fixture(t);
  const dbOnlyUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const staleIndexUuid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const titleUuid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const movedUuid = "12121212-1212-4121-8121-121212121212";
  const unindexedUuid = "34343434-3434-4343-8343-343434343434";
  const sqliteDir = path.join(f.root, "custom-sqlite-home");
  fs.mkdirSync(sqliteDir);
  fs.writeFileSync(path.join(f.codexHome, "config.toml"), `sqlite_home = '${sqliteDir}'\n`);
  f.extraEnv = { CODEX_SQLITE_HOME: path.join(f.root, "ignored-sqlite-home") };

  const movedCheckout = path.join(f.root, "sqlite-moved");
  fs.mkdirSync(movedCheckout);
  const movedRollout = writeSessionRollout(f, movedUuid, f.cwd, "2026-11-23T22-10-00", [
    { type: "turn_context", payload: { cwd: movedCheckout } }
  ]);
  const staleDbRollout = path.join(f.codexHome, "sessions", "2026", "11", "23", `rollout-2026-11-23T22-20-00-missing.jsonl`);
  const validFallbackUuid = "45454545-4545-4545-8545-454545454545";
  const validFallbackRollout = writeSessionRollout(f, validFallbackUuid, movedCheckout, "2026-11-23T22-05-00");
  const staleDbUuid = "78787878-7878-4878-8878-787878787878";

  const db = new DatabaseSync(path.join(sqliteDir, "state_5.sqlite"));
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        rollout_path TEXT,
        name TEXT,
        title TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        model_provider TEXT NOT NULL DEFAULT 'openai',
        source TEXT NOT NULL DEFAULT 'cli',
        creator_account_id TEXT,
        creator_user_id TEXT,
        attached_thread_parent_id TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER
      );
    `);
    db.prepare("INSERT INTO threads (id, cwd, name, updated_at_ms) VALUES (?, ?, ?, ?)")
      .run(dbOnlyUuid, f.cwd, "sqlite-only", 2_000);
    db.prepare("INSERT INTO threads (id, cwd, name, updated_at_ms) VALUES (?, ?, ?, ?)")
      .run(staleIndexUuid, f.cwd, "new-name", 3_000);
    db.prepare("INSERT INTO threads (id, cwd, title, updated_at_ms) VALUES (?, ?, ?, ?)")
      .run(titleUuid, f.cwd, "Generated Thread Title", 4_000);
    db.prepare("INSERT INTO threads (id, cwd, rollout_path, updated_at_ms) VALUES (?, ?, ?, ?)")
      .run(movedUuid, f.cwd, movedRollout, 5_000);
    db.prepare("INSERT INTO threads (id, cwd, rollout_path, updated_at_ms) VALUES (?, ?, ?, ?)")
      .run(staleDbUuid, movedCheckout, staleDbRollout, 6_000);
    db.prepare("INSERT INTO threads (id, cwd, rollout_path, updated_at_ms) VALUES (?, ?, ?, ?)")
      .run(validFallbackUuid, movedCheckout, validFallbackRollout, 4_500);
  } finally {
    db.close();
  }
  writeSessionIndex(f, [{ id: staleIndexUuid, thread_name: "stale-name" }]);
  writeSessionRollout(f, staleIndexUuid, f.cwd);

  const ok = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", sessionId: "sqlite-only" });
  assert.equal(ok.isError, false);
  assert.equal(JSON.parse(ok.text).sessionId, dbOnlyUuid);

  const stale = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", sessionId: "stale-name" });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /No recorded session with that current name/);

  const byTitle = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", sessionId: "Generated Thread Title" });
  assert.equal(byTitle.isError, false);
  assert.equal(JSON.parse(byTitle.text).sessionId, titleUuid);

  // Moved session has SQLite cwd = f.cwd, rollout turn_context cwd = movedCheckout; staleDbUuid (missing rollout) is skipped.
  const lastMoved = await invoke(f, "codex_resume", { cwd: movedCheckout, prompt: "Continue.", last: true });
  assert.equal(lastMoved.isError, false);
  assert.equal(JSON.parse(lastMoved.text).sessionId, movedUuid);

  // Unindexed rollout in a clean directory still discovered via rollout fallback when SQLite has no match.
  const unindexedDir = path.join(f.root, "unindexed-dir");
  fs.mkdirSync(unindexedDir);
  writeSessionRollout(f, unindexedUuid, unindexedDir);
  const unindexed = await invoke(f, "codex_resume", { cwd: unindexedDir, prompt: "Continue.", last: true });
  assert.equal(unindexed.isError, false);
  assert.equal(JSON.parse(unindexed.text).sessionId, unindexedUuid);
});

test("respects project trust for model_provider, filters creator_user_id, rejects foreign worktree fallback, and accepts compact UUIDs", async (t) => {
  const f = fixture(t, { mode: "other-owned-worktree" });
  initGit(f);
  f.extraEnv = { FAKE_CODEX_REPO: f.cwd };
  const foreignRes = await invoke(f, "codex_exec", {
    cwd: f.cwd, prompt: "Work in worktree.", sandbox: "workspace-write", worktree: true
  });
  assert.equal(foreignRes.isError, false);
  assert.equal(JSON.parse(foreignRes.text).worktreePath, null);

  f.mode = "";
  const localUuid = "56565656-5656-4565-8565-565656565656";
  const dir = path.join(f.codexHome, "sessions", "2026", "11", "23");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(f.cwd, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, ".codex", "config.toml"), "model_provider = 'local'\n");
  fs.writeFileSync(
    path.join(dir, `rollout-2026-11-23T22-15-00-${localUuid}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: localUuid, cwd: f.cwd, model_provider: "local" } }) + "\n"
  );

  // Untrusted project .codex/config.toml must be ignored.
  const untrustedRes = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", last: true });
  assert.equal(untrustedRes.isError, true);
  assert.match(untrustedRes.text, /No resumable Codex session found/);

  // Trusted project .codex/config.toml is honored.
  fs.writeFileSync(
    path.join(f.codexHome, "config.toml"),
    `[projects.${JSON.stringify(f.cwd)}]\ntrust_level = "trusted"\n`
  );
  const localRes = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", last: true });
  assert.equal(localRes.isError, false);
  assert.equal(JSON.parse(localRes.text).sessionId, localUuid);

  // creator_user_id must match active user even when creator_account_id is shared.
  const otherUserUuid = "91919191-9191-4919-8919-919191919191";
  const myUserUuid = "92929292-9292-4929-8929-929292929292";
  const jwtPayload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { user_id: "user-current", chatgpt_account_id: "acct-shared" }
  })).toString("base64url");
  fs.writeFileSync(path.join(f.codexHome, "auth.json"), JSON.stringify({
    tokens: { account_id: "acct-shared", id_token: `hdr.${jwtPayload}.sig` }
  }));
  const userDir = path.join(f.root, "shared-workspace");
  fs.mkdirSync(userDir);
  const nowSec = Math.floor(Date.now() / 1_000);
  const myPath = path.join(dir, `rollout-2026-11-23T22-16-00-${myUserUuid}.jsonl`);
  fs.writeFileSync(myPath, JSON.stringify({
    type: "session_meta",
    payload: {
      id: myUserUuid, cwd: userDir, account_scoped: true,
      creator_account_id: "acct-shared", creator_user_id: "user-current"
    }
  }) + "\n");
  fs.utimesSync(myPath, nowSec + 10, nowSec + 10);
  const otherPath = path.join(dir, `rollout-2026-11-23T22-17-00-${otherUserUuid}.jsonl`);
  fs.writeFileSync(otherPath, JSON.stringify({
    type: "session_meta",
    payload: {
      id: otherUserUuid, cwd: userDir, account_scoped: true,
      creator_account_id: "acct-shared", creator_user_id: "user-other"
    }
  }) + "\n");
  fs.utimesSync(otherPath, nowSec + 30, nowSec + 30);
  const userRes = await invoke(f, "codex_resume", { cwd: userDir, prompt: "Continue.", last: true });
  assert.equal(userRes.isError, false);
  assert.equal(JSON.parse(userRes.text).sessionId, myUserUuid);

  const compact = sessionUuid.replace(/-/g, "");
  const compactRes = await invoke(f, "codex_resume", { cwd: f.cwd, prompt: "Continue.", sessionId: compact });
  assert.equal(compactRes.isError, false);
  assert.equal(JSON.parse(compactRes.text).sessionId, sessionUuid);
});

test("refuses to resume in main checkout when owned managed worktree is missing or replaced", async (t) => {
  const f = fixture(t);
  initGit(f);
  const missingWt = path.join(f.root, "deleted-wt");
  git(f, "worktree", "add", "--detach", missingWt, "HEAD");
  fs.writeFileSync(
    path.join(f.cwd, ".git", "worktrees", "deleted-wt", "codex-thread.json"),
    JSON.stringify({ version: 1, ownerThreadId: sessionUuid })
  );
  fs.rmSync(missingWt, { recursive: true, force: true });

  const deletedRes = await invoke(f, "codex_resume", {
    cwd: f.cwd, prompt: "Do not edit main.", sessionId: sessionUuid, sandbox: "workspace-write"
  });
  assert.equal(deletedRes.isError, true);
  assert.match(deletedRes.text, /no longer available on disk\. Refusing to resume/);
  assert.deepEqual(deletedRes.invocations, []);

  // Plain directory recreated at the same path without a valid .git ownership link must still be rejected.
  fs.mkdirSync(missingWt);
  const replacedRes = await invoke(f, "codex_resume", {
    cwd: f.cwd, prompt: "Do not edit main.", sessionId: sessionUuid, sandbox: "workspace-write"
  });
  assert.equal(replacedRes.isError, true);
  assert.match(replacedRes.text, /no longer available on disk\. Refusing to resume/);
  assert.deepEqual(replacedRes.invocations, []);

  // Normal moved checkout (not a managed worktree) must still allow explicit UUID resume from the new path.
  const normalMovedUuid = "abababab-abab-4bab-8bab-abababababab";
  const oldCheckoutPath = path.join(f.root, "old-normal-checkout");
  writeSessionRollout(f, normalMovedUuid, oldCheckoutPath);
  const movedRes = await invoke(f, "codex_resume", {
    cwd: f.cwd, prompt: "Continue in moved checkout.", sessionId: normalMovedUuid
  });
  assert.equal(movedRes.isError, false);
  assert.equal(JSON.parse(movedRes.text).sessionId, normalMovedUuid);
});

test("honors untrusted subdir override, excludes attached forks, and rejects multi-account last without auth.json", async (t) => {
  const f = fixture(t);
  const dir = path.join(f.codexHome, "sessions", "2026", "11", "23");
  fs.mkdirSync(dir, { recursive: true });
  const subDir = path.join(f.cwd, "untrusted-sub");
  fs.mkdirSync(path.join(subDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(subDir, ".codex", "config.toml"), "model_provider = 'local'\n");
  fs.writeFileSync(
    path.join(f.codexHome, "config.toml"),
    `[projects.${JSON.stringify(f.cwd)}]\ntrust_level = "trusted"\n\n`
      + `[projects.${JSON.stringify(subDir)}]\ntrust_level = "untrusted"\n`
  );
  const localUuid = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
  fs.writeFileSync(
    path.join(dir, `rollout-2026-11-23T22-18-00-${localUuid}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: localUuid, cwd: subDir, model_provider: "local" } }) + "\n"
  );
  const untrustedSub = await invoke(f, "codex_resume", { cwd: subDir, prompt: "Continue.", last: true });
  assert.equal(untrustedSub.isError, true);
  assert.match(untrustedSub.text, /No resumable Codex session found/);

  // Attached fork (attached_thread: true) must be excluded from --last.
  const forkDir = path.join(f.root, "attached-fork-dir");
  fs.mkdirSync(forkDir);
  const attachedForkUuid = "efefefef-efef-4fef-8fef-efefefefefef";
  fs.writeFileSync(
    path.join(dir, `rollout-2026-11-23T22-19-00-${attachedForkUuid}.jsonl`),
    JSON.stringify({
      type: "session_meta",
      payload: { id: attachedForkUuid, cwd: forkDir, attached_thread: true, forked_from_id: localUuid }
    }) + "\n"
  );
  const attachedRes = await invoke(f, "codex_resume", { cwd: forkDir, prompt: "Continue.", last: true });
  assert.equal(attachedRes.isError, true);
  assert.match(attachedRes.text, /No resumable Codex session found/);

  // Without auth.json (e.g. keyring), two distinct account/user identities in cwd must fail --last explicitly.
  const multiDir = path.join(f.root, "multi-account-dir");
  fs.mkdirSync(multiDir);
  const acctAUuid = "13131313-1313-4313-8313-131313131313";
  const acctBUuid = "24242424-2424-4424-8424-242424242424";
  fs.writeFileSync(
    path.join(dir, `rollout-2026-11-23T22-20-00-${acctAUuid}.jsonl`),
    JSON.stringify({
      type: "session_meta",
      payload: { id: acctAUuid, cwd: multiDir, account_scoped: true, creator_account_id: "acct-a", creator_user_id: "u-a" }
    }) + "\n"
  );
  fs.writeFileSync(
    path.join(dir, `rollout-2026-11-23T22-21-00-${acctBUuid}.jsonl`),
    JSON.stringify({
      type: "session_meta",
      payload: { id: acctBUuid, cwd: multiDir, account_scoped: true, creator_account_id: "acct-b", creator_user_id: "u-b" }
    }) + "\n"
  );
  const multiRes = await invoke(f, "codex_resume", { cwd: multiDir, prompt: "Continue.", last: true });
  assert.equal(multiRes.isError, true);
  assert.match(multiRes.text, /Multiple Codex accounts or users/);
  assert.deepEqual(multiRes.invocations, []);
});

test("honors linked worktree .codex/config.toml on last resume", async (t) => {
  const f = fixture(t);
  initGit(f);
  const wtRoot = path.join(f.root, "trusted-wt");
  git(f, "worktree", "add", "--detach", wtRoot, "HEAD");
  const wtSub = path.join(wtRoot, "packages", "app");
  fs.mkdirSync(path.join(wtRoot, ".codex"), { recursive: true });
  fs.mkdirSync(wtSub, { recursive: true });
  fs.writeFileSync(path.join(wtRoot, ".codex", "config.toml"), "model_provider = 'local'\n");
  fs.writeFileSync(
    path.join(f.codexHome, "config.toml"),
    `[projects.${JSON.stringify(wtRoot)}]\ntrust_level = "trusted"\n`
  );
  const wtLocalUuid = "35353535-3535-4535-8535-353535353535";
  const dir = path.join(f.codexHome, "sessions", "2026", "11", "23");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `rollout-2026-11-23T22-22-00-${wtLocalUuid}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: wtLocalUuid, cwd: wtSub, model_provider: "local" } }) + "\n"
  );
  const res = await invoke(f, "codex_resume", { cwd: wtSub, prompt: "Continue.", last: true });
  assert.equal(res.isError, false);
  assert.equal(JSON.parse(res.text).sessionId, wtLocalUuid);
});

test("preserves subdirectory across exec --worktree, linked worktrees, and guards symlinks", async (t) => {
  const f = fixture(t, { mode: "git-worktree" });
  const pkgSubdir = path.join("packages", "app");
  fs.mkdirSync(path.join(f.cwd, pkgSubdir), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, pkgSubdir, "index.js"), "export const x = 1;\n");
  initGit(f);
  git(f, "add", ".");
  git(f, "-c", "user.name=MCP test", "-c", "user.email=mcp@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-qm", "Add package");
  f.extraEnv = { FAKE_CODEX_REPO: f.cwd };

  const execRes = await invoke(f, "codex_exec", {
    cwd: path.join(f.cwd, pkgSubdir), prompt: "Work in package.", sandbox: "workspace-write", worktree: true
  });
  assert.equal(execRes.isError, false);
  const wtOneRoot = path.join(f.root, "wt-one");
  const expectedSubdir = path.join(wtOneRoot, pkgSubdir);
  assert.equal(JSON.parse(execRes.text).worktreePath, expectedSubdir);

  fs.writeFileSync(
    path.join(f.cwd, ".git", "worktrees", "wt-one", "codex-thread.json"),
    JSON.stringify({ version: 1, ownerThreadId: sessionUuid })
  );
  writeSessionRollout(f, sessionUuid, expectedSubdir);
  f.mode = "";

  const resumeRes = await invoke(f, "codex_resume", {
    cwd: f.cwd, prompt: "Continue in package.", sessionId: sessionUuid
  });
  assert.equal(resumeRes.isError, false);
  assert.equal(resumeRes.invocations[1].cwd, expectedSubdir);
  assert.equal(JSON.parse(resumeRes.text).worktreePath, expectedSubdir);

  // Starting exec --worktree from a subdirectory of an existing linked worktree maps relative to that linked worktree.
  const outsideTarget = path.join(f.root, "outside-dir");
  fs.mkdirSync(outsideTarget);
  const wtTwoRoot = path.join(f.root, "wt-two");
  f.mode = "git-worktree-two";
  const siblingExec = await invoke(f, "codex_exec", {
    cwd: expectedSubdir, prompt: "New worktree from linked wt subdir.", sandbox: "workspace-write", worktree: true
  });
  assert.equal(siblingExec.isError, false);
  assert.equal(JSON.parse(siblingExec.text).worktreePath, path.join(wtTwoRoot, pkgSubdir));
  f.mode = "";

  // Verify symlink escaping wtRoot falls back to wtRoot rather than leaking an external directory.
  if (!isWindows) {
    const escapedSubdir = path.join("packages", "escaped");
    fs.mkdirSync(path.join(f.cwd, escapedSubdir), { recursive: true });
    fs.symlinkSync(outsideTarget, path.join(wtOneRoot, escapedSubdir), "dir");
    fs.rmSync(wtTwoRoot, { recursive: true, force: true });
    git(f, "worktree", "prune");
    fs.rmSync(wtOneRoot, { recursive: true, force: true });
    git(f, "worktree", "prune");
    const wtThreeRoot = path.join(f.root, "wt-three");
    git(f, "worktree", "add", "--detach", wtThreeRoot, "HEAD");
    fs.mkdirSync(path.join(wtThreeRoot, "packages"), { recursive: true });
    fs.symlinkSync(outsideTarget, path.join(wtThreeRoot, escapedSubdir), "dir");
    fs.writeFileSync(
      path.join(f.cwd, ".git", "worktrees", "wt-three", "codex-thread.json"),
      JSON.stringify({ version: 1, ownerThreadId: sessionUuid })
    );
    fs.rmSync(path.join(f.codexHome, "sessions"), { recursive: true, force: true });
    const escapedResume = await invoke(f, "codex_resume", {
      cwd: path.join(f.cwd, escapedSubdir), prompt: "Continue safely.", sessionId: sessionUuid
    });
    assert.equal(escapedResume.isError, false);
    assert.equal(JSON.parse(escapedResume.text).worktreePath, wtThreeRoot);
  }
});

test("passes resolved absolute CODEX_HOME to spawned Codex", async (t) => {
  const f = fixture(t);
  const relHome = "rel-codex-home";
  const absHome = path.join(f.root, relHome);
  f.codexHome = absHome;
  writeSessionRollout(f, sessionUuid, f.cwd);
  f.codexHome = relHome;
  f.extraEnv = { FAKE_CODEX_LOG_HOME: "1" };
  const { text, isError, invocations } = await invoke(f, "codex_resume", {
    cwd: f.cwd, prompt: "Continue.", last: true
  });
  assert.equal(isError, false);
  assert.equal(JSON.parse(text).resumable, true);
  assert.equal(invocations[0].codexHome, absHome);
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

function runHeldCall(f, options = {}, _meta) {
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
  send(rpc(1, "tools/call", { name: "codex_exec", arguments: { cwd: f.cwd, prompt: "Hold.", ...options }, _meta }));
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

test("suppresses progress after cancellation", { skip: isWindows && "POSIX signal handlers only" }, async (t) => {
  const f = fixture(t, { mode: "cancel-progress" });
  const token = "cancel";
  const { server, signal, exited, output, replies, send, started } = runHeldCall(f, {}, { progressToken: token });
  let pid;
  try {
    const [invocation] = await Promise.all([started, once(output, "line", { signal })]);
    pid = invocation.pid;
    const stopped = waitForStatus(f, signal, "stopped");
    send(rpc(undefined, "notifications/cancelled", { requestId: 1 }));
    await stopped;
    await waitForProcessDeath(pid, signal);

    const pong = once(output, "line", { signal });
    send(rpc(2, "ping"));
    await pong;
    server.stdin.end();
    assert.deepEqual(await exited, [0, null]);
    assert.deepEqual(replies, [
      progressMessage(token, 1, "Codex session started: thread-123"),
      { jsonrpc: "2.0", id: 2, result: {} }
    ]);
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
