import { Platform } from 'react-native';

/**
 * Vintage film aesthetic. Warm dark backgrounds, amber accent for the
 * date stamps, sage green for success, all sourced from cleaned-up
 * Kodak Gold mood-board values.
 */
export const Colors = {
  bg: '#0F0E0C',
  bgElevated: '#1A1815',
  surface: '#23201B',
  border: '#3A352D',
  divider: '#5A4F3F',

  text: '#F2EAD9',
  textMuted: '#A89B83',
  textSubtle: '#6E6452',

  amber: '#E5A24A',
  amberDeep: '#B97A24',
  amberSoft: '#3A2A14',

  sage: '#7AA886',
  sageDeep: '#4F8060',

  red: '#D26B5A',

  filmHole: '#1F1C16',
  filmEdge: '#2A251D',
} as const;

export const Fonts = {
  /** UI body / labels. */
  ui: Platform.select({
    ios: 'System',
    android: 'Roboto',
    default: 'System',
  }) as string,
  /** Headlines + titles. */
  display: Platform.select({
    ios: 'Georgia',
    android: 'serif',
    default: 'Georgia',
  }) as string,
  /** Date stamp + technical readouts. */
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'Menlo',
  }) as string,
} as const;

export const Radii = {
  sm: 6,
  md: 12,
  lg: 18,
  pill: 999,
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;
