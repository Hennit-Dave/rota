# Learning log

## Self-study checklist

The seven self-study topics (a graded requirement). Tick a topic only when its entry below is written in your own words. Agents point out what is missing; they never write or edit an entry.

- [x] EAS Build
- [x] Why AsyncStorage is unsafe for tokens
- [x] Refresh-token rotation and reuse detection
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

## 2026-10-21 — Server authentication (PR A) · Self-study: Refresh-token rotation and reuse detection

**Why two tokens?**
The app uses 2 tokens because one of the tokens is used for every request to prove who the user is, the other token is to get an access token.
We use two tokens because a short-lived access token stops working, and the refresh token means the app doesn't have to log in again every 15 mins.

**Rotation and families**
Rotation means every time the phone uses a refresh token, the server marks the token used then gives back a new token and a new access token. The chain of used tokens coming from one login on one device is the family.

**Reuse detection**
When a phone uses a token then gets a new one, the old token is marked used. If an imposter tries the previously used token, the server sees a used token coming back and can't tell which one is the real user, so the server's only option is to kill the whole family.
Both the user and attacker get signed out; the real user gets logged in again and the attacker is logged out.

**Why only a hash is stored**
If the database gets stolen, they only see the fingerprints and not the usable tokens.

**Why every failure is the same 401**
So the attacker can't tell they have been caught, and only the server logs get to know the real reason.

**What I got wrong at first**
At first I thought the attacker would know they were caught, but actually they wouldn't know a thing, just the plain 401, and the server logs the reason why.

**JWT handling**
A JSON Web Token (JWT) is like a digital ID card that an app can check to confirm information about a user, such as their identity or permissions.
JWT handling is the process of how an app checks and uses tokens safely, including verifying signatures, checking expiry dates, and rejecting revoked tokens. It also explains how to protect tokens from theft and misuse.

**Sources read**
JSON Web Token Cheat Sheet — OWASP Cheat Sheet Series


## 2026-10-22 — Offline storage and token storage · Self-study: Why AsyncStorage is unsafe for tokens

**What AsyncStorage is**
AsyncStorage is a simple way for an app to save small pieces of data on your device, even after you close it. For example, it can save app settings or your theme choice. Think of it like a small storage box for the app.

**Why it's risky for tokens**
However, it stores data unencrypted, so anyone who gains access to those files could read what is saved there. That makes it risky for login tokens.

**What SecureStore does differently**
Expo SecureStore protects the data you put in it, not the whole phone. In SecureStore, tokens are saved encrypted. On Android, it uses encryption keys protected by Android Keystore. A token is a secret that lets you access your account. If someone steals a usable token, they may be able to act as you until it expires or is revoked.

**Shifts vs tokens in Rota**
For Rota, Expo SQLite can hold the offline shifts the app needs. Shift information can still be private, so only the fields needed are kept, and the saved shifts are cleared on logout. Tokens need stronger protection, so they belong in SecureStore.

**Sources read**
Expo SecureStore documentation.


## 2026-10-22 — App scaffold and first native build (PR #25, #27) · Self-study: EAS Build

**What a development build is**
A development build is a testing version of your own app. It includes the native features your app needs — parts that work directly with Android or iOS. Expo Go comes with a fixed set of those features, and you cannot add new native pieces to it.

**What EAS Build does**
EAS Build turns your project's code into an app you can install. Its cloud service does the building on Expo's computers instead of using your Mac. It can also manage the signing credentials used to sign the app.

**Why the native modules were planned first**
Adding native code that isn't already inside your development build requires rebuilding it. Planning the modules first helps avoid unnecessary builds and saves time and your cloud allowance. Ordinary JavaScript changes usually don't require a new native build.

**What the local build proved**
The local test checked that the app could build and run on the emulator using 16 KB memory pages. That helped catch compatibility problems before using a cloud build. The cloud APK still needed its own check because it was a separately built file.

**What surprised me**
One thing that surprised me was the emulator froze because the Mac ran low on memory: build programs were still running in the background and iCloud was likely syncing the project's build folders. The build tools were stopped, and I moved the project out of iCloud into a Developer folder.

**Sources read**
Development build guidance and EAS Build documentation.


## 2026-10-22 — Sign-in screens (PR #30)

**What this slice does**
It adds login and signup screens and connects them to the server. After a successful login or signup, the app stores the login tokens safely in SecureStore.

**How the app decides what to show on launch**
The app checks the saved session with the server first. While checking, it shows a loading screen. A valid session opens the signed-in screens; an invalid or missing session opens the login and signup screens. A connection problem should allow a retry rather than automatically treating the user as logged out.

**Errors come from the server**
The server returns an error code, and the app turns it into a clear message. This keeps the app's response consistent with what actually happened.
"Email or password is incorrect" appears in a banner because the server deliberately doesn't reveal which detail was wrong. Marking either field would suggest the app knows which one caused the failure and could reveal whether an account exists.

**What I learned**
One thing I learned is from missing the grey-dim bug. I was told to record every bug along the way for the build, but the agent went ahead and fixed it. If it had been recorded, it would give me an edge if something like that occurred again. I then told the agent to always stop and show me any bug it encounters before fixing it, so I can record the bug and also record the fix.

## 2026-10-23 — Teams and roles (PR #34)

I built team creation and permission checks. A user can create a team and become its Owner. The server checks their membership and role before allowing an action.
When joining, the directory record is saved first and membership second. The directory helps find the team, but only membership gives access. If the process stops halfway, the directory record alone cannot let someone in. When leaving, membership is deleted first so access ends immediately, even if cleaning up the directory fails.
A stranger gets 404 so the response doesn't reveal whether the team exists. A Staff member trying a Manager-only action gets 403 because they already belong to the team, but their role doesn't allow that action.

## 2026-10-23 — Invites server slice (PR #36)

The invitation and the task to send its email are saved in one transaction, so both are saved or neither is saved. If Resend sends the email but its reply gets lost, the worker retries with the same idempotency key to prevent a duplicate email within Resend's deduplication window. The database separately prevents the same person from having duplicate memberships in one team. If someone accepts an invite but loses the success response, their retry gets 200 again because the server sees that they already accepted it. Nothing new is created, and another person cannot use that accepted invite.

## 2026-10-26 — Invites app slice (PR #40)

The invite screen did not save the invitation token in app storage, it used the token from the link. This avoided leaving an extra saved copy of a sensitive token that could be exposed or accidentally reused later. I also learned that a screen can be hidden without being closed. An old invite screen stayed alive underneath Home and reacted when another invite link arrived. This taught me to check which screens are still listening for links, not just which screen is visible.

## 2026-10-26 — Valkey recovery after silent connection loss (PR #42)

The Valkey connection stopped responding without clearly disconnecting, so login kept failing until the API restarted. I learned that "connected" does not always mean a connection is working. The fix detects when the connection stops responding and replaces it so the API can recover.

## 2026-10-26 — Password reset and magic link (PR #45)

Someone could register with your email and choose a password. When you open the magic link in your inbox, you prove you control that email. In Rota, for an unverified email, it then removes the previously set password and ends the existing sessions, so that person can't keep accessing the account. Removing both matters: deleting the password stops future password logins; ending sessions removes access they already had.

## 2026-10-27 — Shifts and calendar (PR #47)

I learned that checking for overlapping shifts separately from saving leaves a gap where two managers could both see the same person as available. The overlap check and save need to happen in one transaction, with protection against simultaneous bookings, so both conflicting bookings cannot succeed. A transaction alone is not enough unless the database also makes those competing operations wait or rejects one.

## 2026-10-27 — Activity feed (PR #49)

I learned that cursor pagination keeps my place in a feed by using the last row's timestamp and ID instead of counting how many rows to skip. New rows can arrive at the top without making the next page repeat earlier rows. The ID acts as a tiebreaker when two rows have the same timestamp.

## 2026-10-27 — Shift swaps (PR #50)

I learned that idempotency means retrying the same action does not create extra results. For a swap request, the app reuses the same key so a lost response does not cause a second request for the manager. The database's unique rule prevents duplicates even when retries arrive at the same time.

## 2026-10-28 — Settings (PR #51)

I learned that the server sets updatedAt so changes use one trusted clock instead of different phone and tablet clocks, which could be wrong. This makes the order of saved updates consistent, but it records when the server accepted a change, not when the user originally made it.
