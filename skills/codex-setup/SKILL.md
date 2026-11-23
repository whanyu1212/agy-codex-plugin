---
name: codex-setup
description: >-
  Verify that the OpenAI Codex CLI is installed, authenticated, and healthy.
  Use when the user invokes `/codex-setup` or encounters missing binary,
  authentication, or runtime errors from Codex commands.
---

# Codex Setup & Health Check

Verify the local `codex` CLI installation, version, and authentication state.

## Steps

1. **Run a local diagnostic check** with the `codex_doctor` MCP tool, or use
   `run_command` with the bundled runner. Resolve `<plugin-root>` two levels
   up from the directory containing this `SKILL.md`.
   ```bash
   node "<plugin-root>/scripts/codex-run.mjs" doctor
   ```
   If the runner is unavailable, use `codex --version && codex doctor --summary`.
   If Codex reports an unsupported `--summary` option, retry with `codex doctor`.

2. **Interpret the result**:
   - **If `codex` is not found on `PATH`**, provide installation commands and
     stop:
     - Homebrew (macOS): `brew install --cask codex`
     - npm: `npm install -g @openai/codex`
   - **If `codex doctor` reports missing or expired authentication**, instruct
     the user to authenticate in their terminal:
     - Interactive ChatGPT or API login: `codex login`
     - Or set `OPENAI_API_KEY` in their environment.
   - **If everything passes**, confirm the installed `codex --version` and let
     the user know `/codex-review`, `/codex-adversarial`, and `/codex-rescue`
     are ready to use.
