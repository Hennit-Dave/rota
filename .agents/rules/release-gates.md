---
trigger: model_decision
description: "Read before preparing a release or submission: the README first screen, repo description and topics, pinning, the secret scan of Git history, deliverable links for SUBMISSION.md, the deployed backend, build download links, or the final checklist."
---

# Release gates

If a rule here conflicts with `AGENTS.md`, stop and ask. **A missing or broken link means the item is not
complete** (brief). Repo commands stay pending until they exist.

## Brief requirements

### Repository
- One public repo, structured as `/app`, `/server`, `/docs`, `/load-tests`.
- A clear name: `rota-mobile`, never `my-app-final-v2`.
- A **GitHub description and topic tags** (e.g. `react-native`, `expo`, `postgresql`).
- **Rota pinned** on Dave's GitHub profile.
- `.env.example` (names only) and an MIT `LICENSE`.

### README
- **The first screen must contain:** a one-line description, a GIF of the app, a download link, and a link
  to the demo video. *Why: most visitors never scroll.*
- Further down: the problem, a screenshot, the live backend link, the stack, how to run it, the
  architecture, key decisions, what's next.
- **A section on Apple's and Google's in-app purchase rules**, and how they would affect Rota in production.
- The payment wording: "This integration uses Stripe test mode only. Live-payment eligibility has not been
  verified."

### Task A deliverables (each needs a working link in `SUBMISSION.md`)
- Public repo · **Android development build download link** · **deployed backend**
- `README.md`, `ARCHITECTURE.md`, `STATE.md`, `SECURITY.md`, `SHARDING.md`, `LEARNING-LOG.md`
- An architecture diagram (format is our choice: Excalidraw or Mermaid in Markdown)
- Test results for **permissions, team isolation and proration**
- The load test report (200 virtual users, before and after caching)
- A demo video under 3 minutes (`evidence-capture.md`)
- A LinkedIn post about one technical decision

### Secret scan (release gate)
- Search **every repo's history**, not just the working tree (brief). GitHub's secret scanning helps, and
  the brief suggests searching for words like `sk_`, `secret`, `password`.
- **Our policy:** run a dedicated secret scanner over the full Git history (candidates: Gitleaks,
  TruffleHog; choose one in an ADR), then the brief's keyword checks as a supplement. Keyword or
  string-history searches alone are not a complete scan.
- Record in `SECURITY.md`: the tool and version, the scope (all branches, full history), the date, and the
  findings **redacted**. Never paste a discovered credential anywhere, including `SECURITY.md`.
- **A key that was ever committed is rotated at the provider:** generate a new one, disable the old one.
  Deleting the file leaves it in history.

### Where the submission lives
`SUBMISSION.md` is in a **separate repo**, `final-task-dave-hennit`. This repo produces the evidence and
the links; Dave assembles them there.

## Our policies

- **The README's download link is the preview APK**, because it runs without a dev server.
  `SUBMISSION.md` links both: the development build (the brief's Task A deliverable) and the preview APK
  for testing (`expo-builds.md`).
- The README's stack section names the Valkey substitution for Redis and links its ADR.
- Before submitting, open every link from a signed-out browser or a fresh device. Private repos and
  expired build links count as broken.
- **Free hosting may sleep.** Confirm the backend wakes successfully, document any cold-start delay, and
  verify the reviewer can complete the demo. A suspended service that cannot recover fails the gate.
- **Re-check the final deployment non-destructively:** API and worker up, both shards reachable, one
  test-mode payment, one email. **Queue-loss and failure-injection tests never run against the final
  services**; they run on disposable infrastructure (`jobs.md`).

## Release checklist

- [ ] Repo public, named clearly, with description and topics; Rota pinned
- [ ] README first screen has all four items; IAP section; test-mode wording
- [ ] All six docs present and current; architecture diagram present
- [ ] Permission, team-isolation and proration test results linked
- [ ] Load test report linked, before and after caching
- [ ] Development build link and preview APK link both install
- [ ] Deployed backend wakes and completes the demo; cold-start delay documented
- [ ] Demo video under 3 minutes, linked
- [ ] LinkedIn decision post linked
- [ ] Dedicated full-history secret scan plus keyword checks, recorded with findings redacted;
      anything found rotated
- [ ] Every link opened from a signed-out browser
