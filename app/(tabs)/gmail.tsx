import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
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

function SetupCard({ onSetup }: { onSetup: () => void }) {
  const colors = useColors();
  return (
    <View style={styles.connectCard}>
      <View style={[styles.connectIcon, { backgroundColor: colors.email + "15" }]}>
        <IconSymbol name="envelope.fill" size={48} color={colors.email} />
      </View>
      <Text style={[styles.connectTitle, { color: colors.foreground }]}>Gmail Integration</Text>
      <Text style={[styles.connectDesc, { color: colors.muted }]}>
        Enter your Gmail address to automatically fetch and parse invoice emails from your inbox.
      </Text>
      <Pressable
        onPress={onSetup}
        style={({ pressed }) => [
          styles.connectBtn,
          { backgroundColor: colors.email },
          pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
        ]}
      >
        <IconSymbol name="envelope.fill" size={18} color="#fff" />
        <Text style={styles.connectBtnText}>Set Up Gmail</Text>
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
  const [gmailEmail, setGmailEmail] = useState("");
  const [isSetup, setIsSetup] = useState(false);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupInput, setSetupInput] = useState("");

  const fetchMutation = trpc.invoices.fetchGmailInvoices.useMutation();
  const parseMutation = trpc.invoices.parseEmailInvoice.useMutation();

  useEffect(() => {
    AsyncStorage.getItem(GMAIL_EMAIL_KEY).then((v) => {
      if (v) {
        setGmailEmail(v);
        setIsSetup(true);
      }
    });
  }, []);

  const handleSetupGmail = useCallback(async () => {
    if (!setupInput.trim()) {
      Alert.alert("Error", "Please enter your Gmail address");
      return;
    }
    
    const email = setupInput.trim().toLowerCase();
    if (!email.includes("@gmail.com")) {
      Alert.alert("Error", "Please enter a valid Gmail address");
      return;
    }

    await AsyncStorage.setItem(GMAIL_EMAIL_KEY, email);
    setGmailEmail(email);
    setIsSetup(true);
    setShowSetupModal(false);
    setSetupInput("");
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert("Success", `Gmail set to ${email}`);
  }, [setupInput]);

  const fetchEmails = useCallback(async () => {
    if (!gmailEmail) return;
    setFetching(true);
    try {
      // For now, we'll use a placeholder - backend will handle the actual Gmail fetch
      const result = await fetchMutation.mutateAsync({
        accessToken: gmailEmail, // Pass email as identifier for backend
        maxResults: 20,
      });
      setEmails((result.messages as EmailMessage[]) ?? []);
    } catch (err) {
      Alert.alert("Error", "Failed to fetch Gmail messages. Make sure Gmail is properly configured.");
    } finally {
      setFetching(false);
    }
  }, [gmailEmail, fetchMutation]);

  useEffect(() => {
    if (isSetup && gmailEmail) {
      fetchEmails();
    }
  }, [isSetup, gmailEmail]);

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
    Alert.alert("Disconnect Gmail", "Are you sure you want to disconnect your Gmail account?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Disconnect",
        style: "destructive",
        onPress: async () => {
          await AsyncStorage.removeItem(GMAIL_EMAIL_KEY);
          setGmailEmail("");
          setIsSetup(false);
          setEmails([]);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        },
      },
    ]);
  }, []);

  if (!isSetup) {
    return (
      <ScreenContainer containerClassName="bg-background">
        <SetupCard onSetup={() => setShowSetupModal(true)} />

        {showSetupModal && (
          <View style={[styles.modal, { backgroundColor: colors.background + "99" }]}>
            <View style={[styles.modalContent, { backgroundColor: colors.surface }]}>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>Enter Gmail Address</Text>
              <TextInput
                style={[styles.modalInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                placeholder="your.email@gmail.com"
                placeholderTextColor={colors.muted}
                value={setupInput}
                onChangeText={setSetupInput}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />
              <View style={styles.modalActions}>
                <Pressable
                  onPress={() => {
                    setShowSetupModal(false);
                    setSetupInput("");
                  }}
                  style={[styles.modalBtn, { borderColor: colors.border }]}
                >
                  <Text style={[styles.modalBtnText, { color: colors.muted }]}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleSetupGmail}
                  style={[styles.modalBtn, { backgroundColor: colors.email }]}
                >
                  <Text style={[styles.modalBtnText, { color: "#fff" }]}>Connect</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}
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
                {gmailEmail}
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
  modal: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  modalContent: {
    borderRadius: 16,
    padding: 20,
    width: "80%",
    gap: 16,
  },
  modalTitle: { fontSize: 18, fontWeight: "600" },
  modalInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  modalActions: { flexDirection: "row", gap: 12, justifyContent: "flex-end" },
  modalBtn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  modalBtnText: { fontSize: 14, fontWeight: "600" },
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
