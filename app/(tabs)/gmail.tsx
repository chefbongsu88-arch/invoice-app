import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useInvoices } from "@/hooks/use-invoices";
import type { Invoice, InvoiceCategory } from "@/shared/invoice-types";
import { trpc } from "@/lib/trpc";
import { getApiBaseUrl } from "@/constants/oauth";
import { PRODUCTION_API_ORIGIN } from "@/constants/receipt-api-origin";
import { coerceInvoiceDateIsoForStorage, displayInvoiceNumber } from "@/lib/invoice-display";
import { getSheetsExportTarget } from "@/lib/sheets-settings";
import { DEFAULT_MAIN_TRACKER_SHEET_NAME } from "@/shared/sheets-defaults";
import {
  GMAIL_EMAIL_KEY,
  GMAIL_OAUTH_RETURN_HOST,
  GMAIL_TOKEN_KEY,
  getGmailOAuthRedirectBaseUrl,
  parseGmailAuthReturnUrl,
  persistGmailOAuthFromParsed,
} from "@/lib/gmail-oauth";
import {
  NATIVE_GOOGLE_SIGNIN_UNAVAILABLE,
  configureGoogleSignInForGmail,
  isGoogleSignInCancelled,
  signInWithGoogleForGmailAndSheets,
  signOutGoogleNative,
} from "@/lib/google-native-sign-in";
import { isExpoGo } from "@/lib/is-expo-go";

const SETTINGS_KEY = "app_settings_v1";

async function mergeAppSettingsPatch(patch: Record<string, unknown>): Promise<void> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  const cur = raw ? JSON.parse(raw) : {};
  const next = {
    spreadsheetId: "",
    sheetName: DEFAULT_MAIN_TRACKER_SHEET_NAME,
    autoSaveGmailEmails: false,
    autoExportToSheets: false,
    ...cur,
    ...patch,
  };
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
}

const WEB_GOOGLE_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ??
  "614052249025-n9uf9hirmtop9phdl1bjsdod8d6sfhg2.apps.googleusercontent.com";
const IOS_GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? "";
const GMAIL_FETCH_PAGE_SIZE = 10;

function getNativeAppScheme(): string {
  const s = Constants.expoConfig?.scheme;
  if (typeof s === "string" && s.length > 0) return s;
  if (Array.isArray(s) && typeof s[0] === "string") return s[0];
  return "manus20260325194257";
}

function encodeGmailOAuthState(scheme: string, redirectUri: string): string {
  const json = JSON.stringify({ v: 1, scheme, redirectUri });
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(json);
  }
  const Buf = (globalThis as unknown as { Buffer?: { from: (s: string, e: string) => { toString: (e: string) => string } } }).Buffer;
  if (Buf) return Buf.from(json, "utf-8").toString("base64");
  return json;
}

interface EmailMessage {
  id: string;
  subject: string;
  from: string;
  date: string;
  internalDate?: string;
  bodyText: string;
  snippet: string;
  parsed?: boolean;
  parsedData?: {
    invoiceNumber: string;
    vendor: string;
    date: string;
    totalAmount: number;
    ivaAmount: number;
    category: string;
  };
}

function normalizeApiHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function LoginCard({
  onLogin,
  apiBase,
  oauthRedirectBase,
}: {
  onLogin: () => void;
  apiBase: string;
  /** Web only — native iOS/Android use system Google Sign-In (no Railway redirect page). */
  oauthRedirectBase: string | null;
}) {
  const colors = useColors();
  const hostMismatch =
    normalizeApiHost(apiBase) !== normalizeApiHost(PRODUCTION_API_ORIGIN);
  const oauthDiffers =
    oauthRedirectBase != null && normalizeApiHost(oauthRedirectBase) !== normalizeApiHost(apiBase);
  return (
    <View style={styles.connectCard}>
      <View style={[styles.connectIcon, { backgroundColor: colors.email + "15" }]}>
        <IconSymbol name="envelope.fill" size={48} color={colors.email} />
      </View>
      <Text style={[styles.connectTitle, { color: colors.foreground }]}>Gmail Integration</Text>
      <Text style={[styles.connectDesc, { color: colors.muted }]}>
        Sign in with your Google account to automatically fetch and parse invoice emails from your inbox.
      </Text>
      <Text style={[styles.apiBaseHint, { color: colors.muted }]} selectable>
        API: {apiBase}
      </Text>
      {oauthRedirectBase == null ? (
        <Text style={[styles.apiBaseHint, { color: colors.muted, marginTop: 6 }]}>
          On iPhone and Android, sign-in uses Google’s system dialog — no browser redirect. Your data still goes
          through the API above.
        </Text>
      ) : oauthDiffers ? (
        <Text style={[styles.apiBaseHint, { color: colors.muted, marginTop: 6 }]} selectable>
          Web Gmail sign-in redirect: {oauthRedirectBase}
        </Text>
      ) : null}
      {hostMismatch ? (
        <Text style={[styles.apiBaseWarn, { color: colors.warning }]}>
          This app is using a different API host than the project default. For Gmail sign-in to work, the browser
          should show{" "}
          <Text style={{ fontWeight: "700" }}>{normalizeApiHost(PRODUCTION_API_ORIGIN)}</Text>
          .{"\n\n"}
          App now: {normalizeApiHost(apiBase)}
          {"\n"}
          Expected: {normalizeApiHost(PRODUCTION_API_ORIGIN)}
          {"\n\n"}
          Rebuild the app with EAS, or deploy the latest code to your Railway service (including legacy
          app-production-… if you still use it).
        </Text>
      ) : null}
      <Pressable
        onPress={onLogin}
        style={({ pressed }) => [
          styles.connectBtn,
          { backgroundColor: colors.email },
          pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
        ]}
      >
        <IconSymbol name="envelope.fill" size={18} color="#fff" />
        <Text style={styles.connectBtnText}>Sign in with Google</Text>
      </Pressable>
    </View>
  );
}

function EmailCard({
  email,
  onParse,
  onSave,
  parsing,
}: {
  email: EmailMessage;
  onParse: (email: EmailMessage) => void;
  onSave: (email: EmailMessage) => void;
  parsing: boolean;
}) {
  const colors = useColors();
  const pd = email.parsedData;

  return (
    <View style={[styles.emailCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.emailHeader}>
        <View style={[styles.emailIcon, { backgroundColor: colors.email + "15" }]}>
          <IconSymbol name="envelope.fill" size={16} color={colors.email} />
        </View>
        <View style={styles.emailInfo}>
          <Text style={[styles.emailSubject, { color: colors.foreground }]} numberOfLines={1}>
            {email.subject || "(No subject)"}
          </Text>
          <Text style={[styles.emailFrom, { color: colors.muted }]} numberOfLines={1}>
            {email.from}
          </Text>
        </View>
      </View>

      {pd ? (
        <View style={[styles.parsedBox, { backgroundColor: colors.success + "10", borderColor: colors.success + "30" }]}>
          <View style={styles.parsedRow}>
            <Text style={[styles.parsedLabel, { color: colors.muted }]}>Vendor</Text>
            <Text style={[styles.parsedValue, { color: colors.foreground }]}>{pd.vendor}</Text>
          </View>
          <View style={styles.parsedRow}>
            <Text style={[styles.parsedLabel, { color: colors.muted }]}>Invoice #</Text>
            <Text style={[styles.parsedValue, { color: colors.foreground }]}>
              {displayInvoiceNumber(pd.invoiceNumber)}
            </Text>
          </View>
          <View style={styles.parsedRow}>
            <Text style={[styles.parsedLabel, { color: colors.muted }]}>Date</Text>
            <Text style={[styles.parsedValue, { color: colors.foreground }]}>{pd.date}</Text>
          </View>
          <View style={styles.parsedRow}>
            <Text style={[styles.parsedLabel, { color: colors.muted }]}>Total</Text>
            <Text style={[styles.parsedValue, { color: colors.foreground, fontWeight: "700" }]}>
              €{pd.totalAmount.toFixed(2)}
            </Text>
          </View>
          <View style={styles.parsedRow}>
            <Text style={[styles.parsedLabel, { color: colors.muted }]}>IVA</Text>
            <Text style={[styles.parsedValue, { color: colors.warning }]}>€{pd.ivaAmount.toFixed(2)}</Text>
          </View>
          <View style={styles.parsedRow}>
            <Text style={[styles.parsedLabel, { color: colors.muted }]}>Category</Text>
            <Text style={[styles.parsedValue, { color: colors.primary }]}>{pd.category}</Text>
          </View>
        </View>
      ) : (
        <Text style={[styles.snippet, { color: colors.muted }]} numberOfLines={2}>
          {email.snippet}
        </Text>
      )}

      <View style={styles.emailActions}>
        {!pd ? (
          <Pressable
            onPress={() => onParse(email)}
            disabled={parsing}
            style={({ pressed }) => [
              styles.actionBtn,
              { backgroundColor: colors.primary },
              pressed && { opacity: 0.8 },
              parsing && { opacity: 0.5 },
            ]}
          >
            {parsing ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <IconSymbol name="bolt.fill" size={14} color="#fff" />
            )}
            <Text style={styles.actionBtnText}>{parsing ? "Parsing..." : "Parse with AI"}</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={() => onSave(email)}
            style={({ pressed }) => [
              styles.actionBtn,
              { backgroundColor: colors.success },
              pressed && { opacity: 0.8 },
            ]}
          >
            <IconSymbol name="checkmark.circle.fill" size={14} color="#fff" />
            <Text style={styles.actionBtnText}>Save to Receipts</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export default function GmailScreen() {
  const colors = useColors();
  const { addInvoice, updateInvoice } = useInvoices();
  const [emails, setEmails] = useState<EmailMessage[]>([]);
  const [fetching, setFetching] = useState(false);
  const [parsingId, setParsingId] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);
  const [autoExportEnabled, setAutoExportEnabled] = useState(false);
  const [gmailPreparingLabel, setGmailPreparingLabel] = useState("");
  const [gmailCompleteLabel, setGmailCompleteLabel] = useState("");
  const autoSaveStartedRef = useRef<Set<string>>(new Set());
  const fetchInFlightRef = useRef(false);
  const lastAutoFetchKeyRef = useRef("");

  const fetchMutation = trpc.invoices.fetchGmailInvoices.useMutation();
  const parseMutation = trpc.invoices.parseEmailInvoice.useMutation();
  const exportMutation = trpc.invoices.exportToSheets.useMutation();
  const relabelMutation = trpc.invoices.gmailRelabelMessage.useMutation();

  const refreshAutomationSettings = useCallback(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then((raw) => {
      if (!raw) return;
      const settings = JSON.parse(raw) as {
        autoSaveGmailEmails?: boolean;
        autoExportToSheets?: boolean;
        gmailPreparingLabel?: string;
        gmailCompleteLabel?: string;
      };
      setAutoSaveEnabled(settings.autoSaveGmailEmails ?? false);
      setAutoExportEnabled(settings.autoExportToSheets ?? false);
      setGmailPreparingLabel(settings.gmailPreparingLabel?.trim() ?? "");
      setGmailCompleteLabel(settings.gmailCompleteLabel?.trim() ?? "");
    });
  }, []);

  useEffect(() => {
    // Load saved token on mount
    AsyncStorage.getItem(GMAIL_TOKEN_KEY).then((token) => {
      if (token) {
        setAccessToken(token);
        setIsLoggedIn(true);
      }
    });
    AsyncStorage.getItem(GMAIL_EMAIL_KEY).then((email) => {
      if (email) setUserEmail(email);
    });
    refreshAutomationSettings();
  }, [refreshAutomationSettings]);

  // Fallback: some iOS builds deliver `scheme://gmail-auth?token=…` via Linking instead of WebBrowser result
  useEffect(() => {
    const applyGmailAuthUrl = async (url: string) => {
      if (!url.includes("://gmail-auth")) return;
      const parsed = parseGmailAuthReturnUrl(url);
      if (parsed.error) {
        const msg = parsed.detail ? `OAuth failed: ${parsed.error}\n\n${parsed.detail}` : `OAuth failed: ${parsed.error}`;
        Alert.alert("Error", msg);
        return;
      }
      const saved = await persistGmailOAuthFromParsed(parsed);
      if (!saved.ok) return;
      setAccessToken(parsed.token ?? "");
      setUserEmail(parsed.email ?? "");
      setIsLoggedIn(true);
      try {
        WebBrowser.dismissAuthSession();
      } catch {
        /* iOS only; ignore if already closed */
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Success", "Google account connected!");
    };

    const sub = Linking.addEventListener("url", (e) => {
      void applyGmailAuthUrl(e.url);
    });
    void Linking.getInitialURL().then((url) => {
      if (url) void applyGmailAuthUrl(url);
    });
    return () => sub.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshAutomationSettings();
      void AsyncStorage.getItem(GMAIL_TOKEN_KEY).then((t) => {
        if (t) {
          setAccessToken(t);
          setIsLoggedIn(true);
        }
      });
      void AsyncStorage.getItem(GMAIL_EMAIL_KEY).then((e) => {
        if (e) setUserEmail(e);
      });
    }, [refreshAutomationSettings]),
  );

  const handleGoogleLogin = useCallback(async () => {
    const runWebBrowserOAuth = async () => {
      /* OAuth in browser (Safari / in-app browser) + deep link back. */
      const oauthBase = getGmailOAuthRedirectBaseUrl();
      const scheme = getNativeAppScheme();
      const appAuthRedirectUri = `${scheme}://${GMAIL_OAUTH_RETURN_HOST}`;
      const clientId = WEB_GOOGLE_CLIENT_ID;
      const redirectUri = `${oauthBase}/auth/gmail/callback`;
      const statePayload = encodeGmailOAuthState(scheme, redirectUri);
      if (__DEV__) {
        console.log(
          "[Gmail OAuth] redirect_uri (must be in Google Cloud + match this deploy):",
          redirectUri,
        );
      }
      const scope =
        "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/spreadsheets";

      const oauthUrl =
        `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(scope)}` +
        `&access_type=offline` +
        `&prompt=consent` +
        `&state=${encodeURIComponent(statePayload)}`;

      const result = await WebBrowser.openAuthSessionAsync(oauthUrl, appAuthRedirectUri, {
        preferEphemeralSession: false,
      });

      if (result.type === "success" && result.url) {
        const { token, email, error, detail } = parseGmailAuthReturnUrl(result.url);
        if (error) {
          const hint =
            error === "access_denied"
              ? "Google sign-in was cancelled or blocked."
              : error === "missing_code"
                ? "The login page did not return a code. Close the browser and try again from the app."
                : error === "token_exchange_failed"
                  ? [
                      "Server could not exchange the login code.",
                      detail ?? "",
                      "",
                      `OAuth redirect: ${redirectUri}`,
                      `OAuth host: ${oauthBase}`,
                      `Client ID: ${clientId}`,
                    ]
                      .filter(Boolean)
                      .join("\n")
                  : error;
          Alert.alert("Gmail sign-in", hint);
          return;
        }
        if (token) {
          const saved = await persistGmailOAuthFromParsed({ token, email, error });
          if (!saved.ok) {
            Alert.alert("Error", "Could not save Gmail connection.");
            return;
          }
          setAccessToken(token);
          setUserEmail(email ?? "");
          setIsLoggedIn(true);
          try {
            WebBrowser.dismissAuthSession();
          } catch {
            /* noop */
          }
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert("Success", "Google account connected!");
          return;
        }
        Alert.alert("Error", "No token returned. Try signing in again.");
        return;
      }

      if (result.type === "cancel" || result.type === "dismiss") {
        Alert.alert(
          "Sign-in not finished",
          "The app did not receive the login token. Try again and wait until the app opens automatically after Google (do not close the browser first).",
        );
      }
    };

    try {
      /** Prefer native Sign-In when the binary includes RNGoogleSignin (not Expo Go). */
      if (Platform.OS !== "web" && !isExpoGo()) {
        try {
          const shouldSkipNativeOnIos = Platform.OS === "ios" && IOS_GOOGLE_CLIENT_ID.trim().length === 0;
          if (shouldSkipNativeOnIos) {
            // Native iOS Google Sign-In needs iosClientId or GoogleService-Info.plist.
            await runWebBrowserOAuth();
            return;
          }
          await configureGoogleSignInForGmail(WEB_GOOGLE_CLIENT_ID, {
            iosClientId: Platform.OS === "ios" ? IOS_GOOGLE_CLIENT_ID : undefined,
          });
          const { accessToken: token, email } = await signInWithGoogleForGmailAndSheets();
          const saved = await persistGmailOAuthFromParsed({ token, email });
          if (!saved.ok) {
            Alert.alert("Error", "Could not save Gmail connection.");
            return;
          }
          setAccessToken(token);
          setUserEmail(email ?? "");
          setIsLoggedIn(true);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert("Success", "Google account connected!");
          return;
        } catch (inner) {
          const nativeMsg = inner instanceof Error ? inner.message.toLowerCase() : String(inner).toLowerCase();
          const nativeClientIdMissing =
            nativeMsg.includes("failed to determine clientid") ||
            nativeMsg.includes("googleservice-info.plist") ||
            nativeMsg.includes("iosclientid");
          if (
            inner instanceof Error &&
            inner.message === NATIVE_GOOGLE_SIGNIN_UNAVAILABLE
          ) {
            await runWebBrowserOAuth();
            return;
          }
          if (nativeClientIdMissing) {
            // Native GoogleSignIn not configured in this dev build; use browser OAuth instead.
            await runWebBrowserOAuth();
            return;
          }
          throw inner;
        }
      }

      await runWebBrowserOAuth();
    } catch (err) {
      if (isGoogleSignInCancelled(err)) return;
      Alert.alert("Error", "Failed to connect Google account");
    }
  }, []);

  const fetchEmails = useCallback(
    async (token?: string) => {
      const tokenToUse = token?.trim();
      if (!tokenToUse) return;
      if (fetchInFlightRef.current) return;

      fetchInFlightRef.current = true;
      setFetching(true);
      try {
        const prep = gmailPreparingLabel.trim();
        const result = await fetchMutation.mutateAsync({
          accessToken: tokenToUse,
          maxResults: GMAIL_FETCH_PAGE_SIZE,
          preparingLabelName: prep || undefined,
        });
        setEmails((result.messages as EmailMessage[]) ?? []);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const lower = msg.toLowerCase();
        // Do not treat "invalid_grant" here — that phrase is from the server's Google Sheets
        // refresh token (Railway), not from the user's Gmail API token.
        const tokenProblem =
          lower.includes("invalid credentials") ||
          lower.includes("unauthorized") ||
          lower.includes("401") ||
          lower.includes("invalid authentication");
        if (tokenProblem) {
          await AsyncStorage.removeItem(GMAIL_TOKEN_KEY);
          await AsyncStorage.removeItem(GMAIL_EMAIL_KEY);
          lastAutoFetchKeyRef.current = "";
          setAccessToken("");
          setUserEmail("");
          setIsLoggedIn(false);
          setEmails([]);
          Alert.alert(
            "Gmail reconnect needed",
            "Google access token has expired or is invalid. Please disconnect and sign in again.",
          );
          return;
        }
        Alert.alert("Error", `Failed to fetch Gmail messages.\n\n${msg.slice(0, 180)}`);
      } finally {
        fetchInFlightRef.current = false;
        setFetching(false);
      }
    },
    [fetchMutation, gmailPreparingLabel],
  );

  useEffect(() => {
    if (isLoggedIn && accessToken) {
      const key = `${accessToken.trim()}|${gmailPreparingLabel.trim().toLowerCase()}`;
      if (lastAutoFetchKeyRef.current === key) return;
      lastAutoFetchKeyRef.current = key;
      void fetchEmails(accessToken);
    }
  }, [isLoggedIn, accessToken, gmailPreparingLabel, fetchEmails]);

  const handleParse = useCallback(
    async (email: EmailMessage) => {
      setParsingId(email.id);
      try {
        const parsed = await parseMutation.mutateAsync({
          emailText: email.bodyText || email.snippet,
          subject: email.subject,
          accessToken,
          messageId: email.id,
        });
        setEmails((prev) =>
          prev.map((e) =>
            e.id === email.id
              ? { ...e, parsed: true, parsedData: parsed }
              : e
          )
        );
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {
        Alert.alert("Error", "Failed to parse email. Please try again.");
      } finally {
        setParsingId(null);
      }
    },
    [accessToken, parseMutation]
  );

  const handleSave = useCallback(
    async (email: EmailMessage, opts?: { quiet?: boolean }) => {
      if (!email.parsedData) return;
      const pd = email.parsedData;
      const invoice: Invoice = {
        id: `email_${email.id}`,
        source: "email",
        invoiceNumber: pd.invoiceNumber ?? "",
        vendor: pd.vendor ?? email.from ?? "Unknown",
        date: coerceInvoiceDateIsoForStorage(pd.date),
        totalAmount: pd.totalAmount ?? 0,
        ivaAmount: pd.ivaAmount ?? 0,
        baseAmount: (pd.totalAmount ?? 0) - (pd.ivaAmount ?? 0),
        currency: "EUR",
        category: (pd.category as InvoiceCategory) ?? "Other",
        emailId: email.id,
        emailSubject: email.subject,
        exportedToSheets: false,
        createdAt: new Date().toISOString(),
      };
      await addInvoice(invoice);

      let exportOutcome: "none" | "ok" | "duplicate" | "failed" = "none";
      let exportReceiptMissing = false;
      if (autoExportEnabled) {
        try {
          const gmailTokForExport =
            accessToken.trim() ||
            (await AsyncStorage.getItem(GMAIL_TOKEN_KEY))?.trim() ||
            "";
          const { spreadsheetId, sheetName } = await getSheetsExportTarget();
          const result = await exportMutation.mutateAsync({
            spreadsheetId,
            sheetName,
            publicApiBaseUrl: getApiBaseUrl(),
            rows: [
              {
                source: "Email",
                invoiceNumber: invoice.invoiceNumber,
                vendor: invoice.vendor,
                date: invoice.date,
                totalAmount: invoice.totalAmount,
                ivaAmount: invoice.ivaAmount,
                baseAmount: invoice.baseAmount,
                category: invoice.category,
                currency: invoice.currency,
                tip: invoice.tip,
                notes: invoice.notes ?? "",
                items: invoice.items,
                imageUrl: "",
                gmailMessageId: email.id,
                ...(gmailTokForExport
                  ? {
                      gmailReceiptFetch: {
                        userAccessToken: gmailTokForExport,
                        messageId: email.id,
                      },
                    }
                  : {}),
              },
            ],
            automateSheets: true,
          });
          await updateInvoice(invoice.id, {
            exportedToSheets: true,
            exportedAt: new Date().toISOString(),
          });
          exportOutcome = result.rowsAdded === 0 ? "duplicate" : "ok";
          exportReceiptMissing =
            exportOutcome === "ok" && Boolean(result.receiptImageMissing);
        } catch (err) {
          console.error("[Gmail] exportToSheets failed:", err);
          exportOutcome = "failed";
        }
      }

      if (
        autoExportEnabled &&
        (exportOutcome === "ok" || exportOutcome === "duplicate") &&
        accessToken &&
        invoice.totalAmount > 0
      ) {
        try {
          const rawSettings = await AsyncStorage.getItem(SETTINGS_KEY);
          const parsed = rawSettings ? JSON.parse(rawSettings) : {};
          const prep = String(parsed.gmailPreparingLabel ?? "").trim();
          const done = String(parsed.gmailCompleteLabel ?? "").trim();
          // Complete label alone is enough (many users only set "2026 Invoice Complete").
          if (done) {
            await relabelMutation.mutateAsync({
              accessToken,
              messageId: email.id,
              removeLabelName: prep || undefined,
              addLabelName: done,
            });
          }
        } catch (relErr) {
          console.error("[Gmail] Relabel after export failed:", relErr);
        }
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setEmails((prev) => prev.filter((e) => e.id !== email.id));

      if (opts?.quiet) {
        if (exportOutcome === "failed") {
          Alert.alert(
            "Sheets export failed",
            `${invoice.vendor} was saved to Receipts. Open it and tap Export.`,
          );
        }
        return;
      }

      if (exportOutcome === "failed") {
        Alert.alert(
          "Saved",
          `${invoice.vendor}: saved to Receipts, but Google Sheets export failed. Open the receipt and tap Export.`,
        );
      } else if (exportOutcome === "ok") {
        if (exportReceiptMissing) {
          Alert.alert(
            "Saved & exported",
            `${invoice.vendor} is in your spreadsheet, but the Receipt column has no PDF/image (Gmail could not attach a file). Open the receipt and tap Export again, or remove the duplicate row in Sheets and re-save from Gmail.`,
          );
        } else {
          Alert.alert("Saved & exported", `${invoice.vendor} is in Receipts and your spreadsheet.`);
        }
      } else if (exportOutcome === "duplicate") {
        Alert.alert(
          "Saved",
          `${invoice.vendor}: saved to Receipts. A matching row was already in Sheets — marked as exported.`,
        );
      } else {
        Alert.alert("Saved!", `Invoice from ${invoice.vendor} has been saved to your receipts.`);
      }
    },
    [accessToken, addInvoice, autoExportEnabled, exportMutation, relabelMutation, updateInvoice],
  );

  // Auto-save parsed emails if enabled
  useEffect(() => {
    if (!autoSaveEnabled) return;

    for (const email of emails) {
      if (!email.parsedData || !email.parsed) continue;
      if (autoSaveStartedRef.current.has(email.id)) continue;
      autoSaveStartedRef.current.add(email.id);
      void handleSave(email, { quiet: true }).finally(() => {
        autoSaveStartedRef.current.delete(email.id);
      });
    }
  }, [emails, autoSaveEnabled, handleSave]);

  const handleDisconnect = useCallback(() => {
    Alert.alert("Disconnect Google", "Are you sure you want to disconnect your Google account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          await signOutGoogleNative();
          await AsyncStorage.removeItem(GMAIL_TOKEN_KEY);
          await AsyncStorage.removeItem(GMAIL_EMAIL_KEY);
          lastAutoFetchKeyRef.current = "";
          setAccessToken("");
          setUserEmail("");
          setIsLoggedIn(false);
          setEmails([]);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        },
      },
    ]);
  }, []);

  if (!isLoggedIn) {
    return (
      <ScreenContainer containerClassName="bg-background">
        <LoginCard
          onLogin={handleGoogleLogin}
          apiBase={getApiBaseUrl()}
          oauthRedirectBase={getGmailOAuthRedirectBaseUrl()}
        />
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer containerClassName="bg-background">
      <FlatList
        style={{ flex: 1, backgroundColor: colors.background }}
        data={emails}
        keyExtractor={(item, index) => `${item.id}__${item.internalDate ?? ""}__${index}`}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.headerRow}>
              <View>
                <Text style={[styles.title, { color: colors.foreground }]}>Gmail Invoices</Text>
                <Text style={[styles.subtitle, { color: colors.muted }]}>
                  {emails.length} invoice email{emails.length !== 1 ? "s" : ""} found
                </Text>
                <Text style={[styles.sourceHint, { color: colors.muted }]}>
                  {gmailPreparingLabel.trim()
                    ? `Source: label “${gmailPreparingLabel.trim()}” (read + unread, up to ${GMAIL_FETCH_PAGE_SIZE})`
                    : `Source: keyword search in inbox (up to ${GMAIL_FETCH_PAGE_SIZE})`}
                </Text>
              </View>
              <View style={styles.headerActions}>
                <Pressable
                  onPress={() => fetchEmails(accessToken)}
                  disabled={fetching}
                  style={({ pressed }) => [
                    styles.refreshBtn,
                    { borderColor: colors.border, backgroundColor: colors.surface },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  {fetching ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <IconSymbol name="arrow.clockwise" size={18} color={colors.primary} />
                  )}
                </Pressable>
                <Pressable
                  onPress={handleDisconnect}
                  style={({ pressed }) => [
                    styles.disconnectBtn,
                    { borderColor: colors.error + "50" },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={[styles.disconnectText, { color: colors.error }]}>Disconnect</Text>
                </Pressable>
              </View>
            </View>

            <View style={[styles.connectedBadge, { backgroundColor: colors.success + "15", borderColor: colors.success + "30" }]}>
              <IconSymbol name="checkmark.circle.fill" size={14} color={colors.success} />
              <Text style={[styles.connectedText, { color: colors.success }]}>
                {userEmail || "Connected"}
              </Text>
            </View>

            <View style={[styles.automationCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.automationTitle, { color: colors.muted }]}>AUTOMATION &amp; LABELS</Text>
              <View style={[styles.automationRow, { borderBottomColor: colors.border }]}>
                <View style={styles.automationRowText}>
                  <Text style={[styles.automationLabel, { color: colors.foreground }]}>Auto-save Gmail emails</Text>
                  <Text style={[styles.automationHint, { color: colors.muted }]}>
                    Save parsed messages to Receipts automatically
                  </Text>
                </View>
                <Switch
                  value={autoSaveEnabled}
                  onValueChange={async (v) => {
                    await mergeAppSettingsPatch({ autoSaveGmailEmails: v });
                    setAutoSaveEnabled(v);
                  }}
                  trackColor={{ false: colors.border, true: colors.primary }}
                  thumbColor="#ffffff"
                  ios_backgroundColor={colors.border}
                />
              </View>
              <View style={[styles.automationRow, { borderBottomColor: colors.border }]}>
                <View style={styles.automationRowText}>
                  <Text style={[styles.automationLabel, { color: colors.foreground }]}>Auto-export to Sheets</Text>
                  <Text style={[styles.automationHint, { color: colors.muted }]}>
                    After save, push rows to your spreadsheet
                  </Text>
                </View>
                <Switch
                  value={autoExportEnabled}
                  onValueChange={async (v) => {
                    await mergeAppSettingsPatch({ autoExportToSheets: v });
                    setAutoExportEnabled(v);
                  }}
                  trackColor={{ false: colors.border, true: colors.primary }}
                  thumbColor="#ffffff"
                  ios_backgroundColor={colors.border}
                />
              </View>
              <View
                style={[
                  styles.labelFieldBlock,
                  styles.labelFieldDivider,
                  { borderBottomColor: colors.border },
                ]}
              >
                <Text style={[styles.labelFieldTitle, { color: colors.foreground }]}>Preparing label</Text>
                <Text style={[styles.automationHint, { color: colors.muted }]}>
                  Exact Gmail label name to list here (empty = keyword search in inbox)
                </Text>
                <TextInput
                  style={[
                    styles.labelInput,
                    { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background },
                  ]}
                  value={gmailPreparingLabel}
                  onChangeText={setGmailPreparingLabel}
                  onEndEditing={async () => {
                    const t = gmailPreparingLabel.trim();
                    await mergeAppSettingsPatch({ gmailPreparingLabel: t });
                    setGmailPreparingLabel(t);
                  }}
                  placeholder="e.g. 2026 Preparing Invoices"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={styles.labelFieldBlock}>
                <Text style={[styles.labelFieldTitle, { color: colors.foreground }]}>Complete label</Text>
                <Text style={[styles.automationHint, { color: colors.muted }]}>
                  After export, message moves here (preparing label removed)
                </Text>
                <TextInput
                  style={[
                    styles.labelInput,
                    { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background },
                  ]}
                  value={gmailCompleteLabel}
                  onChangeText={setGmailCompleteLabel}
                  onEndEditing={async () => {
                    const t = gmailCompleteLabel.trim();
                    await mergeAppSettingsPatch({ gmailCompleteLabel: t });
                    setGmailCompleteLabel(t);
                  }}
                  placeholder="e.g. 2026 Invoice Complete"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <EmailCard
            email={item}
            onParse={handleParse}
            onSave={handleSave}
            parsing={parsingId === item.id}
          />
        )}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          fetching ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={[styles.loadingText, { color: colors.muted }]}>
                Fetching invoice emails...
              </Text>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <IconSymbol name="envelope.fill" size={48} color={colors.border} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                No invoice emails found
              </Text>
              <Text style={[styles.emptyDesc, { color: colors.muted }]}>
                We searched for emails with &quot;factura&quot;, &quot;invoice&quot;, &quot;recibo&quot; in the subject line
              </Text>
              <Pressable
                onPress={() => fetchEmails(accessToken)}
                style={[styles.refreshLargeBtn, { backgroundColor: colors.primary }]}
              >
                <IconSymbol name="arrow.clockwise" size={16} color="#fff" />
                <Text style={styles.refreshLargeBtnText}>Refresh</Text>
              </Pressable>
            </View>
          )
        }
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  connectCard: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 16,
  },
  connectIcon: {
    width: 96,
    height: 96,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  connectTitle: { fontSize: 24, fontWeight: "700" },
  connectDesc: { fontSize: 14, textAlign: "center", lineHeight: 22 },
  apiBaseHint: { fontSize: 11, textAlign: "center", marginTop: 10, lineHeight: 16 },
  apiBaseWarn: { fontSize: 12, textAlign: "left", marginTop: 10, lineHeight: 18, paddingHorizontal: 4 },
  connectBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 14,
    marginTop: 8,
  },
  connectBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  header: { padding: 20, paddingBottom: 8 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  title: { fontSize: 26, fontWeight: "700" },
  subtitle: { fontSize: 13, marginTop: 2 },
  sourceHint: { fontSize: 11, marginTop: 4, lineHeight: 15 },
  headerActions: { flexDirection: "row", gap: 8, alignItems: "center" },
  refreshBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  disconnectBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  disconnectText: { fontSize: 13, fontWeight: "500" },
  connectedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  connectedText: { fontSize: 13, fontWeight: "500" },
  automationCard: {
    marginTop: 16,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  automationTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
  },
  automationRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  automationRowText: { flex: 1, gap: 4, paddingRight: 8 },
  automationLabel: { fontSize: 15, fontWeight: "700" },
  automationHint: { fontSize: 11, lineHeight: 15, fontWeight: "500" },
  labelFieldBlock: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
  },
  labelFieldDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  labelFieldTitle: { fontSize: 14, fontWeight: "700" },
  labelInput: {
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontWeight: "500",
  },
  listContent: { paddingBottom: 32 },
  emailCard: {
    marginHorizontal: 20,
    marginBottom: 10,
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  emailHeader: { flexDirection: "row", gap: 10, alignItems: "center" },
  emailIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  emailInfo: { flex: 1 },
  emailSubject: { fontSize: 14, fontWeight: "600" },
  emailFrom: { fontSize: 12, marginTop: 1 },
  snippet: { fontSize: 12, lineHeight: 18 },
  parsedBox: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    gap: 6,
  },
  parsedRow: { flexDirection: "row", justifyContent: "space-between" },
  parsedLabel: { fontSize: 12 },
  parsedValue: { fontSize: 12, fontWeight: "500" },
  emailActions: { flexDirection: "row", justifyContent: "flex-end" },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  actionBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  loadingBox: { alignItems: "center", paddingTop: 60, gap: 12 },
  loadingText: { fontSize: 14 },
  emptyState: { alignItems: "center", paddingTop: 60, paddingHorizontal: 40, gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "600" },
  emptyDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  refreshLargeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
    marginTop: 8,
  },
  refreshLargeBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
});
