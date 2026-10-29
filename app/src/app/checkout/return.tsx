import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Stripe sends the buyer back here (`https://rota.davebuilds.design/checkout/return?operation=<id>`, an App Link). Opening it consumes nothing and decides
 * nothing: it opens the status screen, which asks the SERVER whether the payment is settled (AGENTS.md rule 7; app/AGENTS.md: "returning from Checkout
 * triggers a server status check").
 */
export default function CheckoutReturn() {
  const { operation } = useLocalSearchParams<{ operation?: string }>();
  return <Redirect href={{ pathname: '/billing/status', params: { operation: typeof operation === 'string' ? operation : '' } }} />;
}
