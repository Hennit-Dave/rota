# 0015: Invitations: the token, who may accept, expiry, limits, and what changes in security.md

- **Status:** accepted (2026-10-23; Dave approved the plan and decisions A to G, and amended `security.md` for A and E through this ADR)
- **Date:** 2026-10-23
- **Decided by:** Dave
- **Related:** ADR 0013 (directory), ADR 0014 (permissions), ADR 0016 (the email job), `.agents/rules/security.md`, `.agents/rules/data.md`, issues #33 and #35, Figma 05 Team and 03 Authentication invite frames

## Problem

An Owner or Manager invites someone by email into a role. The invitation is a credential that travels by email, so it must be unguessable, usable once, tied to
the person it was meant for, and answer the same way however it fails. It must also be found on the right shard by someone who does not know the team, and its
email must go out without the request calling Resend.

## Options and decisions

1. **The token.** (a) 32 random bytes, only the SHA-256 stored, single use by one conditional update, fixed expiry; (b) a signed JWT (cannot be revoked or made
   single-use without a row); (c) a short typed code (too little entropy). **Chosen (a).** Same pattern as refresh tokens (ADR 0005).
2. **Finding the invitation without a lookup table (decision E).** The link is `https://rota.davebuilds.design/invite/<teamId>.<secret>`. The team ID is a routing
   hint: it picks the shard like every team route, and the query is `WHERE team_id = ? AND token_hash = ?`. Only the secret is hashed. The alternative was a
   `token_hash -> team_id` table on shard A (the literal reading of `security.md`), which adds a cross-shard write and breaks if a team moves shards.
   **Amends `security.md`:** the link no longer "carries only the opaque token". Team and role still come from the row. **An unknown, malformed or wrong team ID,
   and an expired, used or revoked invitation, all give the identical `404 invite_unavailable`.**
3. **Tied to the invited address.** Accepting needs a signed-in account whose address equals the invitation's. A different account gets `403 invite_wrong_account`
   (only a holder of a valid link can reach it, and the preview already told them the address). Nothing is granted or consumed. The preview is a `POST` (the token
   never sits in an access log), consumes nothing, and says whether the signed-in account matches, so the app shows the right screen without deciding anything.
3a. **Accept is idempotent for the account that already accepted (Dave, 2026-10-23).** Found by a full-suite run: two simultaneous accepts by one person gave `[200, 404]`
   when the second request landed after the first had consumed the link, and the same would happen to a retry after a lost response (the person has joined but is told the link
   is "unavailable"). So when the token is this invitation's **current** one, it was **accepted by the caller**, was not revoked, and the caller's **membership still exists**,
   accept returns the same `200 { team, role }` again (the role is the membership's role as it is now) and **writes nothing**. Everyone else keeps the identical `404
   invite_unavailable` (a different account, a token that is not this invitation's, a caller whose membership is gone), and nobody signed in is `401` as ever. The preview of a
   spent link stays "unavailable" for everyone. This narrows "used links answer identically" to "identically for everyone except the account that used it", which reveals
   nothing it did not already know. Tested: both of two simultaneous accepts get 200; a retry strictly after the first gets the same body and changes no row; a different
   account, a wrong-team token and an unknown token give byte-identical 404s.
4. **Accept verifies and clears nothing (decision A).** `security.md` said redeeming an email-bound invite for an unverified account clears its password and revokes
   its sessions. Accepting already requires a signed-in session of the matching account, so there is nobody to evict, and signup verification is deferred, so every
   account is unverified: the rule would wipe every accepter's password. **Amends `security.md`:** invite acceptance marks the address verified and does nothing else.
   The clearing rule stays for magic link and reset (2b). **Accepted gap:** an address someone pre-registered blocks the real person until reset exists.
5. **Expiry: 7 days from create or resend (decision B).** Reasons: staff may read email only every few days and a weekly rota is the natural rhythm, so under 24 hours
   would often expire over a weekend; but it is a token that grants team access, tied to one address, so it should not live for weeks. It is config
   (`INVITE_EXPIRY_DAYS`), not a measurement. The email prints it in the team's time zone.
6. **Resend and revoke.** A resend keeps the same invitation, rotates `token_hash` and `expires_at` (the old link dies at once) and writes a **new email work row**
   (`jobs.md`: a new token is a new logical email). A revoke sets `revoked_at`. You may resend or revoke only what you could have created, so a Manager cannot touch
   a Manager invitation. A queued email of a dead invitation is skipped by the job (ADR 0016). One pending invitation per team and address (a partial unique index);
   an expired unaccepted one for the same address is reused like a resend.
7. **Order and the one failure that matters.** Create: the invitation and its email work row in **one transaction on the team's shard**, then enqueue after commit; an
   enqueue failure never fails the request (the row is eligible at once). Accept: validate; on shard A mark the address verified and write the directory row **first**
   (ADR 0013); then one team-shard transaction consumes the invitation and writes the membership. A failure in between leaves an inert directory row and an unconsumed
   invitation; the retry completes it. Seat claiming joins that transaction when billing exists (out of scope here).
8. **Database guards.** `invitations.role <> 'owner'` (CHECK), `email = lower(btrim(email))` (CHECK), one pending per team and address (partial unique index).
9. **Rate limits (decision C), all in Valkey, failing closed.** Per user 10 per hour (create and resend), per team 20 per day, preview per IP 30 per 15 minutes, accept
   per IP 30 per 15 minutes and per user 10 per hour, and an **app-wide cap of 50 invite emails per UTC day**. Reason for 50: Resend's free plan sends 100 emails per UTC
   day in total (each recipient counts, test emails count), shared with reset and magic link (2b) and proofs; an even split keeps 50 for the sends that cannot wait. 50 is a
   split I chose, not a measurement; Resend's own `daily_quota_exceeded` stays as the backstop (ADR 0016). **Refinement of the pipeline order:** limits keyed by the team or
   by the whole app run **after** the membership and role check, so a stranger or a Staff member cannot spend another team's budget or the app-wide cap (tested).
   Per-user limits still run first. A request refused for role or membership counts toward neither.
10. **`emailStatus` (decision F).** The pending list returns `queued`, `sent` or `failed` from the invitation's latest email work row (`invitations.email_work_row_id`);
    Resend and Revoke stay available in every state. The app displays it and decides nothing.

## Consequences

- No lookup table and no new cross-shard write for invites; a team can move shards without breaking links.
- The invite email's link is only openable on a phone once `rota.davebuilds.design` is hosted (issue #35); until then the flow is proven with adb.
- An invitation reveals to the inviter whether an address is already on the team (`already_member`), which the inviter could see from the member list anyway.
- Revisit when: seat limits land (the seat claim joins the accept transaction), link invitations are wanted (removed from the design), or reset and magic link (2b) change who can take over a pre-registered address.

## Evidence

`server/src/invites/*.test.ts`, `server/src/jobs/email*.test.ts` on the test shards, and the evidence in the server PR.
