const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

// Use path.resolve to guarantee an absolute, symlink-free projectRoot.
// In CI environments (Railway) where pnpm may use symlinked node_modules,
// Metro must see the real absolute path or it throws "file is not watched".
const projectRoot = path.resolve(__dirname);
const config = getDefaultConfig(projectRoot);

// react-native-css-interop (NativeWind) writes generated CSS to
// node_modules/react-native-css-interop/.cache/web.css at build time.
// On Railway/Linux, Watchman respects .gitignore which had a global ".cache/"
// rule that excluded every .cache directory, making that file invisible to
// Metro ("file is not watched" / DependencyGraph.getOrComputeSha1).
// Explicitly adding it to watchFolders forces Metro to track it regardless.
config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.join(projectRoot, "node_modules", "react-native-css-interop", ".cache"),
];

module.exports = withNativeWind(config, {
  input: "./global.css",
  // Force write CSS to file system instead of virtual modules
  // This fixes iOS styling issues in development mode
  forceWriteFileSystem: true,
});
