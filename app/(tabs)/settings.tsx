import AsyncStorage from "@react-native-async-storage/async-storage";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useGoogleAuth } from "@/hooks/use-google-auth";

const SETTINGS_KEY = "app_settings_v1";
const GOOGLE_CLIENT_ID_KEY = "google_client_id";
const GOOGLE_CLIENT_SECRET_KEY = "google_client_secret";

interface AppSettings {
  spreadsheetId: string;
  sheetName: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  spreadsheetId: "",
  sheetName: "Invoices",
};

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
  const { isConnected, disconnect } = useGoogleAuth();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  useEffect(() => {
    AsyncStorage.getItem(SETTINGS_KEY).then((raw) => {
      if (raw) setSettings(JSON.parse(raw) as AppSettings);
    });
    AsyncStorage.getItem(GOOGLE_CLIENT_ID_KEY).then((v) => v && setClientId(v));
    AsyncStorage.getItem(GOOGLE_CLIENT_SECRET_KEY).then((v) => v && setClientSecret(v));
  }, []);

  const saveSettings = async (updated: AppSettings) => {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
    setSettings(updated);
  };

  const handleDisconnect = () => {
    Alert.alert("Disconnect Google", "Are you sure?", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: disconnect },
    ]);
  };

  return (
    <ScreenContainer containerClassName="bg-background">
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: colors.foreground }]}>Settings</Text>

        {/* Google Account */}
        <SectionHeader title="Google Account" />
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.settingRow, { borderBottomColor: colors.border }]}>
            <View style={styles.settingLeft}>
              <View style={[styles.settingIcon, { backgroundColor: (isConnected ? colors.success : colors.muted) + "20" }]}>
                <IconSymbol name="checkmark.seal.fill" size={18} color={isConnected ? colors.success : colors.muted} />
              </View>
              <View>
                <Text style={[styles.settingLabel, { color: colors.foreground }]}>Google Account</Text>
                <Text style={[styles.settingValue, { color: isConnected ? colors.success : colors.muted }]}>
                  {isConnected ? "Connected" : "Not connected"}
                </Text>
              </View>
            </View>
            {isConnected && (
              <Pressable
                onPress={handleDisconnect}
                style={[styles.smallBtn, { borderColor: colors.error + "50" }]}
              >
                <Text style={[styles.smallBtnText, { color: colors.error }]}>Disconnect</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Google OAuth Credentials */}
        <SectionHeader title="Google OAuth Credentials" />
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <EditableField
            label="Client ID"
            value={clientId}
            placeholder="Your Google OAuth Client ID"
            onSave={async (v) => {
              await AsyncStorage.setItem(GOOGLE_CLIENT_ID_KEY, v);
              setClientId(v);
            }}
          />
          <EditableField
            label="Client Secret"
            value={clientSecret}
            placeholder="Your Google OAuth Client Secret"
            secure
            onSave={async (v) => {
              await AsyncStorage.setItem(GOOGLE_CLIENT_SECRET_KEY, v);
              setClientSecret(v);
            }}
          />
        </View>

        <Pressable
          onPress={() => WebBrowser.openBrowserAsync("https://console.cloud.google.com/apis/credentials")}
          style={[styles.infoBox, { backgroundColor: colors.primary + "10", borderColor: colors.primary + "30" }]}
        >
          <IconSymbol name="info.circle.fill" size={16} color={colors.primary} />
          <Text style={[styles.infoText, { color: colors.muted }]}>
            Create OAuth 2.0 credentials at Google Cloud Console with Gmail API and Sheets API enabled.
            Tap to open Google Cloud Console.
          </Text>
          <IconSymbol name="chevron.right" size={14} color={colors.primary} />
        </Pressable>

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
  settingLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  settingIcon: { width: 34, height: 34, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  settingLabel: { fontSize: 15, fontWeight: "500" },
  settingRight: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, justifyContent: "flex-end" },
  settingValue: { fontSize: 13, maxWidth: 200 },
  smallBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  smallBtnText: { fontSize: 13, fontWeight: "500" },
  editRow: { padding: 14, gap: 8, borderBottomWidth: 1 },
  editLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.3 },
  editInput: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  hintText: { fontSize: 11, lineHeight: 16 },
  editActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  editBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  editBtnText: { fontSize: 14, fontWeight: "600" },
  infoBox: {
    flexDirection: "row",
    gap: 10,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginTop: 10,
    alignItems: "center",
  },
  infoText: { flex: 1, fontSize: 12, lineHeight: 18 },
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
});
