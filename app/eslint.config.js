// Flat-config ESLint setup. expo/flat brings RN + a11y + react-hooks
// rules calibrated for the Expo bundle; we narrow the file scope and
// downgrade exhaustive-deps to warn so refactors aren't blocked.
const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  ...expoConfig,
  {
    ignores: ['node_modules/**', '.expo/**', 'dist/**', 'babel.config.js'],
  },
  {
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
      // TypeScript already flags unused locals via tsc --noEmit; the
      // base rule misfires on constructor-parameter properties and
      // interface method signatures.
      'no-unused-vars': 'off',
    },
  },
];
