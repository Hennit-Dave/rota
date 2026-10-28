// One-off helper for a hands-on look at the Swaps tab. NEVER application code, and it only ever touches the TEST shards:
// the test app it starts refuses to run without TEST_DATABASE_ALLOWED=true and never falls back to the application's shard URLs.
//
//   npm run db:demo-swap
//
// Needs the API running on API_URL (default http://127.0.0.1:3100) against the same test shards, and VALKEY_URL for the seeding app.
// It registers a manager and two staff through the real API, creates the team "The Olive Room", gives Amara a shift tomorrow morning and
// Tunde one tomorrow evening, and files Amara's request to swap with Tunde. It prints the manager's sign-in. Passwords are throwaway test values.
import { bearer, startTeamsTestApp } from '../teams/testkit.js';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3100';
const PASSWORD = 'correct-horse-battery-staple-26';

async function register(name: string, email: string): Promise<string> {
  const res = await fetch(`${API_URL}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: PASSWORD }),
  });
  const body = (await res.json()) as { user?: { id: string } };
  if (res.status !== 201 || !body.user) throw new Error(`register ${email}: ${res.status} ${JSON.stringify(body)}`);
  return body.user.id;
}

// Never call app.stop(): it deletes every team the test app seeded, and the point here is that the team stays.
const app = await startTeamsTestApp();
{
  const stamp = Date.now().toString(36);
  const email = (who: string) => `${who}-${stamp}@example.test`;
  const managerId = await register('Mira Manager', email('manager'));
  const amaraId = await register('Amara Okafor', email('amara'));
  const tundeId = await register('Tunde Bello', email('tunde'));

  // The seeding app creates the team with its Owner; the manager is added on top, so the manager is not the sole approver's stand-in.
  const ownerId = await register('Dave Owner', email('owner'));
  const { teamId, shard } = await app.seedTeam({ ownerId, name: 'The Olive Room' });
  await app.raw[shard].primary.team.update({ where: { id: teamId }, data: { timeZone: 'Africa/Lagos' } });
  await app.addMember(teamId, managerId, 'manager');
  await app.addMember(teamId, amaraId, 'staff');
  await app.addMember(teamId, tundeId, 'staff');

  // Lagos is UTC+1 all year, so 09:00 there is 08:00Z.
  const day = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const owner = bearer((await app.signIn(ownerId)).accessToken);
  const makeShift = async (title: string, from: number, to: number, who: string) => {
    const res = await app.post(
      `/teams/${teamId}/shifts`,
      { title, startsAt: `${day}T${String(from - 1).padStart(2, '0')}:00:00.000Z`, endsAt: `${day}T${String(to - 1).padStart(2, '0')}:00:00.000Z`, assignedUserId: who },
      owner,
    );
    if (res.status !== 201) throw new Error(`shift ${title}: ${res.status}`);
    return res.body.shift.id as string;
  };
  const morning = await makeShift('Morning service', 9, 13, amaraId);
  const evening = await makeShift('Evening service', 17, 22, tundeId);

  const amara = bearer((await app.signIn(amaraId)).accessToken);
  const swap = await app.post(
    `/teams/${teamId}/swaps`,
    { offeredShiftId: morning, requestedShiftId: evening },
    { ...amara, 'idempotency-key': crypto.randomUUID() },
  );
  if (swap.status !== 201) throw new Error(`swap request: ${swap.status} ${JSON.stringify(swap.body)}`);

  console.log(JSON.stringify({ team: 'The Olive Room', teamId, shard, swapStatus: swap.body.swap.status, signInAs: 'manager', email: email('manager'), password: PASSWORD }, null, 2));
}
process.exit(0);
