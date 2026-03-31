const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

// Use path.resolve to guarantee an absolute, symlink-free projectRoot.
// In CI environments (Railway) where pnpm may use symlinked node_modules,
// Metro must see the real absolute path or it throws "file is not watched".
const projectRoot = path.resolve(__dirname);
const config = getDefaultConfig(projectRoot);

module.exports = withNativeWind(config, {
  input: "./global.css",
  // Force write CSS to file system instead of virtual modules
  // This fixes iOS styling issues in development mode
  forceWriteFileSystem: true,
});
