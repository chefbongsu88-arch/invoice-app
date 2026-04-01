const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.blockList = [
  /node_modules\/react-native-css-interop\/.cache\/.*/,
];

module.exports = config;
