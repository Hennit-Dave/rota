---
trigger: model_decision
description: "Read when a real bug appears, before fixing any bug, when planning or recording the demo video, when a feature is finished that could support a LinkedIn post, the portfolio case study, or outreach to a company."
---

# Evidence capture

If a rule here conflicts with `AGENTS.md`, stop and ask. This evidence can't be reconstructed later, so
the agent prompts Dave at the moment it matters.

## Brief requirements

- **Before-and-after clips of problems fixed** ("Screenshot and record as you go"). This is separate from
  PR screenshots and from the demo video.
- **Demo video under 3 minutes:** the product first, then **one** technical deep dive. Not a feature tour,
  not architecture first.
- **LinkedIn:** at least two posts a week during the build, each covering one problem and one decision;
  plus the Task A post about one technical decision. No announcement posts.
- **A portfolio case study:** the problem, constraints, architecture, the three hardest decisions, results
  with load test numbers, and what's next.
- **Outreach:** 30 target companies that build scheduling, workforce, HR or B2B SaaS tools, added to Dave's
  tracker; messages lead with Rota and point at **the feature closest to that company's product**.
- One CV and LinkedIn bullet about Rota, with specifics.

## Our policies

### Where a proof runs
- **Proofs run on the test shards by default:** `npm run proof:api` and `npm run proof:worker` set `USE_TEST_SHARDS=true` (the
  `TEST_SHARD_*` URLs behind the `TEST_DATABASE_ALLOWED` guard) and use their own queue, `work-proof`, so a proof worker never picks up
  real jobs. Plain `start:api` / `start:worker` use the real shards.
- **The real shards only with Dave's explicit go.** Ledger rows can never be deleted (ADR 0026), so anything a proof writes there stays
  for good. When it does happen, the PR says exactly what is now in the real shards.
- *Why: the P3 proof (PR #57) ran on the real shards by default, left a throwaway user, two teams and test ledger rows there, and nobody had decided that.*

### Bugs
- **The moment a real bug appears, before changing any code: tell Dave to record it broken.** After the
  fix, tell him to record it working. *Why: a fixed bug can't be filmed.*
- Good candidates: a double-submitted swap, duplicated rows on fast scroll, a notification at 2am, a stale
  read after a write, a lost queued job.
- Clips don't go in the repo (size). The fixing PR's description links both clips.

### Demo video
- Product first (what a manager and a staff member actually do), then one deep dive that the logs or tests
  can prove, e.g. proration with the ledger, refresh-token reuse detection, or queue-loss recovery.
- Recorded on the preview build against the deployed backend, with seeded data, never real personal data.

### Outreach map
- **When a finished feature maps to a kind of company, add a line to `docs/outreach-feature-map.md`:** the
  feature, the kind of company, and the evidence to show (PR, clip, test).
- Starting points from the build prompt (not the brief): swap approval → shift-scheduling tools; seat-based proration → B2B SaaS;
  quiet-hours-aware notifications → anything with on-call staff.

### Posts and case study material
- When a slice produces a clear problem-and-decision story, say so and point at the evidence. Dave writes
  the post; the agent never drafts it as if it were his.
- Record the real load-test numbers as they're produced; the case study uses measured results only.

## Acceptance checks

1. Every bug-fix PR for a user-visible bug links a before and an after clip.
2. The demo video is under 3 minutes, product first, one deep dive.
3. `docs/outreach-feature-map.md` has an entry for each feature that maps to a kind of company.
4. Case-study numbers match the load test report.
