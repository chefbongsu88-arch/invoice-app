const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.blockList = [
  /node_modules\/react-native-css-interop\/.cache\/.*/,
];

// Scoped packages + pnpm hoists: point Metro at the real folder if resolution fails.
const googleSignInPkg = path.resolve(
  __dirname,
  'node_modules/@react-native-google-signin/google-signin',
);
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@react-native-google-signin/google-signin': googleSignInPkg,
};

module.exports = config;
