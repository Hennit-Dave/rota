import type { QueryClient } from '@tanstack/react-query';
import { persistQueryClientRestore, persistQueryClientSubscribe, type Persister } from '@tanstack/react-query-persist-client';
import type { Logger } from '../api/errors';
import type { AccountEpoch } from '../auth/epoch';
import { isExpired } from './offlineConfig';
import type { OfflineStore } from './offlineStore';
import { UPCOMING_ROOT } from './upcoming';

export interface OfflineSavingDeps {
  queryClient: QueryClient;
  store: OfflineStore;
  epoch: AccountEpoch;
  maxAgeMs: number;
  logger: Logger;
  now?: () => number;
}

/**
 * Keeps the upcoming-shifts query, and nothing else, on the device (app-state.md "Offline upcoming shifts", ADR 0034).
 *
 * - **Allowlist:** only a query that holds data and whose key starts with `upcoming-shifts` is saved (a failed refresh keeps its old data, and the copy). Never another query, never a mutation.
 * - **Whose it is:** the row records the user; it is the persister's buster, so another account's copy is never restored. At an offline start the user is
 *   not yet known, so the row's own user is trusted (sign-out deletes the row, the tokens and the caches together) and a signed-in `begin(userId)` for
 *   anyone else wipes it.
 * - **Age:** counted from when the data was fetched (`dataUpdatedAt`), not from the last save. The library's own `maxAge` measures the time of the last
 *   SAVE, which moves every time the app opens, so it is switched off (Infinity) and the age is checked here and where the screen shows the data.
 * - **Sign-out:** `stopAndClear` after the epoch was bumped. A save that started under an older epoch is discarded (it runs inside the queue below, so it
 *   either finished before the clear or sees the new epoch and writes nothing).
 * - **Failures never reach the user:** a store that throws is logged by event name and the app simply has no saved copy.
 */
export function createOfflineSaving({ queryClient, store, epoch, maxAgeMs, logger, now = Date.now }: OfflineSavingDeps) {
  let unsubscribe: (() => void) | null = null;
  let activeUser: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  // One thing at a time, in order: begin, restore, save and clear can never interleave.
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const savedQueries = () => queryClient.getQueryCache().findAll({ queryKey: [UPCOMING_ROOT] });

  const persisterFor = (userId: string): Persister => {
    const captured = epoch.current;
    return {
      persistClient: (client) =>
        serial(async () => {
          if (!epoch.isCurrent(captured)) return; // the account changed: this belongs to the past
          try {
            await store.save(userId, client);
          } catch {
            logger.warn('offline_save_failed');
          }
        }),
      restoreClient: async () => {
        const row = await store.load();
        return row !== null && row.userId === userId ? row.client : undefined;
      },
      removeClient: () => store.clear(),
    };
  };

  function subscribe(userId: string): void {
    unsubscribe = persistQueryClientSubscribe({
      queryClient,
      persister: persisterFor(userId),
      buster: userId,
      dehydrateOptions: {
        shouldDehydrateQuery: (query) =>
          // "Has data", not "succeeded": a refresh that fails offline sets the status to 'error' but leaves the data, and it must stay on the device (the
          // first offline start on the emulator emptied the row when this said `status === 'success'`).
          query.queryKey[0] === UPCOMING_ROOT && query.state.data !== undefined && !isExpired(query.state.dataUpdatedAt, now(), maxAgeMs),
        shouldDehydrateMutation: () => false,
      },
    });
    activeUser = userId;
  }

  function stop(): void {
    unsubscribe?.();
    unsubscribe = null;
    activeUser = null;
  }

  async function safeLoad() {
    try {
      return await store.load();
    } catch {
      logger.warn('offline_load_failed');
      return null;
    }
  }

  async function safeClear() {
    try {
      await store.clear();
    } catch {
      logger.warn('offline_clear_failed');
    }
  }

  return {
    /**
     * App start, before the first screen: put what is on the device back into the cache and keep saving for its owner. Never throws. A copy older than the
     * maximum age is deleted instead.
     */
    restoreOnStart(): Promise<void> {
      return serial(async () => {
        const row = await safeLoad();
        if (!row) return;
        try {
          await persistQueryClientRestore({ queryClient, persister: persisterFor(row.userId), buster: row.userId, maxAge: Infinity });
        } catch {
          logger.warn('offline_restore_failed');
        }
        for (const query of savedQueries()) if (isExpired(query.state.dataUpdatedAt, now(), maxAgeMs)) queryClient.getQueryCache().remove(query);
        if (savedQueries().length === 0) {
          await safeClear();
          return;
        }
        subscribe(row.userId);
      });
    },

    /**
     * A session now exists for this person. Same person as the saved copy: carry on. Anyone else: delete the other person's copy first, from the cache and
     * from the device, then save for this one.
     */
    begin(userId: string): Promise<void> {
      return serial(async () => {
        if (activeUser === userId && unsubscribe) return;
        stop();
        const row = await safeLoad();
        if (row && row.userId !== userId) {
          queryClient.removeQueries({ queryKey: [UPCOMING_ROOT] });
          await safeClear();
        }
        subscribe(userId);
      });
    },

    /** Part of every full sign-out (signOut.ts step 3): stop saving, then delete the saved copy. Never throws. */
    stopAndClear(): Promise<void> {
      stop();
      return serial(() => safeClear());
    },
  };
}

export type OfflineSaving = ReturnType<typeof createOfflineSaving>;
