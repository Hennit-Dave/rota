# Learning log

## Self-study checklist

The seven self-study topics (a graded requirement). Tick a topic only when its entry below is written in your own words. Agents point out what is missing; they never write or edit an entry.

- [ ] EAS Build
- [ ] Why AsyncStorage is unsafe for tokens
- [ ] Refresh-token rotation and reuse detection
- [x] Idempotency (2026-10-21)
- [x] Observability
- [ ] Load testing
- [x] Architecture Decision Records (2026-10-16)

## 2026-10-15 — Agent instruction setup

Using one canonical file gives Claude Code and the Antigravity agent a single source of truth. If each agent had its own copy of the project instructions, those copies could gradually become different, causing the agents to follow different rules. With one shared file, I only need to update the instructions once. Both agents still need to know where that file is and when to read it.

Automatic loading means the instructions are given to the agent before it starts working. On-demand loading means the agent reads the file when it needs that information. On-demand loading only works reliably when the agent knows where to find the file and when to use it.

The Valkey mistake showed me what can happen when instructions leave out important details. The skill said to “record the marker” but did not say where. Because Valkey appeared throughout the rules, the agent assumed it was the right place. The agent loading test exposed that mistake. I updated the instructions to say the marker belongs in the API server’s own memory, not Valkey. Then I ran the test again, and it passed.

## 2026-10-16 — ADRs (self-study) and the server scaffold
ADR means Architecture Decision Record. It is a document used to keep track of an important technical decision made in a project, why that decision was made, the other options that were considered, and the trade-offs involved.
For the server toolchain, I chose TypeScript 6.0.3 instead of TypeScript 7 because `typescript-eslint`, which will be used in a later slice, currently supports TypeScript versions below 6.1.0. Choosing TypeScript 7 now could therefore create compatibility problems later.
Writing this as an ADR means i do not just record what was chosen. I also record why I rejected the other option, so someone reading the project later does not need to repeat the same research.
Another important part of an ADR is the revisit condition. A technical decision does not always have to stay permanent. In this case, I can reconsider TypeScript 7 when `typescript-eslint` supports the 7.x version and Prisma officially confirms support for it.
What I understand from this is that an ADR is not just documentation of a choice. It is a record of the reasoning behind the choice and the condition that could make me change it later.

## 2026-10-19 — Database shards, migrations and durable work records (PR #16)
Rota saves a record of the work in PostgreSQL before adding it to Valkey’s queue. If queueing fails or Valkey loses the job, the pending record remains so the reconciliation process can queue it again. The worker marks the work as done only after successfully processing it.
A shard is a database that hold one part of app's data, each shards has a teams in the database and those teams has an ID that helps them route functions which help them choose a shard consistently.
Using the same shard matters to keep it consistent and for it to not look at the wrong places when searching.
Both shards need the same tables because rota can work with both shards the same way so the structure matches. Rota saves unfinished work in PostgreSQL so that the record remains in PostgreSQL even if valkey loses the job so that unfinished work can be found and queued again.

## 2026-10-19— Background workers, retries, crash recovery and the autorun bug (PR #17)
Workers holds queued jobs, the worker picks up a job after working on it it becomes successful, however some jobs fails temporarily and that triggers another try after a delay.
When a worker crashes leaving unfinished work behind another worker can reclaim it after a limited time.
Before a duplicate job happen the database record is checked first, if it already says done, the job is skipped because the job was successful.
Logs are record, checking which job retried, failed or finished and it doesnt expose passwords or credentials, this helps fish out issues to know where how to solve the issue
The worker was created but didn’t start because an unset option overwrote the library’s default of starting automatically. Earlier tests missed this because they disabled startup or used a mock worker. The fix keeps automatic startup enabled unless explicitly turned off, and the new test checks all three cases: omitted, unset and false.

## 2026-10-21 — Reconciliation sweep and recovery guard (PR #18) · Self-study: Idempotency

**What this slice did:**  
PR #18 added a reconciliation sweep that checks Postgres for work that still needs to be done and puts it back into the queue if it is missing. It also added a recovery guard so that an old worker cannot come back later and update a job it no longer owns.

**What is idempotency?**  
Idempotency means doing the same action more than once should still give the same final result as doing it once.  
My everyday example would be locking my phone. If I press the lock button again after it is already locked, it stays locked instead of creating a second lock.

**Why do duplicates happen in Rota?**  
Duplicates can happen because a background worker may crash while doing a job, so the job gets retried. They can also happen when the reconciliation sweep and the normal queue process both try to add the same job.

**What does each tool protect?**  
The fixed job ID stops the same job from being added to the queue more than once.  
The claim token makes sure only the worker that currently owns the job is allowed to update it, so an old worker cannot come back later and overwrite the result.  
Resend's idempotency key helps stop the same email from being sent twice when the same key is used again.

**What can't it guarantee?**  
It cannot guarantee that an email will never be sent twice in every possible situation. For example, the worker could send the email through Resend, Resend accepts it, and then the worker crashes before saving `sent_at` in the database. When the job retries, the system may think the email was never sent. In that situation, only Resend's idempotency key protects against another send, and that protection only lasts for 24 hours.

**Where will it matter next?**  
It will matter even more with payments and webhooks. A payment request may be retried if the network fails, and payment providers can send the same webhook more than once. Without idempotency, the same payment could be processed twice or the same event could change the database twice. With money, duplicates are much more serious because they can mean charging a customer twice.

**What I got wrong at first:**  
My belief for a queued job was that it meant the job was done. However, I was wrong. A queued job simply means the work has been promised and is waiting to be processed.

The job first starts as **pending**. When a worker picks it up, it becomes **claimed**, meaning that worker currently owns the job and is responsible for processing it. It only moves to **done** after the actual action succeeds.

What showed me I was wrong was learning about the recovery process. A job can already be in the queue or even be claimed by a worker and still fail before the work is completed. For example, the worker can crash after claiming the job, which means another worker may need to recover and process it later.

This matters because being queued or claimed is not proof that the actual work happened. The system needs to track the real state of the work so it can retry unfinished jobs without losing them or allowing an old worker to update a job after ownership has changed.

**Sources read:**  
- Stripe documentation — idempotent requests  

## 2026-10-21 — Request IDs and safe logging · Self-study: Observability

Observability means being able to understand what happened inside a running system from the information it records. The brief’s goal is to answer “What happened to this user’s payment at 3:14pm?” using logs alone. The login logging is a step toward that goal, but payment tracing is still unfinished.
The user sees a general message such as “Email or password is incorrect,” while the internal log records the specific reason, such as bad_password. This helps investigate the failure without revealing to the caller whether an account exists. Each request gets a request ID—a tracking number shared by its log entries—so one login attempt can be followed without mixing it up with others.
An allow-list limits logging to approved fields, such as request ID, status and duration. If a new field hasn’t been approved, it stays out. This is safer than recording everything and trying to remove known secrets, because someone could forget to block a sensitive field. Approved fields still need checking to ensure their contents don’t expose passwords, tokens or other private information.
Logs also need testing. The reported bug recorded /login instead of /auth/login, showing that an application can work while its logs give misleading information. The lesson is to record enough to investigate problems, protect private information, and test that the records are accurate. Following payments through background jobs and keeping logs available long enough to investigate them still needs work.
**Sources read:**  
- OWASP Logging cheat sheet - 

