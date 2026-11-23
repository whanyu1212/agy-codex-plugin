---
name: codex-review
description: >-
  Run a read-only code review against local git changes using the OpenAI Codex
  CLI (`codex review`). Use when the user invokes `/codex-review` or asks for a
  Codex review of uncommitted changes, a branch diff (`--base`), or a specific
  commit (`--commit`).
---

# Codex Review

Run a non-interactive, read-only code review using the local `codex review`
command.

## Core Rules

- **Strictly review-only.** Never edit files, apply patches, or suggest that
  you are about to fix issues yourself.
- Present Codex's findings faithfully, preserving file paths, line numbers, and
  severity/context.
- If `codex` is missing or not authenticated, tell the user to run
  `/codex-setup` and stop.

## Steps

1. **Determine the review target** from the user's request:
   - **Default (uncommitted changes)**: `codex review --uncommitted`
   - **Branch diff** (e.g. `--base main` or "against main"):
     `codex review --base <branch>`
   - **Single commit** (e.g. `--commit <sha>`):
     `codex review --commit <sha>`

2. **Check git state first** so you do not run an empty review and can choose
   foreground vs. background execution:
   - For uncommitted changes:
     `git status --short --untracked-files=all && git diff --shortstat --cached && git diff --shortstat`
   - For base branch diff:
     `git diff --shortstat <branch>...HEAD`
   - For a commit:
     `git show --stat --oneline <sha>`
   - If there are no changes to review, report that clearly and stop.

3. **Run `codex review` via `run_command`**:
   - **Small diff** (roughly 1–2 files changed): run in the foreground with
     `WaitMsBeforeAsync: 10000`.
   - **Larger or unclear diff**: launch with `WaitMsBeforeAsync: 500` so the
     command continues in the background and Antigravity notifies you
     automatically upon completion (tell the user the review is running and stop
     calling tools until notified).

   Examples:
   ```bash
   codex review --uncommitted
   codex review --base main
   codex review --commit abc1234
   ```

4. **Return the review output** cleanly to the user without modifying any files.
