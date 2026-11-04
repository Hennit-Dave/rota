import * as Sentry from '@sentry/react-native';
import { isReportableError, requestIdOf } from './reportable';
import { createEventGate, fingerprintOf, scrubBreadcrumb, scrubEvent } from './sentryScrub';

/**
 * Sentry in the app (ADR 0039): ERRORS ONLY, and only what has been through the shared redaction list (`sentryScrub.ts`, the same file the server uses).
 *
 * - No tracing, profiling, session replay or user feedback: none of their settings or integrations is given. Screenshots and view hierarchy stay off.
 * - Nothing personal is collected: `sendDefaultPii` is off, the user is only an ID (added by `setSentryUser`), and `scrubEvent` removes any request, cookie, header, body or
 *   query string. Failed HTTP requests are not turned into events by the SDK (`enableCaptureFailedRequests: false`): `reportQueryError` decides which failures are bugs.
 * - Breadcrumbs go through `scrubBreadcrumb`: console lines are dropped, and every URL or route loses its query string and any token in it (`/invite/`, `/magic/`, `/reset/`).
 * - What may leave is limited by a gate: one event per error per 5 minutes, 10 a minute, 20 per app session. CHOSEN, NOT MEASURED (Dave, 2026-11-04).
 * - The DSN is `EXPO_PUBLIC_SENTRY_DSN`, which anyone can read in the app. A DSN can only SUBMIT events (docs/SECURITY.md); it cannot read them. No auth token is ever in the app.
 * - With no DSN, Sentry is off and nothing is sent.
 */

export interface SentryInitConfig {
  dsn: string | undefined;
  environment: string;
}

/** The limits (CHOSEN, NOT MEASURED, Dave 2026-11-04). The server's per-day limit is 50 a process; an app session is 20 in all. */
export const APP_EVENT_LIMITS = { dedupeMs: 5 * 60_000, maxPerMinute: 10, maxPerSession: 20 } as const;

let started = false;

/** Returns whether Sentry is on. Safe to call more than once. */
export function initSentry(config: SentryInitConfig): boolean {
  if (started) return true;
  if (!config.dsn) return false;
  const gate = createEventGate({
    dedupeMs: APP_EVENT_LIMITS.dedupeMs,
    maxPerMinute: APP_EVENT_LIMITS.maxPerMinute,
    maxTotal: APP_EVENT_LIMITS.maxPerSession,
    totalWindowMs: Number.POSITIVE_INFINITY,
  });
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    sampleRate: 1, // the gate does the limiting
    // No personal data is collected by default (this SDK version's own flag); the user is only ever an ID that `setSentryUser` adds, and `scrubEvent` removes the rest.
    sendDefaultPii: false,
    enableCaptureFailedRequests: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    maxBreadcrumbs: 50,
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    beforeSend: (event) => {
      const clean = scrubEvent(event);
      const decision = gate.check(fingerprintOf(clean));
      if (__DEV__) {
        // Development builds only: what is about to leave, as keys (never values of anything personal), so the trimming can be seen without opening Sentry.
        const e = clean as { user?: Record<string, unknown>; contexts?: Record<string, Record<string, unknown>>; tags?: Record<string, unknown> };
        console.log('[sentry] outgoing ' + JSON.stringify({ decision, user: e.user ?? null, tags: e.tags ?? {}, contexts: Object.fromEntries(Object.entries(e.contexts ?? {}).map(([k, v]) => [k, Object.keys(v ?? {})])) }));
      }
      return decision === 'send' ? clean : null;
    },
  });
  started = true;
  return true;
}

export function sentryIsOn(): boolean {
  return started;
}

/** Reports an error that is a bug (callers decide with `isReportableError`). Never throws. Returns the event id. */
export function reportAppError(error: unknown, context: { requestId?: string | null; tags?: Record<string, string> } = {}): string | undefined {
  if (!started) return undefined;
  try {
    const tags: Record<string, string> = { ...context.tags };
    if (context.requestId) tags.request_id = context.requestId;
    return Sentry.captureException(error, { tags });
  } catch {
    return undefined;
  }
}

/** The TanStack Query cache's `onError`: report an error only when it is a bug (reportable.ts), tagged with the failing response's request ID. */
export function reportQueryError(error: unknown): void {
  if (isReportableError(error)) reportAppError(error, { requestId: requestIdOf(error) });
}

/** The signed-in person: the ID only, never an email or a name (Sentry shows them as "user"). null clears it (sign-out). */
export function setSentryUser(userId: string | null): void {
  if (!started) return;
  Sentry.setUser(userId ? { id: userId } : null);
}

/** The team that is open, as the `team_id` tag. null removes the tag (sign-out, or no team selected). */
export function setSentryTeam(teamId: string | null): void {
  if (!started) return;
  Sentry.setTag('team_id', teamId ?? undefined);
}

/** What the Sentry scope holds right now, for the development check screen only: the user ID, the team tag, and the last few breadcrumbs (their kind, data keys and URL, never their bodies). */
export function sentryScopeSummary(): { userId: string | null; teamId: string | null; breadcrumbs: Array<{ category?: string; type?: string; keys: string[]; url?: string; message?: string }> } {
  if (!started) return { userId: null, teamId: null, breadcrumbs: [] };
  const data = Sentry.getIsolationScope().getScopeData();
  const team = data.tags?.team_id;
  return {
    userId: typeof data.user?.id === 'string' ? data.user.id : null,
    teamId: typeof team === 'string' ? team : null,
    breadcrumbs: (data.breadcrumbs ?? []).slice(-8).map((b) => ({
      category: b.category,
      type: b.type,
      keys: Object.keys(b.data ?? {}),
      url: typeof b.data?.url === 'string' ? b.data.url : undefined,
      message: b.message,
    })),
  };
}

/**
 * One test event for the development check screen. FAKE secrets in the message and the extra data (including a URL with a query string and a token), which must show as
 * [redacted] or without their query string in Sentry. The navigation breadcrumb to an invite link is added BEFORE the capture so it is attached.
 */
export async function sendSentryTestEvent(): Promise<{ eventId: string | undefined; requestId: string; flushed: boolean; host: string | null }> {
  const host = Sentry.getClient()?.getDsn()?.host ?? null;
  const requestId = `test-${Date.now().toString(36)}`;
  if (!started) return { eventId: undefined, requestId, flushed: false, host };
  Sentry.addBreadcrumb({ category: 'navigation', data: { from: '/(app)/index', to: '/invite/00000000-0000-4000-8000-0000000000b2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?x=1' } });
  const eventId = Sentry.captureException(
    new Error('Rota test event from the app. Fake data that must NOT appear in Sentry: sam.test@example.com, card 4242 4242 4242 4242, Bearer fakefakefakefakefakefake'),
    {
      tags: { request_id: requestId, test_event: 'true' },
      extra: {
        email: 'sam.test@example.com',
        cardNumber: '4242 4242 4242 4242',
        authorization: 'Bearer fakefakefakefakefakefake',
        note: 'invite link https://rota.davebuilds.design/invite/00000000-0000-4000-8000-0000000000b2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?x=1 and https://api.example.com/auth/magic?token=abc',
        attempt: 1,
      },
    },
  );
  const flushed = await Sentry.flush();
  return { eventId, requestId, flushed, host };
}
