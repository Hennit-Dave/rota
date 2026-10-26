import { useLocalSearchParams } from 'expo-router';
import { ForgotPasswordScreen } from '../../recovery/ForgotPasswordScreen';

/** Forgot password (Figma 8:74), opened from the login screen with the address typed there. */
export default function ForgotPasswordRoute() {
  const { email } = useLocalSearchParams<{ email?: string | string[] }>();
  const initial = Array.isArray(email) ? email[0] : email;
  return <ForgotPasswordScreen initialEmail={typeof initial === 'string' ? initial : ''} />;
}
