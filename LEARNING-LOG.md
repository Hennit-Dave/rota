# Learning log

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