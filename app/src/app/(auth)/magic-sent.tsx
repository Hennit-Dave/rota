import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { goBackTo } from '../../invites/goBackTo';
import { LinkSentView } from '../../recovery/LinkSentView';
import { getRecoveryApi } from '../../services';

/** "Check your inbox" for a magic-link request (Figma 8:47). The login screen made the request; this screen only shows it and can ask again. */
export default function MagicSentRoute() {
  const { email } = useLocalSearchParams<{ email?: string | string[] }>();
  const address = Array.isArray(email) ? email[0] : email;
  if (typeof address !== 'string' || address.trim() === '') return <Redirect href="/login" />;
  return (
    <LinkSentView
      kind="magic"
      email={address}
      onResend={() => getRecoveryApi().requestMagicLink(address)}
      onBack={() => goBackTo(router, '/login')}
    />
  );
}
