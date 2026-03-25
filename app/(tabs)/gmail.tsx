import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useGoogleAuth } from "@/hooks/use-google-auth";
import { useInvoices } from "@/hooks/use-invoices";
import type { Invoice, InvoiceCategory } from "@/shared/invoice-types";
import { trpc } from "@/lib/trpc";

const GOOGLE_CLIENT_ID_KEY = "google_client_id";
const GOOGLE_CLIENT_SECRET_KEY = "google_client_secret";

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

function ConnectCard({ onConnect }: { onConnect: () => void }) {
  const colors = useColors();
  return (
    <View style={styles.connectCard}>
      <View style={[styles.connectIcon, { backgroundColor: colors.email + "15" }]}>
        <IconSymbol name="envelope.fill" size={48} color={colors.email} />
      </View>
      <Text style={[styles.connectTitle, { color: colors.foreground }]}>Connect Gmail</Text>
      <Text style={[styles.connectDesc, { color: colors.muted }]}>
        Connect your Gmail account to automatically fetch and parse invoice emails. You'll need a
        Google Cloud OAuth 2.0 Client ID configured with Gmail and Sheets scopes.
      </Text>
      <Pressable
        onPress={onConnect}
        style={({ pressed }) => [
          styles.connectBtn,
          { backgroundColor: colors.email },
          pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
        ]}
      >
        <IconSymbol name="envelope.fill" size={18} color="#fff" />
        <Text style={styles.connectBtnText}>Connect with Google</Text>
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
            <Text style={[styles.parsedValue, { color: colors.foreground }]}>{pd.invoiceNumber || "—"}</Text>
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
  const { isConnected, accessToken, saveTokens, disconnect } = useGoogleAuth();
  const { addInvoice } = useInvoices();
  const [emails, setEmails] = useState<EmailMessage[]>([]);
  const [fetching, setFetching] = useState(false);
  const [parsingId, setParsingId] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const fetchMutation = trpc.invoices.fetchGmailInvoices.useMutation();
  const parseMutation = trpc.invoices.parseEmailInvoice.useMutation();

  useEffect(() => {
    AsyncStorage.getItem(GOOGLE_CLIENT_ID_KEY).then((v) => v && setClientId(v));
    AsyncStorage.getItem(GOOGLE_CLIENT_SECRET_KEY).then((v) => v && setClientSecret(v));
  }, []);

  const handleConnect = useCallback(async () => {
    // Guide user to set up Google OAuth
    Alert.alert(
      "Google OAuth Setup Required",
      "To connect Gmail and Google Sheets, you need to:\n\n" +
        "1. Go to Google Cloud Console\n" +
        "2. Create a project and enable Gmail API + Sheets API\n" +
        "3. Create OAuth 2.0 credentials\n" +
        "4. Enter your Client ID and Client Secret in Settings\n\n" +
        "Then tap 'Authorize' to connect.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Open Cloud Console",
          onPress: () => WebBrowser.openBrowserAsync("https://console.cloud.google.com/"),
        },
        {
          text: "Authorize",
          onPress: () => handleOAuthFlow(),
        },
      ]
    );
  }, []);

  const handleOAuthFlow = useCallback(async () => {
    const savedClientId = await AsyncStorage.getItem(GOOGLE_CLIENT_ID_KEY);
    if (!savedClientId) {
      Alert.alert(
        "Client ID Required",
        "Please enter your Google OAuth Client ID in Settings first.",
        [{ text: "OK" }]
      );
      return;
    }

    const redirectUri = "https://auth.expo.io/@anonymous/invoice-tracker";
    const scopes = encodeURIComponent(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/spreadsheets"
    );

    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${savedClientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${scopes}` +
      `&access_type=offline` +
      `&prompt=consent`;

    const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);

    if (result.type === "success" && result.url) {
      const url = new URL(result.url);
      const code = url.searchParams.get("code");
      if (code) {
        await exchangeCodeForTokens(code, savedClientId, redirectUri);
      }
    }
  }, []);

  const exchangeCodeForTokens = useCallback(
    async (code: string, cId: string, redirectUri: string) => {
      const savedSecret = await AsyncStorage.getItem(GOOGLE_CLIENT_SECRET_KEY);
      if (!savedSecret) {
        Alert.alert("Error", "Client Secret not found. Please configure in Settings.");
        return;
      }

      try {
        const res = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: cId,
            client_secret: savedSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }).toString(),
        });

        const data = await res.json() as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          error?: string;
        };

        if (data.access_token) {
          await saveTokens({
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
            scope: "gmail spreadsheets",
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert("Connected!", "Gmail and Google Sheets are now connected.");
        } else {
          Alert.alert("Auth Error", data.error ?? "Failed to get access token.");
        }
      } catch (err) {
        Alert.alert("Error", "Failed to exchange authorization code.");
      }
    },
    [saveTokens]
  );

  const fetchEmails = useCallback(async () => {
    if (!accessToken) return;
    setFetching(true);
    try {
      const result = await fetchMutation.mutateAsync({
        accessToken,
        maxResults: 20,
      });
      setEmails((result.messages as EmailMessage[]) ?? []);
    } catch (err) {
      Alert.alert("Error", "Failed to fetch Gmail messages. Check your connection.");
    } finally {
      setFetching(false);
    }
  }, [accessToken, fetchMutation]);

  useEffect(() => {
    if (isConnected && accessToken) {
      fetchEmails();
    }
  }, [isConnected]);

  const handleParse = useCallback(
    async (email: EmailMessage) => {
      setParsingId(email.id);
      try {
        const parsed = await parseMutation.mutateAsync({
          emailText: email.bodyText || email.snippet,
          subject: email.subject,
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
    [parseMutation]
  );

  const handleSave = useCallback(
    async (email: EmailMessage) => {
      if (!email.parsedData) return;
      const pd = email.parsedData;
      const invoice: Invoice = {
        id: `email_${email.id}`,
        source: "email",
        invoiceNumber: pd.invoiceNumber ?? "",
        vendor: pd.vendor ?? email.from ?? "Unknown",
        date: pd.date ?? new Date().toISOString().split("T")[0],
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
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Saved!", `Invoice from ${invoice.vendor} has been saved to your receipts.`);
      // Remove from list
      setEmails((prev) => prev.filter((e) => e.id !== email.id));
    },
    [addInvoice]
  );

  const handleDisconnect = useCallback(() => {
    Alert.alert("Disconnect Google", "Are you sure you want to disconnect your Google account?", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: disconnect },
    ]);
  }, [disconnect]);

  return (
    <ScreenContainer containerClassName="bg-background">
      {!isConnected ? (
        <ConnectCard onConnect={handleConnect} />
      ) : (
        <FlatList
          data={emails}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={
            <View style={styles.header}>
              <View style={styles.headerRow}>
                <View>
                  <Text style={[styles.title, { color: colors.foreground }]}>Gmail Invoices</Text>
                  <Text style={[styles.subtitle, { color: colors.muted }]}>
                    {emails.length} invoice email{emails.length !== 1 ? "s" : ""} found
                  </Text>
                </View>
                <View style={styles.headerActions}>
                  <Pressable
                    onPress={fetchEmails}
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
                  Google Account Connected
                </Text>
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
                  We searched for emails with "factura", "invoice", "recibo" in the subject line
                </Text>
                <Pressable
                  onPress={fetchEmails}
                  style={[styles.refreshLargeBtn, { backgroundColor: colors.primary }]}
                >
                  <IconSymbol name="arrow.clockwise" size={16} color="#fff" />
                  <Text style={styles.refreshLargeBtnText}>Refresh</Text>
                </Pressable>
              </View>
            )
          }
        />
      )}
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
