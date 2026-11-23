---
name: codex-rescue
description: >-
  Delegate a tricky bug investigation, second-opinion diagnosis, or substantial
  implementation task to the local OpenAI Codex CLI (`codex exec`). Use when
  the user invokes `/codex-rescue` or asks Codex to diagnose, fix, implement, or
  continue a prior Codex task.
---

# Codex Rescue

Delegate a focused diagnosis or implementation task to `codex exec` using
Antigravity's native `run_command` background execution and reactive wakeup.

## Core Rules

- Pass multi-line prompts via stdin heredoc (`<<'EOF'`) to prevent shell-escaping
  bugs.
- Choose the narrowest sandbox mode that fits the request:
  - `-s read-only` for diagnosis, research, or second opinions without edits.
  - `-s workspace-write` (default for implementation/fixes) when Codex should
    edit files and run checks.
- Add `--worktree` only when the user explicitly asks for an isolated Git
  worktree.
- Add `-m <model>` only when the user explicitly specifies a model.
- For a faster run on a bounded task, optionally add
  `-c model_reasoning_effort=medium` after `codex exec` and before any subcommand.
- If `codex` is missing or unauthenticated, direct the user to `/codex-setup`.

## Steps

1. **Choose the command mode**:
   - **Fresh read-only diagnosis**:
     ```bash
     codex exec -s read-only - <<'EOF'
     <clear problem statement, relevant files, and constraints>
     EOF
     ```
   - **Fresh write-capable task (fix / implement)**:
     ```bash
     codex exec -s workspace-write - <<'EOF'
     <clear task, acceptance criteria, and verification command>
     EOF
     ```
   - **Continue previous Codex session in this repo** (when the user asks to
     resume/continue/keep going):
     ```bash
     codex exec resume --last - <<'EOF'
     <follow-up instruction>
     EOF
     ```

2. **Execute via `run_command`**:
   - For quick, bounded read-only questions, use `WaitMsBeforeAsync: 10000`.
   - For open-ended debugging or write-capable implementation tasks, use
     `WaitMsBeforeAsync: 500` so the command runs in the background. Tell the user
     Codex is working in the background and stop calling tools until
     Antigravity wakes you up with the completion output.

3. **Report results**:
   - Summarize what Codex did or found, include any modified files (`git status --short`),
     and surface any errors or remaining verification needed.
