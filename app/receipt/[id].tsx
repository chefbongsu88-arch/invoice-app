import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as FileSystem from "expo-file-system/legacy";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useInvoices } from "@/hooks/use-invoices";
import { trpc } from "@/lib/trpc";
import type { Invoice } from "@/shared/invoice-types";

const SETTINGS_KEY = "app_settings_v1";

// Helper function to convert image file to base64
async function convertImageToBase64(imageUri: string): Promise<string> {
  try {
    // Try FileSystem first (works with both camera and library images)
    const base64 = await FileSystem.readAsStringAsync(imageUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return base64;
  } catch (fsError) {
    console.warn("[Export] FileSystem read failed, using fetch fallback", fsError);
    try {
      // Fallback to fetch + blob conversion
      const response = await fetch(imageUri);
      const blob = await response.blob();
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          const b64 = result.split(",")[1];
          if (!b64) {
            reject(new Error("Failed to extract base64 from blob"));
          } else {
            resolve(b64);
          }
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (fetchError) {
      console.error("[Export] Both FileSystem and fetch failed", fetchError);
      throw new Error("Failed to convert image to base64");
    }
  }
}

function DetailRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  const colors = useColors();
  return (
    <View style={[styles.detailRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.detailLabel, { color: colors.muted }]}>{label}</Text>
      <Text style={[styles.detailValue, { color: accent ?? colors.foreground }]}>{value}</Text>
    </View>
  );
}

export default function ReceiptDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const router = useRouter();
  const { invoices, deleteInvoice, updateInvoice } = useInvoices();
  const [exporting, setExporting] = useState(false);

  const exportMutation = trpc.invoices.exportToSheets.useMutation();

  const invoice = invoices.find((inv) => inv.id === id);

  const handleDelete = useCallback(() => {
    Alert.alert("Delete Invoice", "Are you sure you want to delete this invoice?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteInvoice(id);
          router.back();
        },
      },
    ]);
  }, [id, deleteInvoice, router]);

  const handleExport = useCallback(async () => {
    if (!invoice) return;

    const settings = await AsyncStorage.getItem(SETTINGS_KEY);
    const parsed = settings ? JSON.parse(settings) : {};
    const spreadsheetId = parsed.spreadsheetId;
    const sheetName = parsed.sheetName ?? "Invoices";
    const apiKey = parsed.googleApiKey;

    if (!spreadsheetId) {
      Alert.alert(
        "Spreadsheet Not Configured",
        "Please enter your Google Spreadsheet ID in Settings.",
        [{ text: "OK" }]
      );
      return;
    }

    // API Key is no longer required - using Service Account authentication

    setExporting(true);
    try {
      // Convert image to base64 if it exists
      let imageBase64 = "";
      if (invoice.imageUri) {
        try {
          imageBase64 = await convertImageToBase64(invoice.imageUri);
          console.log("[Export] Image converted to base64, length:", imageBase64.length);
        } catch (imgError) {
          console.warn("[Export] Failed to convert image to base64:", imgError);
          // Continue without image if conversion fails
        }
      }

      await exportMutation.mutateAsync({
        spreadsheetId,
        sheetName,
        rows: [
          {
            source: invoice.source === "camera" ? "Camera" : "Email",
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
            imageUrl: imageBase64 ? `data:image/jpeg;base64,${imageBase64}` : "",
          },
        ],
        automateSheets: true,
      });

      await updateInvoice(id, {
        exportedToSheets: true,
        exportedAt: new Date().toISOString(),
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Exported!", "Invoice has been added to your Google Spreadsheet.");
    } catch (err) {
      Alert.alert("Export Failed", "Could not export to Google Sheets. Check your connection and spreadsheet ID.");
    } finally {
      setExporting(false);
    }
  }, [invoice, exportMutation, updateInvoice, id]);

  if (!invoice) {
    return (
      <ScreenContainer containerClassName="bg-background">
        <View style={styles.notFound}>
          <Text style={[styles.notFoundText, { color: colors.muted }]}>Invoice not found</Text>
          <Pressable onPress={() => router.back()}>
            <Text style={[styles.backLink, { color: colors.primary }]}>Go back</Text>
          </Pressable>
        </View>
      </ScreenContainer>
    );
  }

  const sourceColor = invoice.source === "camera" ? colors.camera : colors.email;
  const sourceLabel = invoice.source === "camera" ? "Camera Receipt" : "Email Invoice";

  return (
    <ScreenContainer containerClassName="bg-background">
      <ScrollView contentContainerStyle={styles.content}>
        {/* Header */}
        <View style={styles.topBar}>
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          >
            <IconSymbol name="chevron.left" size={22} color={colors.primary} />
            <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
          </Pressable>
          <Pressable
            onPress={handleDelete}
            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
          >
            <IconSymbol name="trash.fill" size={20} color={colors.error} />
          </Pressable>
        </View>

        {/* Source Badge */}
        <View style={styles.sourceRow}>
          <View style={[styles.sourceBadge, { backgroundColor: sourceColor + "20" }]}>
            <IconSymbol
              name={invoice.source === "camera" ? "camera.fill" : "envelope.fill"}
              size={14}
              color={sourceColor}
            />
            <Text style={[styles.sourceBadgeText, { color: sourceColor }]}>{sourceLabel}</Text>
          </View>
          {invoice.exportedToSheets && (
            <View style={[styles.exportedBadge, { backgroundColor: colors.success + "20" }]}>
              <IconSymbol name="checkmark.circle.fill" size={14} color={colors.success} />
              <Text style={[styles.exportedText, { color: colors.success }]}>Exported to Sheets</Text>
            </View>
          )}
        </View>

        {/* Vendor */}
        <Text style={[styles.vendorName, { color: colors.foreground }]}>
          {invoice.vendor || "Unknown Vendor"}
        </Text>

        {/* Amount Card */}
        <View style={[styles.amountCard, { backgroundColor: colors.primary + "10", borderColor: colors.primary + "30" }]}>
          <View style={styles.amountRow}>
            <View style={styles.amountItem}>
              <Text style={[styles.amountLabel, { color: colors.muted }]}>Total Amount</Text>
              <Text style={[styles.amountValue, { color: colors.primary }]}>
                €{invoice.totalAmount.toFixed(2)}
              </Text>
            </View>
            <View style={[styles.amountDivider, { backgroundColor: colors.border }]} />
            <View style={styles.amountItem}>
              <Text style={[styles.amountLabel, { color: colors.muted }]}>IVA</Text>
              <Text style={[styles.amountValue, { color: colors.warning }]}>
                €{invoice.ivaAmount.toFixed(2)}
              </Text>
            </View>
            <View style={[styles.amountDivider, { backgroundColor: colors.border }]} />
            <View style={styles.amountItem}>
              <Text style={[styles.amountLabel, { color: colors.muted }]}>Base</Text>
              <Text style={[styles.amountValue, { color: colors.foreground }]}>
                €{invoice.baseAmount.toFixed(2)}
              </Text>
            </View>
          </View>
        </View>

        {/* Details */}
        <View style={[styles.detailsCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <DetailRow label="Invoice Number" value={invoice.invoiceNumber || "—"} />
          <DetailRow
            label="Date"
            value={new Date(invoice.date).toLocaleDateString("en-ES", {
              weekday: "long",
              day: "2-digit",
              month: "long",
              year: "numeric",
            })}
          />
          <DetailRow label="Category" value={invoice.category} accent={colors.primary} />
          <DetailRow label="Currency" value={invoice.currency} />
          {invoice.emailSubject && (
            <DetailRow label="Email Subject" value={invoice.emailSubject} />
          )}
          {invoice.notes && <DetailRow label="Notes" value={invoice.notes} />}
          <DetailRow
            label="Added"
            value={new Date(invoice.createdAt).toLocaleDateString("en-ES", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          />
        </View>

        {/* Receipt Image */}
        {invoice.imageUri && (
          <View>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Receipt Image</Text>
            <Image
              source={{ uri: invoice.imageUri }}
              style={[styles.receiptImage, { borderColor: colors.border }]}
              contentFit="contain"
            />
          </View>
        )}

        {/* Export Button */}
        <Pressable
          onPress={handleExport}
          disabled={exporting || invoice.exportedToSheets}
          style={({ pressed }) => [
            styles.exportBtn,
            {
              backgroundColor: invoice.exportedToSheets
                ? colors.success
                : colors.primary,
            },
            pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
            (exporting || invoice.exportedToSheets) && { opacity: 0.7 },
          ]}
        >
          {exporting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <IconSymbol
              name={invoice.exportedToSheets ? "checkmark.circle.fill" : "tablecells"}
              size={20}
              color="#fff"
            />
          )}
          <Text style={styles.exportBtnText}>
            {exporting
              ? "Exporting..."
              : invoice.exportedToSheets
              ? "Already Exported"
              : "Export to Google Sheets"}
          </Text>
        </Pressable>


      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 48, gap: 16 },
  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  backText: { fontSize: 16, fontWeight: "500" },
  sourceRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  sourceBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  sourceBadgeText: { fontSize: 13, fontWeight: "600" },
  exportedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  exportedText: { fontSize: 13, fontWeight: "600" },
  vendorName: { fontSize: 28, fontWeight: "700" },
  amountCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  amountRow: { flexDirection: "row", justifyContent: "space-around", alignItems: "center" },
  amountItem: { alignItems: "center", flex: 1 },
  amountLabel: { fontSize: 11, fontWeight: "500", marginBottom: 4 },
  amountValue: { fontSize: 20, fontWeight: "700" },
  amountDivider: { width: 1, height: 40 },
  detailsCard: { borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  detailLabel: { fontSize: 13 },
  detailValue: { fontSize: 14, fontWeight: "500", flex: 1, textAlign: "right" },
  sectionTitle: { fontSize: 16, fontWeight: "600", marginBottom: 10 },
  receiptImage: {
    width: "100%",
    height: 300,
    borderRadius: 12,
    borderWidth: 1,
  },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    borderRadius: 14,
    marginTop: 8,
  },
  exportBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  connectHint: { fontSize: 13, textAlign: "center", lineHeight: 18 },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  notFoundText: { fontSize: 16 },
  backLink: { fontSize: 15, fontWeight: "500" },
});
