import type { Logger } from '../api/errors';
import type { AccountEpoch } from './epoch';
import type { SignOutNotice } from './types';

/** The local steps of a full sign-out, in the order app-state.md and the Zustand decision (ADR 0008) require. */
export interface SignOutSteps {
  /** Cancel in-flight queries; clear the in-memory query cache and mutation cache. */
  clearQueryCaches(): Promise<void> | void;
  /** Stop the persister and delete the persisted cache. Supplied by the offline-shifts slice; a no-op until then. */
  clearPersistedCache(): Promise<void> | void;
  /** Reset the Zustand store to signed-out, carrying the notice the UI should show. */
  resetClientState(notice: SignOutNotice): void;
  /** Delete the tokens from secure-store. */
  clearTokens(): Promise<void>;
}

export interface SignOutDeps {
  epoch: AccountEpoch;
  steps: SignOutSteps;
  logger: Logger;
}

/**
 * Full local sign-out. Order: bump the epoch (so anything still in flight is discarded), clear query and
 * mutation caches, delete the persisted cache, reset client state, delete tokens. Each step runs even if an
 * earlier one throws, because the tokens must be removed no matter what. Concurrent calls share one run.
 */
export function createSignOutLocal({ epoch, steps, logger }: SignOutDeps) {
  let running: Promise<void> | null = null;

  async function run(notice: SignOutNotice): Promise<void> {
    epoch.bump();
    const attempts: Array<[string, () => Promise<void> | void]> = [
      ['clear_query_caches', () => steps.clearQueryCaches()],
      ['clear_persisted_cache', () => steps.clearPersistedCache()],
      ['reset_client_state', () => steps.resetClientState(notice)],
      ['clear_tokens', () => steps.clearTokens()],
    ];
    for (const [name, step] of attempts) {
      try {
        await step();
      } catch {
        logger.warn('sign_out_step_failed', { step: name });
      }
    }
  }

  return function signOutLocal(notice: SignOutNotice = 'none'): Promise<void> {
    if (!running) {
      running = run(notice).finally(() => {
        running = null;
      });
    }
    return running;
  };
}

export type SignOutLocal = ReturnType<typeof createSignOutLocal>;
