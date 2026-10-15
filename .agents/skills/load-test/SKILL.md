---
name: load-test
description: Procedure for Rota's k6 load test - 200 virtual users on the activity feed, before and after caching - covering preparation, rate-limit and Neon budget handling, the two runs, what to measure and the written report. Use when writing k6 scripts, running them, or writing the report.
---

# Load test

The requirement is in `docs/requirements/ROTA-BUILD-PROMPT.md` (Task A backend system design: 200
virtual users loading the activity feed at once, response times before and after caching; a
`load-tests/` folder with scripts and a written report). The brief PDF wins if they differ. Related rules:
`caching.md` (the caching switch, hit rate), `data.md` (Neon budget, pool tests), `security.md` (feed rate
limit, session-check cost), `observability.md`. Paths are from the repo root.

**Self-study topic: load testing.** On first touch, name it and prompt Dave's own-words
`LEARNING-LOG.md` entry.

## Steps

1. **Plan and wait for "go".** Present: the target environment, test users, how the rate limit is
   handled (step 3), and what will be measured. Don't invent pass thresholds; if Dave wants one, agree it
   in the plan.
2. **Prerequisites:** the feed slice is done (`cursor-pagination`), the seeded high-volume team exists
   (`data.md`), caching can be switched off by the one config switch (`caching.md`), and k6 runs locally
   (free; check its install docs for the current method).
3. **Rate limits:** 200 VUs will trigger the feed's rate limit if they share a user or IP. Decide in the
   plan how test traffic is shaped (for example, many seeded members of the team). **Never disable or
   loosen a rate limit to make the test pass without Dave's approval** (`AGENTS.md`), and record whatever
   was decided in the report.
4. **Neon budget:** raise the autoscaling cap only for the run, then lower it again (`data.md`). Note the
   compute used.
5. **Script** in `load-tests/`: each VU signs in (or uses a pre-issued test token), then loads the feed's
   first page and follows cursors. Tokens and passwords come from env, never committed.
6. **Run "before"** with caching off, then **"after"** with caching on, against the same build, data and
   environment. Warm-up handling is the same for both; say what it was.
7. **Collect:** k6's response-time distribution and error rate for each run; the cache hit rate during
   "after" (`caching.md`); API latency, database time and pool wait separately, and that connections
   stayed within the pool maximums (`data.md` test 11); the session-check cost (`security.md`).
8. **Write the report** in `load-tests/`: environment, script summary, the two result tables, what changed
   and why, bottlenecks seen, cold-start effects if the host was sleeping, and what you'd change next.
   Numbers are copied from output, never rounded into nicer ones.
9. **Ship** with `ship-feature-pr`; the case-study numbers must match the report (`evidence-capture.md`).

## Common mistakes

- Comparing runs against different data, builds or environments.
- One shared user for all VUs, so the test measures the rate limiter.
- Turning off rate limits or the session check "for the test".
- Running destructive or failure-injection tests on the final services (`release-gates.md`).
- Leaving the Neon cap raised afterwards.
- Reporting only the average.
- Committing test credentials.
