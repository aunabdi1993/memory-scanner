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
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  DateInputRow,
  draftFromParts,
  validateDraft,
  type DraftDate,
} from '../components/DateInputRow';
import { Colors, Fonts, Radii, Spacing } from '../constants/theme';
import {
  ApiError,
  downloadUrl,
  processPhoto,
  type DateParts,
} from '../services/api';
import type { BatchItem } from './batch';

interface ReviewItem extends BatchItem {
  saveStatus: 'idle' | 'saving' | 'saved' | 'failed';
  saveError?: string;
  /** True once the user has overridden the OCR-detected date. */
  edited: boolean;
}

function partsOf(item: ReviewItem): DateParts | null {
  if (item.year == null || item.month == null || item.day == null) return null;
  return { year: item.year, month: item.month, day: item.day };
}

function isEditable(item: ReviewItem): boolean {
  // Items with no photoId failed at scan time (e.g. network error) and
  // can't be processed — exclude from save-all.
  return !!item.photoId;
}

function isReady(item: ReviewItem): boolean {
  return isEditable(item) && partsOf(item) !== null;
}

function fmtDate(d: DateParts): string {
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${mm}/${dd}/${d.year}`;
}

export default function BatchReviewScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    results: string;
    truncated: string;
    totalRequested: string;
  }>();

  const initial = useMemo<ReviewItem[]>(() => {
    try {
      const parsed = JSON.parse(params.results ?? '[]') as BatchItem[];
      return parsed.map((b) => ({
        ...b,
        saveStatus: 'idle' as const,
        edited: false,
      }));
    } catch {
      return [];
    }
  }, [params.results]);

  const [items, setItems] = useState<ReviewItem[]>(initial);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<DraftDate>({
    month: '',
    day: '',
    year: '',
  });
  const [saving, setSaving] = useState(false);

  const truncated = params.truncated === '1';
  const totalRequested = parseInt(params.totalRequested ?? '0', 10) || items.length;
  const readyCount = items.filter(isReady).length;

  const openEditor = (idx: number) => {
    const item = items[idx];
    setEditingIdx(idx);
    setEditDraft(draftFromParts(partsOf(item)));
  };

  const closeEditor = () => setEditingIdx(null);

  const saveEdit = () => {
    if (editingIdx == null) return;
    const valid = validateDraft(editDraft);
    if (!valid) {
      Alert.alert('Invalid date', 'Please enter a real date between 1950 and 2030.');
      return;
    }
    setItems((prev) =>
      prev.map((it, i) =>
        i === editingIdx
          ? {
              ...it,
              year: valid.year,
              month: valid.month,
              day: valid.day,
              edited: true,
            }
          : it,
      ),
    );
    setEditingIdx(null);
  };

  const saveAll = async () => {
    if (saving || readyCount === 0) return;
    setSaving(true);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    const localUris: string[] = [];
    let savedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!isReady(item)) continue;
      const parts = partsOf(item)!;
      const source: 'auto' | 'manual' =
        item.detected && !item.edited ? 'auto' : 'manual';

      setItems((prev) =>
        prev.map((it, idx) =>
          idx === i ? { ...it, saveStatus: 'saving' } : it,
        ),
      );

      try {
        await processPhoto(item.photoId, parts, source);
        const target = new File(Paths.cache, `${item.photoId}_final.jpg`);
        await File.downloadFileAsync(downloadUrl(item.photoId), target, {
          idempotent: true,
        });
        localUris.push(target.uri);
        savedCount += 1;
        setItems((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, saveStatus: 'saved' } : it,
          ),
        );
      } catch (e) {
        failedCount += 1;
        const msg = e instanceof ApiError ? e.message : 'Save failed';
        setItems((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, saveStatus: 'failed', saveError: msg } : it,
          ),
        );
      }
    }

    setSaving(false);

    if (localUris.length === 0) {
      Alert.alert(
        'Nothing saved',
        failedCount > 0
          ? `All ${failedCount} photos failed to process. Check your connection and try again.`
          : 'No photos were ready to save.',
      );
      return;
    }

    const headline = failedCount
      ? `Saved ${savedCount} · ${failedCount} failed`
      : `${savedCount} photos dated`;
    Alert.alert(headline, 'Where would you like to put them?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Save to Photos',
        onPress: async () => {
          const perm = await MediaLibrary.requestPermissionsAsync();
          if (!perm.granted) {
            Alert.alert('Permission denied', 'We need access to save.');
            return;
          }
          for (const u of localUris) {
            await MediaLibrary.saveToLibraryAsync(u);
          }
          router.replace('/library');
        },
      },
      {
        text: 'Share / Drive',
        onPress: async () => {
          if (!(await Sharing.isAvailableAsync())) return;
          // expo-sharing is single-asset on iOS; share each in turn.
          for (const u of localUris) {
            await Sharing.shareAsync(u, {
              mimeType: 'image/jpeg',
              dialogTitle: 'Save your dated photos',
            });
          }
        },
      },
    ]);
  };

  const closeAll = () => {
    if (saving) return;
    if (items.some((it) => it.saveStatus === 'saved')) {
      router.replace('/library');
      return;
    }
    Alert.alert('Discard scanned photos?', 'They won’t be saved.', [
      { text: 'Keep reviewing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => router.replace('/'),
      },
    ]);
  };

  if (items.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No photos to review</Text>
          <Pressable onPress={() => router.replace('/')} style={styles.secondary}>
            <Text style={styles.secondaryText}>Back home</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable
          onPress={closeAll}
          accessibilityRole="button"
          accessibilityLabel="Close batch review"
          style={styles.close}
        >
          <Text style={styles.closeText}>Close</Text>
        </Pressable>
        <Text style={styles.headline}>
          {items.length} photo{items.length === 1 ? '' : 's'} scanned
        </Text>
        <View style={styles.close} />
      </View>

      {truncated ? (
        <View style={styles.truncatedBanner}>
          <Text style={styles.truncatedText}>
            Stopped at {items.length} of {totalRequested}. Upgrade to scan the
            rest.
          </Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.list}>
        {items.map((item, idx) => (
          <ItemRow
            key={`${item.uri}-${idx}`}
            item={item}
            onTap={() => isEditable(item) && openEditor(idx)}
          />
        ))}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          onPress={saveAll}
          disabled={saving || readyCount === 0}
          accessibilityRole="button"
          accessibilityLabel="Save all dated photos"
          style={({ pressed }) => [
            styles.primary,
            (saving || readyCount === 0) && styles.primaryDisabled,
            pressed && !saving && readyCount > 0 && styles.primaryPressed,
          ]}
        >
          {saving ? (
            <ActivityIndicator color={Colors.bg} />
          ) : (
            <Text style={styles.primaryText}>
              {readyCount === items.length
                ? `Save all ${readyCount} photos`
                : `Save ${readyCount} of ${items.length} photos`}
            </Text>
          )}
        </Pressable>
        {readyCount < items.length ? (
          <Text style={styles.footerHint}>
            Tap any photo missing a date to set one before saving.
          </Text>
        ) : null}
      </View>

      <EditModal
        visible={editingIdx != null}
        draft={editDraft}
        onChange={setEditDraft}
        onCancel={closeEditor}
        onSave={saveEdit}
      />
    </SafeAreaView>
  );
}

function ItemRow({ item, onTap }: { item: ReviewItem; onTap: () => void }) {
  const parts = partsOf(item);
  const status = item.saveStatus;
  const hasError = !!item.error;
  const badgeStyle = hasError
    ? styles.badgeError
    : parts && item.detected && item.confidence >= 0.6
    ? styles.badgeOk
    : styles.badgeMissing;
  const badgeText = hasError
    ? `Failed: ${item.error}`
    : parts
    ? item.detected
      ? `${fmtDate(parts)} · ${Math.round(item.confidence * 100)}%`
      : `${fmtDate(parts)} · manual`
    : 'No date — tap to set';

  return (
    <Pressable
      onPress={onTap}
      accessibilityRole="button"
      accessibilityLabel={
        parts ? `Edit date ${fmtDate(parts)}` : 'Set a date for this photo'
      }
      disabled={hasError}
      style={({ pressed }) => [
        styles.row,
        pressed && !hasError && styles.rowPressed,
      ]}
    >
      <Image source={{ uri: item.uri }} style={styles.thumb} resizeMode="cover" />
      <View style={styles.rowBody}>
        <View style={[styles.badge, badgeStyle]}>
          <Text style={styles.badgeLabel}>{badgeText}</Text>
        </View>
        {!hasError ? (
          <Text style={styles.rowHint}>Tap to edit</Text>
        ) : null}
      </View>
      <View style={styles.rowStatus}>
        {status === 'saving' ? (
          <ActivityIndicator color={Colors.amber} />
        ) : status === 'saved' ? (
          <Text style={styles.statusSaved}>✓</Text>
        ) : status === 'failed' ? (
          <Text style={styles.statusFailed}>!</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

interface EditModalProps {
  visible: boolean;
  draft: DraftDate;
  onChange: (next: DraftDate) => void;
  onCancel: () => void;
  onSave: () => void;
}

function EditModal({ visible, draft, onChange, onCancel, onSave }: EditModalProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.modalBackdrop}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        />
        <View style={styles.modalSheet}>
          <Text style={styles.modalLabel}>CAPTURE DATE</Text>
          <DateInputRow value={draft} onChange={onChange} />
          <View style={styles.modalButtons}>
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              style={styles.modalCancel}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onSave}
              accessibilityRole="button"
              style={styles.modalSave}
            >
              <Text style={styles.modalSaveText}>Save date</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  close: { minWidth: 60, minHeight: 44, justifyContent: 'center' },
  closeText: { color: Colors.textMuted, fontFamily: Fonts.ui, fontSize: 14 },
  headline: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 18,
    flex: 1,
    textAlign: 'center',
  },
  truncatedBanner: {
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.md,
    padding: Spacing.md,
    backgroundColor: Colors.amberSoft,
    borderRadius: Radii.sm,
  },
  truncatedText: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 0.5,
  },
  list: {
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xxl,
    gap: Spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    padding: Spacing.sm,
    gap: Spacing.md,
  },
  rowPressed: { backgroundColor: Colors.bgElevated },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: Radii.sm,
    backgroundColor: Colors.bgElevated,
  },
  rowBody: { flex: 1, gap: Spacing.xs },
  badge: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: Radii.pill,
  },
  badgeOk: { backgroundColor: Colors.sageDeep },
  badgeMissing: { backgroundColor: Colors.amberSoft },
  badgeError: { backgroundColor: '#5A2424' },
  badgeLabel: {
    color: Colors.text,
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  rowHint: {
    color: Colors.textSubtle,
    fontFamily: Fonts.ui,
    fontSize: 11,
  },
  rowStatus: { width: 28, alignItems: 'center' },
  statusSaved: {
    color: Colors.sage,
    fontFamily: Fonts.mono,
    fontSize: 20,
    fontWeight: '600',
  },
  statusFailed: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 20,
    fontWeight: '600',
  },
  footer: {
    padding: Spacing.xl,
    gap: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.surface,
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
  },
  footerHint: {
    color: Colors.textSubtle,
    fontFamily: Fonts.ui,
    fontSize: 12,
    textAlign: 'center',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: Colors.bg,
    padding: Spacing.xl,
    paddingBottom: Spacing.xxl,
    borderTopLeftRadius: Radii.lg,
    borderTopRightRadius: Radii.lg,
    gap: Spacing.md,
  },
  modalLabel: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 3,
  },
  modalButtons: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.sm },
  modalCancel: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    minHeight: 44,
    justifyContent: 'center',
  },
  modalCancelText: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 15,
  },
  modalSave: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: Colors.amber,
    borderRadius: Radii.md,
  },
  modalSaveText: {
    color: Colors.bg,
    fontFamily: Fonts.ui,
    fontSize: 15,
    fontWeight: '600',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
    gap: Spacing.md,
  },
  emptyTitle: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 22,
  },
  secondary: { paddingVertical: 14, minHeight: 44 },
  secondaryText: { color: Colors.textMuted, fontFamily: Fonts.ui, fontSize: 14 },
});
