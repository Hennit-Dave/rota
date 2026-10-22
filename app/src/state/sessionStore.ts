import { create } from 'zustand';
import type { SignOutNotice } from '../auth/types';

/**
 * Client state that exists only on the phone (ADR 0008). Session status, the selected team and UI flags, nothing
 * else. Server data lives in TanStack Query; tokens live in secure-store; money has no place here at all.
 */
export type SessionStatus = 'restoring' | 'signedOut' | 'signedIn';

export interface SessionState {
  status: SessionStatus;
  /** Which of the user's teams is open. An ID only; the server checks membership on every request. */
  selectedTeamId: string | null;
  ui: {
    /** Why the user is looking at the signed-out screen, so the right message can be shown. */
    signOutNotice: SignOutNotice;
  };
  setSignedIn(): void;
  setSignedOut(): void;
  selectTeam(teamId: string | null): void;
  /** Full sign-out: back to the initial state, carrying the notice. Called from the sign-out sequence. */
  resetForSignOut(notice: SignOutNotice): void;
  clearSignOutNotice(): void;
}

const initial = {
  status: 'restoring' as SessionStatus,
  selectedTeamId: null as string | null,
  ui: { signOutNotice: 'none' as SignOutNotice },
};

export const useSessionStore = create<SessionState>()((set) => ({
  ...initial,
  setSignedIn: () => set({ status: 'signedIn', ui: { signOutNotice: 'none' } }),
  setSignedOut: () => set({ status: 'signedOut' }),
  selectTeam: (selectedTeamId) => set({ selectedTeamId }),
  resetForSignOut: (notice) =>
    set({ status: 'signedOut', selectedTeamId: null, ui: { signOutNotice: notice } }),
  clearSignOutNotice: () => set({ ui: { signOutNotice: 'none' } }),
}));
