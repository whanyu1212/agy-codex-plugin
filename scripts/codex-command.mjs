import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const outputLimit = 1024 * 1024;
const pipeDrainMs = 250;
const terminationGraceMs = 500;
const useProcessGroups = process.platform !== "win32";
const activeChildren = new Set();
export const truncationMarker = "[output truncated]";

async function isFile(file) {
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() ?? false;
}

async function resolveWindowsCodex(args, signal) {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    signal.throwIfAborted();
    const executable = path.resolve(directory.replace(/^"|"$/g, ""), "codex.exe");
    if (await isFile(executable)) {
      return [executable, args];
    }
  }
  for (const directory of directories) {
    signal.throwIfAborted();
    const shim = path.resolve(directory.replace(/^"|"$/g, ""), "codex.cmd");
    const contents = await fs.readFile(shim, { encoding: "utf8", signal }).catch(() => "");
    signal.throwIfAborted();
    // Read npm's generated Node entrypoint without evaluating the batch file.
    const target = contents.match(/"%_prog%"[ \t]+"%dp0%\\([^"\r\n]+\.js)"[ \t]+%\*[ \t]*$/im)?.[1];
    if (target) {
      const entrypoint = path.resolve(path.dirname(shim), target);
      if (await isFile(entrypoint)) {
        return [process.execPath, [entrypoint, ...args]];
      }
    }
  }
  signal.throwIfAborted();
  throw new Error("Could not start Codex. Check PATH for codex.exe or an npm-generated codex.cmd.");
}

export async function withAbort(signal, start) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, start()]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function cleanOutput(text) {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

export function boundedOutput() {
  let buffer;
  let size = 0;
  let truncated = false;
  return {
    get truncated() { return truncated; },
    append(chunk) {
      const length = Math.min(chunk.length, outputLimit - size);
      if (length > 0) {
        if (size + length > (buffer?.length ?? 0)) {
          const capacity = Math.min(outputLimit, Math.max(256, size + length, 2 * (buffer?.length ?? 0)));
          const grown = Buffer.allocUnsafe(capacity);
          buffer?.copy(grown, 0, 0, size);
          buffer = grown;
        }
        chunk.copy(buffer, size, 0, length);
        size += length;
      }
      truncated ||= length < chunk.length;
    },
    text() {
      return (buffer?.toString("utf8", 0, size) ?? "") + (truncated ? `\n${truncationMarker}` : "");
    }
  };
}

function signalGroup(pid, signal) {
  if (useProcessGroups && pid !== undefined) {
    try {
      return process.kill(-pid, signal);
    } catch (error) {
      return signal === 0 && error.code === "EPERM";
    }
  }
  return false;
}

async function waitForProcessTree(child, isRunning, graceMs) {
  const deadline = performance.now() + graceMs;
  while (isRunning() || signalGroup(child.pid, 0)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return false;
    }
    await delay(Math.min(remaining, 25));
  }
  return true;
}

const windowsTaskkillTimeoutMs = 5_000;

async function terminateProcessTree(child, isRunning) {
  if (!useProcessGroups) {
    if (isRunning()) {
      // Killing the npm launcher alone would leave its native Codex subprocess running.
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
      const args = ["/PID", String(child.pid), "/T", "/F"];
      await new Promise((done) => execFile(taskkill, args, { timeout: windowsTaskkillTimeoutMs, windowsHide: true }, done));
      if (isRunning()) {
        child.kill("SIGKILL");
        await waitForProcessTree(child, isRunning, pipeDrainMs);
      }
    }
    return;
  }
  if (!signalGroup(child.pid, "SIGTERM") && isRunning()) {
    child.kill("SIGTERM");
  }
  if (!await waitForProcessTree(child, isRunning, terminationGraceMs)) {
    if (!signalGroup(child.pid, "SIGKILL") && isRunning()) {
      child.kill("SIGKILL");
    }
    await waitForProcessTree(child, isRunning, pipeDrainMs);
  }
}

export function runCommand(command, args, {
  cwd, input, signal, events, label, ignoreStderr = false, failOnTruncatedOutput = false
}) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, stdio: ["pipe", "pipe", ignoreStderr ? "ignore" : "pipe"], detached: useProcessGroups, windowsHide: true
    });
    const stdout = boundedOutput();
    const stderr = boundedOutput();
    let running = child.pid !== undefined;
    let settled = false;
    let drainTimer;
    let stdinError;
    let spawnError;
    let termination;
    const terminate = () => termination ??= terminateProcessTree(child, () => running);

    activeChildren.add(terminate);
    signal.addEventListener("abort", terminate, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
      if (failOnTruncatedOutput && stdout.truncated) {
        terminate();
      }
      events?.append(chunk);
    });
    child.stderr?.on("data", (chunk) => stderr.append(chunk));
    child.stdin.on("error", (error) => { stdinError = error; });
    child.on("error", (error) => {
      spawnError = error;
    });

    function finish(code, exitSignal) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(drainTimer);
      const complete = () => {
        activeChildren.delete(terminate);
        signal.removeEventListener("abort", terminate);
        signal.throwIfAborted();
        const output = { stdout: stdout.text(), stderr: stderr.text() };
        if (spawnError) {
          const message = spawnError.code === "ENOENT"
            ? `Could not start ${label}. Check that ${label} is installed and available on PATH and cwd still exists.`
            : `Could not start ${label}: ${spawnError.message}`;
          throw new Error(message, { cause: spawnError });
        }
        if (failOnTruncatedOutput && stdout.truncated) {
          throw new Error(`${label} output exceeded ${outputLimit} bytes.`);
        }
        if (code !== 0) {
          const status = exitSignal ? `was terminated by ${exitSignal}` : `exited with code ${code}`;
          const details = [cleanOutput(output.stderr), cleanOutput(output.stdout)].filter(Boolean).join("\n");
          throw new Error(`${label} ${status}.${details ? `\n${details}` : ""}`);
        }
        if (stdinError) {
          throw new Error(`Could not send input to ${label}: ${stdinError.message}`, { cause: stdinError });
        }
        return { ...output, result: events?.finish(output.stdout) };
      };
      Promise.resolve(termination).then(complete).then(resolve, reject);
    }

    child.once("exit", (code, exitSignal) => {
      running = false;
      drainTimer = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr?.destroy();
        finish(code, exitSignal);
      }, pipeDrainMs);
    });
    child.once("close", (code, exitSignal) => {
      running = false;
      finish(code, exitSignal);
    });
    child.stdin.end(input);
  });
}

export async function runCodex(args, options) {
  // A PATH entry can be on a network share, and fs.stat cannot be aborted.
  const [command, argv] = useProcessGroups
    ? ["codex", args]
    : await withAbort(options.signal, () => resolveWindowsCodex(args, options.signal));
  return runCommand(command, argv, { ...options, label: "Codex" });
}

export async function terminateActiveCommands() {
  await Promise.allSettled([...activeChildren].map((terminate) => terminate()));
}
