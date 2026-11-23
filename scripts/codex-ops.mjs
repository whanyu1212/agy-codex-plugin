import { promises as fs } from "node:fs";
import { cleanOutput, collectExecEvents, runCodex, runGit, withAbort } from "./codex-command.mjs";

export const defaultSandbox = "read-only";
export const sandboxes = Object.freeze([defaultSandbox, "workspace-write"]);
export const efforts = Object.freeze(["low", "medium", "high"]);
export const minTimeoutMs = 1_000;
export const maxTimeoutMs = 1_800_000;
export const defaultTimeoutMs = 600_000;
export const doctorTimeoutMs = 60_000;

export async function runOperation(run, args, { name, signal, onEvent, timeoutMs }) {
  signal.throwIfAborted();
  const timeout = new AbortController();
  const executionSignal = AbortSignal.any([signal, timeout.signal]);
  const timer = setTimeout(() => {
    timeout.abort(new Error(`${name} timed out after ${timeoutMs} ms.`));
  }, timeoutMs).unref();
  try {
    const toolArgs = args.cwd === undefined ? args : { ...args, cwd: await validateCwd(args.cwd, executionSignal) };
    const report = onEvent && ((event) => {
      if (!executionSignal.aborted) onEvent(event);
    });
    return await run(toolArgs, executionSignal, report);
  } finally {
    clearTimeout(timer);
  }
}

async function validateCwd(cwd, signal) {
  let canonicalCwd;
  let info;
  try {
    canonicalCwd = await withAbort(signal, () => fs.realpath(cwd));
    info = await withAbort(signal, () => fs.stat(canonicalCwd));
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(`Cannot access cwd ${JSON.stringify(cwd)}: ${error.message}`, { cause: error });
  }
  if (!info.isDirectory()) {
    throw new Error(`cwd must be a directory: ${JSON.stringify(cwd)}.`);
  }
  return canonicalCwd;
}

function effortArgs(effort) {
  return effort === undefined ? [] : ["-c", `model_reasoning_effort=${effort}`];
}

function commandOutput({ stdout, stderr }) {
  return cleanOutput(stdout) || cleanOutput(stderr);
}

export async function runReview({ cwd, target = "uncommitted", base, commit, prompt, effort }, signal) {
  if (target !== "base" && base !== undefined) {
    throw new Error("base can only be used when target is base.");
  }
  if (target !== "commit" && commit !== undefined) {
    throw new Error("commit can only be used when target is commit.");
  }
  const ref = { base, commit }[target];
  if (target !== "uncommitted" && ref === undefined) {
    throw new Error(`${target} is required when target is ${target}.`);
  }
  let sha;
  if (ref !== undefined) {
    try {
      const { stdout } = await runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd, signal });
      sha = stdout.trim();
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(`Cannot resolve Git ref ${JSON.stringify(ref)} to a commit. ${error.message}`, { cause: error });
    }
  }
  const args = ["exec", "-s", defaultSandbox, ...effortArgs(effort), "review"];
  if (prompt !== undefined) {
    const header = sha === undefined ? target : `${target} ${sha}`;
    return commandOutput(await runCodex([...args, "-"], { cwd, input: `Target: ${header}\n\n${prompt}`, signal }));
  }
  args.push(`--${target}`);
  if (ref !== undefined) {
    args.push(target === "commit" || ref.startsWith("-") ? sha : ref);
  }
  return commandOutput(await runCodex(args, { cwd, signal }));
}

export async function runExec({ cwd, prompt, sandbox = defaultSandbox, model, worktree, ephemeral, effort }, signal, onEvent) {
  if (worktree && ephemeral) {
    throw new Error("worktree and ephemeral cannot be combined.");
  }
  if (worktree && sandbox !== "workspace-write") {
    throw new Error('worktree requires sandbox "workspace-write".');
  }
  if (model !== undefined && model.startsWith("-")) {
    throw new Error("model must not start with '-'.");
  }
  const args = ["exec", "--json", "-s", sandbox, "-C", cwd, ...effortArgs(effort)];
  if (model !== undefined) {
    args.push("-m", model);
  }
  if (worktree) {
    args.push("--worktree");
  }
  if (ephemeral) {
    args.push("--ephemeral");
  }
  const { result } = await runCodex([...args, "-"], {
    input: prompt, signal, events: collectExecEvents({ fallbackToStdout: true, onEvent })
  });
  return JSON.stringify(result);
}

export async function runResume({ cwd, prompt, sessionId, sandbox = defaultSandbox, effort }, signal, onEvent) {
  const args = ["exec", "-s", sandbox, ...effortArgs(effort), "resume", "--json"];
  if (sessionId === undefined) {
    args.push("--last");
  } else {
    // A thread name can begin with a dash. Keep it in the positional arguments.
    if (sessionId.startsWith("-")) {
      args.push("--");
    }
    args.push(sessionId);
  }
  const { result } = await runCodex([...args, "-"], {
    cwd, input: prompt, signal, events: collectExecEvents({ fallbackToStdout: true, onEvent })
  });
  return JSON.stringify(result);
}

export async function runDoctor({ cwd }, signal) {
  const version = await runCodex(["--version"], { cwd, signal });
  let report;
  try {
    report = await runCodex(["doctor", "--summary"], { cwd, signal });
  } catch (error) {
    const unsupportedSummary = /\b(?:unexpected|unknown|unrecognized|unsupported)\s+(?:argument|option|flag)s?[\s:'"`]*--summary\b/i;
    if (!unsupportedSummary.test(error.message)) {
      throw error;
    }
    report = await runCodex(["doctor"], { cwd, signal });
  }
  return [commandOutput(version), commandOutput(report)].filter(Boolean).join("\n\n");
}
