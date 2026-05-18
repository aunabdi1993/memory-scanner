import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { File } from 'expo-file-system';

import { useOnline } from '../components/OfflineBanner';
import { Colors, Fonts, Radii, Spacing } from '../constants/theme';
import { useEntitlement } from '../contexts/EntitlementContext';
import {
  ApiError,
  QuotaExhaustedError,
  isLargeUpload,
  scanPhotoWithProgress,
} from '../services/api';

const VIEWFINDER_RATIO = 0.85;

function ViewfinderMask({ analyzing }: { analyzing: boolean }) {
  return (
    <View style={styles.maskRoot} pointerEvents="none">
      <View style={styles.dim} />
      <View style={styles.middleRow}>
        <View style={styles.dim} />
        <View style={styles.viewfinder}>
          <View style={[styles.corner, styles.tl]} />
          <View style={[styles.corner, styles.tr]} />
          <View style={[styles.corner, styles.bl]} />
          <View style={[styles.corner, styles.br]} />
          {analyzing ? (
            <View style={styles.analyzingPill}>
              <ActivityIndicator color={Colors.amber} />
              <Text style={styles.analyzingText}>Analyzing…</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.dim} />
      </View>
      <View style={styles.dim}>
        <Text style={styles.hint}>
          {analyzing ? 'Reading the date stamp…' : 'Place photo here'}
        </Text>
      </View>
    </View>
  );
}

export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const online = useOnline();
  const { isPro, scansRemaining, refresh } = useEntitlement();

  const confirmLargeUpload = async (uri: string): Promise<boolean> => {
    try {
      const file = new File(uri);
      const size = file.exists ? file.size : 0;
      if (!isLargeUpload(size)) return true;
    } catch {
      return true; // if we can't stat, don't block the user
    }
    return new Promise<boolean>((resolve) => {
      Alert.alert(
        'Large photo',
        'This file is over 15 MB and may take a while to upload. Continue?',
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Upload', onPress: () => resolve(true) },
        ],
      );
    });
  };

  const dispatchScan = async (uri: string) => {
    if (!online) {
      Alert.alert('Offline', 'Reconnect to upload this scan.');
      return;
    }
    // Pre-flight quota check using the cached snapshot. The server is
    // the source of truth — if this client cache is stale we still get
    // a 402 below.
    if (!isPro && scansRemaining <= 0) {
      router.push('/paywall');
      return;
    }
    if (!(await confirmLargeUpload(uri))) return;
    setAnalyzing(true);
    setProgress(0);
    try {
      const result = await scanPhotoWithProgress(uri, setProgress);
      // The scan just consumed one of the free quota (or was free for
      // Pro). Refresh in the background so the indicator stays accurate.
      void refresh();
      router.replace({
        pathname: '/review',
        params: {
          photoId: result.photo_id,
          uri,
          detected: result.detected ? '1' : '0',
          year: result.date?.year?.toString() ?? '',
          month: result.date?.month?.toString() ?? '',
          day: result.date?.day?.toString() ?? '',
          confidence: result.confidence.toString(),
        },
      });
    } catch (e) {
      if (e instanceof QuotaExhaustedError) {
        void refresh();
        router.replace('/paywall');
        return;
      }
      const msg = e instanceof ApiError ? e.message : 'Scan failed';
      Alert.alert('Scan failed', msg);
    } finally {
      setAnalyzing(false);
    }
  };

  const onShutter = async () => {
    if (analyzing || !cameraRef.current) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.95 });
      if (photo?.uri) await dispatchScan(photo.uri);
    } catch (e) {
      Alert.alert('Camera error', String(e));
    }
  };

  const onLibrary = async () => {
    await Haptics.selectionAsync();
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.95,
      allowsEditing: false,
      allowsMultipleSelection: true,
      selectionLimit: 50,
    });
    if (result.canceled || result.assets.length === 0) return;
    if (result.assets.length === 1) {
      await dispatchScan(result.assets[0].uri);
      return;
    }
    const uris = result.assets.map((a) => a.uri);
    router.push({
      pathname: '/batch',
      params: { uris: JSON.stringify(uris) },
    });
  };

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.amber} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.center}>
          <Text style={styles.eyebrow}>CAMERA ACCESS NEEDED</Text>
          <Text style={styles.permissionTitle}>Let us see your photos.</Text>
          <Text style={styles.permissionBody}>
            Memories Scanner needs camera access to capture your printed
            photos. Nothing is uploaded until you tap the shutter.
          </Text>
          <Pressable
            onPress={requestPermission}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.primary,
              pressed && styles.primaryPressed,
            ]}
          >
            <Text style={styles.primaryText}>Grant access</Text>
          </Pressable>
          <Pressable onPress={() => router.back()} style={styles.secondary}>
            <Text style={styles.secondaryText}>Not now</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.cameraRoot}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
      />
      <ViewfinderMask analyzing={analyzing} />

      <SafeAreaView edges={['bottom']} style={styles.controlsSafe}>
        <View style={styles.controls}>
          <Pressable
            onPress={onLibrary}
            accessibilityRole="button"
            accessibilityLabel="Pick from library"
            style={styles.iconButton}
          >
            <Text style={styles.iconText}>☐</Text>
            <Text style={styles.iconLabel}>Library</Text>
          </Pressable>

          <Pressable
            onPress={onShutter}
            disabled={analyzing}
            accessibilityRole="button"
            accessibilityLabel="Capture photo"
            style={({ pressed }) => [
              styles.shutter,
              pressed && styles.shutterPressed,
            ]}
          >
            <View style={styles.shutterCore} />
          </Pressable>

          <View style={styles.iconButton}>
            <Text style={[styles.iconText, { color: 'transparent' }]}>·</Text>
          </View>
        </View>

        {!isPro && Number.isFinite(scansRemaining) ? (
          <Text style={styles.quotaBadge}>
            {scansRemaining > 0
              ? `${scansRemaining} free scan${scansRemaining === 1 ? '' : 's'} left`
              : 'Free quota used — upgrade to keep scanning'}
          </Text>
        ) : null}

        {analyzing ? (
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${Math.round(progress * 100)}%` },
              ]}
            />
          </View>
        ) : (
          <Text style={styles.tip}>
            Tip: lay the print on a dark, matte surface for the cleanest read.
          </Text>
        )}
      </SafeAreaView>
    </View>
  );
}

const SHUTTER_SIZE = 72;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  center: {
    flex: 1,
    backgroundColor: Colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  cameraRoot: { flex: 1, backgroundColor: '#000' },
  maskRoot: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  dim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  middleRow: { flexDirection: 'row', aspectRatio: 1 / VIEWFINDER_RATIO },
  viewfinder: {
    aspectRatio: 1,
    flexShrink: 0,
    flexGrow: 0,
    alignSelf: 'center',
    width: '85%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: Colors.amber,
  },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3 },
  analyzingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15,14,12,0.85)',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: Radii.pill,
    gap: Spacing.sm,
  },
  analyzingText: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 1,
  },
  hint: {
    color: Colors.text,
    fontFamily: Fonts.ui,
    fontSize: 14,
    opacity: 0.85,
  },
  controlsSafe: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
  },
  iconButton: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { color: Colors.text, fontSize: 24 },
  iconLabel: {
    color: Colors.textSubtle,
    fontFamily: Fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    marginTop: 2,
  },
  shutter: {
    width: SHUTTER_SIZE,
    height: SHUTTER_SIZE,
    borderRadius: SHUTTER_SIZE / 2,
    borderWidth: 4,
    borderColor: Colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterPressed: { borderColor: Colors.amber },
  shutterCore: {
    width: SHUTTER_SIZE - 18,
    height: SHUTTER_SIZE - 18,
    borderRadius: (SHUTTER_SIZE - 18) / 2,
    backgroundColor: Colors.text,
  },
  progressTrack: {
    height: 3,
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: { height: 3, backgroundColor: Colors.amber },
  quotaBadge: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 1.5,
    textAlign: 'center',
    marginBottom: Spacing.sm,
    paddingHorizontal: Spacing.xl,
  },
  tip: {
    color: Colors.textSubtle,
    fontFamily: Fonts.ui,
    fontSize: 12,
    textAlign: 'center',
    marginBottom: Spacing.md,
    paddingHorizontal: Spacing.xl,
  },
  eyebrow: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 3,
    marginBottom: Spacing.md,
  },
  permissionTitle: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 28,
    textAlign: 'center',
    marginBottom: Spacing.md,
  },
  permissionBody: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: Spacing.xl,
  },
  primary: {
    backgroundColor: Colors.amber,
    borderRadius: Radii.md,
    paddingVertical: 16,
    paddingHorizontal: Spacing.xl,
    minHeight: 44,
  },
  primaryPressed: { backgroundColor: Colors.amberDeep },
  primaryText: {
    color: Colors.bg,
    fontFamily: Fonts.ui,
    fontSize: 16,
    fontWeight: '600',
  },
  secondary: { paddingTop: Spacing.md, minHeight: 44 },
  secondaryText: { color: Colors.textMuted, fontFamily: Fonts.ui, fontSize: 14 },
});
