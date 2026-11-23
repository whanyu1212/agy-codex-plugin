import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function writeFakeCodex(bin, source) {
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "codex.js"), source);
    // Match the invocation line in npm's Windows shim.
    fs.writeFileSync(path.join(bin, "codex.cmd"), '"%_prog%" "%dp0%\\codex.js" %*\r\n');
  } else {
    fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  }
}

function readHostPath() {
  const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path");
  return entry?.[1] ?? "";
}

export function envWithPath(pathValue, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() !== "path") {
      env[key] = value;
    }
  }
  return { ...env, PATH: pathValue, ...extra };
}

export function fakeCodexPath(bin, withGit) {
  if (!withGit) {
    return bin;
  }
  const hostPath = readHostPath();
  if (process.platform !== "win32") {
    return [bin, hostPath].join(path.delimiter);
  }

  // The Windows resolver prefers any codex.exe to the fixture's codex.cmd.
  const directories = hostPath.split(path.delimiter).filter(Boolean).map((dir) => dir.replace(/^"|"$/g, ""));
  const gitDir = directories.find((dir) =>
    fs.existsSync(path.join(dir, "git.exe")) && !fs.existsSync(path.join(dir, "codex.exe"))
  );
  if (!gitDir) {
    throw new Error("The tests need a Git for Windows PATH entry without codex.exe.");
  }
  return [bin, gitDir].join(path.delimiter);
}
