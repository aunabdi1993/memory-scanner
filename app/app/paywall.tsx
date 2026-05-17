import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Fonts, Radii, Spacing } from '../constants/theme';
import { useEntitlement } from '../contexts/EntitlementContext';
import {
  getProProduct,
  isIapAvailable,
  purchaseMonthly,
  restorePurchases,
  type ProProduct,
} from '../services/billing';

const TOS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
const PRIVACY_URL = 'https://memoriesscanner.app/privacy';

export default function PaywallScreen() {
  const router = useRouter();
  const { snapshot, refresh } = useEntitlement();
  const [product, setProduct] = useState<ProProduct | null>(null);
  const [loadingProduct, setLoadingProduct] = useState(true);
  const [buying, setBuying] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await getProProduct();
        if (!cancelled) setProduct(p);
      } catch {
        if (!cancelled) setProduct(null);
      } finally {
        if (!cancelled) setLoadingProduct(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubscribe = async () => {
    if (buying) return;
    setBuying(true);
    try {
      const snap = await purchaseMonthly();
      await refresh();
      if (snap.tier === 'pro') router.back();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Purchase failed.';
      // Apple's user-cancelled error is intentionally quiet.
      if (!/cancel/i.test(msg)) Alert.alert('Subscription failed', msg);
    } finally {
      setBuying(false);
    }
  };

  const onRestore = async () => {
    if (restoring) return;
    setRestoring(true);
    try {
      const snap = await restorePurchases();
      await refresh();
      if (snap?.tier === 'pro') {
        Alert.alert('Restored', 'Your Pro subscription is active again.');
        router.back();
      } else {
        Alert.alert(
          'Nothing to restore',
          'No active subscription found for this Apple ID.',
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Restore failed.';
      Alert.alert('Restore failed', msg);
    } finally {
      setRestoring(false);
    }
  };

  const priceLabel = loadingProduct
    ? '—'
    : product?.displayPrice ?? '£4.99';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={styles.close}
          hitSlop={12}
        >
          <Text style={styles.closeText}>Close</Text>
        </Pressable>

        <Text style={styles.eyebrow}>MEMORIES SCANNER PRO</Text>
        <Text style={styles.title}>
          Keep scanning your{'\n'}
          <Text style={styles.titleAccent}>whole shoebox.</Text>
        </Text>
        <View style={styles.divider} />

        <View style={styles.benefits}>
          <Benefit text="Unlimited photo scans, dated automatically" />
          <Benefit text="Higher OCR priority — no waiting in queue" />
          <Benefit text="All your existing scans stay yours, always" />
        </View>

        {snapshot && snapshot.tier === 'free' ? (
          <View style={styles.usageRow}>
            <Text style={styles.usageText}>
              You&apos;ve used {snapshot.scans_used} of your {snapshot.free_limit}{' '}
              free scans.
            </Text>
          </View>
        ) : null}

        <View style={styles.priceCard}>
          <Text style={styles.priceLine}>
            <Text style={styles.priceBig}>{priceLabel}</Text>
            <Text style={styles.priceSmall}> / month</Text>
          </Text>
          <Text style={styles.priceSubtle}>Cancel anytime in Settings.</Text>
        </View>

        <Pressable
          onPress={onSubscribe}
          disabled={buying || !isIapAvailable()}
          accessibilityRole="button"
          accessibilityLabel="Subscribe to Memories Scanner Pro"
          style={({ pressed }) => [
            styles.primary,
            (buying || !isIapAvailable()) && styles.primaryDisabled,
            pressed && styles.primaryPressed,
          ]}
        >
          {buying ? (
            <ActivityIndicator color={Colors.bg} />
          ) : (
            <Text style={styles.primaryText}>
              {isIapAvailable() ? 'Subscribe' : 'Available in App Store build'}
            </Text>
          )}
        </Pressable>

        <Pressable
          onPress={onRestore}
          disabled={restoring}
          accessibilityRole="button"
          accessibilityLabel="Restore purchases"
          style={styles.secondary}
        >
          <Text style={styles.secondaryText}>
            {restoring ? 'Restoring…' : 'Restore purchases'}
          </Text>
        </Pressable>

        <Text style={styles.fineprint}>
          Auto-renewing subscription. Your Apple ID is charged{' '}
          {product?.displayPrice ?? priceLabel} per month, renewing automatically
          unless cancelled at least 24 hours before the end of the current
          period. Manage and cancel in your Apple ID Settings → Subscriptions.
        </Text>

        <View style={styles.linkRow}>
          <Pressable
            onPress={() => Linking.openURL(TOS_URL)}
            accessibilityRole="link"
          >
            <Text style={styles.link}>Terms of Use (EULA)</Text>
          </Pressable>
          <Text style={styles.linkDot}>·</Text>
          <Pressable
            onPress={() => Linking.openURL(PRIVACY_URL)}
            accessibilityRole="link"
          >
            <Text style={styles.link}>Privacy Policy</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Benefit({ text }: { text: string }) {
  return (
    <View style={styles.benefitRow}>
      <Text style={styles.benefitCheck}>✓</Text>
      <Text style={styles.benefitText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: Spacing.xl, paddingBottom: Spacing.xxl, gap: Spacing.md },
  close: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center' },
  closeText: { color: Colors.textMuted, fontFamily: Fonts.ui, fontSize: 14 },
  eyebrow: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 3,
  },
  title: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 36,
    lineHeight: 42,
    marginTop: Spacing.sm,
  },
  titleAccent: { color: Colors.amber, fontStyle: 'italic' },
  divider: {
    height: 2,
    width: 56,
    backgroundColor: Colors.amber,
    marginTop: Spacing.md,
    marginBottom: Spacing.lg,
  },
  benefits: { gap: Spacing.sm },
  benefitRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm },
  benefitCheck: {
    color: Colors.sage,
    fontFamily: Fonts.mono,
    fontSize: 16,
    width: 18,
  },
  benefitText: {
    color: Colors.text,
    fontFamily: Fonts.ui,
    fontSize: 15,
    flex: 1,
    lineHeight: 22,
  },
  usageRow: {
    marginTop: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radii.sm,
    backgroundColor: Colors.amberSoft,
  },
  usageText: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 1,
  },
  priceCard: {
    marginTop: Spacing.lg,
    padding: Spacing.lg,
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    alignItems: 'center',
  },
  priceLine: { color: Colors.text, fontFamily: Fonts.display },
  priceBig: { fontSize: 38, color: Colors.amber },
  priceSmall: { fontSize: 16, color: Colors.textMuted, fontFamily: Fonts.ui },
  priceSubtle: {
    color: Colors.textSubtle,
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 1,
    marginTop: Spacing.xs,
  },
  primary: {
    backgroundColor: Colors.amber,
    borderRadius: Radii.md,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: Spacing.lg,
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
  secondary: { paddingVertical: 14, alignItems: 'center', minHeight: 44 },
  secondaryText: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 14,
  },
  fineprint: {
    color: Colors.textSubtle,
    fontFamily: Fonts.ui,
    fontSize: 11,
    lineHeight: 16,
    marginTop: Spacing.md,
  },
  linkRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  link: {
    color: Colors.amber,
    fontFamily: Fonts.ui,
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  linkDot: { color: Colors.textSubtle, fontFamily: Fonts.mono, fontSize: 12 },
});
