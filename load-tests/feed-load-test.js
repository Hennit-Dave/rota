// k6 script for the activity feed (ROTA-BUILD-PROMPT.md, Task A: 200 VUs loading the feed at once).
// Run from Dave's own Mac against the deployed API, not from inside this repo's CI or sandbox:
//
//   k6 run load-tests/feed-load-test.js
//   k6 run load-tests/feed-load-test.js -e BASE_URL=https://api.rota.davebuilds.design   (default, shown for clarity)
//
// Reads the team ID and 200 pre-issued, pre-seeded bearer tokens from load-tests/.k6-tokens.json
// (written by seed-k6-team.ts). No login call is made here - the login rate limit is never touched.
// Every request carries X-Load-Test: k6 so LOAD_TEST_MODE can keep these out of the Sentry quota
// (set LOAD_TEST_MODE=true on the deployed API for the run, back to unset immediately after).
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://api.rota.davebuilds.design';
const TOKENS_FILE = __ENV.TOKENS_FILE || './load-tests/.k6-tokens.json';
const PAGES_PER_ITERATION = 4; // first page + 3 cursor pages, per the skill's "first page and follows cursors"

const seed = JSON.parse(open(TOKENS_FILE));
const TEAM_ID = seed.teamId;
const TOKENS = seed.tokens.map((t) => t.accessToken);

// Warm-up (same for both the cache-off and cache-on run), then the 200-VU stage, then ramp down.
// Kept short on purpose (Dave's Neon-budget ask): about 2 minutes total per run.
export const options = {
  stages: [
    { duration: '10s', target: 10 }, // warm-up ramp
    { duration: '15s', target: 10 }, // warm-up hold
    { duration: '20s', target: 200 }, // ramp to the full 200 VUs
    { duration: '60s', target: 200 }, // hold at 200
    { duration: '10s', target: 0 }, // ramp down
  ],
  thresholds: {
    // Dave's approved threshold (2026-11-06): error rate under 1%. Latency is reported as measured,
    // no invented pass/fail target on it.
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  // __VU is 1..200 while VUs are active, matching the 200 seeded tokens 1:1 - no two VUs ever share
  // a seeded user, so the per-user feed rate limit is never shared across VUs either.
  const token = TOKENS[(__VU - 1) % TOKENS.length];
  const headers = { Authorization: `Bearer ${token}`, 'X-Load-Test': 'k6' };

  let cursor = null;
  for (let page = 0; page < PAGES_PER_ITERATION; page++) {
    const url = cursor
      ? `${BASE_URL}/teams/${TEAM_ID}/activity?limit=20&cursor=${encodeURIComponent(cursor)}`
      : `${BASE_URL}/teams/${TEAM_ID}/activity?limit=20`;
    const res = http.get(url, { headers, tags: { page: cursor ? 'cursor' : 'first' } });
    const ok = check(res, {
      'status is 200': (r) => r.status === 200,
      'has items and nextCursor fields': (r) => {
        try {
          const body = r.json();
          return Array.isArray(body.items) && 'nextCursor' in body;
        } catch {
          return false;
        }
      },
    });
    if (!ok || res.status !== 200) break;
    const body = res.json();
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }

  sleep(1);
}
