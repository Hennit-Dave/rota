/**
 * Work that happens AFTER a response has been sent, tracked so a shutdown can wait for it and a test can wait for it (ADR 0020).
 * A failure is reported to `onError`, never thrown: nobody is waiting for the answer any more.
 */
export interface TaskTracker {
  run(task: () => Promise<void>): void;
  /** Resolves when every task started so far has finished (including ones started while it waits). */
  drain(): Promise<void>;
}

export function createTaskTracker(onError: (err: unknown) => void): TaskTracker {
  const pending = new Set<Promise<void>>();
  return {
    run(task) {
      const promise: Promise<void> = Promise.resolve()
        .then(task)
        .catch(onError)
        .finally(() => void pending.delete(promise));
      pending.add(promise);
    },
    async drain() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
