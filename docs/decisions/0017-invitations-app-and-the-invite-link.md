# 0017: Invitations in the app: the invite link, the return after sign-in, and the right team

- **Status:** accepted (2026-10-25; Dave approved the plan on 2026-10-24 and its changes after the proof run)
- **Date:** 2026-10-25
- **Decided by:** Dave
- **Related:** ADR 0009 (routing, deep links), ADR 0015 (invitations, server), ADR 0016 (invite email job), `.agents/rules/security.md` (Invites, amended), `docs/STATE.md`, the brief (Requirement 3: invite flow; Required feature 1), issues #35, #37, #38, #39, Figma "03 Authentication" (invite-accept 8:119, invite-confirm 8:134, invite-expired 8:146, invite-wrong-email 100:204, invite-offline 289:469)

## Problem

The server half of invitations exists (ADR 0015). The app has to open the link, show what it is for, let the person sign in or sign up, and put them in the invited team, "the right
team" in the brief's words, without ever showing Create team and without a screen deciding anything about permissions. Several choices could each be got wrong in a way a person notices:
where the invitation screen lives, how it survives signing in, where the secret in the link is kept, and what happens when the same person opens a link twice.

## What this PR covers, and what it does not

**This PR covers email invitations and the deep link that opens the app** (the Figma invite frames, the accept flow, login and signup from an invitation). The brief's Required feature 1 reads
"invite team members **by email or link**". Dave does not accept an email-only reading, so **link invitations (a shareable, single-use link not tied to an email) are built as their own small
slice right after this PR.** They are not in this PR. The questions to settle (who may create one, which roles, expiry, single use, revoke, and the schema change to `invitations`, which Dave
approves separately) are issue #37.

## Options considered and decided

1. **Where the invitation screen lives.** (a) Inside the signed-in or the signed-out group: each would need its own copy and could not be reached from the other side. (b) **A root route,
   `invite/[token]`, outside both session guards** (chosen): reachable signed in or signed out, one screen with one set of states. Sign in and Create account open on top of it.
2. **How signing in or signing up returns to it.** (a) Trust the invitation screen to still be underneath. **Tried and failed on the device (2026-10-24):** starting a session removes the
   signed-out screens and Expo Router puts Home on top, so the person landed on Home, and a new account with no team would be sent on to Create team. (b) A pending-invite store: Zustand is reset on
   every sign-out by design (`app-state.md`), and the secret must not go into secure-store or any cache. (c) **Carry the token as route params to login and signup (memory only) and, once the session
   exists, return with `dismissTo` to the existing invitation screen** (chosen). `dismissTo`, not `replace`: a `replace` made a second copy and left the first running underneath, which
   later sent the person away from a newer invitation (below). The pure decision is `routeAfterAuth` (tested): from an invitation both flows end back on it and never on Create team.
3. **Where the secret is kept.** Nowhere: it lives in the route (memory) and is never logged, never put in a TanStack query key (the preview query's key is the screen's own ID plus a counter), and
   never stored. It also travels as a route parameter to login and signup, which is why `SECURITY.md` says to scrub route params when Sentry is added.
4. **Opening a link consumes nothing.** The app calls the preview endpoint (a POST, so the token never sits in a URL or an access log). Only the tap on "Accept invitation" accepts.
5. **"Lands in the right team" (the brief).** After Accept, the accepted team is put into the teams list **from the accept answer** and selected, then the list is refetched. Without the seed, the home
   screen's own rule (keep the selection only while the list has it) would send a person who is already in another team back to their first team. Tested, and shown on the emulator with an
   account that already had another team, including a second team on the other shard.
6. **Preview mirrors accept's replay (server, Dave, 2026-10-24).** Someone who taps their email link again after joining was told "No team access was granted", which is false. Now `POST
   /invitations/preview` answers `200 { status: "already_member", team, role }` to **the one account that already accepted this exact token and still has the membership**, and the app takes them to
   that team. Everyone else keeps the identical `404 invite_unavailable`, signed in or not. **Amends ADR 0015, 3a** ("the preview of a spent link stays unavailable for everyone") and `security.md`
   (Invites); tested both ways. It reveals nothing the account did not already know.
7. **Defence against screens left underneath.** A screen that is not in front must not act: the preview query runs only while the invitation screen is focused, and the already-member redirect
   navigates only when focused. Found when a hidden copy replaced a newer invitation with Home.
8. **Accept is one request.** The button greys out only after React re-renders, and quick taps can arrive first (three taps sent two requests). A synchronous latch refuses the second tap
   until the request finishes (Figma note 232:415). The server was already idempotent, so this was never a double join, but the app must not rely on that.
9. **No screen waits for ever.** TanStack pauses a query while offline, which left "Opening your invitation" on screen. The preview now runs offline, the client says "offline" at once, and
   the Figma offline screen (289:469) shows. A request that does start is bounded by the client's 15 s timeout (tested).
10. **Leaving the invitation screen leaves nothing behind.** Every exit (Accept, Back to Rota, Back to login, Close, the already-member redirect) goes through one helper: pop back to the screen
    behind it if there is one, otherwise replace itself. A bare `replace('/')` over Home made a second Home, so Back needed an extra press per copy (tested; both cases).

## Consequences

- One invitation screen reaches every state in the Figma frames, signed in or signed out; the three states Figma has no frame for (loading, rate limited, generic error) reuse the login patterns and
  are marked "not in Figma yet" in the copy file.
- The Manager access line ("Create and edit shifts, approve swaps and manage your preferences.") is built from the brief's role list; Figma only has the Staff text.
- The link carries the team ID and the secret; the app never inspects it and the server decides everything (permissions, role, team).
- **Proven with adb, not with a tapped link.** Until `rota.davebuilds.design` is hosted (issue #35) Android reports the domain as unverified, so a tapped `https` link opens the browser. The adb
  intent (`-p design.davebuilds.rota`) proves the app's handling, not a Gmail tap.
- **Cold start from a link needs a preview build:** a development build opens the dev launcher first. To be tested once before submission.
- Revisit when: link invitations are built (#37), Sentry is added (scrub route params), the team picker exists (the selection rule), seat limits land (the accept answer may change).

## Evidence

Unit tests (app `npm test`, 167): the link and response parsers, the failure mapping, the screen states, `routeAfterAuth`, the accepted-team seeding, the preview query settings, the latch, `goBackTo`,
and the offline and timeout behaviour of the preview call. Server (`invites.integration.test.ts`): "preview mirrors accept". On the emulator (development build, local API on the test shards, worker
off so the invite links stay in the work rows): signed-out invitation; login from an invitation; signup from an invitation (never Create team); Accept landing on the invited team for an account that
already had another; wrong account, then log out and sign in correctly; unavailable (revoked, expired, unknown, no token) signed in and signed out with the right button; the replay; the `https` link;
warm start; offline and recovery; three taps on Accept sending one request; Back from Home needing one press. Bugs found and fixed on the way: the link opened after an Accept was undone by a hidden
invitation screen (issue #38); a double Accept request; offline waiting for ever; a second Home behind Home. The stale Valkey connection seen on the local API is issue #39 (not part of this PR).
