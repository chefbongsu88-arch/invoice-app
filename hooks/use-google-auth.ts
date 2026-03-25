import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useState } from "react";

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_TOKENS_KEY = "google_oauth_tokens";

interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
}

// Google OAuth scopes needed
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
].join(" ");

export function useGoogleAuth() {
  const [tokens, setTokens] = useState<GoogleTokens | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(GOOGLE_TOKENS_KEY).then((raw) => {
      if (raw) {
        const parsed = JSON.parse(raw) as GoogleTokens;
        // Check if token is still valid (with 5 min buffer)
        if (parsed.expiresAt > Date.now() + 5 * 60 * 1000) {
          setTokens(parsed);
        } else {
          // Token expired, clear it
          AsyncStorage.removeItem(GOOGLE_TOKENS_KEY);
        }
      }
      setLoading(false);
    });
  }, []);

  const saveTokens = useCallback(async (t: GoogleTokens) => {
    await AsyncStorage.setItem(GOOGLE_TOKENS_KEY, JSON.stringify(t));
    setTokens(t);
  }, []);

  const disconnect = useCallback(async () => {
    await AsyncStorage.removeItem(GOOGLE_TOKENS_KEY);
    setTokens(null);
  }, []);

  const isConnected = tokens !== null && tokens.expiresAt > Date.now();

  return {
    tokens,
    isConnected,
    loading,
    error,
    setError,
    saveTokens,
    disconnect,
    accessToken: tokens?.accessToken ?? null,
  };
}
