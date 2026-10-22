import { useQuery } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { cacheTimes } from '../api/cacheTimes';
import { ApiError, NetworkError, OfflineError } from '../api/errors';
import { ConfigError, readApiBaseUrl } from '../api/config';
import { getApi } from '../services';
import { useSessionStore } from '../state/sessionStore';
import { radius, space, touchSize, useColors } from '../theme';
import { Text } from '../ui/Text';

/** The one placeholder screen: proves the app and the API talk by calling GET /health. No feature, no fake data. */
export default function HealthScreen() {
  const colors = useColors();
  const sessionStatus = useSessionStore((s) => s.status);
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => getApi().get<{ ok?: unknown }>('/health', { auth: false, signal }),
    ...cacheTimes.health,
  });

  let apiUrl = '';
  try {
    apiUrl = readApiBaseUrl();
  } catch {
    // shown as the error below
  }

  let line: { tone: 'success' | 'danger' | 'muted'; text: string };
  if (health.isPending) line = { tone: 'muted', text: 'Checking the API…' };
  else if (health.isError) line = { tone: 'danger', text: describe(health.error) };
  else if (health.data?.ok === true) line = { tone: 'success', text: 'The API answered: ok.' };
  else line = { tone: 'danger', text: 'The API answered, but not with ok.' };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ flex: 1, padding: space[24], gap: space[16] }}>
        <Text variant="caption" tone="muted">
          ROTA
        </Text>
        <Text variant="title">API check</Text>
        <View
          style={{
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: radius[12],
            padding: space[16],
            gap: space[8],
          }}
        >
          <Text variant="label" tone={line.tone} accessibilityLiveRegion="polite">
            {line.text}
          </Text>
          <Text variant="caption" tone="muted">
            {apiUrl ? `API: ${apiUrl}` : 'API: not configured'}
          </Text>
          <Text variant="caption" tone="muted">
            {`Session: ${sessionStatus}`}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => void health.refetch()}
          disabled={health.isFetching}
          style={{
            minHeight: touchSize,
            borderRadius: radius[12],
            backgroundColor: colors.action,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: health.isFetching ? 0.6 : 1,
          }}
        >
          <Text variant="label" style={{ color: colors.onAction }}>
            {health.isFetching ? 'Checking…' : 'Check again'}
          </Text>
        </Pressable>
        {__DEV__ ? (
          <Link href="/dev-check" style={{ minHeight: touchSize, textAlignVertical: 'center' }}>
            <Text variant="label" tone="action">
              Native module check (development only)
            </Text>
          </Link>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function describe(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof OfflineError) return 'The device is offline.';
  if (error instanceof NetworkError) return error.timedOut ? 'The API did not answer in time.' : 'Could not reach the API.';
  if (error instanceof ApiError) return `The API answered ${error.status} (${error.code}).`;
  return 'Something went wrong.';
}
