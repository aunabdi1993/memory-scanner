module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // expo-router uses this to resolve the entry file
      require.resolve('expo-router/babel'),
      // react-native-reanimated must be listed last
      'react-native-reanimated/plugin',
    ],
  };
};
