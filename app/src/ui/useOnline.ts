import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

/** Connectivity as the rest of the app sees it: TanStack's onlineManager, fed by NetInfo (services.ts). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
    () => true,
  );
}
