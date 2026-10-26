import { ResetPasswordScreen } from '../../recovery/ResetPasswordScreen';

/** `/reset` with no token: the same "link isn't available" answer as any bad link. */
export default function ResetIndexRoute() {
  return <ResetPasswordScreen token={null} />;
}
