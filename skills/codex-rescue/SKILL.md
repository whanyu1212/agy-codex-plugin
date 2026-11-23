---
name: codex-rescue
description: >-
  Delegate a tricky bug investigation, second-opinion diagnosis, or substantial
  implementation task to the local OpenAI Codex CLI (`codex exec`). Use when
  the user invokes `/codex-rescue` or asks Codex to diagnose, fix, implement, or
  continue a prior Codex task.
---

# Codex Rescue

Delegate a focused diagnosis or implementation task with the bundled Codex
runner and Antigravity's native `run_command` background execution and reactive
wakeup. Resolve `<plugin-root>` two levels up from the directory containing
this `SKILL.md`. Run commands from the target repository.

## Core Rules

- Pass multi-line prompts via stdin heredoc (`<<'EOF'`) to prevent shell-escaping
  bugs.
- Choose the narrowest sandbox mode that fits the request:
  - `--sandbox read-only` for diagnosis, research, or second opinions without edits.
  - `--sandbox workspace-write` for implementation or fixes when Codex should
    edit files and run checks.
- Add `--worktree` only when the user explicitly asks for an isolated Git
  worktree.
- Add `--model <model>` to `exec` only when the user explicitly specifies a model.
- For a faster run on a bounded task, optionally add `--effort medium`.
- If `codex` is missing or unauthenticated, direct the user to `/codex-setup`.

## Steps

1. **Choose the command mode**:
   - **Fresh read-only diagnosis**:
     ```bash
     node "<plugin-root>/scripts/codex-run.mjs" exec --sandbox read-only <<'EOF'
     <clear problem statement, relevant files, and constraints>
     EOF
     ```
   - **Fresh write-capable task (fix / implement)**:
     ```bash
     node "<plugin-root>/scripts/codex-run.mjs" exec --sandbox workspace-write <<'EOF'
     <clear task, acceptance criteria, and verification command>
     EOF
     ```
   - **Continue a specific Codex session** (default when resuming a prior task):
     ```bash
     node "<plugin-root>/scripts/codex-run.mjs" resume --session "<sessionId>" --sandbox read-only <<'EOF'
     <follow-up instruction>
     EOF
     ```
     Pass the exact `sessionId` returned by the earlier `exec` (or `resume`) run.
     If the prior run returned a non-null `worktreePath`, pass `--cwd "<worktreePath>"`
     so the follow-up runs inside the isolated worktree rather than the main checkout.
     Only pass `--last` when the user explicitly asks to resume the latest
     session in the repository and no `sessionId` is available:
     ```bash
     node "<plugin-root>/scripts/codex-run.mjs" resume --last --sandbox read-only <<'EOF'
     <follow-up instruction>
     EOF
     ```
     Use `--sandbox workspace-write` only when the task requires edits; if the
     prior session was `read-only`, get explicit user authorization to write
     before upgrading to `--sandbox workspace-write`.

   If the runner script is unavailable, use `codex exec -s <sandbox> --json -`
   for a fresh prompt. Keep `--worktree` when requested and translate any
   `--model <model>` to `-m <model>`. For a follow-up, default to
   `codex exec -s <sandbox> resume --json -- "$session_id" -` with the exact
   session ID in `$session_id` (run from `<worktreePath>` via
   `cd "<worktreePath>" && ...` when the prior run created a worktree); only use
   `codex exec -s <sandbox> resume --json --last -` when the user explicitly opts
   in to resuming the latest session.
   Translate `--effort <level>` to `-c model_reasoning_effort=<level>` immediately
   after `codex exec`. Pass the same prompt on stdin and read the session ID
   and final message from the Codex event stream.

2. **Execute via `run_command`**:
   - For quick, bounded read-only questions, use `WaitMsBeforeAsync: 10000`.
   - For open-ended debugging or write-capable implementation tasks, use
     `WaitMsBeforeAsync: 500` so the command runs in the background. Tell the user
     Codex is working in the background and stop calling tools until
     Antigravity wakes you up with the completion output.

3. **Report results**:
   - The runner returns JSON with `sessionId`, `resumable`, `repoRoot`,
     `worktreePath`, and `finalMessage`. Always report `sessionId`, `resumable`,
     and `worktreePath` (when non-null) so follow-ups target the exact task and
     worktree.
   - If `resumable` is `false` (for example, an `--ephemeral` run or missing
     session ID) or `resume` reports a missing/non-resumable session, explain
     why it cannot be continued and offer to start a fresh `exec` run.
   - Summarize what Codex did or found, include any modified files (`git status --short`),
     and surface any errors or remaining verification needed.
