# agy-codex-plugin

A minimal, zero-broker Antigravity (`agy`) plugin that lets Antigravity delegate code reviews, adversarial audits, and rescue tasks to your local OpenAI **Codex CLI** (`codex`).

Instead of bundling a background daemon or reimplementing job queues, this plugin pairs `codex`'s public non-interactive CLI (`codex review`, `codex exec`, `codex doctor`) with Antigravity's native skills, background `run_command` wakeup, custom subagents, and lifecycle hooks.

## Prerequisites

1. **OpenAI Codex CLI** (`codex`) installed and authenticated:
   ```bash
   # Install (choose one)
   brew install --cask codex
   # or
   npm install -g @openai/codex

   # Authenticate
   codex login
   ```
2. **Antigravity** (`agy` CLI, Antigravity App, or Antigravity IDE).
3. **Node.js** (only needed if you enable the optional `Stop` review-gate hook).

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

Verify installation:

```bash
agy plugin list
```

## Slash Commands (Skills)

| Command | What it does | Underlying Codex command |
| :--- | :--- | :--- |
| `/codex-review` | Read-only review of uncommitted changes, `--base <branch>`, or `--commit <sha>` | `codex review` |
| `/codex-adversarial` | Skeptical challenge review probing assumptions, concurrency, edge cases, and security | `codex review ... -` |
| `/codex-rescue` | Delegate diagnosis (`read-only`) or fixes (`workspace-write`), including `resume --last` | `codex exec` |
| `/codex-setup` | Check `codex` installation, version, and authentication health | `codex doctor` |

## Subagent

- **`codex-delegate`** (`agents/codex-delegate.md`): A lightweight `flash` subagent that Antigravity can spawn in the background for second opinions, reviews, or delegated `codex exec` runs without blocking your main conversation.

## Optional Stop Review Gate (`hooks.json`)

The plugin ships with an **opt-in** `Stop` hook (`codex-stop-review-gate`) that runs a fast, read-only `codex exec --ephemeral` check on uncommitted git changes before Antigravity finishes a turn, continuing the loop if Codex flags concrete bugs or regressions.

It is **disabled by default** (`"enabled": false` in `hooks.json`) so normal sessions stay fast. To enable it, edit `hooks.json` in your installed plugin directory and set `"enabled": true`.

## Local Validation

Validate the plugin structure and manifest with:

```bash
agy plugin validate --strict .
```

## License

MIT
