// Proof helper for offline shifts (ADR 0034, PR evidence). NEVER application code, and it only ever touches the TEST shards (the test app it starts refuses to run
// without TEST_DATABASE_ALLOWED=true and never falls back to the application's shard URLs).
//
//   npm run proof:seed-shifts
//
// Needs the proof API running on API_URL (default http://127.0.0.1:3100) against the same test shards. It registers a Staff member and a colleague through the real
// API, creates the team "The Olive Room" (time zone Africa/Lagos) with a third person as Owner, and gives the Staff member three upcoming shifts and the colleague
// one (which must never appear on the Staff member's phone). Prints the Staff member's sign-in and the team id. Passwords are throwaway test values.
import { startTeamsTestApp } from '../teams/testkit.js';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3100';
const PASSWORD = 'correct-horse-battery-staple-26';
const HOUR = 60 * 60 * 1000;

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
  const tag = Date.now().toString(36);
  const ownerId = await register('Olive Owner', `owner-${tag}@example.test`);
  const staffEmail = `staff-${tag}@example.test`;
  const staffId = await register('Sam Staff', staffEmail);
  const colleagueId = await register('Sofia Staff', `colleague-${tag}@example.test`);
  const { teamId, shard } = await app.seedTeam({ ownerId, name: 'The Olive Room' });
  const db = app.raw[shard].primary;
  await db.team.update({ where: { id: teamId }, data: { timeZone: 'Africa/Lagos' } });
  await app.addMember(teamId, staffId, 'staff');
  await app.addMember(teamId, colleagueId, 'staff');

  // Whole hours from the next full hour, so the list reads the same however long the proof takes.
  const base = Math.ceil(Date.now() / HOUR) * HOUR;
  const shift = (title: string, area: string, fromHours: number, lengthHours: number, assignedUserId: string) =>
    db.shift.create({
      data: { teamId, title, area, startsAt: new Date(base + fromHours * HOUR), endsAt: new Date(base + (fromHours + lengthHours) * HOUR), assignedUserId, createdByUserId: ownerId },
    });
  await shift('Morning service', 'Front of house', 20, 8, staffId);
  await shift('Lunch prep', 'Kitchen', 48, 6, staffId);
  await shift('Closing', 'Bar', 96, 7, staffId);
  await shift("Sofia's shift (never on Sam's phone)", 'Kitchen', 30, 6, colleagueId);
  console.log(JSON.stringify({ team: 'The Olive Room', teamId, shard, signInAs: 'staff', email: staffEmail, password: PASSWORD }, null, 2));
}
process.exit(0);
