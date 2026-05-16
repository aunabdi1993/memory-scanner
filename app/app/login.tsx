import * as AppleAuthentication from 'expo-apple-authentication';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '../contexts/AuthContext';
import { Colors, Fonts, Spacing } from '../constants/theme';

export default function LoginScreen() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    AppleAuthentication.isAvailableAsync().then(setAvailable);
  }, []);

  const onAppleButton = async () => {
    try {
      await signIn();
      router.replace('/');
    } catch (e: unknown) {
      const code = (e as { code?: string } | null)?.code;
      if (code === 'ERR_REQUEST_CANCELED') return;
      Alert.alert('Sign-in failed', String((e as Error)?.message ?? e));
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <View style={styles.root}>
        <View style={styles.body}>
          <Text style={styles.eyebrow}>SCAN. DATE. RESTORE.</Text>
          <Text style={styles.title}>
            Old prints,{'\n'}
            <Text style={styles.titleAccent}>time-stamped.</Text>
          </Text>
          <View style={styles.divider} />
          <Text style={styles.subtitle}>
            Point your camera at any printed photo. We read the date off
            the print, write it into the file's metadata, and save it back
            to Photos, iCloud, or Drive.
          </Text>
        </View>

        <View style={styles.actionWrap}>
          {available === false ? (
            <Text style={styles.notice}>
              Sign in with Apple is only available on iOS devices. Run this app
              on an iPhone or iPad to continue.
            </Text>
          ) : available === true ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={
                AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
              }
              buttonStyle={
                AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
              }
              cornerRadius={12}
              style={styles.appleButton}
              onPress={onAppleButton}
            />
          ) : null}
          <Text style={styles.fineprint}>
            Apple shares only your name and a verified email (or a private
            relay address). Nothing else is sent to us.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  root: { flex: 1, justifyContent: 'space-between', padding: Spacing.xl },
  body: { flex: 1, justifyContent: 'center' },
  eyebrow: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 3,
    marginBottom: Spacing.md,
  },
  title: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 42,
    lineHeight: 48,
  },
  titleAccent: { color: Colors.amber, fontStyle: 'italic' },
  divider: {
    height: 2,
    width: 56,
    backgroundColor: Colors.amber,
    marginVertical: Spacing.lg,
  },
  subtitle: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 15,
    lineHeight: 22,
  },
  actionWrap: { gap: Spacing.md },
  appleButton: { height: 52, width: '100%' },
  fineprint: {
    color: Colors.textSubtle,
    fontFamily: Fonts.ui,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  notice: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    backgroundColor: Colors.surface,
    padding: Spacing.md,
    borderRadius: 12,
  },
});
