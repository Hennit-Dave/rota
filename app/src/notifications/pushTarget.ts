/**
 * What tapping a push opens (ADR 0032). The server sends only a version, a type, a moment and a team id, never a path. The app maps a KNOWN shape to a screen and
 * ignores everything else, so a forged or newer-version notification opens nothing. Whatever screen it opens loads its data through the normal authorised API,
 * so a notification can point the app somewhere but can never show anything the signed-in user could not already see. No amount ever travels in a push.
 */
export const PUSH_MOMENTS = ['renewal_failed', 'renewal_read_only'] as const;
export type PushMoment = (typeof PUSH_MOMENTS)[number];

export interface PushTarget {
  type: 'billing';
  moment: PushMoment;
  teamId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The notification's `data`, or null if it is not exactly a shape this app knows. Extra keys are ignored; a missing or wrong one is a refusal. */
export function parsePushData(raw: unknown): PushTarget | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (d.v !== 1 || d.type !== 'billing') return null;
  if (typeof d.moment !== 'string' || !(PUSH_MOMENTS as readonly string[]).includes(d.moment)) return null;
  if (typeof d.teamId !== 'string' || !UUID.test(d.teamId)) return null;
  return { type: 'billing', moment: d.moment as PushMoment, teamId: d.teamId.toLowerCase() };
}

/** The screen for a target. One today: the billing hub, where the Owner sees the renewal and Retry payment. */
export function routeFor(target: PushTarget): '/billing' {
  switch (target.type) {
    case 'billing':
      return '/billing';
  }
}
