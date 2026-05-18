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
  getLifetimeProduct,
  getProProduct,
  isIapAvailable,
  purchaseLifetime,
  purchaseMonthly,
  restorePurchases,
  type ProProduct,
} from '../services/billing';

const TOS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
const PRIVACY_URL = 'https://memoriesscanner.app/privacy';

type Plan = 'monthly' | 'lifetime';

export default function PaywallScreen() {
  const router = useRouter();
  const { snapshot, refresh } = useEntitlement();
  const [monthly, setMonthly] = useState<ProProduct | null>(null);
  const [lifetime, setLifetime] = useState<ProProduct | null>(null);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [buying, setBuying] = useState<Plan | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, l] = await Promise.all([
          getProProduct().catch(() => null),
          getLifetimeProduct().catch(() => null),
        ]);
        if (!cancelled) {
          setMonthly(m);
          setLifetime(l);
        }
      } finally {
        if (!cancelled) setLoadingProducts(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onBuy = async (plan: Plan) => {
    if (buying) return;
    setBuying(plan);
    try {
      const snap =
        plan === 'monthly' ? await purchaseMonthly() : await purchaseLifetime();
      await refresh();
      if (snap.tier === 'pro') router.back();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Purchase failed.';
      // Apple's user-cancelled error is intentionally quiet.
      if (!/cancel/i.test(msg)) Alert.alert('Purchase failed', msg);
    } finally {
      setBuying(null);
    }
  };

  const onRestore = async () => {
    if (restoring) return;
    setRestoring(true);
    try {
      const snap = await restorePurchases();
      await refresh();
      if (snap?.tier === 'pro') {
        Alert.alert('Restored', 'Your Pro access is active again.');
        router.back();
      } else {
        Alert.alert(
          'Nothing to restore',
          'No active purchase found for this Apple ID.',
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Restore failed.';
      Alert.alert('Restore failed', msg);
    } finally {
      setRestoring(false);
    }
  };

  const monthlyPrice = loadingProducts
    ? '—'
    : monthly?.displayPrice ?? '£4.99';
  const lifetimePrice = loadingProducts
    ? '—'
    : lifetime?.displayPrice ?? '£14.99';

  const iapReady = isIapAvailable();

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
          <Benefit text="Batch scan up to 50 prints at a time" />
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

        <View style={styles.cards}>
          <PriceCard
            badge="MOST POPULAR"
            price={monthlyPrice}
            unit="/ month"
            footnote="Cancel anytime"
            ctaText={iapReady ? 'Subscribe' : 'Not available'}
            buying={buying === 'monthly'}
            disabled={!iapReady || !!buying}
            onPress={() => onBuy('monthly')}
          />
          <PriceCard
            badge="BEST VALUE"
            price={lifetimePrice}
            unit="one-time"
            footnote="Pay once · yours forever"
            ctaText={iapReady ? 'Buy lifetime' : 'Not available'}
            buying={buying === 'lifetime'}
            disabled={!iapReady || !!buying}
            onPress={() => onBuy('lifetime')}
            accent
          />
        </View>

        <Pressable
          onPress={onRestore}
          disabled={restoring || !!buying}
          accessibilityRole="button"
          accessibilityLabel="Restore purchases"
          style={styles.secondary}
        >
          <Text style={styles.secondaryText}>
            {restoring ? 'Restoring…' : 'Restore purchases'}
          </Text>
        </Pressable>

        <Text style={styles.fineprint}>
          Subscription: auto-renewing. Your Apple ID is charged{' '}
          {monthlyPrice} per month, renewing automatically unless cancelled at
          least 24 hours before the end of the current period. Manage and
          cancel in your Apple ID Settings → Subscriptions.
          {'\n\n'}
          Lifetime: one-time purchase of {lifetimePrice}. No renewals, no
          recurring charges. Refunds handled by Apple under standard App
          Store terms.
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

interface PriceCardProps {
  badge: string;
  price: string;
  unit: string;
  footnote: string;
  ctaText: string;
  buying: boolean;
  disabled: boolean;
  onPress: () => void;
  accent?: boolean;
}

function PriceCard({
  badge,
  price,
  unit,
  footnote,
  ctaText,
  buying,
  disabled,
  onPress,
  accent,
}: PriceCardProps) {
  return (
    <View style={[styles.priceCard, accent && styles.priceCardAccent]}>
      <Text style={[styles.priceBadge, accent && styles.priceBadgeAccent]}>
        {badge}
      </Text>
      <Text style={styles.priceBig}>{price}</Text>
      <Text style={styles.priceUnit}>{unit}</Text>
      <Text style={styles.priceFootnote}>{footnote}</Text>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={ctaText}
        style={({ pressed }) => [
          styles.primary,
          accent && styles.primaryAccent,
          disabled && styles.primaryDisabled,
          pressed && !disabled && styles.primaryPressed,
        ]}
      >
        {buying ? (
          <ActivityIndicator color={Colors.bg} />
        ) : (
          <Text style={styles.primaryText}>{ctaText}</Text>
        )}
      </Pressable>
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
  cards: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing.lg,
  },
  priceCard: {
    flex: 1,
    padding: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  priceCardAccent: {
    borderColor: Colors.amber,
    backgroundColor: Colors.bgElevated,
  },
  priceBadge: {
    color: Colors.textMuted,
    fontFamily: Fonts.mono,
    fontSize: 10,
    letterSpacing: 2,
    marginBottom: Spacing.sm,
  },
  priceBadgeAccent: { color: Colors.amber },
  priceBig: {
    fontSize: 30,
    color: Colors.amber,
    fontFamily: Fonts.display,
  },
  priceUnit: {
    fontSize: 13,
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    marginTop: 2,
  },
  priceFootnote: {
    color: Colors.textSubtle,
    fontFamily: Fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    marginTop: Spacing.sm,
    textAlign: 'center',
    minHeight: 14,
  },
  primary: {
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    paddingVertical: 14,
    paddingHorizontal: Spacing.md,
    alignItems: 'center',
    marginTop: Spacing.md,
    minHeight: 44,
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: Colors.amber,
  },
  primaryAccent: {
    backgroundColor: Colors.amber,
    borderColor: Colors.amber,
  },
  primaryPressed: { opacity: 0.85 },
  primaryDisabled: { backgroundColor: Colors.divider, borderColor: Colors.divider },
  primaryText: {
    color: Colors.bg,
    fontFamily: Fonts.ui,
    fontSize: 14,
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
