import { MagicConfirmScreen } from '../../recovery/MagicConfirmScreen';

/** `/magic` with no token (the link prefix matches it): the same "link isn't available" answer as any bad link. */
export default function MagicIndexRoute() {
  return <MagicConfirmScreen token={null} />;
}
