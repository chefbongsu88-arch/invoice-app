import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
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
import { useInvoices } from "@/hooks/use-invoices";
import type { Invoice, InvoiceCategory } from "@/shared/invoice-types";
import { trpc } from "@/lib/trpc";

const GMAIL_TOKEN_KEY = "gmail_oauth_token";
const GMAIL_EMAIL_KEY = "gmail_email_address";

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

function LoginCard({ onLogin }: { onLogin: () => void }) {
  const colors = useColors();
  return (
    <View style={styles.connectCard}>
      <View style={[styles.connectIcon, { backgroundColor: colors.email + "15" }]}>
        <IconSymbol name="envelope.fill" size={48} color={colors.email} />
      </View>
      <Text style={[styles.connectTitle, { color: colors.foreground }]}>Gmail Integration</Text>
      <Text style={[styles.connectDesc, { color: colors.muted }]}>
        Sign in with your Google account to automatically fetch and parse invoice emails from your inbox.
      </Text>
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
  const { addInvoice } = useInvoices();
  const [emails, setEmails] = useState<EmailMessage[]>([]);
  const [fetching, setFetching] = useState(false);
  const [parsingId, setParsingId] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  const fetchMutation = trpc.invoices.fetchGmailInvoices.useMutation();
  const parseMutation = trpc.invoices.parseEmailInvoice.useMutation();

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
  }, []);

  const handleGoogleLogin = useCallback(async () => {
    try {
      // Build OAuth URL
      const clientId = "174596473104-1lbjcc0450cbg53lfhhl5eghu7vida1r.apps.googleusercontent.com";
      const redirectUri = "https://invoicetrk-k9hvsw3x.manus.space/auth/callback";
      const scope = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/spreadsheets";
      
      const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline`;

      // Open browser for OAuth
      const result = await WebBrowser.openAuthSessionAsync(oauthUrl, redirectUri);

      if (result.type === "success") {
        const url = new URL(result.url);
        const code = url.searchParams.get("code");
        
        if (code) {
          // Exchange code for token (this would normally be done on backend)
          // For now, we'll use the code as a placeholder
          await AsyncStorage.setItem(GMAIL_TOKEN_KEY, code);
          setAccessToken(code);
          setIsLoggedIn(true);
          
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Alert.alert("Success", "Google account connected!");
          
          // Fetch emails after login
          setTimeout(() => fetchEmails(code), 500);
        }
      }
    } catch (err) {
      Alert.alert("Error", "Failed to connect Google account");
    }
  }, []);

  const fetchEmails = useCallback(async (token?: string) => {
    const tokenToUse = token || accessToken;
    if (!tokenToUse) return;
    
    setFetching(true);
    try {
      const result = await fetchMutation.mutateAsync({
        accessToken: tokenToUse,
        maxResults: 20,
      });
      setEmails((result.messages as EmailMessage[]) ?? []);
    } catch (err) {
      Alert.alert("Error", "Failed to fetch Gmail messages. Please try again.");
    } finally {
      setFetching(false);
    }
  }, [accessToken, fetchMutation]);

  useEffect(() => {
    if (isLoggedIn && accessToken) {
      fetchEmails();
    }
  }, [isLoggedIn, accessToken]);

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
      setEmails((prev) => prev.filter((e) => e.id !== email.id));
    },
    [addInvoice]
  );

  const handleDisconnect = useCallback(() => {
    Alert.alert("Disconnect Google", "Are you sure you want to disconnect your Google account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          await AsyncStorage.removeItem(GMAIL_TOKEN_KEY);
          await AsyncStorage.removeItem(GMAIL_EMAIL_KEY);
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
        <LoginCard onLogin={handleGoogleLogin} />
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer containerClassName="bg-background">
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
                  onPress={() => fetchEmails()}
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
                onPress={() => fetchEmails()}
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
