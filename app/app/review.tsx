import { Text, View } from 'react-native';

import { Colors } from '../constants/theme';

// Placeholder review screen. Real implementation lands in PR 9.
export default function ReviewScreen() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: Colors.text }}>Review</Text>
    </View>
  );
}
