import NetInfo from '@react-native-community/netinfo';
import * as Sentry from '@sentry/react-native';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Font from 'expo-font';
import * as Linking from 'expo-linking';
import * as Localization from 'expo-localization';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import * as SystemUI from 'expo-system-ui';
import * as WebBrowser from 'expo-web-browser';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Rect } from 'react-native-svg';
import { palette, space, useColors } from '../theme';
import { Text } from '../ui/Text';

/**
 * Development only. Calls one harmless function of every native module the app ships, so a missing or unloadable
 * native library shows up here (and in logcat as "[dev-check]") before any EAS build is spent.
 */
interface Result {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Array<[string, () => Promise<string>]> = [
  [
    'expo-secure-store',
    async () => {
      const key = 'rota.devcheck';
      await SecureStore.setItemAsync(key, 'ok');
      const back = await SecureStore.getItemAsync(key);
      await SecureStore.deleteItemAsync(key);
      return `available=${await SecureStore.isAvailableAsync()} roundtrip=${back === 'ok'}`;
    },
  ],
  [
    'expo-sqlite',
    async () => {
      const db = await SQLite.openDatabaseAsync(':memory:');
      try {
        const version = await db.getFirstAsync<{ v: string }>('select sqlite_version() as v');
        const options = await db.getAllAsync<{ compile_options: string }>('pragma compile_options');
        const sqlcipher = options.some((o) => /sqlcipher/i.test(o.compile_options));
        let vec = 'absent';
        try {
          await db.getFirstAsync('select vec_version() as v');
          vec = 'PRESENT';
        } catch {
          vec = 'absent';
        }
        return `sqlite ${version?.v ?? '?'} sqlcipher=${sqlcipher} sqlite-vec=${vec}`;
      } finally {
        await db.closeAsync();
      }
    },
  ],
  ['expo-crypto', async () => `uuid length ${Crypto.randomUUID().length}`],
  ['expo-device', async () => `${Device.manufacturer ?? '?'} ${Device.modelName ?? '?'} isDevice=${Device.isDevice}`],
  ['expo-localization', async () => `timeZone=${Localization.getCalendars()[0]?.timeZone ?? '?'}`],
  [
    '@react-native-community/netinfo',
    async () => {
      const s = await NetInfo.fetch();
      return `type=${s.type} connected=${String(s.isConnected)} reachable=${String(s.isInternetReachable)}`;
    },
  ],
  ['expo-clipboard', async () => `hasString=${await Clipboard.hasStringAsync()}`],
  ['expo-notifications', async () => `permission=${(await Notifications.getPermissionsAsync()).status}`],
  [
    'expo-web-browser',
    async () => `custom-tabs browsers=${(await WebBrowser.getCustomTabsSupportingBrowsersAsync()).browserPackages.length}`,
  ],
  ['expo-linking', async () => Linking.createURL('invite/example')],
  ['expo-constants', async () => `scheme=${String(Constants.expoConfig?.scheme)} name=${Constants.expoConfig?.name}`],
  ['expo-system-ui', async () => `background=${String(await SystemUI.getBackgroundColorAsync())}`],
  ['expo-font', async () => `Manrope_700Bold loaded=${Font.isLoaded('Manrope_700Bold')} DMSans_400Regular loaded=${Font.isLoaded('DMSans_400Regular')}`],
  ['@sentry/react-native', async () => `captureMessage is ${typeof Sentry.captureMessage}; client=${Sentry.getClient() ? 'set' : 'not initialised (Sentry slice)'}`],
];

export default function DevCheck() {
  const colors = useColors();
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    if (!__DEV__) return;
    let cancelled = false;
    void (async () => {
      const out: Result[] = [];
      for (const [name, run] of checks) {
        try {
          out.push({ name, ok: true, detail: await run() });
        } catch (error) {
          out.push({ name, ok: false, detail: error instanceof Error ? error.message : 'failed' });
        }
      }
      if (cancelled) return;
      setResults(out);
      console.log('[dev-check] ' + JSON.stringify(out));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!__DEV__) return <Redirect href="/" />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ padding: space[24], gap: space[12] }}>
        <Text variant="title">Native modules</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[8] }}>
          <Svg width={24} height={24} accessibilityLabel="react-native-svg rendered">
            <Rect x={0} y={0} width={24} height={24} rx={6} fill={palette.teal} />
          </Svg>
          <Text variant="caption" tone="muted">
            react-native-svg rendered
          </Text>
        </View>
        {results.length === 0 ? <Text tone="muted">Running…</Text> : null}
        {results.map((r) => (
          <View key={r.name}>
            <Text variant="label" tone={r.ok ? 'success' : 'danger'}>
              {`${r.ok ? 'OK' : 'FAIL'}  ${r.name}`}
            </Text>
            <Text variant="caption" tone="muted">
              {r.detail}
            </Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
