import { useEffect, useState, type ComponentProps } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { applyApiUrlFromAppSettings, requestTrpcClientRecreate } from "@/constants/oauth";
import { trpc } from "@/lib/trpc";
import { DEFAULT_MAIN_TRACKER_SHEET_NAME } from "@/shared/sheets-defaults";

import { APP_SCREEN_HEADER } from "@/constants/app-typography";
import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useInvoices } from "@/hooks/use-invoices";

const SETTINGS_KEY = "app_settings_v1";

const HIDE_RESET_ALL_DATA =
  process.env.EXPO_PUBLIC_HIDE_RESET_ALL_DATA === "1" ||
  process.env.EXPO_PUBLIC_HIDE_RESET_ALL_DATA === "true";

interface AppSettings {
  spreadsheetId: string;
  sheetName: string;
  autoSaveGmailEmails?: boolean;
  autoExportToSheets?: boolean;
  /** Gmail label to list in the app (read + unread). Empty = keyword search in inbox. */
  gmailPreparingLabel?: string;
  /** After a successful Sheets export, this label is added and preparing label removed. */
  gmailCompleteLabel?: string;
  /** Override API host (https://…, no trailing slash). Empty = auto (fixes legacy app-production Railway hostname). */
  apiBaseUrlOverride?: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  spreadsheetId: "",
  sheetName: DEFAULT_MAIN_TRACKER_SHEET_NAME,
  autoSaveGmailEmails: false,
  autoExportToSheets: false,
};

/** Receipts tab + export/offline queue keys; does not touch app_settings_v1 or auth tokens. */
async function clearLocalInvoiceStorage(): Promise<void> {
  const allKeys = await AsyncStorage.getAllKeys();
  const keysToDelete = allKeys.filter(
    (key) =>
      key.startsWith("invoice_") ||
      key.startsWith("exported_") ||
      key === "exported_invoices" ||
      key === "invoices_v1" ||
      key === "offline_invoices",
  );
  if (keysToDelete.length > 0) {
    await AsyncStorage.multiRemove(keysToDelete);
  }
}

function SectionHeader({ title }: { title: string }) {
  const colors = useColors();
  return (
    <Text style={[styles.sectionHeader, { color: colors.muted }]}>{title.toUpperCase()}</Text>
  );
}

function EditableField({
  label,
  value,
  onSave,
  placeholder,
  secure,
  hint,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  hint?: string;
}) {
  const colors = useColors();
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(value);

  useEffect(() => {
    setInput(value);
  }, [value]);

  const handleSave = () => {
    onSave(input.trim());
    setEditing(false);
  };

  if (editing) {
    return (
      <View style={[styles.editRow, { borderBottomColor: colors.border }]}>
        <Text style={[styles.editLabel, { color: colors.muted }]}>{label}</Text>
        <TextInput
          style={[styles.editInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
          value={input}
          onChangeText={setInput}
          placeholder={placeholder ?? ""}
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={secure}
          returnKeyType="done"
          onSubmitEditing={handleSave}
          autoFocus
        />
        {hint && <Text style={[styles.hintText, { color: colors.muted }]}>{hint}</Text>}
        <View style={styles.editActions}>
          <Pressable
            onPress={() => { setEditing(false); setInput(value); }}
            style={[styles.editBtn, { borderColor: colors.border }]}
          >
            <Text style={[styles.editBtnText, { color: colors.muted }]}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handleSave}
            style={[styles.editBtn, { backgroundColor: colors.primary }]}
          >
            <Text style={[styles.editBtnText, { color: "#fff" }]}>Save</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => setEditing(true)}
      style={({ pressed }) => [
        styles.settingRow,
        { borderBottomColor: colors.border, backgroundColor: pressed ? colors.background : "transparent" },
      ]}
    >
      <Text style={[styles.settingLabel, { color: colors.foreground }]}>{label}</Text>
      <View style={styles.settingRight}>
        <Text style={[styles.settingValue, { color: value ? colors.muted : colors.error }]} numberOfLines={1}>
          {value ? (secure ? "••••••••" : value) : "Not set"}
        </Text>
        <IconSymbol name="chevron.right" size={16} color={colors.muted} />
      </View>
    </Pressable>
  );
}

export default function SettingsScreen() {
  const colors = useColors();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetPasswordInput, setResetPasswordInput] = useState("");
  const { reload: reloadInvoices } = useInvoices();
  const resetAllDataMutation = trpc.invoices.resetAllData.useMutation();
  const rebuildMeatSheetsMutation = trpc.invoices.rebuildMeatSheetsFromMainTracker.useMutation();
  const runSheetsAutomationMutation = trpc.invoices.runSheetsAutomation.useMutation();

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then((raw) => {
      if (raw) setSettings(JSON.parse(raw) as AppSettings);
    });
  }, []);

  const saveSettings = async (updated: AppSettings) => {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
    setSettings(updated);
    applyApiUrlFromAppSettings(updated);
    requestTrpcClientRecreate();
  };

  const handleRebuildMeatSheets = () => {
    const spreadsheetId = settings.spreadsheetId?.trim();
    if (!spreadsheetId) {
      Alert.alert("Spreadsheet ID missing", "Set your Spreadsheet ID under Google Sheets Configuration first.");
      return;
    }
    Alert.alert(
      "Rebuild meat sheets?",
      "Reads the main tracker tab and refreshes Meat_Line_Items, Meat_Orders, Meat_Cut_Summary, and Meat_Monthly_Summary. Line items come from column N (JSON) when present. Monthly and quarterly tabs are not changed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Rebuild",
          onPress: async () => {
            try {
              const r = await rebuildMeatSheetsMutation.mutateAsync({
                spreadsheetId,
                sheetName: settings.sheetName?.trim() || DEFAULT_MAIN_TRACKER_SHEET_NAME,
              });
              Alert.alert(
                r.meatLineItemCount > 0 ? "Meat sheets updated" : "No line items",
                `${r.message}\n\nTracker rows read: ${r.trackerInvoiceCount}.`,
              );
            } catch (err) {
              Alert.alert("Error", err instanceof Error ? err.message : String(err));
            }
          },
        },
      ],
    );
  };

  const handleSyncDerivedSheetsFromMain = () => {
    const spreadsheetId = settings.spreadsheetId?.trim();
    if (!spreadsheetId) {
      Alert.alert("Spreadsheet ID missing", "Set your Spreadsheet ID under Google Sheets Configuration first.");
      return;
    }
    Alert.alert(
      "Sync derived sheets from main tracker?",
      "Rebuilds monthly tabs, quarterly tabs, and meat summaries from whatever is on the main tracker tab now (including rows you edited by hand in Google Sheets). Uses many Sheets API writes; if Google returns a rate limit, wait a minute and try again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sync now",
          onPress: async () => {
            try {
              await runSheetsAutomationMutation.mutateAsync({
                spreadsheetId,
                sheetName: settings.sheetName?.trim() || DEFAULT_MAIN_TRACKER_SHEET_NAME,
                recentRows: [],
              });
              Alert.alert("Done", "Monthly, quarterly, and meat tabs were refreshed from the main sheet.");
            } catch (err) {
              Alert.alert("Sync failed", err instanceof Error ? err.message : String(err));
            }
          },
        },
      ],
    );
  };

  const runResetAllData = async () => {
    if (!resetPasswordInput.trim()) {
      Alert.alert("Password required", "Enter the reset password (2026 unless your server uses RESET_ALL_DATA_PASSWORD).");
      return;
    }
    const spreadsheetId = settings.spreadsheetId || "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";
    try {
      await resetAllDataMutation.mutateAsync({
        spreadsheetId,
        resetPassword: resetPasswordInput.trim(),
      });
      await clearLocalInvoiceStorage();
      await reloadInvoices();
      setResetModalOpen(false);
      setResetPasswordInput("");
      Alert.alert(
        "Done",
        "Check Google Sheets (data rows gone, headers kept) and the Receipts tab (empty).",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert("Error", msg);
    }
  };

  const handleClearCache = async () => {
    Alert.alert(
      "Clear Local Cache",
      "This removes invoice data stored on this device only (Receipts list, pending offline queue). Google Sheets is not changed.\n\nUse “Reset All Data” to clear the spreadsheet.",
      [
        { text: "Cancel", onPress: () => {}, style: "cancel" },
        {
          text: "Clear",
          onPress: async () => {
            try {
              await clearLocalInvoiceStorage();
              await reloadInvoices();
              Alert.alert("Done", "Local invoice cache cleared.");
            } catch (error) {
              Alert.alert("Error", "Failed to clear local data: " + String(error));
            }
          },
          style: "destructive",
        },
      ]
    );
  };

  return (
    <ScreenContainer containerClassName="bg-background">
      <Modal
        visible={resetModalOpen}
        animationType="fade"
        transparent
        onRequestClose={() => {
          setResetModalOpen(false);
          setResetPasswordInput("");
        }}
      >
        <View style={styles.resetModalBackdrop}>
          <View style={[styles.resetModalCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.resetModalTitle, { color: colors.foreground }]}>Reset all data</Text>
            <Text style={[styles.resetModalBody, { color: colors.muted }]}>
              Clears Google Sheets (main, monthly, quarterly, meat tabs — headers stay) and removes every receipt from this device. This cannot be undone.
            </Text>
            <Text style={[styles.resetModalLabel, { color: colors.foreground }]}>Reset password</Text>
            <Text style={[styles.resetModalHint, { color: colors.muted }]}>
              Enter 2026 to confirm. If the server sets RESET_ALL_DATA_PASSWORD, use that value instead.
            </Text>
            <TextInput
              style={[
                styles.resetModalInput,
                { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background },
              ]}
              value={resetPasswordInput}
              onChangeText={setResetPasswordInput}
              placeholder="2026"
              placeholderTextColor={colors.muted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!resetAllDataMutation.isPending}
            />
            <View style={styles.resetModalActions}>
              <Pressable
                onPress={() => {
                  setResetModalOpen(false);
                  setResetPasswordInput("");
                }}
                disabled={resetAllDataMutation.isPending}
                style={[styles.resetModalBtn, { borderColor: colors.border }]}
              >
                <Text style={[styles.resetModalBtnText, { color: colors.muted }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void runResetAllData()}
                disabled={resetAllDataMutation.isPending}
                style={[styles.resetModalBtn, styles.resetModalBtnDanger]}
              >
                {resetAllDataMutation.isPending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={[styles.resetModalBtnText, { color: "#fff" }]}>Erase everything</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>Settings</Text>

        {/* Spreadsheet Configuration */}
        <SectionHeader title="Google Sheets Configuration" />
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <EditableField
            label="Spreadsheet ID"
            value={settings.spreadsheetId}
            placeholder="Paste your Spreadsheet ID here"
            onSave={(v) => saveSettings({ ...settings, spreadsheetId: v })}
            hint="From: docs.google.com/spreadsheets/d/[SPREADSHEET_ID]/edit"
          />
          <EditableField
            label="Sheet Name (Tab)"
            value={settings.sheetName}
            placeholder="2026 Invoice tracker"
            onSave={(v) => saveSettings({ ...settings, sheetName: v || DEFAULT_MAIN_TRACKER_SHEET_NAME })}
          />
        </View>

        {/* Column Structure Info */}
        <View style={[styles.columnsBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.columnsTitle, { color: colors.foreground }]}>Spreadsheet Columns</Text>
          <Text style={[styles.columnsDesc, { color: colors.muted }]}>
            Data will be exported with these columns:
          </Text>
          {[
            ["A", "Source", "Camera / Email"],
            ["B", "Invoice #", "Invoice number"],
            ["C", "Vendor", "Business name"],
            ["D", "Date", "Receipt date"],
            ["E", "IVA (€)", "IVA amount"],
            ["F", "Base (€)", "Amount before tax"],
            ["G", "Tip (€)", "Tip (restaurants)"],
            ["H", "Total (€)", "Total amount"],
            ["I", "Category", "AI classification"],
            ["J", "Currency", "EUR"],
            ["K", "Notes", "Additional notes"],
            ["L", "Receipt", "Image or PDF link"],
            ["M", "Exported At", "Export timestamp"],
            ["N", "Meat line items (JSON)", "Optional meat lines"],
          ].map(([col, name, desc]) => (
            <View key={col} style={styles.columnRow}>
              <View style={[styles.columnLetterBox, { backgroundColor: colors.primary }]}>
                <Text style={styles.columnLetter}>{col}</Text>
              </View>
              <View style={styles.columnTextBlock}>
                <Text style={[styles.columnName, { color: colors.foreground }]}>{name}</Text>
                <Text style={[styles.columnDesc, { color: colors.muted }]}>{desc}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* App Info */}
        <SectionHeader title="App Information" />
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.settingRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.settingLabel, { color: colors.foreground }]}>Version</Text>
            <Text style={[styles.settingValue, { color: colors.muted }]}>1.0.0</Text>
          </View>
          <View style={[styles.settingRow, { borderBottomColor: "transparent" }]}>
            <Text style={[styles.settingLabel, { color: colors.foreground }]}>Region</Text>
            <Text style={[styles.settingValue, { color: colors.muted }]}>Spain (EUR, IVA)</Text>
          </View>
        </View>

        {/* Testing & Maintenance */}
        <SectionHeader title="Testing & Maintenance" />
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.maintenanceButtonsWrap}>
            {!HIDE_RESET_ALL_DATA && (
            <Pressable
              onPress={() => {
                Alert.alert(
                  "Reset All Data",
                  "This will:\n• Clear Google Sheets (main, monthly, quarterly, Meat tabs). Row 1 headers stay.\n• Remove every invoice from this device’s Receipts list.\n\nYou will be asked for the reset password next (if your server requires one).",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Continue",
                      style: "destructive",
                      onPress: () => setResetModalOpen(true),
                    },
                  ]
                );
              }}
              accessibilityRole="button"
              accessibilityLabel="Reset all data"
              style={({ pressed }) => [
                styles.maintenancePrimaryBtn,
                { backgroundColor: colors.error },
                pressed && { opacity: 0.92, transform: [{ scale: 0.985 }] },
              ]}
            >
              <IconSymbol name="trash.fill" size={15} color="#fff" />
              <View style={styles.maintenanceButtonTextWrap}>
                <Text style={styles.maintenancePrimaryBtnText}>Reset All Data</Text>
                <Text style={styles.maintenancePrimarySubtext}>
                  Clear Sheets and remove all local receipts
                </Text>
              </View>
            </Pressable>
            )}

            <Pressable
              onPress={handleClearCache}
              accessibilityRole="button"
              accessibilityLabel="Clear local cache"
              style={({ pressed }) => [
                styles.maintenanceSecondaryBtn,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.border,
                },
                pressed && { opacity: 0.92, transform: [{ scale: 0.985 }] },
              ]}
            >
              <IconSymbol name="xmark.bin.fill" size={15} color={colors.foreground} />
              <View style={styles.maintenanceButtonTextWrap}>
                <Text style={[styles.maintenanceSecondaryBtnText, { color: colors.foreground }]}>
                  Clear Local Cache
                </Text>
                <Text style={[styles.maintenanceSecondarySubtext, { color: colors.muted }]}>
                  Remove this device&apos;s invoice cache only
                </Text>
              </View>
            </Pressable>

            <Pressable
              onPress={handleSyncDerivedSheetsFromMain}
              disabled={runSheetsAutomationMutation.isPending || rebuildMeatSheetsMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel="Sync monthly quarterly and meat sheets from main tracker"
              style={({ pressed }) => [
                styles.maintenanceSecondaryBtn,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.border,
                  opacity:
                    runSheetsAutomationMutation.isPending || rebuildMeatSheetsMutation.isPending ? 0.55 : 1,
                },
                pressed &&
                  !runSheetsAutomationMutation.isPending &&
                  !rebuildMeatSheetsMutation.isPending && { opacity: 0.92, transform: [{ scale: 0.985 }] },
              ]}
            >
              {runSheetsAutomationMutation.isPending ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <IconSymbol name="tablecells" size={15} color={colors.primary} />
              )}
              <View style={styles.maintenanceButtonTextWrap}>
                <Text style={[styles.maintenanceSecondaryBtnText, { color: colors.foreground }]}>
                  Sync month, quarter & meat from tracker
                </Text>
                <Text style={[styles.maintenanceSecondarySubtext, { color: colors.muted }]}>
                  Full rebuild from the main tab (same pipeline as after export). Use “Rebuild meat” below for meat only.
                </Text>
              </View>
            </Pressable>

            <Pressable
              onPress={handleRebuildMeatSheets}
              disabled={rebuildMeatSheetsMutation.isPending || runSheetsAutomationMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel="Rebuild meat sheets from main tracker"
              style={({ pressed }) => [
                styles.maintenanceSecondaryBtn,
                {
                  backgroundColor: colors.background,
                  borderColor: colors.border,
                  opacity:
                    rebuildMeatSheetsMutation.isPending || runSheetsAutomationMutation.isPending ? 0.55 : 1,
                },
                pressed &&
                  !rebuildMeatSheetsMutation.isPending &&
                  !runSheetsAutomationMutation.isPending && { opacity: 0.92, transform: [{ scale: 0.985 }] },
              ]}
            >
              {rebuildMeatSheetsMutation.isPending ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <IconSymbol name="arrow.triangle.2.circlepath" size={15} color={colors.primary} />
              )}
              <View style={styles.maintenanceButtonTextWrap}>
                <Text style={[styles.maintenanceSecondaryBtnText, { color: colors.foreground }]}>
                  Rebuild meat sheets from tracker
                </Text>
                <Text style={[styles.maintenanceSecondarySubtext, { color: colors.muted }]}>
                  Uses column N JSON on the main tab; does not run OCR on receipt links
                </Text>
              </View>
            </Pressable>
          </View>
        </View>

        {/* Quick Start Guide */}
        <SectionHeader title="Quick Start" />
        <View style={[styles.guideBox, { backgroundColor: colors.surface, borderColor: colors.primary + "45" }]}>
          <View style={styles.guideStep}>
            <View style={[styles.stepNumber, { backgroundColor: colors.primary }]}>
              <Text style={styles.stepNumberText}>1</Text>
            </View>
            <View style={styles.stepContent}>
              <Text style={[styles.stepTitle, { color: colors.foreground }]}>Scan Receipts</Text>
              <Text style={[styles.stepDesc, { color: colors.muted }]}>
                Use the Scan tab to capture paper receipts with your camera. AI will automatically extract the data.
              </Text>
            </View>
          </View>

          <View style={styles.guideStep}>
            <View style={[styles.stepNumber, { backgroundColor: colors.primary }]}>
              <Text style={styles.stepNumberText}>2</Text>
            </View>
            <View style={styles.stepContent}>
              <Text style={[styles.stepTitle, { color: colors.foreground }]}>Connect Gmail</Text>
              <Text style={[styles.stepDesc, { color: colors.muted }]}>
                Open the <Text style={{ fontWeight: "700", color: colors.foreground }}>Gmail</Text> tab, sign in with
                Google. At the top, use the <Text style={{ fontWeight: "700", color: colors.foreground }}>Gmail Labels</Text>{" "}
                card to enter Preparing / Complete label names and tap <Text style={{ fontWeight: "700", color: colors.foreground }}>Save label names</Text>. Automation switches are below that.
              </Text>
            </View>
          </View>

          <View style={styles.guideStep}>
            <View style={[styles.stepNumber, { backgroundColor: colors.primary }]}>
              <Text style={styles.stepNumberText}>3</Text>
            </View>
            <View style={styles.stepContent}>
              <Text style={[styles.stepTitle, { color: colors.foreground }]}>Export to Sheets</Text>
              <Text style={[styles.stepDesc, { color: colors.muted }]}>
                Enter your Google Sheets ID above and export all invoices with one tap.
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingTop: 20, paddingBottom: 44 },
  title: { ...APP_SCREEN_HEADER, marginBottom: 16 },
  sectionHeader: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginBottom: 6, marginTop: 16 },
  section: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 13,
    minHeight: 52,
    borderBottomWidth: 1,
  },
  settingLabel: { fontSize: 14, fontWeight: "600", flex: 1, paddingRight: 10 },
  settingRight: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, justifyContent: "flex-end" },
  settingValue: { fontSize: 12, maxWidth: 160 },
  editRow: { padding: 14, gap: 8, borderBottomWidth: 1 },
  editLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.3 },
  editInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  hintText: { fontSize: 11, lineHeight: 16 },
  editActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  editBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  editBtnText: { fontSize: 14, fontWeight: "600" },
  columnsBox: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 6,
    marginTop: 6,
  },
  columnsTitle: { fontSize: 15, fontWeight: "700" },
  columnsDesc: { fontSize: 12, marginBottom: 6 },
  columnRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingVertical: 7,
  },
  columnLetterBox: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  columnLetter: { color: "#fff", fontSize: 14, fontWeight: "800" },
  columnTextBlock: { flex: 1, minWidth: 0, gap: 3, justifyContent: "center" },
  columnName: { fontSize: 14, fontWeight: "700", letterSpacing: -0.2 },
  columnDesc: { fontSize: 12, fontWeight: "500", lineHeight: 16 },
  guideBox: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 12,
    marginTop: 6,
  },
  guideStep: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  stepNumber: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  stepNumberText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  stepContent: { flex: 1, gap: 4 },
  stepTitle: { fontSize: 14, fontWeight: "800", letterSpacing: -0.2 },
  stepDesc: { fontSize: 13, lineHeight: 19, fontWeight: "500" },
  maintenanceButtonsWrap: {
    padding: 14,
    gap: 12,
  },
  maintenancePrimaryBtn: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    justifyContent: "flex-start",
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 58,
    borderRadius: 14,
  },
  maintenanceButtonTextWrap: { flex: 1, gap: 2 },
  maintenancePrimaryBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  maintenancePrimarySubtext: {
    color: "#FFE6E6",
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
  },
  maintenanceSecondaryBtn: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    justifyContent: "flex-start",
    paddingVertical: 14,
    paddingHorizontal: 16,
    minHeight: 58,
    borderWidth: 1,
    borderRadius: 14,
  },
  maintenanceSecondaryBtnText: {
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  maintenanceSecondarySubtext: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
  },
  resetModalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    padding: 24,
  },
  resetModalCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 20,
    gap: 10,
    maxWidth: 400,
    width: "100%",
    alignSelf: "center",
  },
  resetModalTitle: { fontSize: 18, fontWeight: "800" },
  resetModalBody: { fontSize: 13, lineHeight: 19, fontWeight: "500" },
  resetModalLabel: { fontSize: 13, fontWeight: "700", marginTop: 4 },
  resetModalHint: { fontSize: 11, lineHeight: 16, marginTop: -4 },
  resetModalInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
  },
  resetModalActions: { flexDirection: "row", gap: 10, marginTop: 8, justifyContent: "flex-end" },
  resetModalBtn: {
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    minWidth: 108,
    alignItems: "center",
    justifyContent: "center",
  },
  resetModalBtnDanger: { backgroundColor: "#DC2626", borderColor: "#DC2626" },
  resetModalBtnText: { fontSize: 14, fontWeight: "700" },
});
