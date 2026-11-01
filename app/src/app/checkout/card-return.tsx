import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Stripe sends the buyer back here after saving a card (`https://rota.davebuilds.design/checkout/card-return?setup=<id>`, an App Link under the `/checkout` prefix the
 * app already declares). Opening it consumes nothing and decides nothing: it opens the status screen, which asks the SERVER whether the card was saved (ADR 0030).
 */
export default function CheckoutCardReturn() {
  const { setup } = useLocalSearchParams<{ setup?: string }>();
  return <Redirect href={{ pathname: '/billing/card-status', params: { setup: typeof setup === 'string' ? setup : '' } }} />;
}
