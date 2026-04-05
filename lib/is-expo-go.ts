import Constants from "expo-constants";

/**
 * Expo Go does not ship custom native modules (e.g. RNGoogleSignin).
 * Use browser OAuth or a development/production build with native code.
 */
export function isExpoGo(): boolean {
  return Constants.executionEnvironment === "storeClient";
}
