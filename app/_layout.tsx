import "@/global.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import { ThemeProvider } from "@/lib/theme-provider";
import {
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  SafeAreaProvider,
  initialWindowMetrics,
} from "react-native-safe-area-context";
import type { EdgeInsets, Metrics, Rect } from "react-native-safe-area-context";

import {
  applyApiUrlFromAppSettings,
  forceProductionApiBase,
  isValidApiBaseUrl,
  onTrpcClientShouldRecreate,
  requestTrpcClientRecreate,
} from "@/constants/oauth";
import { PRODUCTION_API_ORIGIN } from "@/constants/receipt-api-origin";
import { trpc, createTRPCClient } from "@/lib/trpc";
import { initManusRuntime, subscribeSafeAreaInsets } from "@/lib/_core/manus-runtime";

const APP_SETTINGS_KEY = "app_settings_v1";

function ApiBootstrapErrorScreen({
  providerInitialMetrics,
  hint,
  technicalError,
}: {
  providerInitialMetrics: Metrics;
  hint?: string | null;
  technicalError?: string | null;
}) {
  const [apiUrl, setApiUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(APP_SETTINGS_KEY);
        const parsed = raw ? (JSON.parse(raw) as { apiBaseUrlOverride?: string }) : null;
        if (alive) setApiUrl(parsed?.apiBaseUrlOverride?.trim() ?? "");
      } catch {
        if (alive) setApiUrl("");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const onSaveAndRetry = useCallback(async () => {
    setBusy(true);
    try {
      const raw = await AsyncStorage.getItem(APP_SETTINGS_KEY);
      let base: Record<string, unknown> = {};
      try {
        base = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        base = {};
      }
      const trimmed = apiUrl.trim().replace(/\/$/, "");
      if (trimmed && !isValidApiBaseUrl(trimmed)) {
        Alert.alert(
          "Invalid URL",
          "Use a full address like https://invoice-app-production-18c0.up.railway.app (no … or line breaks).",
          [{ text: "OK" }],
        );
        return;
      }
      const next = { ...base, apiBaseUrlOverride: trimmed || undefined };
      await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(next));
      applyApiUrlFromAppSettings(next as { apiBaseUrlOverride?: string });
      try {
        createTRPCClient();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[ApiBootstrapErrorScreen] createTRPCClient after save", e);
        Alert.alert(
          "Could not connect",
          `Check the URL and try again.\n\nDetails: ${msg}`,
          [{ text: "OK" }],
        );
        return;
      }
      requestTrpcClientRecreate();
    } catch (e) {
      console.error("[ApiBootstrapErrorScreen] save/retry failed", e);
      Alert.alert(
        "Save failed",
        e instanceof Error ? e.message : String(e),
        [{ text: "OK" }],
      );
    } finally {
      setBusy(false);
    }
  }, [apiUrl]);

  /** Light panel; ScrollView + keyboardShouldPersistTaps so the button works while the keyboard is open. */
  return (
    <ThemeProvider>
      <SafeAreaProvider initialMetrics={providerInitialMetrics}>
        <KeyboardAvoidingView
          style={{ flex: 1, backgroundColor: "#e8eaef" }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={Platform.OS === "ios" ? 64 : 0}
        >
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{
              flexGrow: 1,
              justifyContent: "center",
              padding: 24,
              paddingBottom: 48,
            }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
          >
            <Text style={{ textAlign: "center", color: "#1a1a1a", fontSize: 16, lineHeight: 22, marginBottom: 4 }}>
              Enter your API server URL with no trailing slash. Example:{"\n"}
              https://invoice-app-production-18c0.up.railway.app
            </Text>
            <Text
              style={{
                textAlign: "center",
                color: "#b45309",
                fontSize: 13,
                lineHeight: 18,
                marginBottom: 8,
                paddingHorizontal: 8,
              }}
            >
              {hint ??
                "The app could not finish connecting to the API. Enter the URL below or leave it empty to use the default server."}
            </Text>
            {technicalError ? (
              <Text
                selectable
                style={{
                  textAlign: "left",
                  color: "#b91c1c",
                  fontSize: 11,
                  fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                  lineHeight: 15,
                  marginBottom: 10,
                  padding: 10,
                  backgroundColor: "#fef2f2",
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: "#fecaca",
                }}
              >
                {technicalError}
              </Text>
            ) : null}
            <Text style={{ fontSize: 12, color: "#4b5563", marginBottom: 8, textAlign: "center" }}>
              Tip: The line may look cut off with “…” — drag inside the box to scroll, or clear and use the default.
            </Text>
            <TextInput
              value={apiUrl}
              onChangeText={setApiUrl}
              placeholder="Leave empty for default Railway server"
              placeholderTextColor="#6b7280"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={() => {
                Keyboard.dismiss();
              }}
              editable={!busy}
              selectionColor="#2563eb"
              underlineColorAndroid="transparent"
              scrollEnabled
              style={{
                backgroundColor: "#ffffff",
                color: "#111111",
                borderWidth: 2,
                borderColor: "#374151",
                borderRadius: 8,
                padding: 14,
                fontSize: 14,
                marginBottom: 8,
                minHeight: 48,
              }}
            />
            <TouchableOpacity
              disabled={busy}
              onPress={() => setApiUrl("")}
              style={{ alignSelf: "center", marginBottom: 16, paddingVertical: 8, paddingHorizontal: 12 }}
            >
              <Text style={{ color: "#1d4ed8", fontSize: 15, fontWeight: "600" }}>Clear URL (use default server)</Text>
            </TouchableOpacity>
            <View
              style={{
                borderRadius: 10,
                backgroundColor: busy ? "#64748b" : "#1d4ed8",
                minHeight: 54,
                overflow: "hidden",
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.12,
                shadowRadius: 2,
                elevation: 2,
              }}
            >
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                activeOpacity={0.88}
                disabled={busy}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => {
                  Keyboard.dismiss();
                  void onSaveAndRetry();
                }}
                style={{
                  minHeight: 54,
                  paddingVertical: 16,
                  paddingHorizontal: 20,
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <Text style={{ color: "#ffffff", textAlign: "center", fontWeight: "700", fontSize: 16 }}>
                  {busy ? "Saving…" : "Save and reconnect"}
                </Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaProvider>
    </ThemeProvider>
  );
}

const DEFAULT_WEB_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const DEFAULT_WEB_FRAME: Rect = { x: 0, y: 0, width: 0, height: 0 };

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  const initialInsets = initialWindowMetrics?.insets ?? DEFAULT_WEB_INSETS;
  const initialFrame = initialWindowMetrics?.frame ?? DEFAULT_WEB_FRAME;

  const [insets, setInsets] = useState<EdgeInsets>(initialInsets);
  const [frame, setFrame] = useState<Rect>(initialFrame);

  // Initialize Manus runtime for cookie injection from parent container
  useEffect(() => {
    initManusRuntime();
  }, []);

  useEffect(() => {
    WebBrowser.maybeCompleteAuthSession();
  }, []);

  const handleSafeAreaUpdate = useCallback((metrics: Metrics) => {
    setInsets(metrics.insets);
    setFrame(metrics.frame);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const unsubscribe = subscribeSafeAreaInsets(handleSafeAreaUpdate);
    return () => unsubscribe();
  }, [handleSafeAreaUpdate]);

  // Create clients once and reuse them
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Disable automatic refetching on window focus for mobile
            refetchOnWindowFocus: false,
            // Retry failed requests once
            retry: 1,
          },
        },
      }),
  );
  type TrpcBootstrap = {
    client: ReturnType<typeof createTRPCClient> | null;
    /** Set only when synchronous native create throws — always show on Save screen. */
    syncInitErr: string | null;
  };

  const trpcClientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null);
  /** Synchronous create on native (first paint) avoids effect-order races that left trpcClient null forever. */
  const [bootstrapTrpc, setBootstrapTrpc] = useState<TrpcBootstrap>(() => {
    if (Platform.OS === "web") return { client: null, syncInitErr: null };
    try {
      const c = createTRPCClient({ pinnedBase: PRODUCTION_API_ORIGIN });
      trpcClientRef.current = c;
      return { client: c, syncInitErr: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error && e.stack ? `\n${e.stack.split("\n").slice(0, 10).join("\n")}` : "";
      console.error("[RootLayout] synchronous pinned tRPC create failed", e);
      return { client: null, syncInitErr: `${msg}${stack}` };
    }
  });
  const trpcClient = bootstrapTrpc.client;

  const [apiBootstrapDone, setApiBootstrapDone] = useState(false);
  const [bootstrapErrorHint, setBootstrapErrorHint] = useState<string | null>(null);
  /** Shown in red on Save screen — actual exception from createTRPCClient (for support / debugging). */
  const [nativeInitTechnicalError, setNativeInitTechnicalError] = useState<string | null>(null);

  const setTrpcClient = useCallback((c: ReturnType<typeof createTRPCClient> | null) => {
    setBootstrapTrpc((prev) => ({
      client: c,
      syncInitErr: c ? null : prev.syncInitErr,
    }));
    if (c) trpcClientRef.current = c;
  }, []);

  /**
   * Keep ref in sync with state, but never overwrite a non-null ref with stale `null` from the first
   * render (layout #1 sets ref + setState; this effect used to run in the same commit with null state
   * and cleared the ref before the re-render — breaking bootstrap's `else if (trpcClientRef.current)`).
   */
  useLayoutEffect(() => {
    if (trpcClient != null) {
      trpcClientRef.current = trpcClient;
    }
  }, [trpcClient]);

  const replaceTrpcClient = useCallback(() => {
    const apply = (c: ReturnType<typeof createTRPCClient>) => {
      trpcClientRef.current = c;
      setBootstrapTrpc({ client: c, syncInitErr: null });
      setApiBootstrapDone(true);
      setBootstrapErrorHint(null);
      setNativeInitTechnicalError(null);
    };
    try {
      apply(createTRPCClient());
    } catch (e) {
      console.error("[RootLayout] createTRPCClient failed, trying pinned production URL", e);
      try {
        apply(createTRPCClient({ pinnedBase: PRODUCTION_API_ORIGIN }));
      } catch (e2) {
        console.error("[RootLayout] pinned createTRPCClient also failed", e2);
      }
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      type Stored = Record<string, unknown> & { apiBaseUrlOverride?: unknown };
      let parsed: Stored | null = null;
      try {
        const raw = await AsyncStorage.getItem(APP_SETTINGS_KEY);
        if (raw) {
          try {
            parsed = JSON.parse(raw) as Stored;
          } catch {
            parsed = null;
          }
        }
        if (parsed && typeof parsed.apiBaseUrlOverride === "string") {
          const ov = parsed.apiBaseUrlOverride.trim();
          if (ov && !isValidApiBaseUrl(ov)) {
            const rest = { ...parsed };
            delete rest.apiBaseUrlOverride;
            await AsyncStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(rest));
            parsed = rest as Stored;
            console.warn("[RootLayout] Removed invalid apiBaseUrlOverride from storage");
          }
        }
        applyApiUrlFromAppSettings(parsed);
      } catch (e) {
        console.error("[RootLayout] Failed to read app settings", e);
        applyApiUrlFromAppSettings(null);
      }
      if (!alive) return;

      const tryOnce = (): {
        client: ReturnType<typeof createTRPCClient> | null;
        err?: string;
      } => {
        try {
          return { client: createTRPCClient() };
        } catch (e) {
          console.error("[RootLayout] createTRPCClient during bootstrap", e);
          return { client: null, err: e instanceof Error ? e.message : String(e) };
        }
      };

      const first = tryOnce();
      let c = first.client;
      let errMsg = first.err;
      if (!c) {
        applyApiUrlFromAppSettings(null);
        const second = tryOnce();
        c = second.client;
        errMsg = second.err ?? errMsg;
      }
      if (!c) {
        forceProductionApiBase();
        const third = tryOnce();
        c = third.client;
        errMsg = third.err ?? errMsg;
      }
      if (!c) {
        try {
          c = createTRPCClient({ pinnedBase: PRODUCTION_API_ORIGIN });
          errMsg = undefined;
        } catch (e) {
          errMsg = e instanceof Error ? e.message : String(e);
        }
      }
      if (c) {
        trpcClientRef.current = c;
        setTrpcClient(c);
        setBootstrapErrorHint(null);
        setNativeInitTechnicalError(null);
      } else if (trpcClientRef.current) {
        setBootstrapErrorHint(
          errMsg
            ? `Using previous connection. Latest error: ${errMsg}`
            : "Using previous connection; settings could not be applied yet.",
        );
      } else {
        setBootstrapErrorHint(
          errMsg
            ? `API client error: ${errMsg}`
            : "Could not create API client. Enter the full Railway URL below (no … at the end).",
        );
        if (errMsg) {
          setNativeInitTechnicalError((prev) => prev ?? errMsg);
        }
      }
      if (alive) setApiBootstrapDone(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** One-shot: if bootstrap finished without a client (race or ref bug), retry pinned URL once on native. */
  const trpcRecoveryTriedRef = useRef(false);
  useEffect(() => {
    if (Platform.OS === "web" || !apiBootstrapDone || trpcClient != null || trpcRecoveryTriedRef.current) {
      return;
    }
    trpcRecoveryTriedRef.current = true;
    try {
      const c = createTRPCClient({ pinnedBase: PRODUCTION_API_ORIGIN });
      trpcClientRef.current = c;
      setBootstrapTrpc({ client: c, syncInitErr: null });
      setBootstrapErrorHint(null);
      setNativeInitTechnicalError(null);
    } catch (e) {
      console.error("[RootLayout] recovery createTRPCClient (pinned) failed", e);
    }
  }, [apiBootstrapDone, trpcClient]);

  useEffect(() => {
    return onTrpcClientShouldRecreate(replaceTrpcClient);
  }, [replaceTrpcClient]);

  /** Use device metrics as-is — inflating bottom inset here doubled with BottomTabBar + tabBarStyle and caused a gap under the tab bar. */
  const providerInitialMetrics = useMemo(() => {
    return initialWindowMetrics ?? { insets: initialInsets, frame: initialFrame };
  }, [initialInsets, initialFrame]);

  const loadingShell = (
    <ThemeProvider>
      <SafeAreaProvider initialMetrics={providerInitialMetrics}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" />
        </View>
      </SafeAreaProvider>
    </ThemeProvider>
  );

  if (!apiBootstrapDone) {
    return loadingShell;
  }
  if (!trpcClient) {
    return (
      <ApiBootstrapErrorScreen
        providerInitialMetrics={providerInitialMetrics}
        hint={bootstrapErrorHint}
        technicalError={nativeInitTechnicalError ?? bootstrapTrpc.syncInitErr}
      />
    );
  }

  const content = (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          {/* Default to hiding native headers so raw route segments don't appear (e.g. "(tabs)", "products/[id]"). */}
          {/* If a screen needs the native header, explicitly enable it and set a human title via Stack.Screen options. */}
          {/* in order for ios apps tab switching to work properly, use presentation: "fullScreenModal" for login page, whenever you decide to use presentation: "modal*/}
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="gmail-auth" />
            <Stack.Screen name="edit-invoice/[id]" />
            <Stack.Screen name="oauth/callback" />
          </Stack>
          <StatusBar style="auto" />
        </QueryClientProvider>
      </trpc.Provider>
    </GestureHandlerRootView>
  );

  const shouldOverrideSafeArea = Platform.OS === "web";

  if (shouldOverrideSafeArea) {
    return (
      <ThemeProvider>
        <SafeAreaProvider initialMetrics={providerInitialMetrics}>
          <SafeAreaFrameContext.Provider value={frame}>
            <SafeAreaInsetsContext.Provider value={insets}>
              {content}
            </SafeAreaInsetsContext.Provider>
          </SafeAreaFrameContext.Provider>
        </SafeAreaProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <SafeAreaProvider initialMetrics={providerInitialMetrics}>{content}</SafeAreaProvider>
    </ThemeProvider>
  );
}
