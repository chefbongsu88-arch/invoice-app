import { Redirect } from "expo-router";

/** Unknown paths (including empty custom-scheme URLs) → home instead of a dead-end screen. */
export default function NotFoundScreen() {
  return <Redirect href="/(tabs)" />;
}
