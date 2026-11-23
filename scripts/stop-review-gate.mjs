#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const CODEX_TIMEOUT_MS = 240_000;

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function allowStop() {
  process.stdout.write("{}\n");
}

function isGitRepoWithChanges(cwd) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000
    });
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

function parseVerdict(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.block === "boolean") {
        return parsed;
      }
    } catch {
      // Ignore non-JSON lines and keep scanning backward.
    }
  }
  return null;
}

function main() {
  const input = readStdinJson();
  if (!input || input.continuationActive === true || input.terminationReason !== "NO_TOOL_CALL") {
    allowStop();
    return;
  }

  const cwd = typeof input.cwd === "string" ? input.cwd : "";
  if (!cwd || !fs.existsSync(cwd) || !isGitRepoWithChanges(cwd)) {
    allowStop();
    return;
  }

  const prompt = [
    "Review the uncommitted changes in this repository (inspect `git status` and `git diff`).",
    "Block ONLY for concrete bugs, behavioral regressions, broken error handling, or security vulnerabilities.",
    "Do NOT block for style preferences, naming, or minor refactors.",
    'Respond with a single final JSON line and nothing else after it: {"block": false, "summary": ""} or {"block": true, "summary": "<concise list of blocking issues with file paths>"}.'
  ].join("\n");

  const result = spawnSync(
    "codex",
    ["exec", "-s", "read-only", "--ephemeral", "-C", cwd, "-"],
    {
      input: prompt,
      encoding: "utf8",
      timeout: CODEX_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "ignore"]
    }
  );

  // Fail open if codex is missing, timed out, or errored.
  if (result.error || result.status !== 0 || !result.stdout) {
    allowStop();
    return;
  }

  const verdict = parseVerdict(result.stdout);
  const summary = typeof verdict?.summary === "string" ? verdict.summary.trim() : "";
  if (verdict?.block === true && summary) {
    process.stdout.write(
      `${JSON.stringify({
        decision: "continue",
        reason: `Codex stop-gate review found blocking issues:\n${summary}`
      })}\n`
    );
    return;
  }

  allowStop();
}

main();
