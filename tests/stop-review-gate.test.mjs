import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { envWithPath, fakeCodexPath, writeFakeCodex } from "./fixtures/fake-codex.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.resolve(TEST_DIR, "../scripts/stop-review-gate.mjs");
const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeGitRepo({ dirty }) {
  const repoDir = makeTempDir("agy-codex-repo-");
  const git = (...args) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore", timeout: 10_000 });
  git("init", "-b", "main");
  fs.writeFileSync(path.join(repoDir, "app.js"), "export const x = 1;\n", "utf8");
  git("add", "app.js");
  git("-c", "user.name=Test User", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
    "commit", "-m", "init");

  if (dirty) {
    fs.writeFileSync(path.join(repoDir, "app.js"), "export const x = 2;\n", "utf8");
  }
  return repoDir;
}

function makeFakeCodexBin(scriptBody) {
  const binDir = makeTempDir("agy-codex-bin-");
  writeFakeCodex(binDir, scriptBody);
  return binDir;
}

function hookEnv(fakeBinDir) {
  return envWithPath(fakeCodexPath(fakeBinDir, true));
}

function runHook(payload, fakeBinDir) {
  const res = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
    env: hookEnv(fakeBinDir)
  });
  assert.ifError(res.error);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("skips codex when continuationActive is true", () => {
  const repoDir = makeGitRepo({ dirty: true });
  const marker = path.join(repoDir, "codex-called");
  const binDir = makeFakeCodexBin(
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");`
  );

  const out = runHook(
    { continuationActive: true, terminationReason: "NO_TOOL_CALL", cwd: repoDir },
    binDir
  );
  assert.deepEqual(out, {});
  assert.equal(fs.existsSync(marker), false);
});

test("skips codex when terminationReason is not NO_TOOL_CALL", () => {
  const repoDir = makeGitRepo({ dirty: true });
  const marker = path.join(repoDir, "codex-called");
  const binDir = makeFakeCodexBin(
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");`
  );

  const out = runHook(
    { continuationActive: false, terminationReason: "USER_CANCELED", cwd: repoDir },
    binDir
  );
  assert.deepEqual(out, {});
  assert.equal(fs.existsSync(marker), false);
});

test("skips codex when git tree is clean", () => {
  const repoDir = makeGitRepo({ dirty: false });
  const marker = path.join(repoDir, "codex-called");
  const binDir = makeFakeCodexBin(
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");`
  );

  const out = runHook(
    { continuationActive: false, terminationReason: "NO_TOOL_CALL", cwd: repoDir },
    binDir
  );
  assert.deepEqual(out, {});
  assert.equal(fs.existsSync(marker), false);
});

test("skips codex for non-git directory", () => {
  const nonGitDir = makeTempDir("agy-codex-nongit-");
  const marker = path.join(nonGitDir, "codex-called");
  const binDir = makeFakeCodexBin(
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");`
  );

  const out = runHook(
    { continuationActive: false, terminationReason: "NO_TOOL_CALL", cwd: nonGitDir },
    binDir
  );
  assert.deepEqual(out, {});
  assert.equal(fs.existsSync(marker), false);
});

test("allows stop when codex returns block=false", () => {
  const repoDir = makeGitRepo({ dirty: true });
  const binDir = makeFakeCodexBin(
    `process.stdout.write(JSON.stringify({ block: false, summary: "" }) + "\\n");`
  );

  const out = runHook(
    { continuationActive: false, terminationReason: "NO_TOOL_CALL", cwd: repoDir },
    binDir
  );
  assert.deepEqual(out, {});
});

test("blocks stop when codex outputs preamble and block=true verdict", () => {
  const repoDir = makeGitRepo({ dirty: true });
  const binDir = makeFakeCodexBin(
    [
      'process.stdout.write("Checking diff...\\n");',
      'process.stdout.write(JSON.stringify({ block: true, summary: "null deref in app.js:10" }) + "\\n");'
    ].join("\n")
  );

  const out = runHook(
    { continuationActive: false, terminationReason: "NO_TOOL_CALL", cwd: repoDir },
    binDir
  );
  assert.deepEqual(out, {
    decision: "continue",
    reason: "Codex stop-gate review found blocking issues:\nnull deref in app.js:10"
  });
});

test("fails open when codex exits non-zero", () => {
  const repoDir = makeGitRepo({ dirty: true });
  const binDir = makeFakeCodexBin(`process.exit(2);`);

  const out = runHook(
    { continuationActive: false, terminationReason: "NO_TOOL_CALL", cwd: repoDir },
    binDir
  );
  assert.deepEqual(out, {});
});

test("fails open when codex outputs malformed JSON", () => {
  const repoDir = makeGitRepo({ dirty: true });
  const binDir = makeFakeCodexBin(`process.stdout.write("{not valid json\\n");`);

  const out = runHook(
    { continuationActive: false, terminationReason: "NO_TOOL_CALL", cwd: repoDir },
    binDir
  );
  assert.deepEqual(out, {});
});

test("fails open on oversized output", () => {
  const repoDir = makeGitRepo({ dirty: true });
  const binDir = makeFakeCodexBin(
    'process.stdout.write(\'{"block":true,"summary":"Would block"}\\n\' + "x".repeat(2 ** 20));'
  );

  const out = runHook({ terminationReason: "NO_TOOL_CALL", cwd: repoDir }, binDir);
  assert.deepEqual(out, {});
});

test("terminates Codex when interrupted", {
  skip: process.platform === "win32" && "POSIX signal handlers only"
}, async () => {
  const cwd = makeGitRepo({ dirty: true });
  const marker = path.join(cwd, "codex-pid");
  const bin = makeFakeCodexBin(`
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(marker + ".tmp")}, String(process.pid));
    fs.renameSync(${JSON.stringify(marker + ".tmp")}, ${JSON.stringify(marker)});
    setInterval(() => {}, 60_000);
  `);
  const signal = AbortSignal.timeout(5_000);
  const hook = spawn(process.execPath, [HOOK_SCRIPT], {
    env: hookEnv(bin), stdio: ["pipe", "ignore", "ignore"]
  });
  const exited = once(hook, "exit", { signal });
  let pid;
  try {
    hook.stdin.end(JSON.stringify({ terminationReason: "NO_TOOL_CALL", cwd }));
    while (!fs.existsSync(marker)) {
      await delay(25, undefined, { signal });
    }
    pid = Number(fs.readFileSync(marker, "utf8"));
    assert.ok(pid > 0);
    hook.kill("SIGTERM");
    assert.deepEqual(await exited, [null, "SIGTERM"]);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    hook.kill("SIGKILL");
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
});
