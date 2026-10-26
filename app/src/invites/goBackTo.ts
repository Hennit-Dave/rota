/** Where the invitation screen sends the person when it is finished with: their team (signed in) or the login screen (signed out). */
export type ReturnHref = '/' | '/login';

export interface ReturnRouter {
  canGoBack(): boolean;
  dismissTo(href: ReturnHref): void;
  replace(href: ReturnHref): void;
}

/**
 * Leave the invitation screen for `href` without leaving a copy of it behind.
 *
 * - **A screen is behind it** (a link opened while the person was already on Home, or on the login screen): `dismissTo` pops back to
 *   that existing screen. A `replace` here would swap the invitation for a SECOND Home, and the Back button would need one extra press
 *   per copy before the app closed (ADR 0017).
 * - **It was opened cold** (the invitation is the only screen): there is nothing to pop to, so it replaces itself.
 */
export function goBackTo(router: ReturnRouter, href: ReturnHref): 'popped' | 'replaced' {
  if (router.canGoBack()) {
    router.dismissTo(href);
    return 'popped';
  }
  router.replace(href);
  return 'replaced';
}
