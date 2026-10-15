---
name: ship-feature-pr
description: Procedure for finishing a Rota slice and opening its pull request - branch and commit format, evidence, tests, docs and ADRs, secret check, native-build note, the interview question, and the learning-log and daily-log prompts. Use when a slice is ready to ship or Dave says he is stopping.
---

# Ship a feature PR

Rules: `AGENTS.md` (definition of done, always-on reminders), `.agents/rules/git-and-process.md`,
`evidence-capture.md`, `self-study-and-log.md`, `release-gates.md` (secret scan). Paths are from the
repo root. Dave merges; agents never merge, and never commit to or force-push `main`.

## Steps

1. **Check the slice is one slice** (`git-and-process.md`). If it has grown, say so and propose a split.
2. **Branch** named by its type (`git-and-process.md`), from an up-to-date `main`.
3. **Run the required tests** for every rules file the slice touched. Paste the command and its result.
   A failing test is fixed, never weakened; relaxing a security rule needs Dave (`AGENTS.md`).
4. **Prove it on a real device or against a real request** (`AGENTS.md`, definition of done 1).
5. **Collect evidence:** the exact SQL query, HTTP request or test command, and its output, showing the
   right rows exist. Screenshots or a recording for anything visible.
6. **Docs in the same PR:** README sections the slice changes, and whichever of `ARCHITECTURE.md`,
   `STATE.md`, `SECURITY.md`, `SHARDING.md` it affects. An ADR from `0000-template.md` for any real
   decision; close its tracking issue if it settles a pending one.
7. **Secrets:** review the diff for credentials and `EXPO_PUBLIC_` additions. Suspected secret → stop,
   identify it without showing its value, remove it from the commit (`AGENTS.md`). New env names go in
   `.env.example` without values.
8. **Commit** in Conventional Commits format (`git-and-process.md`).
9. **Open the PR** with the template sections in `git-and-process.md`, including whether a new native
   build was needed and the issue it closes. Add any new feature-to-company mapping to
   `docs/outreach-feature-map.md`.
10. **Bug clips:** if a real bug was fixed in this slice, link Dave's before and after clips
    (`evidence-capture.md`). If he hasn't recorded the "after", remind him now.
11. **Interview question:** ask the matching question from the spec and say plainly whether his answer
    would survive a reviewer (`AGENTS.md`, definition of done 7).
12. **Stop and prompt Dave:** his own-words `LEARNING-LOG.md` paragraph (never write it for him), any
    first-touch self-study entry, and today's building minutes in his daily log
    (`self-study-and-log.md`).
13. **Count:** if three features now exist without a PR, say so.

## Worked example: cursor pagination slice

Branch per `git-and-process.md` → feed tests and `app-state.md` test 16 pass → evidence: the feed
request and response, plus the `EXPLAIN ANALYZE` output before and after the index → `ARCHITECTURE.md`
and README updated, ADR for the cursor format → commit, e.g. the brief's own example message → PR with
a screen recording of infinite scroll → interview question on why offset pagination breaks → learning-log
and daily-log prompts.

## Common mistakes

- "Docs in a follow-up PR."
- Evidence that is only a description, with no query or command.
- Writing Dave's learning-log paragraph for him, or skipping the prompt.
- Describing payments as anything beyond the test-mode wording in `AGENTS.md`.
- Bundling two features into one PR.
