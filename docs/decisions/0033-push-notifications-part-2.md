# 0033: Push notifications, part 2: shift and swap pushes, and one Android channel per type

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-11-03
- **Decided by:** Dave (plan approved 2026-11-03): who is told (below), never the person who acted; short generic lock-screen text; the channels created at every registration, billing on its own channel, **no migration**, and the older-install risk recorded here. Nothing is urgent in this slice either. Choices the plan did not spell out were made while building and are marked **new**.
- **Related:** issue #53, ADR 0032 (part 1: devices, the three jobs, quiet hours), ADR 0024 (the per-type switches), ADR 0029 (members deactivated at a reduction), `.agents/rules/jobs.md`, the `background-job` skill

## Problem

Part 1 built the engine and used it for the two failed-renewal pushes. A shift team also needs to hear when its schedule changes: a shift assigned, moved or removed, and a swap that needs a decision or has been decided. The brief asks for "grouped types with per-type toggles": the toggles exist (ADR 0024); the grouping is one Android notification channel per type, so a person can also mute one type in the phone's own settings.

## Options considered

1. **Where the event is written.** (a) After the request, from the route: a crash loses the push. (b) **In the same transaction as the activity row, on the team's shard**, as one `push_event` work row. Chosen: the push commits or rolls back with the change, and a Valkey outage cannot lose it (the sweep re-adds it). Part 1's fan-out, send and receipt jobs do the rest, unchanged in shape.
2. **Who is told.** Decided by Dave (see Decision). The approvers for a swap request come from the existing `approverIdsOf`, inside the same transaction.
3. **The words.** (a) The shift's title and times: useful, and readable on a locked phone. (b) **Short and generic.** Chosen by Dave: no title, time or name, only that something changed. The moment and the ids are in the `data`, which only the app reads.
4. **Channels and the older-install risk.** (a) A `channels_version` column on `device_tokens`, so the server names a type's channel only for a phone that created it: safe, but a new migration on the real shards. (b) **No migration: the app creates every channel at every registration, the server always names the type's channel, billing moves to its own `billing` channel.** Chosen by Dave. The risk is in "Known gaps".

## Decision

**Who is told** (`push/recipients.ts`, pure; **never the person who acted**):
- *Shift created, updated or deleted:* the person it is assigned to; on an update that changed the assignee, also the person it was taken from. An **open** shift tells nobody.
- *Swap requested:* the people who can decide it (the Owner and Managers, never the requester or the other party: a party may not decide their own swap), with "A swap needs your approval"; and the other party, with "A teammate asked to swap shifts with you". Two events, because the words differ. A repeat of the same `Idempotency-Key` tells nobody twice.
- *Swap approved or rejected:* both people in it, never the person who decided.
- *A swap cancelled by the requester* writes no activity row today, so it sends no push.

**Where** (`push/events.ts`): `createShift`, `updateShift`, `deleteShift`, `createSwap` and `decideSwap` each write the event inside their transaction and put it on the queue after the commit (`enqueueEvents`; the routers get an `enqueue`, like billing has). **The jobs** (`push/jobs.ts`) gain the six moments: the type maps to the person's switch (shift changes, swap updates), which now applies (none of these is essential); for these types the recipient must still be an **active member of the team** (any role) when the job runs, so someone who left, or was deactivated at a reduction, since the event gets nothing; billing stays Owner-only.

**Channels.** The app creates, at every registration, `shift_changes` ("Shift changes"), `swap_updates` ("Swap updates"), `billing` ("Billing") and `default` (what part 1 sent everything on). The server names the channel of the push's type. A server unit test reads the app's list and fails if the two ever disagree, because a mismatch drops pushes silently.

**Tap targets.** The push data gains an optional `shiftId` or `swapId`. The app maps `{type, moment, ids}` to a screen: a shift change opens that shift (a deleted shift opens the schedule), a swap event opens that swap, billing opens the billing hub. Anything else opens nothing; the server never sends a path.

**Nothing else changes:** no migration, no native build, no dependency, no new env name.

## Why

- Writing the event with the change is the only way to promise "if the shift changed, the person was told, and if it did not, they were not". Part 1 proved the engine; this reuses it.
- Generic words are the lock-screen privacy decision: a notification is readable by anyone holding the phone.
- A channel per type gives the person a second, phone-level mute on top of Rota's own switches, which the server still enforces first.

## Consequences and known gaps (written down on purpose)

- **Older-install risk (Dave, 2026-11-03).** A push that names a channel the installed app has not created is dropped silently. An install **older than this PR** has only `default`, so it would silently drop every shift, swap and **billing** push (billing moves off `default` here, including the essential failed-renewal notice). Today that is not a problem in practice: the development build loads the latest JavaScript from Metro and no preview build exists yet, so the only install is the one that runs this code. **If an older install ever exists in the wild**, either keep billing on `default` until it is updated, or add the `channels_version` column (option 4a, a migration needing Dave's go). Revisit before the preview build is handed to anyone.
- **Creating a channel again changes nothing the person set:** on Android, setting an existing channel's importance or name later does not override their own choices.
- **A shift update tells its person for any change, including a note.** There is no "only if the time changed" rule (a number of fields to choose); it is generic text, so the cost is one extra buzz.
- **Not covered by a push:** a shift that **starts soon** (nothing is urgent in this slice), a cancelled swap (no activity row), and a person's own actions (never told).
- **No grouping beyond channels:** Android's own stacking of notifications from one channel is the system's; Rota sets no group keys.
- **A change that tells more than 50 people** is not possible today (a shift has one assignee, a swap request has at most the approvers plus one); the event payload caps recipients at 50 (ADR 0032).
- Still open from ADR 0032: no TTL on a message, no cap on devices per person, enhanced push security off. (The cold-start tap is now verified in the preview build, ADR 0032.)

## Tests

Unit (`push/recipients.unit.test.ts`): who is told in every case, the types and channels, the data the phone receives, the generic text, and the app-versus-server channel agreement. Integration (`push/events.integration.test.ts`, test shards A and B, real HTTP): a shift made for someone tells that person on the team shard in the same transaction, never the person who made it, an open shift tells nobody; a move tells both; a refused shift writes no event; the service enqueues each committed row after the commit; a swap request tells the approvers and the other party and a retry tells nobody twice; approval and rejection tell both people and never the manager; the words carry no title, time or name. Jobs (`push/push.integration.test.ts`): channels and data, the per-type switches, a non-member and a deactivated member get nothing. App: `pushTarget.test.ts` (every moment routes; forged shapes open nothing) and `registration.test.ts` (the channels exist before the permission prompt).

## Evidence

See the PR description (the emulator, test shards, Expo sandbox) and `Rota-evidence/push2/` (outside the repo).
