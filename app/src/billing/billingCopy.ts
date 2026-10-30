/**
 * Every user-facing string of the billing screens. NOT YET COMPARED with the Figma 07 Billing frames (node 9:2): the wording and layout follow the swap and
 * team screens' patterns, and the pull request says so. No price, amount or date calculation is written here: amounts arrive from the server as finished strings.
 */
export const activateCopy = {
  title: 'Activate subscription',
  subtitle: 'Choose a plan and the number of seats.',
  bannerTitle: 'Activate your subscription', // the Owner's reminder on the schedule
  bannerBody: 'Your team works within the Starter limits until you activate a plan.',
  bannerAction: 'Activate subscription',
  planLabel: 'Plan',
  seatsLabel: 'Seats',
  seatsHelper: 'Everyone on the team uses a seat, you included.',
  seatsInvalid: 'Enter a whole number of seats.',
  included: (seats: number) => `Up to ${seats} seats included`,
  extraSeat: (price: string) => `${price} for each extra seat`,
  noExtraSeats: 'No extra seats',
  priceTitle: 'Charged today',
  loadingQuote: 'Calculating…',
  continue: 'Continue to payment',
  opening: 'Opening payment page…',
  loading: 'Loading billing…',
  forbidden: 'Only the team’s Owner manages billing.',
  loadFailed: { title: 'Couldn’t load billing', body: 'Check your connection and try again.', retry: 'Try again' },
  offline: 'You’re offline. Billing needs a connection.',
  back: 'Back to schedule',
  yourPlan: 'Your plan',
  planSummary: (name: string, seats: number) => `${name} · ${seats} seats`,
  currentPeriod: (start: string, end: string) => `Current period: ${start} to ${end}`,
} as const;

/** The hub an Owner lands on once the team has a subscription (Figma 07 "billing"; not compared frame by frame yet). */
export const hubCopy = {
  title: 'Plan & billing',
  change: 'Change plan or seats',
  history: 'Billing history',
  paymentOpen: { title: 'A payment is in progress', body: 'Finish it, or wait for it to be confirmed, before changing your plan.', action: 'View payment' },
  seatsUsed: (members: number, limit: number) => `${members} of ${limit} seats in use`,
} as const;

export const changeCopy = {
  title: 'Change plan or seats',
  subtitle: 'You can add seats or move to a higher plan.',
  current: 'Your plan now',
  planLabel: 'New plan',
  seatsLabel: 'New number of seats',
  seatsInvalid: 'Enter a whole number of seats.',
  chargeTitle: 'Charged today',
  noCharge: 'No charge today',
  renewalTitle: 'Next renewal',
  daysLeft: (days: number) => `${days} ${days === 1 ? 'day' : 'days'} left in this period`,
  periodEnds: (date: string) => `This period ends on ${date}`,
  continueToPayment: 'Continue to payment',
  applyNow: 'Apply change',
  applying: 'Applying…',
  opening: 'Opening payment page…',
  loadingQuote: 'Calculating…',
  appliedTitle: 'Change applied',
  appliedSubtitle: 'Your plan was updated.',
  backToBilling: 'Back to billing',
  back: 'Back',
  offline: 'You’re offline. Changes need a connection.',
} as const;

export const historyCopy = {
  title: 'Billing history',
  subtitle: 'Charges, credits and refunds',
  loading: 'Loading billing history…',
  empty: { title: 'Nothing here yet', body: 'Payments and plan changes will show here.' },
  error: { title: 'Couldn’t load billing history', body: 'Check your connection and try again.', retry: 'Try again' },
  end: 'That’s everything',
  hasMore: 'Older entries are not shown yet.',
  back: 'Back to billing',
} as const;

/** The amber pill under every billing header (Figma 07). */
export const billingBadgeCopy = { testMode: 'Test mode' } as const;

export const statusCopy = {
  title: 'Payment',
  waiting: {
    title: 'Waiting for your payment',
    subtitle: 'Finish paying in the browser.',
    banner: { title: 'Nothing is charged until you pay', body: 'You can come back here at any time. This page checks with the server for you.' },
    cancel: 'Cancel payment',
  },
  confirming: {
    title: 'Confirming your payment',
    subtitle: 'This usually takes a few seconds.',
    banner: { title: 'Waiting for the server to confirm', body: 'Your plan changes only after the server has confirmed the payment. You can safely go back to your schedule.' },
    // Figma payment-pending / payment-in-progress: a way out while the server confirms. The payment carries on without this screen.
    back: 'Back to schedule',
  },
  paid: { title: 'Subscription active', subtitle: 'Your payment was confirmed.', done: 'Back to schedule' },
  // A paid plan or seat change (ADR 0028): the same server-confirmed payment, different words.
  paidChange: { title: 'Change applied', subtitle: 'Your payment was confirmed and your plan is updated.', done: 'Back to billing' },
  failed: {
    title: 'Payment didn’t go through',
    subtitle: 'Nothing was applied to your team.',
    banner: { title: 'The payment failed', body: 'You can choose a plan and try again.' },
    retry: 'Try again',
  },
  expired: {
    title: 'Payment cancelled',
    subtitle: 'Nothing was charged and nothing changed.',
    banner: { title: 'This payment was not completed', body: 'You can choose a plan and try again whenever you are ready.' },
    retry: 'Choose a plan again',
  },
  review: {
    title: 'We’re checking your payment',
    subtitle: 'It needs a manual check before your plan changes.',
    banner: { title: 'Your payment is being reviewed', body: 'Your plan has not changed yet. Don’t pay again.' },
    back: 'Back to schedule',
  },
  loading: 'Checking your payment…',
  loadFailed: { title: 'Couldn’t check your payment', body: 'Check your connection and try again.', retry: 'Check again' },
  gone: { title: 'This payment isn’t available', body: 'It may belong to another team.' },
} as const;
