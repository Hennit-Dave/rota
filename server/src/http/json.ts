import express from 'express';

// Approved 2026-10-21 (PR A plan). Auth bodies are a few short strings; anything larger is not a legitimate
// request. Mounted per router, never globally: the Stripe webhook route needs the raw body and must be
// registered before any global express.json() (AGENTS.md rule 7).
export const JSON_BODY_LIMIT = '10kb';

export function jsonBody() {
  return express.json({ limit: JSON_BODY_LIMIT, strict: true });
}
