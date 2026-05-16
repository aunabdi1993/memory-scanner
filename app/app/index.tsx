import { Text, View } from 'react-native';

import { Colors } from '../constants/theme';

// Placeholder home screen. Real implementation lands in PR 7.
export default function HomeScreen() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: Colors.text }}>Memories Scanner</Text>
    </View>
  );
}
