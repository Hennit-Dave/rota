import { InviteScreen } from '../../invites/InviteScreen';

/** A link with no token (`…/invite`): the same "isn't available" screen as any other unusable link, with no request. */
export default function InviteWithoutToken() {
  return <InviteScreen token={null} />;
}
