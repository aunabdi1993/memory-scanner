import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Fonts, Radii, Spacing } from '../constants/theme';
import { captureException } from '../services/sentry';

interface State {
  error: Error | null;
}

/**
 * Top-level catch-all so an unhandled render error renders a recovery
 * screen instead of a white blank. Wrapped around the navigator in
 * _layout.tsx.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (__DEV__) console.error('App error:', error, info.componentStack);
    captureException(error, { componentStack: info.componentStack });
  }

  reset = () => this.setState({ error: null });

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.root}>
        <Text style={styles.eyebrow}>SOMETHING WENT WRONG</Text>
        <Text style={styles.title}>The film jammed.</Text>
        <Text style={styles.body}>{this.state.error.message}</Text>
        <Pressable
          onPress={this.reset}
          accessibilityRole="button"
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
        >
          <Text style={styles.btnText}>Restart</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
    gap: Spacing.md,
  },
  eyebrow: {
    color: Colors.amber,
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 3,
  },
  title: {
    color: Colors.text,
    fontFamily: Fonts.display,
    fontSize: 28,
  },
  body: {
    color: Colors.textMuted,
    fontFamily: Fonts.ui,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: Spacing.lg,
  },
  btn: {
    backgroundColor: Colors.amber,
    paddingVertical: 14,
    paddingHorizontal: Spacing.xl,
    borderRadius: Radii.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  btnPressed: { backgroundColor: Colors.amberDeep },
  btnText: {
    color: Colors.bg,
    fontFamily: Fonts.ui,
    fontSize: 15,
    fontWeight: '600',
  },
});
