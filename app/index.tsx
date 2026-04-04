import { Redirect } from "expo-router";

/** Bare deep links (e.g. scheme:///) and `/` should land on the main tabs. */
export default function RootIndex() {
  return <Redirect href="/(tabs)" />;
}
