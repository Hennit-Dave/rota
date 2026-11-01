import { Redirect, useLocalSearchParams } from 'expo-router';

/** Stripe's "back" link while saving a card (`/checkout/card-cancel?setup=<id>`). It opens the status screen as "cancelled"; nothing changes on the server by opening it. */
export default function CheckoutCardCancel() {
  const { setup } = useLocalSearchParams<{ setup?: string }>();
  return <Redirect href={{ pathname: '/billing/card-status', params: { setup: typeof setup === 'string' ? setup : '', from: 'cancel' } }} />;
}
