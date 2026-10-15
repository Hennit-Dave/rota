---
trigger: model_decision
description: "Read when first using a self-study topic (EAS Build, AsyncStorage risk, refresh-token rotation and reuse, idempotency, observability, load testing, ADRs), when a slice finishes, or when Dave says he is stopping work for the session."
---

# Self-study write-ups, the learning log, and the daily log

If a rule here conflicts with `AGENTS.md`, stop and ask.

## Brief requirements

- **Self-study topics** must be researched, written up **in Dave's own words**, and then used. Using a
  concept isn't the same as satisfying the requirement. Rota's self-study topics:
  1. EAS Build
  2. Why AsyncStorage is unsafe for tokens
  3. Refresh-token rotation and reuse detection
  4. Idempotency
  5. Observability
  6. Load testing
  7. Architecture Decision Records
- **The explain-back rule:** after AI helps build something, Dave closes the chat and writes a short
  paragraph explaining it in his own words, in `LEARNING-LOG.md`.
- **Daily log** (Dave's job-hunt tracker, outside this repo): one row every weekday, including **minutes
  spent building**. Missing days fail a separate requirement.

## Our policies

### Self-study prompts
- **The first time a slice touches a topic above, name it** ("this is self-study: idempotency") and
  prompt Dave to write that topic's `LEARNING-LOG.md` entry before or alongside the slice.
- Offer sources to read, ideally official docs, and quiz him one question at a time if he asks.
- Keep a short checklist at the top of `LEARNING-LOG.md` of the seven topics and whether each has an
  entry. Dave ticks it; the agent can point out what's missing.

### Learning log
- **At the end of every slice, prompt the own-words paragraph.** Never write it, draft it, or "polish" it
  into something he didn't write. Answering his questions so he can write it is fine.
- Pair it with the slice's interview question (`AGENTS.md` definition of done).

### Daily log
- **When a slice finishes, and whenever Dave says he's stopping,** remind him to log today's building
  minutes in his tracker. Agents can't tell when a session ends on their own, so these two moments are
  the trigger.
- The agent doesn't edit the tracker.

## Acceptance checks

1. All seven self-study topics have an own-words entry in `LEARNING-LOG.md` by submission.
2. Every merged slice has a matching `LEARNING-LOG.md` paragraph.
3. Dave was reminded about the daily log at the end of each slice and session.
