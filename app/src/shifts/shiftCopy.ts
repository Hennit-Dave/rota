/**
 * Every user-facing string of the schedule screens. Figma 04 "Your week, at a glance" (page 7:2). Lines marked "not in Figma yet" have no frame: they
 * follow the login and team patterns and are listed in the pull request. Lines marked "interim" are true today and will change when the slice that makes
 * the Figma wording true lands (notifications, offline shifts).
 */
export const scheduleCopy = {
  loading: { title: 'Getting your week ready', subtitle: 'Loading your latest schedule…' }, // 10:370
  empty: {
    title: 'Your week is open', // 10:353
    subtitle: 'No upcoming shifts yet.',
    cardTitle: 'Nothing scheduled yet',
    cardBody: 'Your published shifts will appear here.',
  },
  error: {
    title: 'Couldn’t load shifts', // 7:174
    subtitle: 'Check your connection, then try again.', // interim: Figma says "Your saved shifts remain available." (offline shifts, a later slice)
    cardTitle: 'We couldn’t connect',
    cardBody: 'Your schedule is kept on the server, so nothing was lost.', // not in Figma yet
    retry: 'Try again',
  },
  next: 'Your next shift', // 7:26
  nextTeam: 'Next shift', // not in Figma yet: an Owner or Manager sees the whole team's shifts, so "your" would be wrong
  later: 'LATER TODAY', // 32:1209
  earlier: 'EARLIER TODAY', // not in Figma yet: today's shifts that are already over
  yours: 'Your shifts', // not in Figma yet: a day other than today
  team: 'Shifts', // not in Figma yet: an Owner or Manager sees the whole team's shifts
  dayEmpty: 'No shifts on this day.', // not in Figma yet
  previousWeek: 'Previous week', // not in Figma yet: the week strip has no arrows
  nextWeek: 'Next week', // not in Figma yet
  openShift: 'Open shift', // not in Figma yet
  assignedTo: (name: string) => `Assigned to ${name}`, // not in Figma yet
  scheduled: 'Scheduled', // 7:31
  createShift: 'Create shift', // 102:2684 (Owner and Manager)
  viewActivity: 'View activity', // 7:37; the feed arrives with the next slice, so the button is drawn but disabled until then
  greeting: (hello: string, name: string) => `${hello}, ${name}`, // 7:11
  subtitleManager: (date: string, count: number, today: boolean) => `${date} · ${count === 0 ? 'no shifts' : `${count} ${count === 1 ? 'shift' : 'shifts'}`}${today && count > 0 ? ' today' : ''}`, // 7:12
  subtitleStaff: (date: string, count: number) => `${date} · ${count === 0 ? 'no shifts for you' : `your ${count} ${count === 1 ? 'shift' : 'shifts'}`}`, // 102:283
  offline: 'You’re offline. The schedule needs a connection.', // not in Figma yet (saved shifts arrive in a later slice)
} as const;

export const shiftDetailCopy = {
  status: { title: 'Scheduled', mine: 'Your shift is confirmed.', open: 'This shift has nobody assigned yet.', other: (name: string) => `Assigned to ${name}.` }, // 7:51
  break: (minutes: number) => `Break: ${minutes} minutes`, // 7:56
  workingWith: 'Working with you', // 7:58
  note: 'Shift note', // 7:61
  edit: 'Edit shift', // 7:63
  delete: 'Delete shift', // 7:65
  notFound: { title: 'This shift isn’t available', subtitle: 'It may have been deleted.', back: 'Back to schedule' }, // not in Figma yet
  loading: 'Loading this shift…', // not in Figma yet
} as const;

export const shiftFormCopy = {
  createTitle: 'Create a shift', // 7:72
  editTitle: 'Edit shift', // 10:322
  roleLine: 'Owner / Manager', // 7:73, 10:323
  titleLabel: 'Shift title', // 7:74
  titlePlaceholder: 'Morning service',
  dateLabel: 'Date', // 7:77
  datePlaceholder: 'YYYY-MM-DD', // interim: Figma shows a date picker, which needs a native module (a new build); a typed date for now
  startLabel: 'Start', // 7:80 shows "Start / End" as one field; two fields here
  endLabel: 'End',
  timePlaceholderStart: '09:00',
  timePlaceholderEnd: '17:00',
  assigneeLabel: 'Assign staff', // 7:83 (10:330 says "Assigned teammate" on the edit screen)
  assigneeEditLabel: 'Assigned teammate',
  assigneePlaceholder: 'Open shift (nobody yet)', // not in Figma yet
  assigneeSheet: 'Assign staff', // not in Figma yet
  openShiftOption: 'Open shift (nobody yet)', // not in Figma yet
  supporting: 'Publishing makes this shift visible to the team.', // 32:1210
  publish: 'Publish shift', // 7:86
  publishing: 'Publishing…', // not in Figma yet
  save: 'Save changes', // 10:333
  saving: 'Saving…', // not in Figma yet
  deleteShift: 'Delete shift', // 10:335
  errors: {
    titleRequired: 'Enter a title.', // not in Figma yet
    titleTooLong: (max: number) => `Use ${max} characters or fewer.`,
    dateInvalid: 'Use the date format YYYY-MM-DD, like 2026-10-15.',
    timeInvalid: 'Use 24-hour time, like 09:00.',
    endAfterStart: 'The end must be after the start.',
    overlap: 'This person already has a shift at that time.',
    notMember: 'This person is no longer on the team. Choose someone else.',
    forbidden: 'Your role does not allow this.',
    gone: 'This shift no longer exists.',
    nothingChanged: 'Nothing was changed.',
  },
  overnightHint: 'An end time earlier than the start means the shift ends the next day.', // not in Figma yet
} as const;

export const publishedCopy = {
  title: 'Shift published', // 7:140
  subtitle: 'Your team can now see this shift.', // 7:141
  statusTitle: '✓ Published', // 7:142
  statusBody: 'Assigned staff will see it on their schedule.', // interim: Figma says "Notifications will be sent to assigned staff." (push notifications, a later slice)
  cardDetail: (title: string, who: string) => `${title} · ${who}`, // 7:145
  view: 'View schedule', // 7:150
} as const;

export const deleteShiftCopy = {
  title: 'Delete this shift?', // 10:342
  subtitle: 'It will be removed from the schedule.', // interim: Figma says "Assigned staff will be notified." (push notifications, a later slice)
  confirm: 'Delete shift', // 10:349
  deleting: 'Deleting…', // not in Figma yet
  keep: 'Keep shift', // 10:351
} as const;
