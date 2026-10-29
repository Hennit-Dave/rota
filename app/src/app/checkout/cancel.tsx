import { Redirect, useLocalSearchParams } from 'expo-router';

/** Stripe's "back" link (`/checkout/cancel?operation=<id>`). It opens the status screen as "cancelled"; nothing is changed on the server by opening it. */
export default function CheckoutCancel() {
  const { operation } = useLocalSearchParams<{ operation?: string }>();
  return <Redirect href={{ pathname: '/billing/status', params: { operation: typeof operation === 'string' ? operation : '', from: 'cancel' } }} />;
}
