import { Redirect } from 'expo-router';
import { useSessionStore } from '../../state/sessionStore';

/** Where the signed-out side starts: the screen that explains why the user is here, or login. */
export default function AuthIndex() {
  const notice = useSessionStore((s) => s.ui.signOutNotice);
  if (notice === 'session_ended') return <Redirect href="/session-ended" />;
  if (notice === 'revoke_unconfirmed') return <Redirect href="/signed-out-offline" />;
  return <Redirect href="/login" />;
}
