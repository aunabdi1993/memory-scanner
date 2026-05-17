import { format } from 'date-fns';
import { File, Paths } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Fonts, Radii, Spacing } from '../constants/theme';
import {
  ApiError,
  deletePhoto,
  downloadUrl,
  listPhotos,
  type PhotoSummary,
} from '../services/api';

interface CardProps {
  photo: PhotoSummary;
  busy: boolean;
  onSave: (p: PhotoSummary) => void;
  onShare: (p: PhotoSummary) => void;
  onDelete: (p: PhotoSummary) => void;
}

function PhotoCard({ photo, busy, onSave, onShare, onDelete }: CardProps) {
  const ts = new Date(photo.processed_at ?? photo.created_at);
  return (
    <Pressable
      onLongPress={() => onDelete(photo)}
      delayLongPress={400}
      accessibilityRole="button"
      accessibilityLabel="Photo card. Long-press to delete."
      style={styles.card}
    >
      <View style={styles.perforation}>
        {Array.from({ length: 6 }).map((_, i) => (
          <View key={i} style={styles.perfHole} />
        ))}
      </View>

      <View style={styles.cardBody}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardId}>{photo.photo_id.slice(0, 8)}</Text>
          <View style={styles.okBadge}>
            <Text style={styles.okBadgeText}>✓ DATED</Text>
          </View>
        </View>
        <Text style={styles.cardFilename} numberOfLines={1}>
          {photo.filename}
        </Text>
        <Text style={styles.cardMeta}>
          {photo.size_kb} KB · {format(ts, 'MMM d, yyyy · h:mm a')}
        </Text>

        <View style={styles.actions}>
          <Pressable
            onPress={() => onSave(photo)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Save to Photos"
            style={({ pressed }) => [
              styles.actionBtn,
              pressed && styles.actionBtnPressed,
            ]}
          >
            {busy ? (
              <ActivityIndicator color={Colors.amber} size="small" />
            ) : (
              <Text style={styles.actionText}>Save to Photos</Text>
            )}
          </Pressable>
          <Pressable
            onPress={() => onShare(photo)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Share"
            style={({ pressed }) => [
              styles.actionBtn,
              styles.actionBtnGhost,
              pressed && styles.actionBtnPressed,
            ]}
          >
            <Text style={[styles.actionText, styles.actionTextGhost]}>
              Share ↗
            </Text>
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

function EmptyState() {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyEmoji}>🎞</Text>
      <Text style={styles.emptyTitle}>No scans yet</Text>
      <Text style={styles.emptyBody}>
        Tap Scan a photo on the home screen to get started.
      </Text>
    </View>
  );
}

export default function LibraryScreen() {
  const router = useRouter();
  const [items, setItems] = useState<PhotoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await listPhotos();
      setItems(res.photos);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed to load library';
      Alert.alert('Library error', msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    MediaLibrary.requestPermissionsAsync();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    Haptics.selectionAsync();
    load();
  };

  const downloadToCache = async (p: PhotoSummary): Promise<string> => {
    const target = new File(Paths.cache, p.filename);
    await File.downloadFileAsync(downloadUrl(p.photo_id), target, {
      idempotent: true,
    });
    return target.uri;
  };

  const onSave = async (p: PhotoSummary) => {
    setBusyId(p.photo_id);
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission denied', 'We need access to save.');
        return;
      }
      const uri = await downloadToCache(p);
      await MediaLibrary.saveToLibraryAsync(uri);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Saved', `${p.filename} added to your Photos library.`);
    } catch (e) {
      Alert.alert('Save failed', String(e));
    } finally {
      setBusyId(null);
    }
  };

  const onShare = async (p: PhotoSummary) => {
    setBusyId(p.photo_id);
    try {
      const uri = await downloadToCache(p);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'image/jpeg',
          dialogTitle: 'Share dated photo',
        });
      }
    } catch (e) {
      Alert.alert('Share failed', String(e));
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = (p: PhotoSummary) => {
    Alert.alert(
      'Delete scan?',
      `${p.filename} will be removed from the server.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBusyId(p.photo_id);
            try {
              await deletePhoto(p.photo_id);
              await Haptics.notificationAsync(
                Haptics.NotificationFeedbackType.Success,
              );
              setItems((prev) => prev.filter((x) => x.photo_id !== p.photo_id));
            } catch (e) {
              const msg = e instanceof ApiError ? e.message : String(e);
              Alert.alert('Delete failed', msg);
            } finally {
              setBusyId(null);
            }
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          style={styles.back}
        >
          <Text style={styles.backText}>← Back</Text>
        </Pressable>
        <Text style={styles.title}>Library</Text>
        <Text style={styles.count}>
          {items.length} {items.length === 1 ? 'scan' : 'scans'}
        </Text>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={Colors.amber} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(p) => p.photo_id}
          renderItem={({ item }) => (
            <PhotoCard
              photo={item}
              busy={busyId === item.photo_id}
              onSave={onSave}
              onShare={onShare}
              onDelete={onDelete}
            />
          )}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: Spacing.md }} />}
          ListEmptyComponent={EmptyState}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors.amber}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
  },
  back: { minHeight: 44, justifyContent: 'center' },
  backText: { color: Colors.textMuted, fontFamily: Fonts.ui, fontSize: 14 },
  title: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 32,
    marginTop: Spacing.sm,
  },
  count: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 2,
    marginTop: Spacing.xs,
  },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.xl, flexGrow: 1 },
  card: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderRadius: Radii.md,
    overflow: 'hidden',
    minHeight: 110,
  },
  perforation: {
    width: 18,
    backgroundColor: Colors.filmEdge,
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingVertical: Spacing.sm,
  },
  perfHole: {
    width: 8,
    height: 10,
    backgroundColor: Colors.filmHole,
    borderRadius: 1,
  },
  cardBody: { flex: 1, padding: Spacing.md, gap: 4 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardId: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 14,
    letterSpacing: 1,
  },
  okBadge: {
    backgroundColor: Colors.sageDeep,
    borderRadius: Radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  okBadgeText: {
    color: Colors.text,
    fontFamily: Fonts.mono,
    fontSize: 9,
    letterSpacing: 1,
  },
  cardFilename: {
    color: Colors.text,
    fontFamily: Fonts.ui,
    fontSize: 14,
    marginTop: 2,
  },
  cardMeta: {
    color: Colors.textSubtle,
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: Colors.amber,
    paddingVertical: 10,
    borderRadius: Radii.sm,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  actionBtnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: Colors.divider,
  },
  actionBtnPressed: { opacity: 0.7 },
  actionText: {
    color: Colors.bg,
    fontFamily: Fonts.ui,
    fontSize: 13,
    fontWeight: '600',
  },
  actionTextGhost: { color: Colors.textMuted },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
    gap: Spacing.md,
  },
  emptyEmoji: { fontSize: 48 },
  emptyTitle: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 22,
  },
  emptyBody: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 14,
    textAlign: 'center',
  },
});
