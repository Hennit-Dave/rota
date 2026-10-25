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

## Team directory, invite form and role sheet (checkpoint 2)

11. **Reached from Home, no tab bar yet (Dave, 2026-10-24).** Figma's directory sits under a four-tab bar, but Schedule, Swaps and Settings have no screens, so a tab bar would be three dead tabs.
    The placeholder home gets a "Team" button instead. "Create a shift" is omitted for the same reason, and the Invitations block with "Manage invitations" belongs to the next step.
12. **The server decides what is offered.** "Invite a teammate" shows only when `invitableRoles` (from `GET /teams/:id`, the permission table) is not empty; the role sheet lists exactly those roles
    (an Owner: Manager or Staff; a Manager: Staff only, shown disabled as in Figma 103:2462; never Owner). A Staff member who reaches the form by a link is told "You can't invite people to this
    team" and nothing can be sent. Only the address and the role are ever sent.
13. **Every state of the Team screen ends.** A query that is paused offline, or switched off because nothing is selected, would leave "Loading your team…" for ever. The roster queries run offline
    (`networkMode: 'always'`), and `directoryStatus` decides every case: ready, loading, failed (error with Try again), or no team (back to Home, which goes on to Create team). It includes the case found
    on the emulator where the API is down at launch, so "who am I" fails, so the team list never starts, so no team is selected. The roster is the whole list in one answer, so it has loading, empty and error
    states but no pages and no end-of-list marker.
14. **Parts built from the design, not invented.** The role sheet is a plain React Native `Modal` (no new native module) with the Figma sheet (20 px top corners, 52 px options, check icon downloaded from
    Figma as Icon/Check) over a scrim that is the `text` token at 40% opacity (Figma 291:977). "Invite a teammate" is the white outlined button of Figma 8:202, added to `Button` as `outline`. Copy that has
    no Figma frame ("You can't invite people to this team", the loading text) is marked "not in Figma yet".
15. **Send is one request, like Accept.** The same synchronous latch refuses a second tap before React re-renders; three quick taps created one invitation. The email is sent later by the worker, so the
    app only says "Email queued".

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

Unit tests (app `npm test`, 196): the link and response parsers, the failure mapping, the screen states, `routeAfterAuth`, the accepted-team seeding, the preview query settings, the latch, `goBackTo`,
and the offline and timeout behaviour of the preview call. Server (`invites.integration.test.ts`): "preview mirrors accept". On the emulator (development build, local API on the test shards, worker
off so the invite links stay in the work rows): signed-out invitation; login from an invitation; signup from an invitation (never Create team); Accept landing on the invited team for an account that
already had another; wrong account, then log out and sign in correctly; unavailable (revoked, expired, unknown, no token) signed in and signed out with the right button; the replay; the `https` link;
warm start; offline and recovery; three taps on Accept sending one request; Back from Home needing one press. Bugs found and fixed on the way: the link opened after an Accept was undone by a hidden
invitation screen (issue #38); a double Accept request; offline waiting for ever; a second Home behind Home; the Team screen waiting for ever when the team list could not load. The stale Valkey connection seen on the local API is issue #39 (not part of this PR).

Checkpoint 2, on the emulator against the test shards: the Owner's directory and form (empty address; an address the server rejects; already on the team; already invited; the role sheet; a Manager invitation stored
as `manager`; Resend writing a second email row; three quick taps creating one invitation; offline); the Manager's disabled Staff role; the Staff view with no Invite button and a refused direct link; the empty-team
card; the rate-limited banner with the server's wait; the error state with the team known; and the API down at launch (the endless "Loading your team…", recorded broken, then fixed).
