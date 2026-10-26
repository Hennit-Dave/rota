import { useLocalSearchParams } from 'expo-router';
import { MagicConfirmScreen } from '../../recovery/MagicConfirmScreen';
import { readLinkToken } from '../../recovery/linkToken';

/**
 * `rota://magic/<token>` and `https://rota.davebuilds.design/magic/<token>` (ADR 0009, ADR 0020). Reachable signed in or signed out.
 * Opening it consumes nothing; the button on the screen redeems it.
 */
export default function MagicRoute() {
  const { token } = useLocalSearchParams<{ token?: string | string[] }>();
  return <MagicConfirmScreen token={readLinkToken(token)} />;
}
