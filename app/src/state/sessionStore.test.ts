import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useSessionStore } from './sessionStore';

test('sign-out resets the client state: signed out, no team, the notice set', () => {
  const s = useSessionStore.getState();
  s.setSignedIn();
  s.selectTeam('11111111-1111-4111-8111-111111111111');
  useSessionStore.getState().resetForSignOut('session_ended');
  const after = useSessionStore.getState();
  assert.equal(after.status, 'signedOut');
  assert.equal(after.selectedTeamId, null);
  assert.equal(after.ui.signOutNotice, 'session_ended');
});

test('signing in clears an old notice', () => {
  useSessionStore.getState().resetForSignOut('revoke_unconfirmed');
  useSessionStore.getState().setSignedIn();
  assert.equal(useSessionStore.getState().ui.signOutNotice, 'none');
});
