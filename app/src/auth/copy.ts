/**
 * Every user-facing string on the auth screens. The app maps server error codes to these (ADR 0005: the server owns
 * the codes, the app owns the words). Strings come from the Figma file (03 Authentication); the ones marked
 * "not in Figma yet" were agreed in the plan and are to be added to the design later.
 */

// Shared header eyebrow.
export const ROTA_EYEBROW = 'ROTA';

export const loginCopy = {
  title: 'Welcome back', // 8:6
  subtitle: 'Your team. Your shifts. One place.',
  emailLabel: 'Email address',
  passwordLabel: 'Password',
  forgotPassword: 'Forgot password?',
  submit: 'Log in',
  submitting: 'Logging in…', // 229:269
  alternativePrompt: 'Prefer to sign in without a password?',
  magicLink: 'Email me a sign-in link',
  createAccount: 'Create an account',
} as const;

/** The wrong-credentials layout, login-error 8:158. Banner only: no field is marked. */
export const credentialsCopy = {
  title: 'Let’s try that again',
  subtitle: 'We couldn’t sign you in.',
  bannerTitle: 'Email or password is incorrect',
  bannerBody: 'Check your details and try again.',
  submit: 'Try again',
} as const;

export const signupCopy = {
  title: 'Make room for a better week', // 8:27
  subtitle: 'Create your Rota account.',
  nameLabel: 'Full name',
  namePlaceholder: 'Your full name',
  emailLabel: 'Email address',
  passwordLabel: 'Password',
  submit: 'Create account',
  submitting: 'Creating account…', // 229:320
  haveAccount: 'Already have an account?',
  emailInUse: 'An account with this email already exists.', // 229:3432
  logInInstead: 'Log in instead',
} as const;

export const fieldCopy = {
  nameRequired: 'Enter your name.', // 229:377
  nameTooLong: (max: number) => `Use ${max} characters or fewer.`, // not in Figma yet
  emailInvalid: 'Enter a valid email address.',
  passwordRequired: 'Enter your password.', // not in Figma yet (login only)
  passwordTooShort: (min: number) => `Use at least ${min} characters.`,
  passwordTooLong: (max: number) => `Use ${max} characters or fewer.`, // 229:455
  passwordCommon: 'This password is easy to guess. Try another.', // 231:391
} as const;

/**
 * The static helper under the signup password field, "Use at least 15 characters." (8:27). This is DISPLAY copy only.
 * The minimum is the server's (ADR 0005, NIST SP 800-63B-4); error messages take their number from the server's
 * `details`. If the policy ever changes, this number and the Figma copy change together.
 */
export const PASSWORD_HELPER_MIN = 15;

export const bannerCopy = {
  offline: 'You’re offline. Signing in needs a connection.', // 229:3636; reused for signup (not in Figma yet)
  generic: 'Something went wrong. Please try again.', // 229:3586
  referencePrefix: 'Reference: ',
  rateLimited: (wait: string) => `Too many attempts. Try again ${wait}.`, // 229:3485, wait from Retry-After
  rateLimitedNoWait: 'Too many attempts. Try again later.', // not in Figma yet
} as const;

export const sessionEndedCopy = {
  title: 'Your session ended', // 100:218
  subtitle: 'You were signed out. Sign in again to continue.',
  bannerTitle: 'Signed out',
  bannerBody: 'Sign in again to see your latest shifts.',
  submit: 'Sign in',
} as const;

export const signedOutOfflineCopy = {
  title: 'You are signed out', // 100:232
  subtitle: 'You were signed out while offline. Connect to the internet, then sign in again.',
  bannerTitle: 'Offline',
  // Changed from Figma's "Sign in once you're online to end the session everywhere", which is not true: signing in does
  // not end the old session, only Log out of all devices does (docs/STATE.md, "Offline logout leaves the server session alive").
  bannerBody:
    'Signing in needs a connection. You’re signed out on this phone. Sign in once you’re online, then use Log out of all devices to end it everywhere.',
  retry: 'Try again',
  close: 'Close',
} as const;

/** Screens that are placeholders for later slices, clearly marked. Not in Figma. */
export const placeholderCopy = {
  badge: 'Coming soon',
  forgotPassword: { title: 'Reset your password', body: 'Password reset is built in a later slice.' },
  magicLink: { title: 'Sign-in link', body: 'Signing in by email link is built in a later slice.' },
  createTeam: { title: 'Create your team', body: 'Creating a team is built in a later slice.' },
  back: 'Back',
  skip: 'Skip for now',
} as const;

export const homeCopy = {
  title: 'Home',
  signedInAs: (name: string) => `Signed in as ${name}`,
  signedIn: 'Signed in',
  logout: 'Log out',
  loggingOut: 'Logging out…',
  logoutAll: 'Log out of all devices',
  loggingOutAll: 'Logging out everywhere…',
  offlineTitle: 'You’re offline',
  offlineBody: 'Your session is kept. Connect to the internet to load your details.',
  couldNotLoad: 'We couldn’t load your details.',
  retry: 'Try again',
  logoutAllOffline: 'You’re offline. Connect to the internet to log out of all devices.',
  logoutAllFailed: 'We couldn’t log out of all devices. You are still signed in. Please try again.',
  placeholderNote: 'Placeholder screen. The real home arrives in a later slice.',
} as const;
