import { Text, View } from 'react-native';

import { Colors } from '../constants/theme';

// Placeholder library screen. Real implementation lands in PR 10.
export default function LibraryScreen() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: Colors.text }}>Library</Text>
    </View>
  );
}
