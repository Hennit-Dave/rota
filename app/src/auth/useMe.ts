import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/errors';
import { getApi, meQueryKey } from '../services';
import { parseMe } from './authResponses';

/**
 * The signed-in user (GET /auth/me). Seeded at sign-in or restore; refetched when the app returns to the foreground by the focus
 * manager, not on every screen visit (docs/STATE.md).
 */
export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: async ({ signal }) => {
      const user = parseMe(await getApi().get<unknown>('/auth/me', { signal }));
      if (!user) throw new ApiError(200, 'invalid_response', 'The server answer could not be read.', null);
      return user;
    },
    refetchOnMount: false,
  });
}
