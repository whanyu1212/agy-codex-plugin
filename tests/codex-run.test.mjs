import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { envWithPath, fakeCodexPath, writeFakeCodex } from "./fixtures/fake-codex.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/codex-run.mjs", import.meta.url));
const isWindows = process.platform === "win32";
const prompt = "Check `$(echo literal)`.\nKeep both lines.\n";
const execOutput = '{"sessionId":"thread-123","finalMessage":"Done."}\n';
const fakeCodex = String.raw`const fs = require("node:fs");
const argv = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
const log = process.env.FAKE_CODEX_LOG;
const invocation = { argv, input, cwd: process.cwd() };
if (process.env.FAKE_CODEX_MODE === "trap-term") {
  process.on("SIGTERM", () => fs.appendFileSync(log, '"trapped"\n'));
  setInterval(() => {}, 60_000);
  invocation.pid = process.pid;
}
fs.appendFileSync(log, JSON.stringify(invocation) + "\n");
if (invocation.pid === undefined) {
  if (argv[0] === "--version") {
    console.log("codex-cli 0.test");
  } else if (argv[0] === "doctor") {
    console.log("Summary checks passed.");
  } else if (argv.includes("review")) {
    console.log("Review complete.");
  } else {
    console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-123" }));
    console.log(JSON.stringify({ type: "agent_message", text: "Done." }));
  }
}
`;

function fixture(t, { withGit = false, mode = "" } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-run-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const root = fs.realpathSync.native(temp);
  const cwd = path.join(root, "project with spaces");
  const bin = path.join(root, "bin");
  const log = path.join(root, "codex.jsonl");
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin);
  fs.writeFileSync(log, "");
  if (!isWindows) {
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
  }
  writeFakeCodex(bin, fakeCodex);
  const env = envWithPath(fakeCodexPath(bin, withGit), { FAKE_CODEX_LOG: log, FAKE_CODEX_MODE: mode });
  return { cwd, root, log, env };
}

function initGit({ cwd }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 3_000 }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Runner test", "-c", "user.email=runner@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-qm", "Initial commit", "--allow-empty");
  return git("rev-parse", "HEAD");
}

function readLog({ log }) {
  return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function invoke(f, args, input = "") {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: f.cwd, env: f.env, input, encoding: "utf8", timeout: 5_000
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertSuccess(f, flags, expected, input) {
  assert.deepEqual(invoke(f, flags, input), { status: 0, stdout: expected, stderr: "" });
}

function assertRejected(f, flags, message, input) {
  const { status, stdout, stderr } = invoke(f, flags, input);
  assert.equal(status, 1, stderr);
  assert.equal(stdout, "");
  assert.match(stderr, message);
  assert.deepEqual(readLog(f), []);
}

for (const [label, flags] of [
  ["uncommitted changes", ["--uncommitted"]],
  ["base branch", ["--base", "main"]],
  ["specific commit", ["--commit", "HEAD"]]
]) {
  test(`reviews ${label}`, (t) => {
    const f = fixture(t, { withGit: flags[0] !== "--uncommitted" });
    const sha = flags[0] === "--uncommitted" ? undefined : initGit(f);
    assertSuccess(f, ["review", ...flags], "Review complete.\n");
    const target = flags[0] === "--commit" ? ["--commit", sha] : flags;
    assert.deepEqual(readLog(f), [{ argv: ["exec", "-s", "read-only", "review", ...target], cwd: f.cwd, input: "" }]);
  });
}

test("frames stdin review prompt", (t) => {
  const f = fixture(t, { withGit: true });
  const sha = initGit(f);
  assertSuccess(f, ["review", "--base", "main", "--prompt-stdin", "--effort", "high"], "Review complete.\n", prompt);
  assert.deepEqual(readLog(f), [{
    argv: ["exec", "-s", "read-only", "-c", "model_reasoning_effort=high", "review", "-"],
    cwd: f.cwd, input: `Target: base ${sha}\n\n${prompt}`
  }]);
});

for (const [label, flags, message] of [
  ["missing branch", ["--base", "missing-branch"], /Cannot resolve Git ref/],
  ["dash-prefixed ref", ["--commit=--help"], /Cannot resolve Git ref "--help"/],
  ["conflicting targets", ["--uncommitted", "--base", "main"], /mutually exclusive/],
  ["two ref targets", ["--base", "main", "--commit", "HEAD"], /mutually exclusive/]
]) {
  test(`rejects ${label}`, (t) => {
    const requiresGit = message.source.startsWith("Cannot resolve");
    const f = fixture(t, { withGit: requiresGit });
    if (requiresGit) initGit(f);
    assertRejected(f, ["review", ...flags], message);
  });
}

test("defaults to read-only exec", (t) => {
  const f = fixture(t);
  assertSuccess(f, ["exec"], execOutput, prompt);
  assert.deepEqual(readLog(f), [{ argv: ["exec", "--json", "-s", "read-only", "-C", f.cwd, "-"], cwd: f.cwd, input: prompt }]);
});

test("executes with worktree and model", (t) => {
  const f = fixture(t);
  assertSuccess(f, [
    "exec", "--cwd", "..", "--sandbox", "workspace-write", "--worktree", "--model", "test-model", "--timeout-ms", "4000"
  ], execOutput, prompt);
  assert.deepEqual(readLog(f), [{
    argv: ["exec", "--json", "-s", "workspace-write", "-C", f.root, "-m", "test-model", "--worktree", "-"],
    cwd: f.cwd, input: prompt
  }]);
});

for (const [label, flags, message] of [
  ["read-only worktree", ["--sandbox", "read-only", "--worktree"], /worktree requires sandbox "workspace-write"/],
  ["ephemeral worktree", ["--sandbox", "workspace-write", "--worktree", "--ephemeral"], /worktree and ephemeral/],
  ["dash-prefixed model", ["--model=--help"], /model must not start with '-'/],
  ["invalid sandbox", ["--sandbox", "danger-full-access"], /--sandbox must be one of/],
  ["invalid effort", ["--effort", "extra-high"], /--effort must be one of/],
  ["invalid timeout", ["--timeout-ms", "999"], /--timeout-ms must be an integer from 1000 to 1800000/],
  ["unknown option", ["--unknown"], /Unknown option/],
  ["missing option value", ["--model"], /argument missing/]
]) {
  test(`rejects ${label}`, (t) => {
    assertRejected(fixture(t), ["exec", ...flags], message, prompt);
  });
}

for (const flags of [["exec"], ["resume"], ["review", "--prompt-stdin"]]) {
  test(`rejects empty ${flags[0]} prompt`, (t) => {
    assertRejected(fixture(t), flags, /Prompt on stdin must not be empty/, " \n");
  });
}

for (const [label, flags, selection] of [
  ["the latest session", [], ["--last"]],
  ["a named session", ["--session", "thread-123"], ["thread-123"]]
]) {
  test(`resumes ${label}`, (t) => {
    const f = fixture(t);
    assertSuccess(f, ["resume", ...flags], execOutput, prompt);
    assert.deepEqual(readLog(f), [{
      argv: ["exec", "-s", "read-only", "resume", "--json", ...selection, "-"], cwd: f.cwd, input: prompt
    }]);
  });
}

test("reports version and diagnostics", (t) => {
  const f = fixture(t);
  assertSuccess(f, ["doctor"], "codex-cli 0.test\n\nSummary checks passed.\n");
  assert.deepEqual(readLog(f), [["--version"], ["doctor", "--summary"]].map((argv) => ({ argv, cwd: f.cwd, input: "" })));
});

test("terminates Codex on SIGTERM", { skip: isWindows && "POSIX signal handlers only" }, async (t) => {
  const f = fixture(t, { mode: "trap-term" });
  const signal = AbortSignal.timeout(5_000);
  const watcher = fs.watch(f.log);
  const runner = spawn(process.execPath, [RUNNER, "exec"], { cwd: f.cwd, env: f.env, stdio: ["pipe", "ignore", "ignore"] });
  const exited = once(runner, "close", { signal });
  let pid;
  try {
    const started = once(watcher, "change", { signal });
    runner.stdin.end(prompt);
    await started;
    pid = readLog(f)[0]?.pid;
    assert.ok(pid > 0);
    assert.equal(runner.kill("SIGTERM"), true);
    assert.deepEqual(await exited, [143, null]);
    assert.equal(readLog(f)[1], "trapped");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    watcher.close();
    runner.kill("SIGKILL");
    pid ??= readLog(f)[0]?.pid;
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
});
