import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadActivityConfig } from './config.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { createActivitySchemas } from './schemas.js';

const ID = '3f2b8c1e-5a4d-4e7a-9c0b-1d2e3f4a5b6c';

test('a cursor round-trips, at millisecond precision, and is base64url text a client can put in a URL unescaped', () => {
  const t = new Date('2031-03-04T09:00:00.123Z');
  const text = encodeCursor({ t, i: ID });
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(text), { t, i: ID });
});

test('decodeCursor refuses everything the server could not have made', () => {
  const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const good = { t: '2031-03-04T09:00:00.123Z', i: ID };
  assert.ok(decodeCursor(b64(good)));
  for (const bad of [
    '',
    ' ',
    'x'.repeat(201),
    '!!!',
    b64('hello'),
    b64([]),
    b64(null),
    b64({ ...good, extra: 1 }),
    b64({ t: good.t }),
    b64({ i: good.i }),
    b64({ t: '2031-03-04T09:00:00Z', i: ID }),
    b64({ t: '2031-03-04T09:00:00.123+00:00', i: ID }),
    b64({ t: '2031-02-30T09:00:00.000Z', i: ID }),
    b64({ t: '2031-13-04T09:00:00.000Z', i: ID }),
    b64({ t: good.t, i: ID.toUpperCase() }),
    b64({ t: good.t, i: 'not-a-uuid' }),
    b64({ t: 5, i: ID }),
    b64({ t: good.t, i: 5 }),
    `${b64(good)}=`,
  ]) {
    assert.equal(decodeCursor(bad), null, bad.slice(0, 40));
  }
});

test('the query schema: defaults, the maximum, and a cursor that must decode', () => {
  const schemas = createActivitySchemas({ pageDefault: 20, pageMax: 50 });
  const parse = (q: Record<string, string>) => schemas.query.safeParse(q);
  const ok = parse({});
  assert.ok(ok.success && ok.data.limit === 20 && ok.data.cursor === null);
  const fifty = parse({ limit: '50' });
  assert.ok(fifty.success && fifty.data.limit === 50);
  const badQueries: Array<Record<string, string>> = [{ limit: '51' }, { limit: '0' }, { limit: '1.5' }, { limit: '-3' }, { limit: 'x' }, { cursor: 'junk' }, { extra: '1' }];
  for (const bad of badQueries) {
    assert.equal(parse(bad).success, false, JSON.stringify(bad));
  }
});

test('the settings: defaults 20 and 50, overrides, and a bad or inverted value stops the server', () => {
  assert.deepEqual(loadActivityConfig({}), { pageDefault: 20, pageMax: 50 });
  assert.deepEqual(loadActivityConfig({ ACTIVITY_PAGE_DEFAULT: '10', ACTIVITY_PAGE_MAX: '25' }), { pageDefault: 10, pageMax: 25 });
  for (const env of [{ ACTIVITY_PAGE_MAX: '0' }, { ACTIVITY_PAGE_MAX: 'abc' }, { ACTIVITY_PAGE_DEFAULT: '60' }, { ACTIVITY_PAGE_MAX: '1.5' }]) {
    assert.throws(() => loadActivityConfig(env), JSON.stringify(env));
  }
});
