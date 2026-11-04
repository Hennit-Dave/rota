import { randomUUID } from 'node:crypto';
import { createErrorReporter, loadSentryConfig } from './sentry.js';

// One test event from the server (ADR 0039): `npm run sentry:test-event` from server/ (reads SENTRY_DSN from the root .env). It goes through the SAME init, the same
// redaction list and the same gate as a real error, with the tags a real one carries (request ID, team ID, user ID, route). The message and the extra data hold FAKE
// secrets on purpose: in Sentry the event should show them as [redacted]. The fake ids are not real people, teams or payments.
const config = loadSentryConfig();
if (!config.dsn) {
  console.error('SENTRY_DSN is not set (the root .env). Nothing was sent.');
  process.exit(1);
}
console.log(`sending one test event to ${new URL(config.dsn).host} (environment ${config.environment})`);

const reporter = createErrorReporter(config, { role: 'api' });

const requestId = randomUUID();
const eventId = reporter.captureServerError(
  new Error('Rota test event from the server. Fake data that must NOT appear in Sentry: sam.test@example.com, card 4242 4242 4242 4242, Bearer fakefakefakefakefakefake'),
  {
    requestId,
    userId: '00000000-0000-4000-8000-0000000000a1',
    teamId: '00000000-0000-4000-8000-0000000000b2',
    route: '/teams/:teamId/sentry-test',
    tags: { test_event: 'true' },
    extra: {
      email: 'sam.test@example.com',
      cardNumber: '4242 4242 4242 4242',
      authorization: 'Bearer fakefakefakefakefakefake',
      note: 'invite link https://rota.davebuilds.design/invite/00000000-0000-4000-8000-0000000000b2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?x=1 and https://api.example.com/auth/magic?token=abc',
      attempt: 1,
    },
  },
);
const flushed = await reporter.flush(5000);
console.log(`event id:   ${eventId ?? '(none: the gate or the switch dropped it)'}`);
console.log(`request id: ${requestId}  (the request_id tag; search for it in Sentry)`);
console.log(`flushed:    ${flushed}`);
await reporter.close(2000);
process.exit(eventId && flushed ? 0 : 1);
