---
name: codex-adversarial
description: >-
  Run a skeptical, adversarial challenge review against local git changes using
  `codex exec -s read-only review` with a custom stress-test prompt. Use when the user invokes
  `/codex-adversarial` or asks Codex to challenge assumptions, hunt for race
  conditions, security holes, edge cases, or regressions.
---

# Codex Adversarial Review

Run a skeptical, read-only challenge review with the bundled Codex runner and
pass custom instructions on stdin. Resolve `<plugin-root>` two levels up from
the directory containing this `SKILL.md`. Run commands from the repository
under review.

## Core Rules

- **Strictly read-only.** Do not edit files or apply fixes.
- Pass the review prompt via stdin heredoc (`<<'EOF'`) to avoid shell-quoting
  issues.
- Present Codex's critique faithfully, preserving file paths and line numbers.
- If `codex` is missing or unauthenticated, tell the user to run `/codex-setup`
  and stop.

## Steps

1. **Choose the target flag**. Use `--uncommitted` by default, `--base <ref>`
   for a branch diff, or `--commit <ref>` for a single commit. The runner
   adds the target to the stdin prompt and resolves Git refs to commit SHAs.

2. **Verify there are changes to review**:
   - Uncommitted: `git status --short --untracked-files=all && git diff --shortstat --cached && git diff --shortstat`
   - For a branch or commit, pass the supplied ref as a shell-quoted argument.
     With the ref in `$ref`, run `git rev-parse --verify --end-of-options "${ref}^{commit}"`
     before using the resulting SHA with `git diff --shortstat <sha>...HEAD` or
     `git show --stat --oneline <sha>`.
   - If nothing changed, inform the user and stop.

3. **Run the bundled review command via `run_command`** with the adversarial
   rubric on stdin. Use `WaitMsBeforeAsync: 500` for medium or large diffs so
   Antigravity wakes you up when done, or `10000` for a 1–2 file diff. If the
   command backgrounds, tell the user and stop calling tools until Antigravity
   notifies you. Replace the target flag as needed and append any user-specified
   focus area under `Additional focus`.

   ```bash
   node "<plugin-root>/scripts/codex-run.mjs" review --uncommitted --prompt-stdin <<'EOF'
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

   If the runner script is unavailable, use `codex exec -s read-only review -`
   with the same rubric and put the scope in a `Target:` line in the prompt.

4. **Present the findings** directly to the user without altering any files.
