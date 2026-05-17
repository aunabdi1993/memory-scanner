import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Colors, Fonts, Radii, Spacing } from '../constants/theme';
import type { DateParts } from '../services/api';

export interface DraftDate {
  month: string;
  day: string;
  year: string;
}

/**
 * MM/DD/YYYY input triplet, shared between the single-photo review
 * screen and the batch-review edit sheet. Validation rules match
 * backend/main.py's DateInput model (year 1950–2030, valid calendar
 * date — Feb 30 rejected).
 */
export function validateDraft(d: DraftDate): DateParts | null {
  const m = parseInt(d.month, 10);
  const day = parseInt(d.day, 10);
  const y = parseInt(d.year, 10);
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  if (!Number.isFinite(y) || y < 1950 || y > 2030) return null;
  const probe = new Date(y, m - 1, day);
  if (probe.getMonth() !== m - 1 || probe.getDate() !== day) return null;
  return { year: y, month: m, day };
}

export function draftFromParts(parts: DateParts | null): DraftDate {
  if (!parts) return { month: '', day: '', year: '' };
  return {
    month: String(parts.month),
    day: String(parts.day),
    year: String(parts.year),
  };
}

interface DateInputRowProps {
  value: DraftDate;
  onChange: (next: DraftDate) => void;
}

export function DateInputRow({ value, onChange }: DateInputRowProps) {
  return (
    <View style={styles.row}>
      <TextInput
        value={value.month}
        onChangeText={(t) =>
          onChange({ ...value, month: t.replace(/\D/g, '').slice(0, 2) })
        }
        placeholder="MM"
        placeholderTextColor={Colors.textSubtle}
        keyboardType="number-pad"
        maxLength={2}
        style={styles.input}
        accessibilityLabel="Month"
      />
      <Text style={styles.sep}>/</Text>
      <TextInput
        value={value.day}
        onChangeText={(t) =>
          onChange({ ...value, day: t.replace(/\D/g, '').slice(0, 2) })
        }
        placeholder="DD"
        placeholderTextColor={Colors.textSubtle}
        keyboardType="number-pad"
        maxLength={2}
        style={styles.input}
        accessibilityLabel="Day"
      />
      <Text style={styles.sep}>/</Text>
      <TextInput
        value={value.year}
        onChangeText={(t) =>
          onChange({ ...value, year: t.replace(/\D/g, '').slice(0, 4) })
        }
        placeholder="YYYY"
        placeholderTextColor={Colors.textSubtle}
        keyboardType="number-pad"
        maxLength={4}
        style={[styles.input, styles.inputYear]}
        accessibilityLabel="Year"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  input: {
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
  inputYear: { flex: 1.4 },
  sep: { color: Colors.textSubtle, fontSize: 22, fontFamily: Fonts.mono },
});
