---
name: codex-adversarial
description: >-
  Run a skeptical, adversarial challenge review against local git changes using
  `codex review` with a custom stress-test prompt. Use when the user invokes
  `/codex-adversarial` or asks Codex to challenge assumptions, hunt for race
  conditions, security holes, edge cases, or regressions.
---

# Codex Adversarial Review

Run a skeptical, steerable challenge review using `codex review` with custom
instructions passed via stdin (`-`).

## Core Rules

- **Strictly read-only.** Do not edit files or apply fixes.
- Pass the review prompt via stdin heredoc (`<<'EOF'`) to avoid shell-quoting
  issues.
- Present Codex's critique faithfully, preserving file paths and line numbers.
- If `codex` is missing or unauthenticated, tell the user to run `/codex-setup`
  and stop.

## Steps

1. **Determine the target scope** (note: `codex review` does not allow `--uncommitted`,
   `--base`, or `--commit` flags together with a custom prompt, so specify the
   target scope inside the prompt's `Target:` line):
   - **Default (uncommitted changes)**:
     `Target: review the uncommitted changes in this repository (inspect git status and git diff HEAD).`
   - **Base branch** (e.g. `--base main`):
     `Target: review the branch diff against <branch> (inspect git diff <branch>...HEAD).`
   - **Commit** (e.g. `--commit <sha>`):
     `Target: review commit <sha> (inspect git show <sha>).`

2. **Verify there are changes to review**:
   - Uncommitted: `git status --short --untracked-files=all && git diff --shortstat --cached && git diff --shortstat`
   - Branch: `git diff --shortstat <branch>...HEAD`
   - Commit: `git show --stat --oneline <sha>`
   - If nothing changed, inform the user and stop.

3. **Run `codex review -` with the adversarial rubric via stdin** (`WaitMsBeforeAsync: 500`
   for medium/large diffs so Antigravity wakes you up when done, or `10000` for
   tiny 1–2 file diffs). Replace the `Target:` line when reviewing a branch or
   commit, and append any user-specified focus area under `Additional focus`:

   ```bash
   codex review - <<'EOF'
   Target: review the uncommitted changes in this repository (inspect git status and git diff HEAD).

   Perform a skeptical, adversarial code review of these changes. Assume bugs are hiding until proven otherwise.

   Focus on:
   1. Flawed assumptions, broken invariants, and state-transition gaps.
   2. Concurrency, TOCTOU races, partial-failure handling, and resource leaks.
   3. Error handling, silent failures, boundary/null/empty-input edge cases.
   4. Security, auth/permission boundaries, and injection or path-traversal risks.
   5. Behavioral regressions and missing or weak test coverage.

   Ignore style nits. Report only concrete, evidence-backed findings with file paths, line numbers, failure scenarios, and suggested fixes.
   EOF
   ```

4. **Present the findings** directly to the user without altering any files.
