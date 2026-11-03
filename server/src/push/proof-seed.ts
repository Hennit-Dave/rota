// Proof helper for push (ADR 0032, PR evidence). NEVER application code, and it only ever touches the TEST shards (the test app it starts refuses to run without
// TEST_DATABASE_ALLOWED=true and never falls back to the application's shard URLs).
//
//   npm run proof:seed-push
//
// Needs the proof API running on API_URL (default http://127.0.0.1:3100) against the same test shards, and VALKEY_URL for the seeding app. It registers an Owner
// through the real API, creates the team "The Olive Room" (time zone Africa/Lagos) with that Owner on a test shard, and prints the Owner's sign-in and the team id.
// Next: sign in on the phone, then `npm run proof:seed-subscription -- <teamId> team 9 0` makes a renewal that is due now. The team has NO saved card, so the
// renewal fails at once (ADR 0031) and the failure queues the Owner's push. Passwords are throwaway test values.
import { startTeamsTestApp } from '../teams/testkit.js';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3100';
const PASSWORD = 'correct-horse-battery-staple-26';

async function register(name: string, email: string): Promise<string> {
  const res = await fetch(`${API_URL}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: PASSWORD }),
  });
  const body = (await res.json()) as { user?: { id: string } };
  if (res.status !== 201 || !body.user) throw new Error(`register ${email}: ${res.status}`);
  return body.user.id;
}

// Never call app.stop(): it deletes every team the test app seeded, and the point here is that the team stays.
const app = await startTeamsTestApp();
{
  const email = `owner-${Date.now().toString(36)}@example.test`;
  const ownerId = await register('Olive Owner', email);
  const { teamId, shard } = await app.seedTeam({ ownerId, name: 'The Olive Room' });
  await app.raw[shard].primary.team.update({ where: { id: teamId }, data: { timeZone: 'Africa/Lagos' } });
  console.log(JSON.stringify({ team: 'The Olive Room', teamId, shard, signInAs: 'owner', email, password: PASSWORD }, null, 2));
}
process.exit(0);
