import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Fonts, Radii, Spacing } from '../constants/theme';
import { useEntitlement } from '../contexts/EntitlementContext';
import {
  ApiError,
  QuotaExhaustedError,
  scanPhotoWithProgress,
  type ScanResponse,
} from '../services/api';

export interface BatchItem {
  uri: string;
  photoId: string;
  detected: boolean;
  year: number | null;
  month: number | null;
  day: number | null;
  confidence: number;
  error?: string;
}

function toBatchItem(uri: string, r: ScanResponse): BatchItem {
  return {
    uri,
    photoId: r.photo_id,
    detected: r.detected,
    year: r.date?.year ?? null,
    month: r.date?.month ?? null,
    day: r.date?.day ?? null,
    confidence: r.confidence,
  };
}

export default function BatchScanScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ uris: string }>();
  const { refresh } = useEntitlement();

  const uris: string[] = (() => {
    try {
      const parsed = JSON.parse(params.uris ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((u) => typeof u === 'string') : [];
    } catch {
      return [];
    }
  })();

  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const cancelled = useRef(false);
  const results = useRef<BatchItem[]>([]);

  useEffect(() => {
    if (uris.length === 0) {
      router.back();
      return;
    }
    let alive = true;
    (async () => {
      for (let i = 0; i < uris.length; i++) {
        if (cancelled.current || !alive) break;
        setIndex(i);
        setProgress(0);
        const uri = uris[i];
        try {
          const r = await scanPhotoWithProgress(uri, setProgress);
          results.current.push(toBatchItem(uri, r));
          void refresh();
        } catch (e) {
          if (e instanceof QuotaExhaustedError) {
            // Stop the loop, hand the user to the paywall. Whatever
            // already scanned is preserved in results.current so the
            // batch-review screen can render after they purchase / dismiss.
            void refresh();
            if (!alive) return;
            // Persist results-so-far into the navigation stack via
            // batch-review BEFORE pushing paywall so back-from-paywall
            // lands them on the review screen.
            const payload = JSON.stringify(results.current);
            router.replace({
              pathname: '/batch-review',
              params: {
                results: payload,
                truncated: '1',
                totalRequested: String(uris.length),
              },
            });
            router.push('/paywall');
            return;
          }
          // Non-quota errors per photo: record and keep going.
          const msg = e instanceof ApiError ? e.message : 'Scan failed';
          results.current.push({
            uri,
            photoId: '',
            detected: false,
            year: null,
            month: null,
            day: null,
            confidence: 0,
            error: msg,
          });
        }
      }
      if (!alive) return;
      setDone(true);
      router.replace({
        pathname: '/batch-review',
        params: {
          results: JSON.stringify(results.current),
          truncated: '0',
          totalRequested: String(uris.length),
        },
      });
    })();
    return () => {
      alive = false;
    };
    // We intentionally exclude `uris` from deps — re-running on each
    // re-render would restart the loop. The list is fixed at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCancel = () => {
    if (done) return;
    Alert.alert(
      'Stop scanning?',
      results.current.length === 0
        ? 'No photos have been scanned yet. Stop and go back?'
        : `Keep the ${results.current.length} already scanned and stop the rest?`,
      [
        { text: 'Keep scanning', style: 'cancel' },
        {
          text: 'Stop',
          style: 'destructive',
          onPress: () => {
            cancelled.current = true;
            if (results.current.length === 0) {
              router.back();
            } else {
              router.replace({
                pathname: '/batch-review',
                params: {
                  results: JSON.stringify(results.current),
                  truncated: '1',
                  totalRequested: String(uris.length),
                },
              });
            }
          },
        },
      ],
    );
  };

  const currentUri = uris[index] ?? '';
  const counter = `${Math.min(index + 1, uris.length)} of ${uris.length}`;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.body}>
        <Text style={styles.eyebrow}>BATCH SCAN</Text>
        <Text style={styles.title}>Scanning {counter}…</Text>

        <View style={styles.previewWrap}>
          {currentUri ? (
            <Image source={{ uri: currentUri }} style={styles.preview} resizeMode="cover" />
          ) : (
            <View style={[styles.preview, styles.previewMissing]} />
          )}
          <View style={styles.previewOverlay}>
            <ActivityIndicator color={Colors.amber} />
          </View>
        </View>

        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.round(progress * 100)}%` },
            ]}
          />
        </View>

        <Text style={styles.hint}>
          Reading the date stamp on each photo. You can stop any time —
          we&apos;ll keep what&apos;s already been scanned.
        </Text>

        <Pressable
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Stop batch"
          style={styles.cancel}
        >
          <Text style={styles.cancelText}>Stop</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  body: { flex: 1, padding: Spacing.xl, gap: Spacing.lg },
  eyebrow: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 3,
  },
  title: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 30,
    lineHeight: 36,
  },
  previewWrap: {
    aspectRatio: 1,
    borderRadius: Radii.md,
    borderWidth: 2,
    borderColor: Colors.amber,
    overflow: 'hidden',
  },
  preview: { width: '100%', height: '100%' },
  previewMissing: { backgroundColor: Colors.surface },
  previewOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15,14,12,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: {
    height: 4,
    backgroundColor: Colors.surface,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: { height: 4, backgroundColor: Colors.amber },
  hint: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 13,
    lineHeight: 19,
  },
  cancel: {
    marginTop: 'auto',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  cancelText: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 15,
  },
});
