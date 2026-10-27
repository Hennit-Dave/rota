/**
 * Every user-facing string of the swap screens. Figma 06 Swaps (8:292): swaps 8:296, swap-select 8:316, swap-confirm 8:333, swap-pending 8:350,
 * swap-requesting 103:342, swap-review 8:367, swap-approved 8:381, swap-rejected 8:394, swap-error 8:407, swap-offline 103:363. Lines marked "not in Figma
 * yet" have no frame and follow the login and team patterns; they are listed in the pull request.
 */
export const swapListCopy = {
  title: 'Shift swaps', // 8:301
  subtitle: 'Keep your schedule flexible.', // 8:302
  request: 'Request a swap', // 32:1441
  review: 'WAITING FOR A DECISION', // not in Figma yet: a manager's own list is split in two
  mine: 'YOUR SWAPS', // not in Figma yet
  other: 'OTHER SWAPS', // not in Figma yet
  loading: 'Loading swaps…', // not in Figma yet
  empty: { title: 'No swaps yet', body: 'Swap requests you make or need to decide will show here.' }, // not in Figma yet
  error: { title: 'Couldn’t load swaps', body: 'Check your connection and try again.', retry: 'Try again' }, // not in Figma yet
  offline: 'You’re offline. Swaps need a connection.', // not in Figma yet
} as const;

export const swapStatusCopy = {
  pending: 'Pending', // 5:85
  approved: 'Approved',
  rejected: 'Not approved',
  cancelled: 'Cancelled',
} as const;

export const swapSelectCopy = {
  title: 'Request a swap', // 8:321
  subtitle: 'Choose an eligible shift and teammate.', // 8:322
  yourShift: 'Your shift', // not in Figma yet: the Figma frame shows a shift card and one input
  theirShift: 'Teammate’s shift', // 8:328 reads as the teammate input
  yourPlaceholder: 'Choose one of your shifts',
  theirPlaceholder: 'Choose a teammate’s shift',
  yourSheet: 'Your shift',
  theirSheet: 'Teammate’s shift',
  review: 'Review request', // 8:331
  loading: 'Loading shifts…', // not in Figma yet
  noneOfYours: 'You have no upcoming shifts to swap.', // not in Figma yet
  noneOfTheirs: 'Nobody else has an upcoming shift to swap with.', // not in Figma yet
  loadFailed: 'Couldn’t load shifts', // not in Figma yet
} as const;

export const swapConfirmCopy = {
  title: 'Does this look right?', // 8:338
  subtitle: 'Your manager will review the request.', // 8:339
  give: 'You give', // 8:341
  receive: 'You receive', // 8:344
  send: 'Send swap request', // 8:346
  back: 'Go back', // 8:348
} as const;

export const swapSentCopy = {
  title: 'Request sent', // 8:355, 103:348
  subtitle: 'Waiting for manager approval.', // 8:356, 103:349
  pending: { title: 'Your original shift still applies', body: 'Keep your current shift until the swap is approved.' }, // 127:7408
  requesting: { title: 'Not confirmed yet', body: 'You can’t send this again until the server answers.' }, // 103:352
  requested: 'Swap requested', // 103:355 (disabled)
  backToSwaps: 'Back to swaps', // 8:364
} as const;

export const swapFailedCopy = {
  title: 'Request wasn’t sent', // 8:411
  subtitle: 'Your original shift is unchanged.', // 8:412
  status: { title: 'Couldn’t send your request', body: 'Nothing was changed. Your original shift still applies.' }, // 8:414
  offline: { title: 'You’re offline. Your swap request wasn’t sent.', body: 'Swaps need a connection and aren’t saved for later.' }, // 103:372
  retry: 'Try again', // 8:417
  backToSchedule: 'Back to schedule', // 8:419
} as const;

export const swapReviewCopy = {
  title: 'Review swap', // 8:372
  subtitle: 'Manager / Owner', // 8:373
  approve: 'Approve swap', // 8:377
  approving: 'Approving…', // not in Figma yet
  reject: 'Reject request', // 8:379
  rejecting: 'Rejecting…', // not in Figma yet
  cancel: 'Cancel request', // not in Figma yet: the requester withdraws a waiting request
  cancelling: 'Cancelling…', // not in Figma yet
  approved: { title: 'Swap approved', subtitle: 'The schedule has been updated.', view: 'View updated schedule' }, // 8:386, 8:392
  rejected: { title: 'Swap not approved', subtitle: 'Your original shift stays the same.', back: 'Back to swaps' }, // 8:399, 8:405
  cancelled: { title: 'Request cancelled', subtitle: 'Your original shift stays the same.' }, // not in Figma yet
  notFound: { title: 'This swap isn’t available', subtitle: 'It may have been decided or removed.' }, // not in Figma yet
  loading: 'Loading this swap…', // not in Figma yet
  you: 'you', // not in Figma yet
} as const;

export const swapFailureCopy = {
  limit: 'You already have 3 swap requests waiting. Cancel one or wait for a decision.', // not in Figma yet
  notYours: 'That shift isn’t yours to swap any more. Choose another.', // not in Figma yet
  notSwappable: 'That shift can’t be swapped. Choose another.', // not in Figma yet
  inPast: 'That shift has already started. Choose another.', // not in Figma yet
  alreadyInSwap: 'One of these shifts is already in a swap request.', // not in Figma yet
  wouldDoubleBook: 'This swap would put someone on two shifts at the same time.', // not in Figma yet
  changed: 'One of the shifts has changed since the request was made. Reject it and ask again.', // not in Figma yet
  notPending: 'This request has already been decided or cancelled.', // not in Figma yet
  forbidden: 'Your role does not allow this.', // not in Figma yet
  partyCannotDecide: 'You can’t decide a swap you are part of.', // not in Figma yet
} as const;
