import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { ApiError } from '../api/errors';
import { json, makeHarness } from '../testkit';
import { createBillingApi } from './billingApi';
import { cardCopy, cardStatusCopy } from './billingCopy';
import { describeBillingFailure } from './billingFailure';
import {
  cardSetupKey,
  isCardSetupSettled,
  parseCardSetup,
  parseCardSetupResponse,
  parseCardSetupStart,
  parseOverview,
  parseQuote,
  type CardSetup,
  type CardSetupStatus,
} from './billingResponses';
import { cardSetupQueryOptions } from './cardSetupQuery';

// Saving a card (ADR 0030). Every word about the agreement and every date is the SERVER's finished text; the app only shows it.
const TEAM = '11111111-1111-4111-8111-111111111111';
const SETUP = '44444444-4444-4444-8444-444444444444';
const KEY = '33333333-3333-4333-8333-333333333333';
const WORDING = 'By saving this card, you authorise Rota to charge this card the monthly price of your plan and seats, currently $50.00, on day 15 of each month until you remove this card. Test mode only.';
const setupBody = (over: Record<string, unknown> = {}) => ({ id: SETUP, status: 'awaiting_card', expiresAt: '2031-06-01T12:31:00.000Z', ...over });
const savedCard = { summary: 'Visa ending 4242', expiresDisplay: 'Expires 08/2031', consentWording: WORDING, consentedOn: '2031-06-01' };
const overview = (over: Record<string, unknown> = {}) => ({
  testModeNotice: 'Test mode.', activated: true, plans: [], members: 3, seatLimit: 9,
  subscription: { plan: 'team', planName: 'Team', seats: 9, monthlyDisplay: '$50.00', periodStartsOn: '2031-06-01', periodEndsOn: '2031-07-01' },
  openOperation: null, scheduledChange: null, savedCard: null, cardConsentWording: WORDING, ...over,
});
const bad = (fn: () => unknown) => assert.throws(fn, (e) => e instanceof ApiError && e.code === 'invalid_response');

test('the overview carries the saved card and the consent wording as the server wrote them, or null; a damaged card is refused', () => {
  const none = parseOverview(overview());
  assert.equal(none.savedCard, null);
  assert.equal(none.cardConsentWording, WORDING);
  const withCard = parseOverview(overview({ savedCard }));
  assert.deepEqual(withCard.savedCard, savedCard);
  assert.equal(parseOverview(overview({ activated: false, subscription: null, cardConsentWording: null })).cardConsentWording, null);
  bad(() => parseOverview(overview({ savedCard: { ...savedCard, expiresDisplay: 8 } })));
  bad(() => parseOverview(overview({ savedCard: { ...savedCard, consentedOn: 'yesterday' } })));
  bad(() => parseOverview(overview({ savedCard: undefined })));
  bad(() => parseOverview(overview({ cardConsentWording: 5 })));
});

test('the activation quote carries the wording the payment will save the card under', () => {
  const quote = { plan: 'team', planName: 'Team', seats: 9, chargeTodayDisplay: '$50.00', periodStartsOn: '2031-06-01', periodEndsOn: '2031-07-01', note: 'n', testModeNotice: 't', consentWording: 'By paying, you authorise Rota…' };
  assert.equal(parseQuote({ quote }).consentWording, 'By paying, you authorise Rota…');
  bad(() => parseQuote({ quote: { ...quote, consentWording: undefined } }));
});

test('a card setup: only the six statuses the server knows; a start answer needs a Stripe address', () => {
  for (const status of ['awaiting_card', 'confirming', 'saved', 'failed', 'expired', 'under_review']) assert.equal(parseCardSetup(setupBody({ status })).status, status);
  bad(() => parseCardSetup(setupBody({ status: 'paid' })));
  bad(() => parseCardSetup(setupBody({ id: 5 })));
  bad(() => parseCardSetup(null));
  assert.equal(parseCardSetupResponse({ setup: setupBody() }).id, SETUP);
  bad(() => parseCardSetupResponse({}));
  const ok = { status: 'card_setup_required', setup: setupBody(), checkoutUrl: 'https://checkout.stripe.com/c/setup/cs_test_1' };
  assert.equal(parseCardSetupStart(ok).checkoutUrl, ok.checkoutUrl);
  bad(() => parseCardSetupStart({ ...ok, checkoutUrl: 'https://evil.example/stripe.com' }));
  bad(() => parseCardSetupStart({ ...ok, status: 'payment_required' }));
});

test('settled means the server has decided: saved, failed, expired or under review; waiting and confirming keep the screen asking', () => {
  const settled: CardSetupStatus[] = ['saved', 'failed', 'expired', 'under_review'];
  const open: CardSetupStatus[] = ['awaiting_card', 'confirming'];
  for (const s of settled) assert.equal(isCardSetupSettled(s), true, s);
  for (const s of open) assert.equal(isCardSetupSettled(s), false, s);
});

test('start: POST sends NO body (the server words the consent and names the amount), only the idempotency key as a header', async () => {
  const h = makeHarness({ handler: () => json(201, { status: 'card_setup_required', setup: setupBody(), checkoutUrl: 'https://checkout.stripe.com/c/setup/cs_test_1' }) });
  const started = await createBillingApi(h.client).startCardSetup(TEAM, KEY);
  assert.equal(started.setup.status, 'awaiting_card');
  assert.equal(h.calls[0]?.method, 'POST');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/billing/card/setup`);
  assert.equal(h.calls[0]?.body, undefined, 'no amount, no price, no team, no user, no wording');
  assert.equal(h.calls[0]?.headers?.['idempotency-key'] ?? h.calls[0]?.headers?.['Idempotency-Key'], KEY);
});

test('status, cancel and remove use the routes the server offers; the status is whatever the server says', async () => {
  const h = makeHarness({ handler: (c) => (c.method === 'DELETE' ? new Response(null, { status: 204 }) : json(200, { setup: setupBody({ status: c.path.endsWith('/cancel') ? 'expired' : 'confirming' }) })) });
  const api = createBillingApi(h.client);
  assert.equal((await api.cardSetup(TEAM, SETUP)).status, 'confirming');
  assert.equal(h.calls[0]?.path, `/teams/${TEAM}/billing/card/setups/${SETUP}`);
  assert.equal((await api.cancelCardSetup(TEAM, SETUP)).status, 'expired');
  assert.equal(h.calls[1]?.method, 'POST');
  assert.equal(h.calls[1]?.path, `/teams/${TEAM}/billing/card/setups/${SETUP}/cancel`);
  await api.removeCard(TEAM);
  assert.equal(h.calls[2]?.method, 'DELETE');
  assert.equal(h.calls[2]?.path, `/teams/${TEAM}/billing/card`);
});

test('failures of the card calls become words only from the server\'s code', () => {
  const api = (status: number, code: string) => new ApiError(status, code, 'x', 'req-7');
  assert.equal(describeBillingFailure(api(409, 'not_activated'))?.kind, 'banner');
  assert.equal(describeBillingFailure(api(409, 'payment_in_progress'))?.kind, 'banner');
  assert.equal(describeBillingFailure(api(403, 'forbidden'))?.kind, 'banner');
  assert.deepEqual(describeBillingFailure(api(503, 'service_unavailable')), { kind: 'unavailable' });
  assert.deepEqual(describeBillingFailure(api(404, 'not_found')), { kind: 'gone' });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setup = (status: CardSetupStatus): CardSetup => ({ id: SETUP, status, expiresAt: '2031-06-01T12:31:00.000Z' });

test('the status query stores a settled answer, asks once, and is keyed by user, team and attempt (nothing is shared across accounts)', async () => {
  const client = new QueryClient();
  let asked = 0;
  const api = { cardSetup: async () => (asked++, setup('saved')) };
  const options = cardSetupQueryOptions({ api: () => api, userId: 'u-1', teamId: TEAM, setupId: SETUP });
  assert.deepEqual(options.queryKey, cardSetupKey('u-1', TEAM, SETUP));
  assert.notDeepEqual(options.queryKey, cardSetupKey('u-2', TEAM, SETUP));
  const observer = new QueryObserver(client, options);
  const stop = observer.subscribe(() => {});
  try {
    await wait(300);
    assert.equal(observer.getCurrentResult().data?.status, 'saved');
    assert.equal(asked, 1, 'one request, not a loop');
  } finally {
    stop();
    client.clear();
  }
});

test('the status query keeps asking while the server says waiting or confirming, and is off until it has a user, a team and an attempt', () => {
  const client = new QueryClient();
  const on = cardSetupQueryOptions({ api: () => ({ cardSetup: async () => setup('confirming') }), userId: 'u-1', teamId: TEAM, setupId: SETUP });
  const interval = on.refetchInterval as (q: { state: { data: CardSetup | undefined } }) => number | false;
  assert.equal(typeof interval({ state: { data: setup('confirming') } }), 'number');
  assert.equal(typeof interval({ state: { data: undefined } }), 'number');
  assert.equal(interval({ state: { data: setup('saved') } }), false);
  assert.equal(interval({ state: { data: setup('under_review') } }), false);
  for (const input of [{ userId: undefined, teamId: TEAM, setupId: SETUP }, { userId: 'u-1', teamId: null, setupId: SETUP }, { userId: 'u-1', teamId: TEAM, setupId: null }]) {
    assert.equal(cardSetupQueryOptions({ api: () => ({ cardSetup: async () => setup('saved') }), ...input }).enabled, false);
  }
  client.clear();
});

test('NO MONEY LOGIC in the card code: no amount is written, parsed or computed; the words say nothing of a price (the review aids from money.md)', () => {
  const files = ['billingCopy.ts', 'cardSetupQuery.ts', '../app/(app)/billing/card.tsx', '../app/(app)/billing/card-status.tsx'];
  for (const f of files) {
    const text = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\b(2000|5000|12000)\b/, `${f}: a plan price`);
    assert.doesNotMatch(text, /(amount|price|total|cents)\w*\s*[-+*/%]/, `${f}: arithmetic on an amount`);
    assert.doesNotMatch(text, /\$\d/, `${f}: a hard-coded dollar amount`);
  }
  for (const s of JSON.stringify([cardCopy, cardStatusCopy]).match(/"[^"]*"/g) ?? []) assert.doesNotMatch(s, /\$\d/, s);
});
