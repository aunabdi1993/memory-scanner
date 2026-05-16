import { Text, View } from 'react-native';

import { Colors } from '../constants/theme';

// Placeholder scan screen. Real implementation lands in PR 8.
export default function ScanScreen() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: Colors.text }}>Scan</Text>
    </View>
  );
}
