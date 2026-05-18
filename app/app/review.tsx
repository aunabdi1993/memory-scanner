import { File, Paths } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Fonts, Radii, Spacing } from '../constants/theme';
import {
  ApiError,
  downloadUrl,
  processPhoto,
  type DateParts,
} from '../services/api';

interface DraftDate {
  month: string;
  day: string;
  year: string;
}

function validate(d: DraftDate): DateParts | null {
  const m = parseInt(d.month, 10);
  const day = parseInt(d.day, 10);
  const y = parseInt(d.year, 10);
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  if (!Number.isFinite(y) || y < 1950 || y > 2030) return null;
  // Reject impossible calendar dates (e.g. Feb 30).
  const probe = new Date(y, m - 1, day);
  if (probe.getMonth() !== m - 1 || probe.getDate() !== day) return null;
  return { year: y, month: m, day };
}

export default function ReviewScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    photoId: string;
    uri: string;
    detected: string;
    year: string;
    month: string;
    day: string;
    confidence: string;
  }>();
  const photoId = params.photoId ?? '';
  const uri = params.uri ?? '';
  const detected = params.detected === '1';
  const confidencePct = Math.round(parseFloat(params.confidence ?? '0') * 100);

  const initial: DraftDate = {
    month: params.month ?? '',
    day: params.day ?? '',
    year: params.year ?? '',
  };

  const [draft, setDraft] = useState<DraftDate>(initial);
  const [saving, setSaving] = useState(false);
  const valid = useMemo(() => validate(draft), [draft]);
  const dirty =
    draft.month !== initial.month ||
    draft.day !== initial.day ||
    draft.year !== initial.year;

  const restoreDetected = () => {
    if (!detected) return;
    setDraft(initial);
    Haptics.selectionAsync();
  };

  const onSave = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await processPhoto(photoId, valid, dirty ? 'manual' : 'auto');

      const target = new File(Paths.cache, `${photoId}_final.jpg`);
      await File.downloadFileAsync(downloadUrl(photoId), target, {
        idempotent: true,
      });
      const localUri = target.uri;

      Alert.alert('Photo dated', 'Where would you like to save it?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save to Photos',
          onPress: async () => {
            const perm = await MediaLibrary.requestPermissionsAsync();
            if (!perm.granted) {
              Alert.alert('Permission denied', 'We need access to save.');
              return;
            }
            await MediaLibrary.saveToLibraryAsync(localUri);
            router.replace('/library');
          },
        },
        {
          text: 'Share / Drive',
          onPress: async () => {
            if (await Sharing.isAvailableAsync()) {
              await Sharing.shareAsync(localUri, {
                mimeType: 'image/jpeg',
                dialogTitle: 'Save your dated photo',
              });
            }
          },
        },
        {
          text: 'Both',
          onPress: async () => {
            const perm = await MediaLibrary.requestPermissionsAsync();
            if (perm.granted) await MediaLibrary.saveToLibraryAsync(localUri);
            if (await Sharing.isAvailableAsync()) {
              await Sharing.shareAsync(localUri, {
                mimeType: 'image/jpeg',
                dialogTitle: 'Save your dated photo',
              });
            }
            router.replace('/library');
          },
        },
      ]);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Save failed';
      Alert.alert('Save failed', msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={styles.back}
          >
            <Text style={styles.backText}>← Retake</Text>
          </Pressable>

          <View style={styles.previewWrap}>
            {uri ? (
              <Image source={{ uri }} style={styles.preview} resizeMode="cover" />
            ) : (
              <View style={[styles.preview, styles.previewMissing]} />
            )}
          </View>

          <View
            style={[
              styles.badge,
              detected && confidencePct >= 60 && styles.badgeOk,
              detected && confidencePct < 60 && styles.badgeWarn,
              !detected && styles.badgeMissing,
            ]}
          >
            <Text style={styles.badgeText}>
              {detected && confidencePct >= 60
                ? `Date detected · ${confidencePct}% confidence`
                : detected
                  ? `Low confidence · ${confidencePct}% — double-check the date`
                  : 'No date stamp found — enter manually'}
            </Text>
          </View>

          <Text style={styles.label}>CAPTURE DATE</Text>

          <View style={styles.dateRow}>
            <TextInput
              value={draft.month}
              onChangeText={(t) => setDraft({ ...draft, month: t.replace(/\D/g, '').slice(0, 2) })}
              placeholder="MM"
              placeholderTextColor={Colors.textSubtle}
              keyboardType="number-pad"
              maxLength={2}
              style={styles.dateInput}
              accessibilityLabel="Month"
            />
            <Text style={styles.dateSep}>/</Text>
            <TextInput
              value={draft.day}
              onChangeText={(t) => setDraft({ ...draft, day: t.replace(/\D/g, '').slice(0, 2) })}
              placeholder="DD"
              placeholderTextColor={Colors.textSubtle}
              keyboardType="number-pad"
              maxLength={2}
              style={styles.dateInput}
              accessibilityLabel="Day"
            />
            <Text style={styles.dateSep}>/</Text>
            <TextInput
              value={draft.year}
              onChangeText={(t) => setDraft({ ...draft, year: t.replace(/\D/g, '').slice(0, 4) })}
              placeholder="YYYY"
              placeholderTextColor={Colors.textSubtle}
              keyboardType="number-pad"
              maxLength={4}
              style={[styles.dateInput, styles.dateInputYear]}
              accessibilityLabel="Year"
            />
          </View>

          {detected && dirty ? (
            <Pressable onPress={restoreDetected} accessibilityRole="button">
              <Text style={styles.restoreLink}>↺ Restore detected date</Text>
            </Pressable>
          ) : null}

          <View style={styles.metaBox}>
            <Text style={styles.metaLine}>
              We&apos;ll write this date into the photo&apos;s EXIF metadata so
              your phone&apos;s Photos app sorts it correctly. The original
              file stays on your device.
            </Text>
          </View>

          <Pressable
            onPress={onSave}
            disabled={!valid || saving}
            accessibilityRole="button"
            accessibilityLabel="Save dated photo"
            style={({ pressed }) => [
              styles.primary,
              (!valid || saving) && styles.primaryDisabled,
              pressed && styles.primaryPressed,
            ]}
          >
            {saving ? (
              <ActivityIndicator color={Colors.bg} />
            ) : (
              <Text style={styles.primaryText}>Save dated photo</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  scroll: {
    padding: Spacing.xl,
    gap: Spacing.lg,
  },
  back: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  backText: { color: Colors.textMuted, fontFamily: Fonts.ui, fontSize: 14 },
  previewWrap: {
    aspectRatio: 1,
    borderRadius: Radii.md,
    borderWidth: 2,
    borderColor: Colors.amber,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  preview: { width: '100%', height: '100%' },
  previewMissing: { backgroundColor: Colors.surface },
  badge: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: Radii.pill,
  },
  badgeOk: { backgroundColor: Colors.sageDeep },
  badgeWarn: { backgroundColor: Colors.amberSoft },
  badgeMissing: { backgroundColor: Colors.amberSoft },
  badgeText: {
    color: Colors.text,
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 1,
  },
  label: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 3,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  dateInput: {
    flex: 1,
    color: Colors.text,
    backgroundColor: Colors.surface,
    borderRadius: Radii.sm,
    paddingVertical: 14,
    paddingHorizontal: Spacing.md,
    textAlign: 'center',
    fontFamily: Fonts.mono,
    fontSize: 22,
    letterSpacing: 2,
    minHeight: 44,
  },
  dateInputYear: { flex: 1.4 },
  dateSep: { color: Colors.textSubtle, fontSize: 22, fontFamily: Fonts.mono },
  restoreLink: {
    color: Colors.amber,
    fontFamily: Fonts.ui,
    fontSize: 13,
    marginTop: -Spacing.sm,
  },
  metaBox: {
    backgroundColor: Colors.bgElevated,
    borderRadius: Radii.md,
    padding: Spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.amber,
  },
  metaLine: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 13,
    lineHeight: 19,
  },
  primary: {
    backgroundColor: Colors.amber,
    borderRadius: Radii.md,
    paddingVertical: 18,
    alignItems: 'center',
    minHeight: 44,
  },
  primaryDisabled: { backgroundColor: Colors.divider },
  primaryPressed: { backgroundColor: Colors.amberDeep },
  primaryText: {
    color: Colors.bg,
    fontFamily: Fonts.ui,
    fontSize: 16,
    fontWeight: '600',
  },
});
