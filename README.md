# agy-codex-plugin

A minimal, zero-broker **Antigravity (`agy`)** plugin for delegating code reviews, adversarial audits, and debugging or implementation tasks to your local OpenAI **Codex CLI** (`codex`).

## Why This Architecture (Zero-Broker Design)

Instead of shipping a custom background daemon, a JSON-RPC app-server client, or a duplicate job tracker, `agy-codex-plugin` pairs **Codex's stable non-interactive CLI** (`codex review`, `codex exec`, `codex doctor`) with **Antigravity's native primitives**:

- **Skills (`/<skill-name>`)** expose `/codex-review`, `/codex-adversarial`, `/codex-rescue`, and `/codex-setup` with zero wrapper code.
- **Reactive `run_command` background wakeup** lets long-running `codex` runs execute asynchronously and wake Antigravity up when finished—no `/status`, `/result`, or `/cancel` polling needed.
- **Custom subagent (`codex-delegate`)** lets Antigravity delegate second opinions or isolated Codex runs in the background.
- **Native `Stop` hook (`hooks.json`)** optionally checks uncommitted changes before Antigravity finishes a turn, using `continuationActive` to prevent loops and failing open on errors.
- **Bundled stdio MCP server (`mcp_config.json`)** exposes Codex review, exec, resume, and diagnostics as typed tools with zero npm dependencies.

```mermaid
flowchart LR
    U["User / Antigravity Session"] --> S["Skills (/codex-review, /codex-adversarial, /codex-rescue, /codex-setup)"]
    U --> A["Subagent (codex-delegate)"]
    U --> H["Opt-in Stop Hook (scripts/stop-review-gate.mjs)"]
    U --> M["MCP Server (scripts/mcp-server.mjs)"]
    S --> C["Local Codex CLI (codex review / codex exec / codex doctor)"]
    A --> C
    H --> C
    M --> C
    C --> R["Local Git Repository"]
```

## Repository Layout

```text
agy-codex-plugin/
├── plugin.json                        # Antigravity plugin manifest (name: codex-cli)
├── mcp_config.json                    # Bundled Codex MCP server registration
├── README.md
├── LICENSE                            # MIT
├── assets/
│   └── logo.svg                       # 128x128 plugin icon
├── skills/
│   ├── codex-review/SKILL.md          # /codex-review (read-only codex review)
│   ├── codex-adversarial/SKILL.md     # /codex-adversarial (skeptical challenge review)
│   ├── codex-rescue/SKILL.md          # /codex-rescue (delegated codex exec + resume --last)
│   └── codex-setup/SKILL.md           # /codex-setup (install & codex doctor check)
├── agents/
│   └── codex-delegate.md              # Background subagent wrapper around codex CLI
├── hooks.json                         # Opt-in Stop review gate (disabled by default)
├── scripts/
│   ├── mcp-server.mjs                 # Zero-dependency Node ESM stdio MCP server
│   └── stop-review-gate.mjs           # Zero-dependency Node ESM Stop hook
└── tests/
    ├── mcp-server.test.mjs            # MCP protocol and Codex invocation tests
    └── stop-review-gate.test.mjs      # Stop hook tests
```

## Prerequisites

1. **OpenAI Codex CLI** (`codex`) installed and authenticated:
   ```bash
   # Install (choose one)
   brew install --cask codex
   # or
   npm install -g @openai/codex

   # Authenticate (ChatGPT subscription or OPENAI_API_KEY)
   codex login
   ```
2. **Antigravity** (`agy` CLI, Antigravity App, or Antigravity IDE).
3. **Node.js** on `PATH` for the bundled MCP server and the optional `Stop` hook.

## Installation

Install directly from GitHub:

```bash
agy plugin install https://github.com/whanyu1212/agy-codex-plugin
```

Or install from a local clone:

```bash
git clone https://github.com/whanyu1212/agy-codex-plugin.git
agy plugin install ./agy-codex-plugin
```

Verify the plugin is enabled, then run `/codex-setup` inside Antigravity to verify `codex doctor`:

```bash
agy plugin list
```

## Slash Commands (Skills)

| Command | Purpose | Underlying Codex CLI |
| :--- | :--- | :--- |
| `/codex-review` | Read-only review of uncommitted changes, `--base <branch>`, or `--commit <sha>` | `codex review` |
| `/codex-adversarial` | Skeptical challenge review probing invariants, concurrency, edge cases, and security | `codex review -` |
| `/codex-rescue` | Delegate diagnosis (`-s read-only`), fixes (`-s workspace-write`), or `resume --last` | `codex exec` |
| `/codex-setup` | Check `codex` binary, version, and authentication health | `codex doctor` |

### Examples

- `/codex-review` — review current uncommitted changes (read-only).
- `/codex-review --base main` — review your branch diff against `main`.
- `/codex-adversarial focus on auth and race conditions` — stress-test changes with a skeptical rubric piped over stdin (`<<'EOF'`), avoiding shell-quoting issues and `codex review`'s `--uncommitted` + prompt conflict.
- `/codex-rescue diagnose why tests/auth.test.ts is flaky` — run a read-only second-opinion diagnosis.
- `/codex-rescue fix the race in src/queue.ts and run unit tests` — delegate edits inside Codex's `workspace-write` sandbox (`--worktree` when isolated changes are requested, or `codex exec resume --last` to continue prior work).

## Subagent (`codex-delegate`)

[`agents/codex-delegate.md`](agents/codex-delegate.md) registers a lightweight `flash` background subagent (`subagent: true`, `mainAgent: false`) so Antigravity can offload a second opinion, review, or `codex exec` run without blocking your main conversation.

## MCP Tools (`mcp_config.json`)

Antigravity starts the bundled `codex` stdio server using [`mcp_config.json`](mcp_config.json). The server runs on Node.js built-ins and needs no `npm install`. It uses the `codex` executable on `PATH`.

| Tool | Inputs | Result |
| :--- | :--- | :--- |
| `codex_review` | Required `cwd`. Optional `target` defaults to `uncommitted`. Use `base` with `target: "base"` or `commit` with `target: "commit"`. An optional `prompt` supplies custom review instructions. | Read-only review output. |
| `codex_exec` | Required `cwd` and `prompt`. Optional `sandbox` defaults to `read-only` and also accepts `workspace-write`. Optional `model`, `worktree`, and `ephemeral`. | JSON text with `sessionId` and `finalMessage`. |
| `codex_resume` | Required `cwd` and `prompt`. Optional `sessionId` selects a session. Omit it to resume the most recent session in `cwd`. | JSON text with `sessionId` and `finalMessage`. |
| `codex_doctor` | Optional `cwd`. | Codex version and local diagnostic output. |

With a custom review `prompt`, the server includes the selected target in the instructions sent to Codex. Use either `worktree` or `ephemeral` for an exec call because Codex rejects the combination. Ephemeral sessions are available only for the duration of the call.

## Optional Stop Review Gate (`hooks.json`)

The plugin ships with an **opt-in** `Stop` hook (`codex-stop-review-gate`) powered by [`scripts/stop-review-gate.mjs`](scripts/stop-review-gate.mjs). When enabled, it runs `codex exec -s read-only --ephemeral` on uncommitted changes before Antigravity ends a turn and continues the loop if Codex reports concrete bugs, regressions, or security issues.

To keep normal turns fast, it is **disabled by default** (`"enabled": false` in [`hooks.json`](hooks.json)) and **fails open** (`{}`) whenever:
- `continuationActive` is `true` (prevents infinite review loops)
- `terminationReason` is not `NO_TOOL_CALL`
- the workspace is not a git repo or has no uncommitted changes
- `codex` is unavailable, times out, or exits non-zero

To enable it, set `"enabled": true` in `hooks.json` inside your installed plugin directory (`~/.gemini/config/plugins/codex-cli/hooks.json`).

## Development & Testing

```bash
# Run deterministic tests with a fake codex on PATH
node --test tests/stop-review-gate.test.mjs tests/mcp-server.test.mjs

# Validate the plugin, including the MCP server registration
agy plugin validate --strict .
```

## License

MIT
