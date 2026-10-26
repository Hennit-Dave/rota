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
  confirmRequired: 'Confirm your password.', // not in Figma yet
  confirmMismatch: 'The two passwords do not match.', // not in Figma yet
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
  // Matches Figma exactly. Signing in does not end the old session, only Log out of all devices does
  // (docs/STATE.md, "Offline logout leaves the server session alive"). The subtitle already says signing in needs a connection.
  bannerBody:
    'You’re signed out on this phone. Sign in once you’re online, then use Log out of all devices to end the session everywhere.',
  retry: 'Try again',
  close: 'Close',
} as const;

/**
 * Password reset and magic link (slice 2b, ADR 0020). Figma frames: magic 8:47 (sent), magic-confirm 8:61, reset 8:74 (request), reset-new 8:86.
 * Lines marked "not in Figma yet" have no frame: they reuse the login patterns and are listed in the pull request.
 */
export const recoveryCopy = {
  forgot: {
    title: 'Forgot your password?', // 8:74
    subtitle: 'We’ll email instructions if your account exists.',
    submit: 'Send reset link',
    submitting: 'Sending…', // not in Figma yet
  },
  sent: {
    title: 'Check your inbox', // 8:47
    magicSubtitle: 'We’ll send a sign-in link if an account exists.',
    resetSubtitle: 'We’ll email instructions if your account exists.', // the reset "sent" state has no frame: the 8:47 layout with the 8:74 wording
    cardTitle: 'Open your email',
    magicBody: (email: string) => `A sign-in link has been requested for ${email}.`,
    resetBody: (email: string) => `A password reset link has been requested for ${email}.`, // not in Figma yet
    resend: 'Resend link',
    resending: 'Sending…', // not in Figma yet
    resent: 'We sent another link if the account exists.', // not in Figma yet
    backToLogin: 'Back to log in',
  },
  confirm: {
    title: 'Sign in to Rota', // 8:61
    subtitle: 'Check the link, then continue when you are ready.',
    bannerTitle: 'One-time sign-in link',
    bannerBody: 'Opening this link does not sign you in. Tap Continue to Rota to finish.',
    submit: 'Continue to Rota',
    submitting: 'Signing in…', // not in Figma yet
  },
  resetNew: {
    title: 'Set a new password', // 8:86
    passwordLabel: 'New password',
    confirmLabel: 'Confirm password',
    submit: 'Save password',
    submitting: 'Saving…', // not in Figma yet
  },
  // The expired / used / replaced / unknown link, for both kinds. Layout of invite-expired 8:146; no frame of its own.
  unavailable: {
    magicTitle: 'This sign-in link isn’t available', // not in Figma yet
    resetTitle: 'This reset link isn’t available', // not in Figma yet
    subtitle: 'Request a new link and use the newest email.',
    bannerTitle: 'Nothing was changed',
    bannerBody: 'This link may have expired or been used already.',
    magicAction: 'Email me a new sign-in link',
    resetAction: 'Request a new reset link',
    backToLogin: 'Back to log in',
    backToRota: 'Back to Rota', // for someone already signed in (same rule as the invitation screen)
  },
  offline: 'You’re offline. Connect to the internet and try again.', // not in Figma yet
  // Shown on the login screen after a successful reset (login pattern, "info" tone). Not in Figma yet.
  passwordUpdated: { title: 'Password updated', body: 'Log in with your new password.' },
} as const;

/** Create team, Figma 8:101. The button and the missing "Next step" banner are Dave's call (plan, 2026-10-23): plan selection does not exist yet. */
export const createTeamCopy = {
  title: 'Your team starts here', // 8:101
  subtitle: 'Owner onboarding',
  nameLabel: 'Team name',
  nameHelper: 'Your team sees this name.',
  timeZoneLabel: 'Team time zone',
  timeZoneHelper: 'Shift times use this time zone.',
  timeZonePlaceholder: 'Choose a time zone', // not in Figma yet
  submit: 'Create team', // Figma still says "Continue to plan selection"; Dave updates Figma until the billing slice
  submitting: 'Creating team…', // not in Figma yet
  nameRequired: 'Enter a team name.', // not in Figma yet
  nameTooLong: (max: number) => `Use ${max} characters or fewer.`, // not in Figma yet, number from the server's details
  timeZoneRequired: 'Choose a time zone.', // not in Figma yet
  timeZoneInvalid: 'Choose a time zone from the list.', // not in Figma yet
  picker: {
    title: 'Team time zone',
    searchLabel: 'Search time zones',
    searchPlaceholder: 'For example Lagos or London',
    empty: 'No time zone matches your search.',
    close: 'Close',
  }, // not in Figma yet
} as const;

export const homeCopy = {
  title: 'Home',
  signedInAs: (name: string) => `Signed in as ${name}`,
  signedIn: 'Signed in',
  teamLoading: 'Loading your team…',
  teamCouldNotLoad: 'We couldn’t load your team.',
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
