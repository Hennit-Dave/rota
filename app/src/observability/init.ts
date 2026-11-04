import { initSentry } from './sentry';

// Imported first by the root layout, so Sentry is on before anything else runs. `process.env.EXPO_PUBLIC_*` must be written out in full: Expo replaces those exact
// expressions with their values when the JavaScript is bundled. The DSN is public by design (docs/SECURITY.md); no auth token is ever read here.
initSentry({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT ?? (__DEV__ ? 'development' : 'production'),
});
