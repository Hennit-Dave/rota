import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consentWording, STRIPE_CUSTOM_TEXT_MAX } from './consent.js';
import { BillingInputError } from './plans.js';

// The wording Dave approved on 2026-11-01 (ADR 0030). These are the exact strings the Stripe page, the app and the stored consent show.

test('activation wording: "By paying", the monthly price of the plan and seats, the day, and "until you remove this card"', () => {
  assert.equal(
    consentWording({ kind: 'activation', amountCents: 5000, anchorDay: 15 }),
    'By paying, you authorise Rota to charge this card the monthly price of your plan and seats, currently $50.00, on day 15 of each month until you remove this card. Test mode only.',
  );
});

test('add-card wording starts "By saving this card" (nothing is paid when a card is only saved)', () => {
  assert.equal(
    consentWording({ kind: 'card_setup', amountCents: 15500, anchorDay: 1 }),
    'By saving this card, you authorise Rota to charge this card the monthly price of your plan and seats, currently $155.00, on day 1 of each month until you remove this card. Test mode only.',
  );
});

test('days 29, 30 and 31 say what happens in a shorter month; day 28 does not need to', () => {
  const note = '(the last day in shorter months)';
  assert.ok(!consentWording({ kind: 'activation', amountCents: 2000, anchorDay: 28 }).includes(note));
  for (const anchorDay of [29, 30, 31]) {
    assert.ok(consentWording({ kind: 'activation', amountCents: 2000, anchorDay }).includes(`on day ${anchorDay} of each month ${note} until you remove this card`));
  }
});

test('the amount is whole cents formatted by the same server formatter; nothing but a positive integer is accepted', () => {
  assert.ok(consentWording({ kind: 'activation', amountCents: 2000, anchorDay: 3 }).includes('currently $20.00,'));
  for (const amountCents of [0, -1, 12.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => consentWording({ kind: 'activation', amountCents, anchorDay: 3 }), BillingInputError, String(amountCents));
  }
  for (const anchorDay of [0, 32, 1.5, -3]) {
    assert.throws(() => consentWording({ kind: 'activation', amountCents: 2000, anchorDay }), BillingInputError, String(anchorDay));
  }
});

test('the longest wording stays far inside the 1200 characters Stripe allows beside the pay button', () => {
  assert.ok(consentWording({ kind: 'card_setup', amountCents: 99_999_999, anchorDay: 31 }).length < STRIPE_CUSTOM_TEXT_MAX / 2);
});
