import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

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
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
    stdio: "ignore"
  });
  execFileSync("git", ["config", "user.name", "Test User"], {
    cwd: repoDir,
    stdio: "ignore"
  });
  fs.writeFileSync(path.join(repoDir, "app.js"), "export const x = 1;\n", "utf8");
  execFileSync("git", ["add", "app.js"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });

  if (dirty) {
    fs.writeFileSync(path.join(repoDir, "app.js"), "export const x = 2;\n", "utf8");
  }
  return repoDir;
}

function makeFakeCodexBin(scriptBody) {
  const binDir = makeTempDir("agy-codex-bin-");
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, `#!/usr/bin/env node\n${scriptBody}\n`, "utf8");
  fs.chmodSync(codexPath, 0o755);
  return binDir;
}

function runHook(payload, fakeBinDir) {
  const env = { ...process.env };
  if (fakeBinDir) {
    env.PATH = `${fakeBinDir}:${env.PATH ?? ""}`;
  }
  const res = spawnSync("node", [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env
  });
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
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "called");`
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
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "called");`
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
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "called");`
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
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "called");`
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
