# Build prompt — Rota (Mobile Task A)

Paste everything below the line into a fresh chat with your build agent.

---

You are helping me build **Rota**, a shift scheduling mobile app, as a graduation requirement for the Dev and Design HQ Product Design and Engineering Bootcamp. I am a design engineer. I will be judged on whether every requirement below is demonstrably met, with evidence, and on whether I can explain every line of what we build.

## Chosen project decisions

The stack list below repeats the brief's allowed options. These are the choices made for this project. Where this section and the rest of this prompt differ, this section wins. Where anything here differs from the graduation brief, the brief wins.

- **One repo.** App, server, docs and load tests together.
- **Backend:** Node.js + Express + TypeScript.
- **Database:** PostgreSQL on two Neon projects, one per shard, using pooled connection strings and read replicas.
- **Queue, cache and rate limiting:** one Aiven for Valkey instance. Valkey is a substitution for the Redis the brief names, **pending facilitator acceptance**. Upstash is not used for the queue.
- **Payments:** Stripe test mode only. Stripe collects amounts we calculated, through Checkout in payment mode or a PaymentIntent. No Stripe Subscriptions and no subscription quantity changes; plan, seats and billing period live in our database.
- **Email:** Resend HTTP API, sent from a background job. Sender `Rota <notification@rota.davebuilds.design>`, Reply-To `rota@davebuilds.design`.
- **Cost:** the purchased domain is a separate expense. All other infrastructure stays on free plans, with no paid upgrades or expiring trial credits.
- **ORM:** Prisma 7 with `@prisma/adapter-pg`, one client per shard primary and replica.
- **Pending approval:** the deployment provider and the client state tool.
- **Removing seats takes effect at the end of the period**, like a downgrade. The brief doesn't say; this is our chosen interpretation, for the same reason the brief gives for downgrades.
- **Proration test 8 (our choice, since the brief names seven cases and asks for at least eight): adding seats beyond the included limit.** A customer on Team (5000c/month, 15 seats included, extra seat 300c/month) is already at 15 seats and adds 3 seats with 12 days remaining in a 30-day period. 3 × 300 × 12 ÷ 30 = 360 cents, rounded down. **Charge today: 360c.** Companion case, same inputs but starting at 12 seats: adding 3 takes them to 15, still inside the included limit, so the charge is **0c**.

## How you must work with me

These rules override your defaults. Follow them for the whole project.

1. **Plan before you build.** Before writing code for any requirement, tell me in plain words: what the problem is, what the options are, which one you recommend and why, and what files you will touch. Wait for me to say go. Do not produce a wall of code and then explain it afterwards.

2. **Explain in simple words first, jargon second.** When you introduce a concept — cursor pagination, refresh token rotation, read-your-own-writes, idempotency — explain it as if to someone who has not met it, then use the proper term. I have to defend all of this in an interview.

3. **Build in slices and stop at each one.** One requirement at a time, working and verified, before the next. Do not scaffold the whole app in one pass.

4. **After each slice, prompt me to write a LEARNING-LOG entry.** I am required to close the chat and write a paragraph in my own words explaining what we built. Remind me. Do not write it for me.

5. **Show me the evidence, not just the behaviour.** "It works" is not success for this task. Success is the correct row existing in the database and me being able to show it. When a slice is done, tell me the exact query, Postman request, or test command that proves it.

6. **Never invent a number.** If you don't know a package version, a config value, or current provider pricing, say so and check. A wrong fact I repeat in an interview is worse than a gap.

7. **Tell me when I am wrong.** If I ask for something that conflicts with a requirement below, or that will fail a reviewer, say so directly rather than building it.

## The seven rules that govern the whole project

These come from the task brief and are non-negotiable.

1. **I must be able to explain everything submitted.** You can write the code. I must understand any line of it well enough to explain it. In an interview nobody cares that the code works; they care whether I understand why it works and what breaks it.

2. **Never trust the frontend.** Every check that matters — who the user is, what they paid, what they are allowed to see — happens on the server. The app only displays what the server allows. Anyone can modify a mobile app or call the API directly with Postman, so checks inside the app protect nothing.

3. **Money is stored in minor units.** Store kobo and cents as whole numbers, never naira or dollars with decimals. `0.1 + 0.2` in JavaScript is `0.30000000000000004`, and over thousands of payments those errors become real money.

4. **"It works" is not success.** Success means the correct record exists in the database and I can show it.

5. **No secrets in the repository or the app.** API keys, database passwords and payment secret keys live in server environment variables. Every repo has a `.env.example` listing variable names with no values. Anything inside a mobile app can be extracted — variables starting with `EXPO_PUBLIC_` are bundled into the app and readable by anyone who downloads it.

6. **The project ends with a LinkedIn post** explaining one specific technical decision and why. Not an announcement post.

7. **The explain-back rule.** After you help me build something, I close the chat and write a short paragraph explaining it in my own words, saved in `LEARNING-LOG.md`.

## Required tech stack

Use exactly this. Do not substitute without telling me why and getting agreement.

- **React Native with Expo.** I build in Antigravity.
- **Backend I control**: Node.js (Express or Hono) or Next.js API routes, with **PostgreSQL**.
- **Redis** for caching, rate limiting and locks. Upstash free tier is fine.
- **BullMQ** (runs on Redis) for the background job queue.
- **Payments in test mode** with Paystack or Flutterwave. Stripe is allowed if I can open an account.
- **Zod** validating every incoming request on the server — body, query parameters and route parameters.
- **TanStack Query** for all server state.
- **expo-secure-store** for tokens. Never AsyncStorage — it is unencrypted.
- **k6** for load testing.
- **Sentry** on both app and server.
- **EAS Build** for the Android development build. Push notifications do not work in Expo Go on Android, so a development build is required. Android only is acceptable; iOS device builds need a paid Apple Developer account.

I have a free Expo account with 15 Android builds a month on a low-priority queue, so **install all native dependencies up front and rebuild as rarely as possible.** Tell me when a change you are proposing will require a new native build.

## Repository structure

One public GitHub repo (or one for app and one for backend, linked to each other in both READMEs). Structure:

```
/app          Expo React Native app
/server       API, jobs, database
/docs         ARCHITECTURE.md, STATE.md, SECURITY.md, SHARDING.md, decisions/
/load-tests   k6 scripts and the written report
```

Plus at the root: `README.md`, `LEARNING-LOG.md`, `.env.example`, `LICENSE` (MIT). **If the app and backend are split into two repos, each one needs its own `.env.example` and `LICENSE`, and each README must link to the other repo.**

**Repo naming:** clear and descriptive — `rota-mobile` and `rota-server`, never `my-app-final-v2`.

**Repo settings, which are graded and easy to forget:** every public repo needs a **GitHub description** and **topic tags** (`react-native`, `expo`, `postgresql`, `redis`, and so on), and **Rota must be pinned on my GitHub profile** when it is done. Remind me to do both — they are a required checklist item, not polish.

**Secret scanning:** at the end of the project, **search the full Git history for secrets**, not just the current working tree. Search for patterns like `sk_`, `secret`, `password`, `_KEY`, and check GitHub's secret scanning alerts. **If a key was ever committed, deleting the file is not enough — the key is still in the history. It must be rotated at the provider**: generate a new one and disable the old one. Tell me how to run this check and treat it as a release gate, not an afterthought.

**Note on `SUBMISSION.md`:** it lives in a **separate** repo (`final-task-dave-hennit`), not in the Rota repo. The Rota repo's job is to produce the evidence and the links; I assemble them there.

### Process requirements that cannot be retrofitted

Set these up on the first commit. They are graded and they cannot be reconstructed at the end.

- **Conventional Commits**: `feat: add cursor pagination to shift feed`, `fix: prevent duplicate swap requests`.
- **A feature branch and a pull request per feature**, with a description and screenshots, merged by me. My repo history has to read as professional work.
- **`docs/decisions/`** — an Architecture Decision Record per significant choice: the problem, the options considered, what I chose, why. One short file each.
- **`LEARNING-LOG.md`** — my own-words paragraph per slice.
- **README written as we go**, not at the end.
- **GitHub issues used as the task list** for planned work.
- **Before-and-after recordings of problems I fix.** This is its own requirement, separate from PR screenshots and the demo video. When we hit a real bug — a double-submitted swap, a list that duplicates rows on fast scroll, a notification firing at 2am — **tell me to record the broken behaviour before we fix it**, then record it working after. These clips are required, and they are also the best material for LinkedIn posts and interviews. I cannot go back and film a bug I already fixed, so prompt me at the moment the bug appears, not afterwards.
- **Written self-study notes.** Several topics in this project are marked self-study because they were not taught in my class: EAS Build, why AsyncStorage is unsafe for tokens, refresh token rotation and reuse detection, idempotency, observability, load testing, and Architecture Decision Records. The requirement is that I **research each one and write down what I learned in my own words**, not merely use it. When we first touch one of these, say so explicitly and prompt me to write that topic's entry. These go in `LEARNING-LOG.md` and they are a graded requirement, not optional reading.
- **My daily log.** I have a separate job-hunt requirement to log every weekday — including minutes spent building. **At the end of each working session, remind me to record today's building minutes.** Missing days are a failed requirement in another part of this task, and a long build sprint is exactly when I forget.

Remind me of these when I forget. If I go three features without a PR, say so.

### README requirements

The first screen of the README must contain, in this order, because most visitors never scroll:

1. One-line description of what Rota is
2. A GIF of the app running
3. The Android development build download link
4. A link to the demo video

Further down: the problem it solves, tech stack, how to run it locally, architecture summary, key decisions, what I would do next, and a section explaining **how Apple's and Google's in-app purchase rules would affect this app in production** — they require their own IAP systems for many digital subscriptions sold inside apps. I am not publishing to the stores, so I use my payment provider in test mode, but the README must show I know this.

---

# What Rota is

Rota is a shift scheduling app for small teams such as restaurants, clinics and retail stores. A business owner creates a team, invites staff and publishes shifts. Staff see their shifts, request swaps and get notified about changes. Businesses pay a monthly subscription priced per staff member (per seat).

**Three roles:**

- **Owner** — creates the team, manages billing, full control
- **Manager** — creates and edits shifts, approves swaps
- **Staff** — views shifts, requests swaps, sets their own preferences

**Eight required features:**

1. Sign up, log in, log out, and invite team members by email or link
2. Role-based permissions for Owner, Manager and Staff
3. Shift calendar and a paginated activity feed (new shifts, swaps, changes)
4. Shift swap requests with manager approval
5. Subscription plans with seat-based pricing, upgrades, downgrades, and adding or removing seats mid-cycle, with proration
6. Push notifications for shift changes, swap requests and approvals
7. User settings synced across devices and respected by the server
8. Offline viewing of the user's upcoming shifts

---

# The backend system design standard

This applies to the whole backend. Several of these were taught in my class; the ones marked self-study were not, and I have to research and write them up in my own words.

### Connection pooling

A pool is a fixed set of database connections the server reuses instead of opening a new one per request. Opening a connection is slow, and PostgreSQL limits concurrent connections (default 100); serverless functions make this worse because each one can open its own.

**Required:** use the provider's pooled connection string (Neon and Supabase both offer one), or PgBouncer, or the ORM's pool settings. **Set a pool size and justify that number in the docs.**

### Replication and read-your-own-writes

The primary handles writes; replicas receive those changes and handle reads. Most apps read far more than they write, so this takes load off the primary. The catch is replication lag — a replica receives changes a moment later, so a user who saves something and immediately reads from a replica may see old data.

**Required:** if the provider offers read replicas on my plan, use one. If not, create a second connection string for reads, route read queries to it in code, and document what changes in production. Either way, **implement read-your-own-writes: for 5 seconds after any write, that user's reads go to the primary.**

### Sharding — simulated, not theoretical

**Required for this app:** create **two separate PostgreSQL databases**. Route each team's data to a shard based on a **hash of `team_id`**. Write **`SHARDING.md`** explaining the shard key choice, how I would handle a single very large team, and which queries became harder.

The trade-off to document: sharding by `team_id` keeps one team's data together so a dashboard needs only one database, which is good — but one enormous team creates a hot shard that gets most of the traffic while others sit idle.

### Caching

Cache-aside for read-heavy data, a TTL on **every** cached item, explicit invalidation when data changes. Document what is cached and what is never cached.

**Never cache:** active subscriptions, payment status, credit balances, webhook idempotency records.

For this app specifically: cache **team rosters and shift calendars**, and invalidate when shifts change.

### Rate limiting

Per user and per IP, **using Redis, not an in-memory JavaScript object** — an in-memory limit resets on restart and does not work across multiple servers. Strict limits on login, password reset, invites, payment initiation, and any expensive endpoint.

### Background jobs and queues

Anything slow or unreliable runs as a background job: push notifications, webhook processing, emails, slow third-party calls. Jobs **retry with exponential backoff** and move to a **failed list** after a set number of attempts.

### Idempotency [self-study]

An operation is idempotent if doing it twice has the same effect as once. Networks fail: a user taps Pay, the request succeeds, the response never arrives, the app retries — without idempotency they pay twice. Payment providers also send the same webhook more than once.

**Required:** the app generates a unique idempotency key per payment attempt and sends it in a header. The server stores the key with its result, and a repeated key returns the stored result instead of charging again. For webhooks, store each event ID and skip events already processed.

### Observability [self-study]

Log every request with a **request ID, user ID, route, response time and result.** Log every job attempt. Sentry on app and server. The test: I must be able to answer **"what happened to this user's payment at 3:14pm?"** from the logs alone.

### Load testing [self-study]

k6. A `load-tests/` folder with the scripts and a **written report** of results.

---

# Requirement 1: Pagination

Loading a long list in pages instead of all at once. Two approaches:

- **Offset pagination** — "skip 20, take 20". Simple, but breaks when new items arrive while the user scrolls.
- **Cursor pagination** — "give me 20 items older than this item". The cursor points at the last item the user saw, usually its timestamp and ID. It stays correct when new items arrive.

Why it matters here: a waiter scrolls the activity feed. With offset pagination, his manager posts 3 new shifts at the top while he reads page 1. Loading page 2 with "skip 20" shifts everything down by 3, so he sees items he already saw — and in other cases items get skipped entirely.

**I must:**

- Implement **cursor pagination on the server** for the activity feed, using a **combination of timestamp and ID** so items with identical timestamps are not skipped
- Add a **database index that supports the cursor query**, and show the query plan with **`EXPLAIN ANALYZE` before and after** the index
- Use **infinite scroll with FlashList** (or FlatList with a written reason), plus **pull to refresh**
- Show **loading, empty, end-of-list and error** states
- **Prevent duplicate requests** when the user scrolls fast
- **Seed at least 10,000 activity records** to prove it works at volume

---

# Requirement 2: State management

Three kinds of state:

- **Server state** — shifts, team members. Lives on the server. Use TanStack Query to fetch, cache and refresh.
- **Client state** — which tab is open, a form being filled. Exists only in the app. Zustand or React state.
- **Persisted state** — upcoming shifts, which must survive closing the app for offline use.

**Optimistic updates:** when the user acts, show the result immediately, send the request, roll back if it fails. Without it a user taps "Request swap", waits two seconds, taps again, and sends two requests. With it the shift instantly shows "Swap requested", the button disables, and on failure the label reverts with an error.

**I must:**

- Use **TanStack Query for all server data**, with cache times explained in the docs
- Use **one client state tool** and explain why I chose it
- Implement **optimistic updates with rollback** for **swap requests and settings changes**
- **Persist upcoming shifts** so they display offline, with a visible **"last updated" time**
- Write **`STATE.md`** mapping every important piece of data to where it lives and why

---

# Requirement 3: Authentication

**I must:**

- Email and password sign-up and login, **plus one of**: Google sign-in or magic link
- Store tokens in **`expo-secure-store`, never AsyncStorage** — AsyncStorage is unencrypted [self-study]
- **Short-lived access tokens and refresh tokens. Rotate the refresh token every time it is used, and reject a refresh token that has already been used** — reuse signals the token was stolen [self-study]
- Implement **"log out of all devices"**
- **Invite flow:** an owner invites a staff member, who signs up through a link that opens the app (a **deep link**) and lands in the right team
- **Password reset with a single-use, expiring token**

---

# Requirement 4: Security

The scenario this guards against: a developer puts his payment secret key in an `EXPO_PUBLIC_` variable so the app can create charges directly. A user downloads the Android build, unzips it, searches the files, and finds the key in plain text — they can now issue refunds and read customer data. Anything inside a mobile app is public.

**I must:**

- **Enforce every permission on the server.** A Staff user calling the delete-shift endpoint directly with Postman must be rejected. **Include a test proving this.**
- **Prevent one team from ever seeing another team's data.** Every query filters by team ID on the server, or use PostgreSQL row-level security. **Include a test proving this.**
- **Validate every incoming request with Zod on the server — the whole request, not only the body.** That means **query parameters and route parameters too**: the activity feed's cursor and page limit, any ID in a path, any filter or sort parameter. A cursor is attacker-controlled input like any other, and an unvalidated `limit` is a denial-of-service waiting to happen. The shared stack rule is "validate every request on the server", so body-only validation does not satisfy it.
- **Rate limit login, password reset, invites and payment endpoints with Redis — plus any expensive endpoint.** The activity feed counts as expensive once it is serving 200 concurrent users.
- **No secrets in the app bundle.** Prove it by **listing every `EXPO_PUBLIC_` variable and explaining why each one is safe to expose.**
- Write **`SECURITY.md` listing 8 threats to this app and how each is handled**

---

# Requirement 5: Payments and proration

Proration means charging fairly for part of a billing period when a customer changes plans or seats mid-period.

## The plans — use these exact prices, stored in cents

| Plan | Price | Seats included | Extra seat |
|---|---|---|---|
| Starter | $20/month (2000 cents) | Up to 5 | Not available |
| Team | $50/month (5000 cents) | Up to 15 | $3/month (300 cents) |
| Business | $120/month (12000 cents) | Up to 40 | $2/month (200 cents) |

## The worked example that must produce exactly this answer

A café owner has 5 staff on Starter. His 30-day billing period started on the 1st. On the 11th he hires 4 more people and upgrades to Team. There are 20 days left.

- Credit for unused Starter time: `2000 × 20 ÷ 30 = 1333` cents (rounded down)
- Cost of Team for the remaining time: `5000 × 20 ÷ 30 = 3333` cents (rounded down)
- **Charge today: `3333 − 1333 = 2000` cents ($20.00)**

On the 1st of next month he pays the full $50.

**Downgrades apply at the end of the period**, not immediately — refunding partial payments adds risk and most subscription products work this way.

**I must:**

- **Implement proration myself on the server. Do not rely on a provider feature to calculate it.** Write the formula in the docs, **including the rounding rule.**
- **Unit tests for at least 8 proration cases:** upgrade, downgrade, adding seats, removing seats, change on the first day, change on the last day, two changes in one period — and at least one more of your choosing
- Payments go through **provider checkout in test mode**. **The app never decides whether a payment succeeded. The server decides, based on a verified webhook.**
- **Verify every webhook's signature. Process webhooks in a background job. Store each event ID and ignore duplicates.**
- **Idempotency keys on every payment request**
- Keep a **ledger table**: every charge, credit and refund is a row that is **never edited or deleted**. Corrections are new rows. **The subscription state must be rebuildable from the ledger.**
- **Enforce seat limits on the server.** An owner on Starter cannot invite a sixth person.
- **Handle a failed renewal:** a grace period of a set number of days, notifications to the owner, then restricted access

---

# Requirement 6: Push notifications

**I must:**

- **Register each device's push token after login** and store it on the server, linked to the user and the device. **One user can have several devices.**
- **Send notifications from a background job, never inside the request that triggered them**
- **Handle invalid tokens:** when the push service reports a token is no longer valid, delete it
- **Tapping a notification opens the exact screen it refers to** (deep linking)
- **Group notification types** — shift changes, swaps, billing — so users can turn each type on or off
- **Respect quiet hours and the user's time zone on the server** (see Requirement 7)

---

# Requirement 7: Settings coordination

Keeping settings consistent between devices and the server, and making sure the server obeys them.

The scenario: a nurse manager sets quiet hours 10pm to 6am on her phone. The setting is saved only on the phone. At 2am a colleague swaps a shift and the server sends a push notification, because the server never knew about her quiet hours. Her tablet, still on old settings, buzzes too. The fix is settings living on the server as the single source of truth, each device loading them on launch and listening for changes, and the notification job checking her quiet hours in her time zone before sending.

**I must:**

- **Store settings on the server:** quiet hours, time zone, notification types, language, theme
- **Changes on one device appear on the user's other devices** without reinstalling — refetch when the app opens or comes to the foreground, or use real-time updates
- **Handle conflicts:** each setting has an **`updatedAt` time set by the server, and the most recent change wins. Document this choice and its weakness.**
- **The notification job checks quiet hours and time zone before sending, and delays non-urgent notifications**
- **Settings changes use optimistic updates with rollback**

---

# Task A backend system design requirements

- **Connection pooling** configured, with the pool size justified
- **Read and write routing with read-your-own-writes**
- **Sharding simulation:** two separate PostgreSQL databases, each team routed by a hash of `team_id`, with **`SHARDING.md`** covering the shard key, how I would handle a very large team, and which queries became harder
- **Redis caching for team rosters and shift calendars**, with invalidation when shifts change
- **Load test: 200 virtual users loading the activity feed at once. Report response times before and after caching.**

---

# Deliverables checklist

Every one of these needs a working link in my `SUBMISSION.md`. A missing or broken link means the item is not complete.

- [ ] Public GitHub repo (or app repo and backend repo, linked to each other)
- [ ] **Android development build download link**
- [ ] **Deployed backend**
- [ ] `README.md`
- [ ] `ARCHITECTURE.md`
- [ ] `STATE.md`
- [ ] `SECURITY.md` (8 threats)
- [ ] `SHARDING.md`
- [ ] `LEARNING-LOG.md`
- [ ] **An architecture diagram** (Excalidraw or Mermaid in Markdown)
- [ ] **Test results for permissions, team isolation and proration**
- [ ] **Load test report** (200 VUs, before and after caching)
- [ ] **A demo video, under 3 minutes, structured as: the product first, then one technical deep dive.** Not a feature tour, and not architecture first — a viewer has to see what it does before they care how it works.
- [ ] **A LinkedIn post about one technical decision**
- [ ] Before-and-after recordings of problems fixed during the build
- [ ] Written self-study notes in `LEARNING-LOG.md` for every topic marked self-study
- [ ] GitHub description and topic tags on each public repo
- [ ] Rota pinned on my GitHub profile
- [ ] Git history scanned for secrets, and anything found rotated at the provider

Plus, from the positioning section of the brief:

- [ ] Two LinkedIn posts per week during the build, each covering one problem and one decision
- [ ] A case study on my portfolio site: problem, constraints, architecture, three hardest decisions, results with load test numbers, what I would do next
- [ ] 30 target companies that build scheduling, workforce, HR or B2B SaaS tools, added to my lead tracker
- [ ] **Outreach that leads with Rota.** When I message a scheduling, workforce, HR or B2B SaaS company, Rota is the proof I lead with, and I point at **the specific feature closest to their product** — swap approval for a shift-scheduling tool, seat-based proration for a B2B SaaS, quiet-hours-aware notifications for anything with on-call staff. A generic link is not this. To make that possible, help me keep a short list of "which Rota feature maps to which kind of company" as we build, so I am not inventing the mapping months later from memory.
- [ ] One CV and LinkedIn bullet with specifics

---

# Interview questions I must be able to answer

Check me on these as we go. When we finish a slice that covers one, ask me the question and tell me whether my answer would survive an interviewer.

1. Why cursor pagination instead of offset? Show me what breaks with offset.
2. A Staff user calls your delete shift endpoint with Postman. Walk me through what stops them.
3. Your access token is stolen. What can the attacker do, and for how long?
4. Calculate the charge if a Team customer adds 3 seats with 12 days left in a 30-day period.
5. The payment provider sends the same webhook three times. What happens?
6. The user changes quiet hours on their phone while offline, then changes them on their tablet. Which wins and why?
7. Why did you pick `team_id` as your shard key? When does it fail?
8. Why are push notifications sent from a job instead of the request?

---

# Suggested build order

Propose your own if you disagree, with reasons. My instinct:

1. Minimal scaffold: repo structure, `.env.example`, LICENSE, Conventional Commits, ADR folder, and an Express API and a worker process that both start. Only what the infrastructure proof needs.
2. **Infrastructure proof, before any feature work.** Run locally against the real cloud services: API and worker start; both Neon shards connected; a `Queue.add` consumed by a `Worker` on Valkey; a delayed job and a retry; recovery after a worker restart; **queue-loss recovery** (delete disposable queued jobs from Valkey and show the reconciliation process, running independently of BullMQ, restores them from PostgreSQL); one email sent from the worker through Resend; Neon, Aiven and Resend confirmed free with spending blocked. Nothing below starts until this passes.
   **Deployment proof** follows once the provider is approved: API and worker on the provider, stop-then-start deploys confirmed, recovery and one email repeated from the deployed worker. Feature work may continue locally meanwhile, but it must pass before read-your-own-writes (step 5) is marked done and before submission.
3. Sentry and request-ID logging. Boring, and everything else inherits from them.
4. Database schema and migrations, with the shard routing decided up front — retrofitting two databases later is painful.
5. Connection pooling and read/write routing with read-your-own-writes.
6. Auth: email/password, secure-store, access and refresh tokens with rotation and reuse rejection, log out of all devices.
7. Teams, roles, server-side permission enforcement, team isolation, and the two Postman tests that prove both.
8. Shifts and the calendar.
9. Activity feed with cursor pagination, the index, `EXPLAIN ANALYZE` before and after, and the 10,000-record seed.
10. TanStack Query throughout, client state tool, `STATE.md`, offline persistence of upcoming shifts.
11. Swap requests with manager approval and optimistic updates with rollback.
12. Settings on the server, cross-device sync, conflict handling.
13. Push notifications from jobs (BullMQ already proven in step 2), with token registration, invalid-token cleanup, grouping, deep linking and quiet hours.
14. Payments: plans, proration with its 8 unit tests, idempotency keys, webhooks verified and processed in a job, the ledger, seat limits, failed renewal and grace period.
15. Valkey caching for rosters and calendars, with invalidation.
16. k6 load test at 200 VUs, before and after caching, and the written report.
17. Docs, diagram, demo video, LinkedIn post.

**Start by reading all of this back to me as a short plan — what you understand the project to be, what you think the riskiest parts are, and what you want to confirm before we write any code.** Do not start building until I reply.