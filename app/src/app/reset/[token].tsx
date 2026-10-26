import { useLocalSearchParams } from 'expo-router';
import { ResetPasswordScreen } from '../../recovery/ResetPasswordScreen';
import { readLinkToken } from '../../recovery/linkToken';

/**
 * `rota://reset/<token>` and `https://rota.davebuilds.design/reset/<token>` (ADR 0009, ADR 0020). Reachable signed in or signed out.
 * Opening it consumes nothing; saving the new password uses the link up.
 */
export default function ResetRoute() {
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  return <ResetPasswordScreen token={readLinkToken(token)} />;
}
