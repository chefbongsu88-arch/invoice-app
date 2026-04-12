import { useEffect, useState, type ComponentProps } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Alert,
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
  const { reload: reloadInvoices } = useInvoices();
  const resetAllDataMutation = trpc.invoices.resetAllData.useMutation();

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
            ["E", "Total (€)", "Total amount"],
            ["F", "IVA (€)", "IVA amount"],
            ["G", "Base (€)", "Amount before tax"],
            ["H", "Tip (€)", "Tip (restaurants)"],
            ["I", "Category", "AI classification"],
            ["J", "Currency", "EUR"],
            ["K", "Notes", "Additional notes"],
            ["L", "Receipt", "Image or PDF link"],
            ["M", "Exported At", "Export timestamp"],
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
            <Pressable
              onPress={() => {
                Alert.alert(
                  "Reset All Data",
                  "This will:\n• Clear Google Sheets (main, monthly, quarterly, Meat tabs). Row 1 headers stay.\n• Remove every invoice from this device’s Receipts list.\n\nAre you sure?",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Reset",
                      style: "destructive",
                      onPress: async () => {
                        const spreadsheetId = settings.spreadsheetId || "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";
                        try {
                          await resetAllDataMutation.mutateAsync({ spreadsheetId });
                          await clearLocalInvoiceStorage();
                          await reloadInvoices();
                          Alert.alert(
                            "Done",
                            "Check Google Sheets (data rows gone, headers kept) and the Receipts tab (empty).",
                          );
                        } catch (err) {
                          Alert.alert("Error", "Reset failed: " + String(err));
                        }
                      },
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
});
