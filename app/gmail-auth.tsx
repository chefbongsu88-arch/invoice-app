import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { persistGmailOAuthFromParsed } from "@/lib/gmail-oauth";

/**
 * Handles `scheme://gmail-auth?token=…` so Expo Router has a real route (not +not-found)
 * when the server bounce page redirects after Google OAuth.
 */
export default function GmailAuthDeepLinkScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();

  useEffect(() => {
    const raw = params as Record<string, string | string[] | undefined>;
    const get = (k: string) => {
      const v = raw[k];
      if (Array.isArray(v)) return v[0];
      return v;
    };
    const token = get("token");
    const email = get("email");
    const error = get("error");

    let cancelled = false;
    (async () => {
      try {
        WebBrowser.maybeCompleteAuthSession();
        const result = await persistGmailOAuthFromParsed({ token, email, error });
        if (error) {
          Alert.alert("Gmail sign-in", error);
        } else if (result.ok) {
          try {
            WebBrowser.dismissAuthSession();
          } catch {
            /* noop */
          }
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch (e) {
        console.error("[gmail-auth] persist failed", e);
        Alert.alert("Gmail sign-in", "Could not save the connection. Try again.");
      } finally {
        if (!cancelled) {
          router.replace("/(tabs)/gmail");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, router]);

  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 12, padding: 24 }}>
      <ActivityIndicator size="large" />
      <Text style={{ fontSize: 15, color: "#666", textAlign: "center" }}>Finishing Gmail sign-in…</Text>
    </View>
  );
}
