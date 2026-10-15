---
trigger: model_decision
description: "Read before creating a branch, committing, opening or merging a pull request, writing an ADR, creating or closing GitHub issues, or updating the README or docs as part of a change."
---

# Git and process

If a rule here conflicts with `AGENTS.md`, stop and ask. Each section separates **brief requirements**
(graded) from **our policies** (workflow choices that help meet them). Repo commands stay pending until
they exist; don't invent scripts.

## Brief requirements

- **Conventional Commits:** `feat: add cursor pagination to shift feed`, `fix: prevent duplicate swap
  requests`. *Why: the history has to read as professional work.*
- **A feature branch and a pull request per feature**, with a description and screenshots, **merged by
  Dave himself**.
- **`docs/decisions/`:** an Architecture Decision Record for every important choice: the problem, the
  options considered, what was chosen, and why. One short file each, from `0000-template.md`.
  **[Self-study: ADRs]** prompt Dave's own-words entry on first use (`self-study-and-log.md`).
- **GitHub issues as the task list** for planned work.
- **The README is written as we go**, in the PR that changes what it describes, not at the end.
- **`LEARNING-LOG.md`:** after AI helps build something, Dave writes a short own-words paragraph there
  (the brief's explain-back rule). Never written by an agent. *Our policy:* the cadence is once per slice.
- Every repo has `.env.example` (names, no values) and an MIT `LICENSE`.

## Our policies

- **Branches:** `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`, `chore/<short-name>`.
- **One slice per PR.** A slice is one requirement or one piece of one, small enough to explain.
- **PR description template** (create it as `.github/pull_request_template.md` in the scaffold slice):
  1. What changed, in plain words.
  2. **Evidence** (`AGENTS.md` definition of done): the exact SQL query, HTTP request or test command that
     shows the right rows exist, and its output.
  3. Screenshots or a short recording for anything visible.
  4. Tests added or run.
  5. Docs and ADRs updated.
  6. Whether this PR needed a new native build, and why (`expo-builds.md`).
  7. The issue it closes.
- **Before Dave merges:** required tests pass, evidence is in the description, docs are updated, and he
  has been asked the matching interview question (`AGENTS.md`).
- Never commit to `main` directly. Never force-push `main`. Never rewrite history that has been pushed
  without asking Dave.
- Never commit credentials or secret values (`AGENTS.md`).
- **Three features without a PR?** Say so.
- An ADR is written in the same PR as the decision, never later.

## Tracking pending decisions

Open an issue for every decision marked pending in the rules (deployment provider, client state tool,
offline storage, routing library, feed fail-open policy, failed-renewal restriction), and close it with
the ADR that settles it.

## Acceptance checks

1. Every commit on `main` follows Conventional Commits.
2. Every feature arrived through its own PR, with a description, evidence and screenshots where visible,
   merged by Dave.
3. Every important decision has an ADR in `docs/decisions/`.
4. Planned work exists as GitHub issues, and merged PRs close them.
5. `LEARNING-LOG.md` has an entry for each slice, in Dave's words.
