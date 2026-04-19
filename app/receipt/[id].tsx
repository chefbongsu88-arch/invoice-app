import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as FileSystem from "expo-file-system/legacy";
import { useFocusEffect } from "@react-navigation/native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { APP_RECEIPT_VENDOR } from "@/constants/app-typography";
import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { useInvoices } from "@/hooks/use-invoices";
import { getApiBaseUrl } from "@/constants/oauth";
import { GMAIL_TOKEN_KEY } from "@/lib/gmail-oauth";
import { displayInvoiceNumber, formatInvoiceDateLongEn } from "@/lib/invoice-display";
import { runWithScreenStayAwake } from "@/lib/keep-awake-export";
import { getSheetsExportTarget } from "@/lib/sheets-settings";
import { getTrpcMutationMessage } from "@/lib/trpc-error-message";
import { trpc } from "@/lib/trpc";
import type { Invoice } from "@/shared/invoice-types";

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
  const { invoices, deleteInvoice, updateInvoice, reload } = useInvoices();
  const { user } = useAuth();
  const [exporting, setExporting] = useState(false);

  const exportMutation = trpc.invoices.exportToSheets.useMutation();

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

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

  const handleExport = useCallback(async (skipDuplicateCheck = false) => {
    if (!invoice) return;

    const { spreadsheetId, sheetName } = await getSheetsExportTarget();

    setExporting(true);
    try {
      await runWithScreenStayAwake(async () => {
      // Convert image to base64 if it exists
      let imageBase64 = "";
      if (invoice.imageUri) {
        try {
          imageBase64 = await convertImageToBase64(invoice.imageUri);
        } catch (imgError) {
          console.warn("[Export] Failed to convert image to base64:", imgError);
        }
      }

      let gmailReceiptFetch:
        | { userAccessToken: string; messageId: string }
        | undefined;
      if (invoice.source === "email" && invoice.emailId && !imageBase64) {
        const gmailTok = (await AsyncStorage.getItem(GMAIL_TOKEN_KEY))?.trim();
        if (gmailTok) {
          gmailReceiptFetch = { userAccessToken: gmailTok, messageId: invoice.emailId };
        }
      }

      const result = await exportMutation.mutateAsync({
        spreadsheetId,
        sheetName,
        publicApiBaseUrl: getApiBaseUrl(),
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
            items: invoice.items,
            imageUrl: imageBase64 ? `data:image/jpeg;base64,${imageBase64}` : "",
            gmailMessageId: invoice.emailId ?? undefined,
            uploadedByName:
              (invoice.uploadedByName?.trim() || user?.name?.trim() || user?.email?.trim() || "") ||
              undefined,
            ...(gmailReceiptFetch ? { gmailReceiptFetch } : {}),
          },
        ],
        automateSheets: true,
        skipDuplicateCheck,
      });

      // Server skips append when this invoice already matches a row — app used to leave "Pending" forever
      if (result.rowsAdded === 0) {
        await updateInvoice(id, {
          exportedToSheets: true,
          exportedAt: new Date().toISOString(),
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert(
          "Already in Google Sheets",
          `A row with the same invoice number or the same store, date, and total is already in your spreadsheet — nothing new was added. This receipt is now marked Exported in the app.\n\n${displayInvoiceNumber(invoice.invoiceNumber)} · ${invoice.vendor}`,
          [
            { text: "OK", style: "cancel" },
            {
              text: "Upload duplicate row",
              onPress: () => handleExport(true),
            },
          ],
        );
        return;
      }

      await updateInvoice(id, {
        exportedToSheets: true,
        exportedAt: new Date().toISOString(),
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if ((result.duplicateSummary?.insertedDuplicateCount ?? 0) > 0) {
        Alert.alert(
          "Duplicate row uploaded",
          "A duplicate invoice row was added to Google Sheets on purpose. The new row is highlighted so you can review it easily.",
          [{ text: "OK" }],
        );
        return;
      }
      if (
        result.receiptImageMissing &&
        (invoice.imageUri || (invoice.source === "email" && invoice.emailId))
      ) {
        Alert.alert(
          "Exported without receipt file",
          "The row was added to your Google Spreadsheet, but the receipt image or PDF could not be attached. Invoice details are still saved.",
          [{ text: "OK" }],
        );
      } else {
        Alert.alert("Exported!", "Invoice has been added to your Google Spreadsheet.");
      }
      });
    } catch (err) {
      console.error("[Export] Error:", err);
      const detail = getTrpcMutationMessage(
        err,
        "Could not export to Google Sheets. Check your connection and spreadsheet ID.",
      );
      Alert.alert("Export Failed", detail.slice(0, 600));
    } finally {
      setExporting(false);
    }
  }, [invoice, exportMutation, updateInvoice, id]);

  const handleMarkExportedManually = useCallback(() => {
    if (!invoice) return;
    Alert.alert(
      "Mark as exported?",
      "Use this only if a row for this invoice already exists in Google Sheets (for example you fixed the date in the sheet, the export timed out but the row appeared, or you added the row by hand). This does not change Google Sheets — it only clears “Pending” in this app.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Mark exported",
          onPress: async () => {
            await updateInvoice(id, {
              exportedToSheets: true,
              exportedAt: new Date().toISOString(),
            });
            await reload();
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
        },
      ],
    );
  }, [invoice, id, updateInvoice, reload]);

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
            <View
              style={[
                styles.exportedBadge,
                {
                  backgroundColor: colors.success + "22",
                  borderColor: colors.success + "66",
                },
              ]}
            >
              <View style={[styles.exportedBadgeIconWrap, { backgroundColor: colors.success + "35" }]}>
                <IconSymbol name="checkmark.circle.fill" size={16} color={colors.success} />
              </View>
              <View style={styles.exportedBadgeTextCol}>
                <Text style={[styles.exportedText, { color: colors.success }]}>Exported to Sheets</Text>
                <Text style={[styles.exportedSubtext, { color: colors.muted }]}>Row is in your spreadsheet</Text>
              </View>
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
          <DetailRow label="Invoice Number" value={displayInvoiceNumber(invoice.invoiceNumber)} />
          <DetailRow label="Date" value={formatInvoiceDateLongEn(invoice.date)} />
          <DetailRow label="Category" value={invoice.category} accent={colors.primary} />
          <DetailRow label="Currency" value={invoice.currency} />
          {invoice.emailSubject && (
            <DetailRow label="Email Subject" value={invoice.emailSubject} />
          )}
          {invoice.notes && <DetailRow label="Notes" value={invoice.notes} />}
          <DetailRow
            label="Added"
            value={new Date(invoice.createdAt).toLocaleDateString("en-US", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          />
        </View>

        {/* Receipt Image — local scan; Sheets uses Receipt column + server-hosted URL for =IMAGE */}
        {invoice.imageUri ? (
          <View>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Receipt Image</Text>
            <Image
              source={{ uri: invoice.imageUri }}
              style={[styles.receiptImage, { borderColor: colors.border }]}
              contentFit="contain"
            />
          </View>
        ) : (
          <View style={[styles.hintBox, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Text style={[styles.hintTitle, { color: colors.foreground }]}>Receipt photo</Text>
            <Text style={[styles.hintBody, { color: colors.muted }]}>
              {invoice.source === "email"
                ? "There is no image stored in the app for this email invoice. When you export to Google Sheets while signed into Gmail in the app, the server can attach the PDF or first image from the message to the Receipt column (link or preview)."
                : "This invoice has no photo saved in the app (for example, it was entered manually). Use a camera scan to store a picture here, or export a camera receipt so the Receipt column in Sheets can show a preview."}
            </Text>
          </View>
        )}

        {/* Google Sheets — card CTA for comfortable tapping */}
        <View
          style={[
            styles.exportSection,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <Text style={[styles.exportSectionTitle, { color: colors.foreground }]}>Google Sheets</Text>
          <Text style={[styles.exportSectionHint, { color: colors.muted }]}>
            {invoice.exportedToSheets
              ? "This invoice is marked exported — your spreadsheet should already have this row."
              : "Send this invoice to your main tracker: amounts, notes, and a receipt image or PDF link when available."}
          </Text>
          <Pressable
            onPress={() => handleExport()}
            disabled={exporting || invoice.exportedToSheets}
            accessibilityRole="button"
            accessibilityLabel={
              invoice.exportedToSheets
                ? "Already exported to Google Sheets"
                : "Export invoice to Google Sheets"
            }
            style={({ pressed }) => [
              styles.exportBtn,
              !invoice.exportedToSheets && !exporting && styles.exportBtnElevated,
              {
                backgroundColor: invoice.exportedToSheets ? colors.success : colors.primary,
              },
              pressed &&
                !invoice.exportedToSheets &&
                !exporting && { opacity: 0.92, transform: [{ scale: 0.98 }] },
              exporting && { opacity: 0.85 },
              invoice.exportedToSheets && { opacity: 1 },
            ]}
          >
            {exporting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <IconSymbol
                name={invoice.exportedToSheets ? "checkmark.circle.fill" : "square.and.arrow.up"}
                size={22}
                color="#fff"
              />
            )}
            <View style={styles.exportBtnLabelCol}>
              <Text style={styles.exportBtnText}>
                {exporting
                  ? "Exporting…"
                  : invoice.exportedToSheets
                    ? "Exported to Sheets"
                    : "Export to Google Sheets"}
              </Text>
              {!invoice.exportedToSheets && !exporting && (
                <Text style={styles.exportBtnSubtext}>Tap to add a row to your spreadsheet</Text>
              )}
            </View>
          </Pressable>
          {!invoice.exportedToSheets && (
            <Pressable
              onPress={handleMarkExportedManually}
              disabled={exporting}
              accessibilityRole="button"
              accessibilityLabel="Mark invoice as already exported to Google Sheets"
              style={({ pressed }) => [
                styles.markExportedBtn,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.background,
                  opacity: exporting ? 0.5 : pressed ? 0.92 : 1,
                },
              ]}
            >
              <Text style={[styles.markExportedTitle, { color: colors.foreground }]}>
                Row already in Sheets — mark exported
              </Text>
              <Text style={[styles.markExportedSub, { color: colors.muted }]}>
                Fixes “Pending” when the spreadsheet is correct but this app did not get the success flag (manual edits, timeout, or Settings sync only).
              </Text>
            </Pressable>
          )}
        </View>


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
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    maxWidth: "100%",
  },
  exportedBadgeIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  exportedBadgeTextCol: { flex: 1, gap: 2, minWidth: 0 },
  exportedText: { fontSize: 14, fontWeight: "700" },
  exportedSubtext: { fontSize: 11, fontWeight: "500" },
  vendorName: { fontSize: 28, fontWeight: "700" },
  amountCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  amountRow: { flexDirection: "row", justifyContent: "space-around", alignItems: "center" },
  amountItem: { alignItems: "center", flex: 1 },
  amountLabel: { fontSize: 11, fontWeight: "500", marginBottom: 4 },
  amountValue: { fontSize: 18, fontWeight: "700", lineHeight: 22 },
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
  hintBox: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 6,
  },
  hintTitle: { fontSize: 15, fontWeight: "600" },
  hintBody: { fontSize: 13, lineHeight: 19 },
  exportSection: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  exportSectionTitle: { fontSize: 17, fontWeight: "700", letterSpacing: -0.3 },
  exportSectionHint: { fontSize: 13, lineHeight: 19, fontWeight: "500" },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 14,
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: 14,
    minHeight: 56,
  },
  exportBtnElevated:
    Platform.OS === "ios"
      ? {
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.22,
          shadowRadius: 8,
        }
      : { elevation: 5 },
  exportBtnLabelCol: { flex: 1, gap: 3, minWidth: 0 },
  exportBtnText: { color: "#fff", fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
  exportBtnSubtext: { color: "rgba(255,255,255,0.88)", fontSize: 12, fontWeight: "600" },
  markExportedBtn: {
    marginTop: 4,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    gap: 6,
  },
  markExportedTitle: { fontSize: 14, fontWeight: "700" },
  markExportedSub: { fontSize: 12, fontWeight: "500", lineHeight: 17 },
  connectHint: { fontSize: 13, textAlign: "center", lineHeight: 18 },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  notFoundText: { fontSize: 16 },
  backLink: { fontSize: 15, fontWeight: "500" },
});
