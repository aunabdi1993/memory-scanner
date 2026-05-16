import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Colors, Fonts, Spacing } from '../constants/theme';

/** Persistent red banner shown whenever the device is offline. */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const apply = (s: NetInfoState) => {
      const isOff = s.isConnected === false || s.isInternetReachable === false;
      setOffline(isOff);
    };
    NetInfo.fetch().then(apply);
    return NetInfo.addEventListener(apply);
  }, []);

  if (!offline) return null;
  return (
    <View
      style={styles.banner}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
    >
      <Text style={styles.text}>You&apos;re offline. Reconnect to scan or sync.</Text>
    </View>
  );
}

/**
 * Hook variant for screens that need to disable buttons when offline.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const apply = (s: NetInfoState) =>
      setOnline(s.isConnected !== false && s.isInternetReachable !== false);
    NetInfo.fetch().then(apply);
    return NetInfo.addEventListener(apply);
  }, []);
  return online;
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: Colors.red,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    alignItems: 'center',
  },
  text: {
    color: Colors.text,
    fontFamily: Fonts.ui,
    fontSize: 13,
    fontWeight: '600',
  },
});
