import { router } from 'expo-router';
import { ApiError } from '../api/errors';
import { bannerCopy } from '../auth/copy';
import { space } from '../theme';
import { Button } from '../ui/Button';
import { PageHeader } from '../ui/PageHeader';
import { Screen, Spacer } from '../ui/Screen';
import { StatusBanner } from '../ui/StatusBanner';
import { Text } from '../ui/Text';
import { shiftDetailCopy, scheduleCopy } from './shiftCopy';
import type { ShiftLoadState } from './shiftLoadState';

/** The three non-ready states of a screen that needs one shift: loading, gone (404) and failed. */
export function ShiftUnavailable({
  state,
  teamName,
  error,
  onRetry,
}: {
  state: Exclude<ShiftLoadState, 'ready'>;
  teamName: string | undefined;
  error: unknown;
  onRetry: () => void;
}) {
  const reference = error instanceof ApiError && error.requestId ? `${bannerCopy.referencePrefix}${error.requestId}` : undefined;
  return (
    <Screen gap={space[16]}>
      <PageHeader
        eyebrowGap={16}
        teamName={teamName}
        title={state === 'gone' ? shiftDetailCopy.notFound.title : state === 'failed' ? scheduleCopy.error.title : shiftDetailCopy.loading}
        subtitle={state === 'gone' ? shiftDetailCopy.notFound.subtitle : state === 'failed' ? scheduleCopy.error.subtitle : undefined}
      />
      {state === 'failed' ? <StatusBanner tone="error" title={scheduleCopy.error.title} reference={reference} /> : null}
      {state === 'loading' ? (
        <Text variant="caption" tone="muted">
          {shiftDetailCopy.loading}
        </Text>
      ) : null}
      <Spacer />
      {state === 'failed' ? <Button label={scheduleCopy.error.retry} variant="secondary" onPress={onRetry} testID="shift-retry" /> : null}
      <Button label={shiftDetailCopy.notFound.back} onPress={() => router.dismissTo('/')} testID="shift-back-to-schedule" />
    </Screen>
  );
}
