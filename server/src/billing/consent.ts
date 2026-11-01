// The consent wording (ADR 0030; Dave, 2026-11-01). Made on the SERVER only: the app and Stripe's page both show this exact string, and the same string is stored with
// the saved card as the record of what the Owner agreed to. The amount is the team's current monthly price from our engine, passed in as integer cents; the day is the
// billing anchor day (a UTC calendar day). This file never calculates a price.
//
// "Until you remove this card" is what "until you cancel" means here: the brief has no subscription cancellation, and removing the saved card withdraws the authorisation.
import { formatUsd } from './display.js';
import { BillingInputError } from './plans.js';

/** `activation`: the card is saved by a payment ("By paying"). `card_setup`: nothing is charged, the card is only saved ("By saving this card"). */
export type ConsentKind = 'activation' | 'card_setup';

/** Days 29 to 31 do not exist in every month: the period then ends on the month's last day (money.md), and the wording says so. */
const SHORT_MONTH_NOTE = ' (the last day in shorter months)';

export function consentWording(input: { kind: ConsentKind; amountCents: number; anchorDay: number }): string {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new BillingInputError('the consent amount must be a positive whole number of cents');
  if (!Number.isSafeInteger(input.anchorDay) || input.anchorDay < 1 || input.anchorDay > 31) throw new BillingInputError('the consent day must be a whole number from 1 to 31');
  const lead = input.kind === 'activation' ? 'By paying' : 'By saving this card';
  const day = `day ${input.anchorDay} of each month${input.anchorDay > 28 ? SHORT_MONTH_NOTE : ''}`;
  return `${lead}, you authorise Rota to charge this card the monthly price of your plan and seats, currently ${formatUsd(input.amountCents)}, on ${day} until you remove this card. Test mode only.`;
}

/** Stripe allows 1200 characters in `custom_text.submit.message` (docs.stripe.com/api/checkout/sessions/create). Ours is far shorter; the guard keeps it so. */
export const STRIPE_CUSTOM_TEXT_MAX = 1200;
