import type { createApiClient } from '../api/client';
import { parseShiftResponse, parseShiftsList, type Shift } from './shiftResponses';

type Client = Pick<ReturnType<typeof createApiClient>, 'get' | 'post' | 'request'>;

export interface ShiftInput {
  title: string;
  area?: string | null;
  startsAt: string;
  endsAt: string;
  breakMinutes?: number | null;
  note?: string | null;
  assignedUserId?: string | null;
}

const base = (teamId: string) => `/teams/${encodeURIComponent(teamId)}/shifts`;

/** The shift routes (docs/ARCHITECTURE.md 5d). Plain functions over the API client, so they are unit-tested without a screen. */
export function createShiftApi(client: Client) {
  return {
    /** GET /teams/:teamId/shifts: the shifts that overlap `[from, to)`, soonest first. `mine` narrows it to the caller's own. */
    async list(teamId: string, range: { from: string; to: string; mine: boolean }, signal?: AbortSignal): Promise<Shift[]> {
      const query = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&mine=${range.mine ? 'true' : 'false'}`;
      return parseShiftsList(await client.get<unknown>(`${base(teamId)}?${query}`, { signal }));
    },
    async get(teamId: string, shiftId: string, signal?: AbortSignal): Promise<Shift> {
      return parseShiftResponse(await client.get<unknown>(`${base(teamId)}/${encodeURIComponent(shiftId)}`, { signal }));
    },
    /** POST: publishes a shift. Only an Owner or Manager may; the server decides, the app only hides the button. */
    async create(teamId: string, input: ShiftInput): Promise<Shift> {
      return parseShiftResponse(await client.post<unknown>(base(teamId), input));
    },
    /** PATCH: only the fields in `changes` are sent; `null` clears an optional field or unassigns. */
    async update(teamId: string, shiftId: string, changes: Partial<ShiftInput>): Promise<Shift> {
      return parseShiftResponse(await client.request<unknown>(`${base(teamId)}/${encodeURIComponent(shiftId)}`, { method: 'PATCH', body: changes }));
    },
    /** DELETE (204, no body). */
    async remove(teamId: string, shiftId: string): Promise<void> {
      await client.request(`${base(teamId)}/${encodeURIComponent(shiftId)}`, { method: 'DELETE' });
    },
  };
}
