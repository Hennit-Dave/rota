import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { hashInviteSecret, issueInviteToken, parseInviteToken } from './tokens.js';

const TEAM = '3f2b8c1e-9a4d-4e7b-b1c2-5d6e7f809a1b';

test('a token is `<teamId>.<secret>`: 32 random bytes in base64url (43 characters), and only the SHA-256 of the secret is the hash', () => {
  const t = issueInviteToken(TEAM);
  const [teamId, secret] = t.token.split('.');
  assert.equal(teamId, TEAM);
  assert.match(secret!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(secret!, 'base64url').length, 32);
  assert.equal(t.tokenHash.length, 32);
  assert.deepEqual(t.tokenHash, createHash('sha256').update(secret!, 'utf8').digest());
  assert.deepEqual(t.tokenHash, hashInviteSecret(secret!));
});

test('two tokens for the same team are different (and so are their hashes)', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(issueInviteToken(TEAM).token);
  assert.equal(seen.size, 200);
});

test('a good token parses back to its team and the same hash', () => {
  const t = issueInviteToken(TEAM);
  const parsed = parseInviteToken(t.token);
  assert.ok(parsed);
  assert.equal(parsed.teamId, TEAM);
  assert.deepEqual(parsed.tokenHash, t.tokenHash);
});

test('anything else does not parse: no dot, uppercase or malformed team ID, short, long or wrongly-encoded secret, extra parts, whitespace', () => {
  const good = issueInviteToken(TEAM).token;
  const secret = good.split('.')[1]!;
  const bad = [
    '',
    'x',
    secret,
    `${TEAM}${secret}`,
    `${TEAM}.`,
    `${TEAM}.${secret.slice(1)}`,
    `${TEAM}.${secret}A`,
    `${TEAM.toUpperCase()}.${secret}`,
    `not-a-uuid.${secret}`,
    `${TEAM}.${secret}.extra`,
    `${TEAM}.${secret.slice(0, 42)}+`,
    `${TEAM}.${secret.slice(0, 42)}=`,
    ` ${good}`,
    `${good} `,
    `${good}\n`,
  ];
  for (const value of bad) assert.equal(parseInviteToken(value), null, JSON.stringify(value));
});
