import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Linking,
  Alert,
} from "react-native";
import { trpc } from "@/lib/trpc";

import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";

const SETTINGS_KEY = "app_settings_v1";

interface AppSettings {
  spreadsheetId: string;
  sheetName: string;
  autoSaveGmailEmails?: boolean;
  autoExportToSheets?: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  spreadsheetId: "",
  sheetName: "Invoices",
  autoSaveGmailEmails: false,
  autoExportToSheets: false,
};

function SectionHeader({ title }: { title: string }) {
  const colors = useColors();
  return (
    <Text style={[styles.sectionHeader, { color: colors.muted }]}>{title.toUpperCase()}</Text>
  );
}

function ToggleField({
  label,
  value,
  onToggle,
  hint,
}: {
  label: string;
  value: boolean;
  onToggle: (v: boolean) => void;
  hint?: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => onToggle(!value)}
      style={({ pressed }) => [
        styles.settingRow,
        { borderBottomColor: colors.border },
        pressed && { opacity: 0.7 },
      ]}
    >
      <View style={styles.toggleLeft}>
        <Text style={[styles.settingLabel, { color: colors.foreground }]}>{label}</Text>
        {hint && <Text style={[styles.hintText, { color: colors.muted }]}>{hint}</Text>}
      </View>
      <View
        style={[
          styles.toggleSwitch,
          {
            backgroundColor: value ? colors.primary : colors.border,
          },
        ]}
      >
        <View
          style={[
            styles.toggleThumb,
            {
              transform: [{ translateX: value ? 20 : 2 }],
              backgroundColor: "#fff",
            },
          ]}
        />
      </View>
    </Pressable>
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
        { borderBottomColor: colors.border },
        pressed && { opacity: 0.7 },
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

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then((raw) => {
      if (raw) setSettings(JSON.parse(raw) as AppSettings);
    });
  }, []);

  const saveSettings = async (updated: AppSettings) => {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
    setSettings(updated);
  };

  // Reset button temporarily disabled - will be re-enabled after TypeScript cache refresh
  // const handleResetData = async () => { ... };

  return (
    <ScreenContainer containerClassName="bg-background">
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>Settings</Text>

        {/* Gmail Automation */}
        <SectionHeader title="Gmail Automation" />
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <ToggleField
            label="Auto-save Gmail Emails"
            value={settings.autoSaveGmailEmails ?? false}
            onToggle={(v) => saveSettings({ ...settings, autoSaveGmailEmails: v })}
            hint="Automatically save parsed Gmail invoices to Receipts"
          />
          <ToggleField
            label="Auto-export to Sheets"
            value={settings.autoExportToSheets ?? false}
            onToggle={(v) => saveSettings({ ...settings, autoExportToSheets: v })}
            hint="Automatically export to all Google Sheets tabs"
          />
        </View>

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
            placeholder="e.g. Invoices"
            onSave={(v) => saveSettings({ ...settings, sheetName: v || "Invoices" })}
          />
          <Pressable
            onPress={() => {
              if (settings.spreadsheetId) {
                Linking.openURL(`https://docs.google.com/spreadsheets/d/${settings.spreadsheetId}/edit`);
              } else {
                Linking.openURL("https://docs.google.com/spreadsheets/d/1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E/edit");
              }
            }}
            style={({ pressed }) => [
              styles.viewSheetsBtn,
              { backgroundColor: colors.primary },
              pressed && { opacity: 0.8 },
            ]}
          >
            <IconSymbol name="paperplane.fill" size={18} color="#fff" />
            <Text style={styles.viewSheetsBtnText}>View Sheets</Text>
          </Pressable>
        </View>

        {/* Column Structure Info */}
        <View style={[styles.columnsBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.columnsTitle, { color: colors.foreground }]}>Spreadsheet Columns</Text>
          <Text style={[styles.columnsDesc, { color: colors.muted }]}>
            Data will be exported with these columns:
          </Text>
          {[
            ["A", "Source", "Camera / Email"],
            ["B", "Invoice #", "Factura number"],
            ["C", "Vendor", "Business name"],
            ["D", "Date", "Receipt date"],
            ["E", "Total (€)", "Total amount"],
            ["F", "IVA (€)", "Tax amount"],
            ["G", "Base (€)", "Amount before tax"],
            ["H", "Category", "AI classification"],
            ["I", "Currency", "EUR"],
            ["J", "Notes", "Additional notes"],
            ["K", "Exported At", "Export timestamp"],
          ].map(([col, name, desc]) => (
            <View key={col} style={styles.columnRow}>
              <Text style={[styles.columnLetter, { color: colors.primary, backgroundColor: colors.primary + "15" }]}>
                {col}
              </Text>
              <Text style={[styles.columnName, { color: colors.foreground }]}>{name}</Text>
              <Text style={[styles.columnDesc, { color: colors.muted }]}>{desc}</Text>
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
            <Text style={[styles.settingValue, { color: colors.muted }]}>Spain (EUR / IVA)</Text>
          </View>
        </View>

        {/* Testing & Maintenance - Coming Soon */}
        {/* <SectionHeader title="Testing & Maintenance" />
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Pressable onPress={handleResetData} style={...}>
            <Text>Reset All Data</Text>
          </Pressable>
        </View> */}

        {/* Quick Start Guide */}
        <SectionHeader title="Quick Start" />
        <View style={[styles.guideBox, { backgroundColor: colors.primary + "10", borderColor: colors.primary + "30" }]}>
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
                Go to Gmail tab and enter your email address to automatically fetch invoice emails.
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
  content: { padding: 20, paddingBottom: 48 },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 24 },
  sectionHeader: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5, marginBottom: 8, marginTop: 20 },
  section: { borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  settingLabel: { fontSize: 15, fontWeight: "500" },
  settingRight: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, justifyContent: "flex-end" },
  settingValue: { fontSize: 13, maxWidth: 200 },
  editRow: { padding: 14, gap: 8, borderBottomWidth: 1 },
  editLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.3 },
  editInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  hintText: { fontSize: 11, lineHeight: 16 },
  editActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  editBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  editBtnText: { fontSize: 14, fontWeight: "600" },
  columnsBox: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 8,
    marginTop: 10,
  },
  columnsTitle: { fontSize: 14, fontWeight: "600" },
  columnsDesc: { fontSize: 12, marginBottom: 4 },
  columnRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  columnLetter: { width: 24, height: 24, borderRadius: 6, textAlign: "center", lineHeight: 24, fontSize: 12, fontWeight: "700" },
  columnName: { fontSize: 13, fontWeight: "500", width: 80 },
  columnDesc: { fontSize: 12, flex: 1 },
  guideBox: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 16,
    marginTop: 10,
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
  stepTitle: { fontSize: 13, fontWeight: "600" },
  stepDesc: { fontSize: 12, lineHeight: 18 },
  toggleLeft: {
    flex: 1,
    gap: 4,
  },
  toggleSwitch: {
    width: 50,
    height: 28,
    borderRadius: 14,
    padding: 2,
    justifyContent: "center",
  },
  toggleThumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  viewSheetsBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    marginHorizontal: 14,
    marginVertical: 14,
  },
  viewSheetsBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  resetBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    marginHorizontal: 14,
    marginVertical: 14,
  },
  resetBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  resetHint: {
    fontSize: 12,
    textAlign: "center",
    marginHorizontal: 14,
    marginBottom: 14,
  },
});
