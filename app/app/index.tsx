import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityRole,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useOnline } from '../components/OfflineBanner';
import { Colors, Fonts, Radii, Spacing } from '../constants/theme';
import { useAuth } from '../contexts/AuthContext';
import { connectivityCheck } from '../services/api';

type ServerStatus = 'checking' | 'ok' | 'unreachable';

const STATUS_LABEL: Record<ServerStatus, string> = {
  checking: 'Checking server…',
  ok: 'Server connected',
  unreachable: 'Server unreachable',
};

const STATUS_COLOR: Record<ServerStatus, string> = {
  checking: Colors.amber,
  ok: Colors.sage,
  unreachable: Colors.red,
};

function FilmHoles() {
  return (
    <View style={styles.filmStrip} accessibilityRole={'image' as AccessibilityRole}>
      {Array.from({ length: 12 }).map((_, i) => (
        <View key={i} style={styles.filmHole} />
      ))}
    </View>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const online = useOnline();
  const { user, signOut } = useAuth();
  const [status, setStatus] = useState<ServerStatus>('checking');
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    let cancelled = false;
    connectivityCheck().then((s) => {
      if (!cancelled) setStatus(s);
    });
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 900,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 900,
        useNativeDriver: true,
      }),
    ]).start();
    return () => {
      cancelled = true;
    };
  }, [opacity, translateY]);

  const onScan = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push('/scan');
  };

  const onLibrary = async () => {
    await Haptics.selectionAsync();
    router.push('/library');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <Animated.View
        style={[styles.root, { opacity, transform: [{ translateY }] }]}
      >
        <FilmHoles />

        <View style={styles.body}>
          <Text style={styles.eyebrow}>MEMORIES SCANNER</Text>
          <Text style={styles.title}>
            Bring your{'\n'}
            <Text style={styles.titleAccent}>old photos</Text>{'\n'}
            back to life.
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subtitle}>
            Scan printed disposable-camera prints. We&apos;ll read the date
            stamp, write it into the photo&apos;s metadata, and save it back
            to your library.
          </Text>

          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: STATUS_COLOR[status] },
              ]}
              accessibilityLabel={`Status: ${STATUS_LABEL[status]}`}
            />
            <Text style={styles.statusText}>{STATUS_LABEL[status]}</Text>
          </View>
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={onScan}
            disabled={!online}
            accessibilityRole="button"
            accessibilityLabel="Scan a photo"
            accessibilityState={{ disabled: !online }}
            style={({ pressed }) => [
              styles.primary,
              !online && styles.primaryDisabled,
              pressed && styles.primaryPressed,
            ]}
          >
            <Text style={styles.primaryText}>
              {online ? 'Scan a photo' : 'Offline'}
            </Text>
          </Pressable>
          <Pressable
            onPress={onLibrary}
            disabled={!online}
            accessibilityRole="button"
            accessibilityLabel="Open library"
            accessibilityState={{ disabled: !online }}
            style={styles.secondary}
          >
            <Text style={styles.secondaryText}>Open library →</Text>
          </Pressable>

          <View style={styles.identityRow}>
            <Text style={styles.identityText} numberOfLines={1}>
              Signed in as {user?.email ?? 'private relay'}
            </Text>
            <Pressable
              onPress={() => {
                signOut().then(() => router.replace('/login'));
              }}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              hitSlop={8}
            >
              <Text style={styles.signOutLink}>Sign out</Text>
            </Pressable>
          </View>
        </View>

        <FilmHoles />
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  root: { flex: 1, justifyContent: 'space-between' },
  filmStrip: {
    height: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: Colors.filmEdge,
    paddingHorizontal: Spacing.sm,
  },
  filmHole: {
    width: 12,
    height: 14,
    backgroundColor: Colors.filmHole,
    borderRadius: 2,
  },
  body: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
    flex: 1,
    justifyContent: 'center',
  },
  eyebrow: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 3,
    marginBottom: Spacing.md,
  },
  title: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 42,
    lineHeight: 48,
    fontWeight: '400',
  },
  titleAccent: { color: Colors.amber, fontStyle: 'italic' },
  divider: {
    height: 2,
    width: 56,
    backgroundColor: Colors.amber,
    marginTop: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  subtitle: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 15,
    lineHeight: 22,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Spacing.xl,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: Spacing.sm,
  },
  statusText: {
    color: Colors.textSubtle,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 1,
  },
  actions: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xl,
    gap: Spacing.md,
  },
  primary: {
    backgroundColor: Colors.amber,
    borderRadius: Radii.md,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 44,
  },
  primaryPressed: { backgroundColor: Colors.amberDeep },
  primaryDisabled: { backgroundColor: Colors.divider },
  primaryText: {
    color: Colors.bg,
    fontFamily: Fonts.ui,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  secondary: {
    paddingVertical: 14,
    alignItems: 'center',
    minHeight: 44,
  },
  secondaryText: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 14,
  },
  identityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
    marginTop: Spacing.sm,
  },
  identityText: {
    color: Colors.textSubtle,
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 1,
    flex: 1,
    marginRight: Spacing.sm,
  },
  signOutLink: {
    color: Colors.amber,
    fontFamily: Fonts.ui,
    fontSize: 12,
    fontWeight: '600',
  },
});
