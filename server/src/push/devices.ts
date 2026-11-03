import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Device tokens (ADR 0032). Identity data on shard A, read and written on the primary. The token is the device's identity: there is no separate install id. The
 * token comes from Expo and is validated for SHAPE only (the database refuses anything else too); whether it is live is learned from Expo's tickets and receipts.
 */
export const EXPO_TOKEN = /^Expo(nent)?PushToken\[[^\]]{1,200}\]$/;

export const deviceBody = z.strictObject({ expoToken: z.string().regex(EXPO_TOKEN) });
export type DeviceBody = z.infer<typeof deviceBody>;

/**
 * Registers a device for the signed-in user. The same token again just refreshes `last_seen_at`; a token that belonged to someone else MOVES to this user, so a
 * phone handed to another person stops notifying the first. `userId` is the session's: the caller never sends it.
 */
export async function registerDevice(db: PrismaClient, userId: string, expoToken: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO device_tokens (user_id, expo_token)
    VALUES (${userId}::uuid, ${expoToken})
    ON CONFLICT (expo_token) DO UPDATE SET user_id = EXCLUDED.user_id, last_seen_at = now()`;
}

/** Removes the signed-in user's own registration of this token (sign-out). Someone else's token, or an unknown one, changes nothing and is not an error. */
export async function unregisterDevice(db: PrismaClient, userId: string, expoToken: string): Promise<number> {
  return db.$executeRaw`DELETE FROM device_tokens WHERE expo_token = ${expoToken} AND user_id = ${userId}::uuid`;
}

export interface DeviceRow {
  id: string;
  expoToken: string;
}

export async function devicesOf(db: PrismaClient, userId: string): Promise<DeviceRow[]> {
  const rows = await db.$queryRaw<Array<{ id: string; expo_token: string }>>`
    SELECT id::text AS id, expo_token FROM device_tokens WHERE user_id = ${userId}::uuid ORDER BY created_at, id`;
  return rows.map((r) => ({ id: r.id, expoToken: r.expo_token }));
}

/** Expo said this token can no longer receive push (DeviceNotRegistered): stop sending to it. Deleting the row removes its delivery records too. */
export async function deleteDeviceById(db: PrismaClient, deviceId: string): Promise<void> {
  await db.$executeRaw`DELETE FROM device_tokens WHERE id = ${deviceId}::uuid`;
}
