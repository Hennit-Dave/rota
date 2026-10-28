# 0025: Invite links: a single-use link, not tied to an email address

- **Status:** proposed (accepted when Dave merges)
- **Date:** 2026-10-28
- **Decided by:** Dave (plan approved 2026-10-28: Staff only, 48 hours (`INVITE_LINK_EXPIRY_HOURS`, chosen, not verified), at most 10 pending per team, rate limits mirroring the email invites (10 per hour per user, 20 per day per team), the schema change, and `security.md` amended through this ADR; the invite form and the pending row are reused, no new Figma frames)
- **Related:** issue #37, brief Requirement 1 ("invite team members by email or link"), `.agents/rules/security.md` (Invites), ADR 0013 (directory), ADR 0015 (invitations), ADR 0017 (the app's invite flow), ADR 0009 (App Links)

## Problem

The brief says staff are invited "by email or link". Email invitations exist (ADR 0015). A **link invitation** is a shareable link that is not tied to an email address: whoever holds it may use it once. That is convenient (paste it in a group chat) and riskier (nothing ties it to a person), so the decisions below keep it small.

## Options considered

1. **A second table (`invite_links`) or the same `invitations` table with a `kind`.** A second table leaves the email code untouched but means two lookups by token, two replay paths and a merged pending list. **One table with `kind` chosen** (Dave): accept, preview, replay, revoke and the list are shared. The cost is that every place that read `email` needs a branch (list, preview, accept, resend), which the tests cover.
2. **Who may create one, and for which role.** (a) Owner and Manager, Staff or Manager links. (b) **Owner and Manager, Staff only.** Chosen: a link grants whatever its role says to whoever holds it, so a link that grants Manager is a takeover risk if it leaks. A Manager is invited by email, where the address is the second factor. This **narrows `security.md`** (Owner may invite as Manager or Staff) for links only.
3. **Expiry.** Same as the email's 7 days, or shorter. **48 hours**, a separate setting (`INVITE_LINK_EXPIRY_HOURS`, Dave: chosen, not verified), because a link is pasted into chats.
4. **A new link replaces the old one, or links are independent.** **Independent**, with a cap on pending links per team (`INVITE_LINK_MAX_PENDING`, 10): two people can be invited at once, and the cap and the create rate limit bound the volume.
5. **Single use or limited uses.** **Single use**, consumed by the same conditional `UPDATE` as an email invitation. A limited-use link would mean amending `security.md` further, and a leaked one admits unbounded people.
6. **Seeing the link again.** Only the SHA-256 of the secret is stored (like every invitation), so the link is **shown once**, in the creation answer. A lost link is revoked and made again; there is no "resend" for a link.

## Decision

**Table.** `invitations` gains `kind` (`email` or `link`, default `email`) and `email` becomes nullable. Two CHECKs: `invitations_kind_email_match` (an email invitation has an address, a link has none) and `invitations_link_staff_only` (`kind = 'email' OR role = 'staff'`). Migration `20261028170000_add_invitation_links`. Every existing row is `email` with an address, so both checks hold for it; adding a constant-default column and dropping `NOT NULL` change only the catalog (no table rewrite). The existing `invitations_email_normalised` CHECK and the partial unique index on `(team_id, email)` ignore a NULL email, so any number of links may be pending.

**Creating.** `POST /teams/:teamId/invitations/links`, no body (a link is always Staff). Team route: Zod, access token and session check, a per-user limit, membership and role from the team shard primary against `invite.staff` (Owner and Manager), a per-team limit. It sends no email, writes no work row and enqueues nothing, so it **never touches the app-wide email cap**. The team row is locked while the pending count and the insert run, so two simultaneous requests cannot both take the last place; over the cap is `409 invite_link_limit`. The answer is `{ invitation, link }`; the link is `https://rota.davebuilds.design/invite/<teamId>.<secret>`, the same shape (and the same App Link and app route) as an email invitation's.

**Using it (preview and accept).** Both reuse the existing routes. For a link: any signed-in account may accept (there is no address to compare), and `account` in the preview is `open` for a signed-in caller. Accepting a link **verifies no address** (an email invitation does; a link proves nothing about the address, `security.md`'s account-verification policy). Someone **already on the team** who opens a link gets `already_member` with the role they hold; the link is **not consumed** and their role **never changes**. The same account that used a link gets the same success again (a lost answer is safe to retry). Everyone else who opens a used, expired, revoked, unknown, malformed or wrong-team link gets the identical `404 invite_unavailable`. Several people may hold one link, so losing the race is ordinary: a loser's directory row (written before the membership, ADR 0013) is taken back if they are not a member, so a stranger's directory is not left pointing at the team.

**Revoking and listing.** The same `DELETE` revokes a link (Owner and Manager, by the permission table). The pending list shows a link with no address and no email state, and the server says `canResend: false`. "Resend" on a link answers like an invitation that is not there.

**What the server says, the app shows.** `GET /teams/:id` gains `canCreateInviteLink` (the permission table), so the app offers "Create an invite link" only to people who may.

**Limits (approved, chosen, not measured).** `invite_link_user` 10 per hour and `invite_link_team` 20 per day, mirroring the email invitations' own limits; both fail closed with `503` when Valkey is down.

**The app.** Reuses the invite form and the pending row. The form gets "Create an invite link" (outlined, under the role field); the result is an "Invite link ready" screen in the same layout as "Invitation sent": the link, **Copy link** (`expo-clipboard`, already in the build) and **Share link** (React Native's own `Share`, JavaScript only), and a plain statement that anyone with the link can join once, as Staff, and that it will not be shown again. When it stops working comes from the server's `expiresAt`, shown on the team's clock. The pending row reads "Invite link · Pending · Staff"; revoking says "Revoke this invite link?". The accept screen needs no new frame: signed out it asks the person to sign in or create **any** account (no address is prefilled); signed in it goes straight to "Accept invitation". **No native rebuild.**

## Why

- One table keeps accept, replay, revoke and the list single-pathed; the CHECKs keep the two kinds from blurring in the database itself.
- Staff only, single use, a short life and a cap keep a bearer link from being worth stealing or hoarding.
- Never consuming a link for someone already on the team stops a link from being wasted, and from ever changing a role.

## Consequences

- **A link is a bearer credential.** Anyone who sees it first can use it first. The ways it is bounded: Staff only, once, 48 hours, revocable, capped. There is no way to know who a link was meant for; the activity record shows who accepted it.
- **Several links mean several credentials.** Inviting five people takes five links.
- **A lost link cannot be shown again.** It is revoked and made again.
- **Seat limit.** There is no billing yet, so no seat is claimed. The accept transaction (`consumeAndJoin`) is where the claim goes when billing exists, for both kinds (`security.md`).
- **A used link's directory row for a race loser is removed best effort.** If that fails, the orphan sweep (issue #33) covers it.
- **Revisit:** limited-use links, a Manager link behind a second check, or showing a link again (it would need the secret stored encrypted) if sharing proves too awkward.

## Evidence

See the PR description: the creation request and answer, the rows (`SELECT … FROM invitations`), the race (five simultaneous accepts, one winner), the test commands, and the screenshots.
