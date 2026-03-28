import { ScrollView, Text, View, TouchableOpacity, TextInput, Alert } from "react-native";
import { useState, useEffect } from "react";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { getGoogleSheetsConfig, saveGoogleSheetsConfig, clearGoogleSheetsConfig } from "@/lib/google-sheets";

export default function SettingsScreen() {
  const colors = useColors();
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const config = await getGoogleSheetsConfig();
      if (config) {
        setSpreadsheetId(config.spreadsheetId);
        setAccessToken(config.accessToken);
      }
    } catch (error) {
      console.error("Failed to load config:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!spreadsheetId.trim() || !accessToken.trim()) {
      Alert.alert("Error", "Please fill in all fields");
      return;
    }

    setIsSaving(true);
    try {
      const success = await saveGoogleSheetsConfig({
        spreadsheetId: spreadsheetId.trim(),
        accessToken: accessToken.trim(),
      });

      if (success) {
        Alert.alert("Success", "Google Sheets configuration saved!");
      } else {
        Alert.alert("Error", "Failed to save configuration");
      }
    } catch (error) {
      Alert.alert("Error", "An error occurred while saving");
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    Alert.alert("Clear Configuration", "Are you sure you want to clear the Google Sheets configuration?", [
      { text: "Cancel", onPress: () => {} },
      {
        text: "Clear",
        onPress: async () => {
          try {
            await clearGoogleSheetsConfig();
            setSpreadsheetId("");
            setAccessToken("");
            Alert.alert("Success", "Configuration cleared");
          } catch (error) {
            Alert.alert("Error", "Failed to clear configuration");
          }
        },
      },
    ]);
  };

  if (isLoading) {
    return (
      <ScreenContainer className="p-6 justify-center items-center">
        <Text className="text-foreground">Loading...</Text>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer className="p-6">
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <View className="gap-6">
          <View>
            <Text className="text-2xl font-bold text-foreground mb-2">Settings</Text>
            <Text className="text-sm text-muted">Configure Google Sheets export</Text>
          </View>

          <View className="gap-4">
            {/* Spreadsheet ID */}
            <View>
              <Text className="text-sm font-semibold text-foreground mb-2">Google Sheets Spreadsheet ID</Text>
              <TextInput
                value={spreadsheetId}
                onChangeText={setSpreadsheetId}
                placeholder="Paste your spreadsheet ID here"
                placeholderTextColor={colors.muted}
                className="border border-border rounded-lg p-3 text-foreground bg-surface"
                editable={!isSaving}
              />
              <Text className="text-xs text-muted mt-2">
                Find this in your Google Sheets URL: https://docs.google.com/spreadsheets/d/[ID]/edit
              </Text>
            </View>

            {/* Access Token */}
            <View>
              <Text className="text-sm font-semibold text-foreground mb-2">Google Access Token</Text>
              <TextInput
                value={accessToken}
                onChangeText={setAccessToken}
                placeholder="Paste your access token here"
                placeholderTextColor={colors.muted}
                className="border border-border rounded-lg p-3 text-foreground bg-surface"
                secureTextEntry={true}
                editable={!isSaving}
              />
              <Text className="text-xs text-muted mt-2">
                Your token is stored securely on your device and never shared.
              </Text>
            </View>

            {/* Save Button */}
            <TouchableOpacity
              onPress={handleSave}
              disabled={isSaving}
              className={`rounded-lg p-4 items-center ${isSaving ? "opacity-50" : ""}`}
              style={{ backgroundColor: colors.primary }}
            >
              <Text className="text-white font-semibold">{isSaving ? "Saving..." : "Save Configuration"}</Text>
            </TouchableOpacity>

            {/* Clear Button */}
            {spreadsheetId && (
              <TouchableOpacity
                onPress={handleClear}
                disabled={isSaving}
                className="rounded-lg p-4 items-center border border-error"
              >
                <Text className="text-error font-semibold">Clear Configuration</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Info Section */}
          <View className="bg-surface rounded-lg p-4 gap-2">
            <Text className="text-sm font-semibold text-foreground">How to get your credentials:</Text>
            <Text className="text-xs text-muted">
              1. Create a Google Sheet and share it with your Google account{"\n"}
              2. Copy the Spreadsheet ID from the URL{"\n"}
              3. Generate an access token from Google Cloud Console
            </Text>
          </View>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}
