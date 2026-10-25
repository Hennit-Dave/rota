import { useLocalSearchParams } from 'expo-router';
import { InviteScreen } from '../../invites/InviteScreen';
import { readInviteToken } from '../../invites/inviteLink';

/**
 * `rota://invite/<teamId>.<secret>` and `https://rota.davebuilds.design/invite/<teamId>.<secret>` (ADR 0009, ADR 0015).
 * Reachable signed in or signed out. Opening it consumes nothing.
 */
export default function InviteRoute() {
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  return <InviteScreen token={readInviteToken(token)} />;
}
