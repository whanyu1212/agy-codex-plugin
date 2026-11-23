# agy-codex-plugin

A zero-dependency **Antigravity (`agy`)** plugin for delegating code reviews, adversarial audits, and debugging or implementation tasks to your local OpenAI **Codex CLI** (`codex`), built on Antigravity's native primitives with no background broker.

## Quick Start

### Prerequisites

- **OpenAI Codex CLI** (`codex`) installed (`brew install --cask codex` or `npm install -g @openai/codex`) and authenticated (`codex login`)
- **Antigravity** (`agy` CLI, Antigravity App, or Antigravity IDE)
- **Node.js 22.15+** on `PATH` (for the bundled CLI runner, MCP server, and optional Stop hook)

### Install

```bash
# Install directly from GitHub
agy plugin install https://github.com/whanyu1212/agy-codex-plugin

# Or install from a local clone
git clone https://github.com/whanyu1212/agy-codex-plugin.git
agy plugin install ./agy-codex-plugin
```

Verify the plugin is enabled, then run `/codex-setup` inside Antigravity to verify `codex doctor`:

```bash
agy plugin list
```

## Slash Commands

| Command | Purpose | Example |
| :--- | :--- | :--- |
| `/codex-review` | Read-only review of uncommitted changes, a base branch, or a commit | `/codex-review --base main` |
| `/codex-adversarial` | Skeptical review probing invariants, concurrency, edge cases, and security | `/codex-adversarial focus on auth and race conditions` |
| `/codex-rescue` | Delegate diagnosis (`read-only`), fixes (`workspace-write`), or follow-ups | `/codex-rescue diagnose why tests/auth.test.ts is flaky` |
| `/codex-setup` | Check `codex` binary, version, and authentication health | `/codex-setup` |

The skills run [`scripts/codex-run.mjs`](scripts/codex-run.mjs) for background work. Use `node /path/to/plugin/scripts/codex-run.mjs` with `review`, `exec`, `resume`, or `doctor` from your repository. For bounded runs, pass `--effort medium`. To continue a specific session, run `resume --session <sessionId>` with the follow-up prompt on stdin (pass `--cwd <worktreePath>` when resuming a managed worktree, or opt in to the latest session with `--last`).

## MCP Tools

Antigravity starts the bundled zero-dependency Node.js stdio MCP server via [`mcp_config.json`](mcp_config.json).

| Tool | Key parameters | Output |
| :--- | :--- | :--- |
| `codex_review` | `cwd`, optional `target` (`uncommitted` default, `base`, `commit`), `base`/`commit`, `prompt` | Read-only review output |
| `codex_exec` | `cwd`, `prompt`, optional `sandbox` (`read-only` default or `workspace-write`), `model`, `worktree`, `ephemeral` | JSON with `sessionId`, `resumable`, `repoRoot`, `worktreePath`, `finalMessage` |
| `codex_resume` | `cwd` (pass prior `worktreePath` if present), `prompt`, `sessionId` (or `last: true` opt-in), optional `sandbox` | JSON with `sessionId`, `resumable`, `repoRoot`, `worktreePath`, `finalMessage` |
| `codex_doctor` | Optional `cwd` | Codex version and diagnostic output |

Common options & notes:
- `effort`: optional `low`, `medium`, or `high` on `codex_review`, `codex_exec`, and `codex_resume`.
- `timeoutMs`: optional integer from `1000` to `1800000` ms (defaults: 10 minutes for review/exec/resume, 1 minute for doctor).
- `worktree` requires `sandbox: "workspace-write"` and cannot be combined with `ephemeral` on `codex_exec`.
- Set `params._meta.progressToken` on `codex_exec` or `codex_resume` calls to receive session and throttled item updates via `notifications/progress`.

**When to use MCP tools vs. slash commands:** Use MCP tools for structured, token-efficient, session-tracked invocations across Antigravity CLI, App, and IDE; use `/codex-*` skills or `codex-delegate` when you want explicit slash workflows or background wakeup on long-running tasks.

## Background Subagent (`codex-delegate`)

[`agents/codex-delegate.md`](agents/codex-delegate.md) registers a `flash` background subagent so Antigravity can offload second opinions, code reviews, or `codex exec` runs without blocking your main conversation.

## Optional Stop Review Gate

[`hooks.json`](hooks.json) defines an opt-in `Stop` hook (`codex-stop-review-gate`) that runs a read-only ephemeral Codex check on uncommitted changes before Antigravity ends a turn. It is disabled by default (`"enabled": false`) and fails open on errors, timeouts, clean repos, or when `continuationActive` is `true` to avoid loops.

To enable it, set `"enabled": true` in your installed plugin copy at `~/.gemini/config/plugins/codex-cli/hooks.json`.

## Development & Testing

Run `agy plugin install .` after edits to refresh the locally installed plugin.

```bash
# Run unit tests (uses a fake codex fixture on PATH)
node --test tests/manifest.test.mjs tests/codex-run.test.mjs tests/stop-review-gate.test.mjs tests/mcp-server.test.mjs

# Strictly validate the plugin manifest and MCP server registration
agy plugin validate --strict .
```

CI runs these tests on Node.js 22 across Linux, macOS, and Windows via [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## License

[MIT](LICENSE)
