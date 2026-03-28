import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import { useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Platform,
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
import { useInvoices } from "@/hooks/use-invoices";
import type { Invoice, InvoiceCategory } from "@/shared/invoice-types";
import { trpc } from "@/lib/trpc";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

type ScanStep = "capture" | "preview" | "review" | "done";

const CATEGORIES: InvoiceCategory[] = [
  "Office Supplies",
  "Travel & Transport",
  "Meals & Entertainment",
  "Utilities",
  "Professional Services",
  "Software & Subscriptions",
  "Equipment",
  "Marketing",
  "Other",
];

function CategoryPicker({
  value,
  onChange,
}: {
  value: InvoiceCategory;
  onChange: (v: InvoiceCategory) => void;
}) {
  const colors = useColors();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}>
      {CATEGORIES.map((cat) => (
        <Pressable
          key={cat}
          onPress={() => onChange(cat)}
          style={[
            styles.catPill,
            {
              backgroundColor: value === cat ? colors.primary : colors.surface,
              borderColor: value === cat ? colors.primary : colors.border,
            },
          ]}
        >
          <Text style={[styles.catPillText, { color: value === cat ? "#fff" : colors.muted }]}>
            {cat}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function FieldRow({
  label,
  value,
  onChange,
  keyboardType,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  keyboardType?: "default" | "decimal-pad";
  placeholder?: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.fieldRow}>
      <Text style={[styles.fieldLabel, { color: colors.muted }]}>{label}</Text>
      <TextInput
        style={[
          styles.fieldInput,
          { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface },
        ]}
        value={value}
        onChangeText={onChange}
        keyboardType={keyboardType ?? "default"}
        placeholder={placeholder ?? ""}
        placeholderTextColor={colors.muted}
        returnKeyType="done"
      />
    </View>
  );
}

export default function ScanScreen() {
  const colors = useColors();
  const router = useRouter();
  const { addInvoice } = useInvoices();
  const [step, setStep] = useState<ScanStep>("capture");
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  // Extracted fields
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [vendor, setVendor] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [totalAmount, setTotalAmount] = useState("");
  const [ivaAmount, setIvaAmount] = useState("");
  const [category, setCategory] = useState<InvoiceCategory>("Other");
  const [notes, setNotes] = useState("");
  const [tip, setTip] = useState("");

  const ocrMutation = trpc.invoices.parseReceipt.useMutation();

  const pickFromCamera = useCallback(async () => {
    if (Platform.OS === "web") {
      Alert.alert("Camera not available", "Please use a physical device to scan receipts.");
      return;
    }
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Required", "Camera permission is needed to scan receipts.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.85,
      base64: true,
      allowsEditing: true,
      aspect: [3, 4],
    });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
      setStep("preview");
    }
  }, []);

  const pickFromLibrary = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Required", "Photo library permission is needed.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.85,
      base64: true,
      allowsEditing: true,
      aspect: [3, 4],
    });
    if (!result.canceled && result.assets[0]) {
      setImageUri(result.assets[0].uri);
      setStep("preview");
    }
  }, []);

  const processImage = useCallback(async () => {
    if (!imageUri) return;
    setProcessing(true);
    try {
      // Convert image to base64 for server processing
      // Use FileSystem for reliable Base64 conversion (works with both camera and library images)
      let base64: string;
      try {
        base64 = await FileSystem.readAsStringAsync(imageUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } catch (fsError) {
        console.warn("FileSystem read failed, using fetch fallback", fsError);
        const response = await fetch(imageUri);
        const blob = await response.blob();
        const reader = new FileReader();
        base64 = await new Promise<string>((resolve, reject) => {
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
      }

      const parsed = await ocrMutation.mutateAsync({ imageBase64: base64 });
      setInvoiceNumber(parsed.invoiceNumber ?? "");
      setVendor(parsed.vendor ?? "");
      setDate(parsed.date ?? new Date().toISOString().split("T")[0]);
      setTotalAmount(parsed.totalAmount?.toString() ?? "");
      setIvaAmount(parsed.ivaAmount?.toString() ?? "");
      setCategory((parsed.category as InvoiceCategory) ?? "Other");
      setTip(""); // Reset tip for manual entry
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStep("review");
    } catch (err) {
      console.error("OCR error:", err);
      // Allow manual entry even if OCR fails
      setStep("review");
      Alert.alert(
        "OCR Notice",
        "Could not automatically extract all fields. Please fill them in manually."
      );
    } finally {
      setProcessing(false);
    }
  }, [imageUri, ocrMutation]);

  const handleSave = useCallback(async () => {
    if (!vendor.trim()) {
      Alert.alert("Required", "Please enter the vendor name.");
      return;
    }
    const total = parseFloat(totalAmount) || 0;
    const iva = parseFloat(ivaAmount) || 0;
    const tipAmount = parseFloat(tip) || 0;
    const invoice: Invoice = {
      id: `cam_${Date.now()}`,
      source: "camera",
      invoiceNumber: invoiceNumber.trim() || `AUTO-${Date.now()}`,
      vendor: vendor.trim(),
      date,
      totalAmount: total,
      ivaAmount: iva,
      baseAmount: total - iva,
      currency: "EUR",
      category,
      notes: notes.trim(),
      tip: tipAmount > 0 ? tipAmount : undefined,
      imageUri: imageUri ?? undefined,
      exportedToSheets: false,
      createdAt: new Date().toISOString(),
    };
    await addInvoice(invoice);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setStep("done");
  }, [vendor, totalAmount, ivaAmount, tip, invoiceNumber, date, category, notes, imageUri, addInvoice]);

  const resetScan = useCallback(() => {
    setStep("capture");
    setImageUri(null);
    setInvoiceNumber("");
    setVendor("");
    setDate(new Date().toISOString().split("T")[0]);
    setTotalAmount("");
    setIvaAmount("");
    setCategory("Other");
    setNotes("");
    setTip("");
  }, []);

  // STEP: CAPTURE
  if (step === "capture") {
    return (
      <ScreenContainer containerClassName="bg-background">
        <View style={styles.captureContainer}>
          <Text style={[styles.captureTitle, { color: colors.foreground }]}>Scan Receipt</Text>
          <Text style={[styles.captureSubtitle, { color: colors.muted }]}>
            Take a photo of your Spanish receipt or invoice
          </Text>

          <View style={[styles.captureArea, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <View style={[styles.captureIcon, { backgroundColor: colors.camera + "15" }]}>
              <IconSymbol name="camera.fill" size={48} color={colors.camera} />
            </View>
            <Text style={[styles.captureHint, { color: colors.muted }]}>
              Position the receipt clearly in frame for best results
            </Text>
          </View>

          <View style={styles.captureActions}>
            <Pressable
              onPress={pickFromCamera}
              style={({ pressed }) => [
                styles.primaryBtn,
                { backgroundColor: colors.camera },
                pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
              ]}
            >
              <IconSymbol name="camera.fill" size={20} color="#fff" />
              <Text style={styles.primaryBtnText}>Open Camera</Text>
            </Pressable>

            <Pressable
              onPress={pickFromLibrary}
              style={({ pressed }) => [
                styles.secondaryBtn,
                { borderColor: colors.border, backgroundColor: colors.surface },
                pressed && { opacity: 0.75 },
              ]}
            >
              <IconSymbol name="photo.fill" size={20} color={colors.primary} />
              <Text style={[styles.secondaryBtnText, { color: colors.primary }]}>
                Choose from Library
              </Text>
            </Pressable>
          </View>
        </View>
      </ScreenContainer>
    );
  }

  // STEP: PREVIEW
  if (step === "preview" && imageUri) {
    return (
      <ScreenContainer containerClassName="bg-background">
        <View style={styles.previewContainer}>
          <Text style={[styles.captureTitle, { color: colors.foreground }]}>Receipt Preview</Text>
          <Text style={[styles.captureSubtitle, { color: colors.muted }]}>
            Confirm the image looks clear before processing
          </Text>

          <Image
            source={{ uri: imageUri }}
            style={[styles.previewImage, { borderColor: colors.border }]}
            resizeMode="contain"
          />

          {processing ? (
            <View style={styles.processingBox}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={[styles.processingText, { color: colors.muted }]}>
                Analyzing receipt with AI...
              </Text>
            </View>
          ) : (
            <View style={styles.previewActions}>
              <Pressable
                onPress={resetScan}
                style={[styles.secondaryBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
              >
                <IconSymbol name="arrow.clockwise" size={18} color={colors.muted} />
                <Text style={[styles.secondaryBtnText, { color: colors.muted }]}>Retake</Text>
              </Pressable>
              <Pressable
                onPress={processImage}
                style={[styles.primaryBtn, { backgroundColor: colors.primary, flex: 1 }]}
              >
                <IconSymbol name="bolt.fill" size={18} color="#fff" />
                <Text style={styles.primaryBtnText}>Process with AI</Text>
              </Pressable>
            </View>
          )}
        </View>
      </ScreenContainer>
    );
  }

  // STEP: REVIEW
  if (step === "review") {
    return (
      <ScreenContainer containerClassName="bg-background">
        <ScrollView contentContainerStyle={styles.reviewContent}>
          <Text style={[styles.captureTitle, { color: colors.foreground }]}>Review & Edit</Text>
          <Text style={[styles.captureSubtitle, { color: colors.muted }]}>
            Verify the extracted data and correct if needed
          </Text>

          {imageUri && (
            <Image
              source={{ uri: imageUri }}
              style={[styles.reviewThumb, { borderColor: colors.border }]}
              resizeMode="cover"
            />
          )}

          <View style={[styles.formCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <FieldRow label="Vendor / Business Name" value={vendor} onChange={setVendor} placeholder="e.g. Mercadona" />
            <FieldRow label="Invoice Number" value={invoiceNumber} onChange={setInvoiceNumber} placeholder="e.g. FAC-2024-001" />
            <FieldRow label="Date (YYYY-MM-DD)" value={date} onChange={setDate} placeholder="2024-01-15" />
            <FieldRow label="Total Amount (€)" value={totalAmount} onChange={setTotalAmount} keyboardType="decimal-pad" placeholder="0.00" />
            <FieldRow label="IVA Amount (€)" value={ivaAmount} onChange={setIvaAmount} keyboardType="decimal-pad" placeholder="0.00" />
            <FieldRow label="Tip (€) - optional" value={tip} onChange={setTip} keyboardType="decimal-pad" placeholder="0.00" />
            <FieldRow label="Notes (optional)" value={notes} onChange={setNotes} placeholder="Any additional notes" />
          </View>

          <Text style={[styles.fieldLabel, { color: colors.muted, marginBottom: 8 }]}>Category</Text>
          <CategoryPicker value={category} onChange={setCategory} />

          <View style={styles.reviewActions}>
            <Pressable
              onPress={resetScan}
              style={[styles.secondaryBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
            >
              <Text style={[styles.secondaryBtnText, { color: colors.muted }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSave}
              style={[styles.primaryBtn, { backgroundColor: colors.primary, flex: 1 }]}
            >
              <IconSymbol name="checkmark.circle.fill" size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>Save Invoice</Text>
            </Pressable>
          </View>
        </ScrollView>
      </ScreenContainer>
    );
  }

  // STEP: DONE
  return (
    <ScreenContainer containerClassName="bg-background">
      <View style={styles.doneContainer}>
        <View style={[styles.doneIcon, { backgroundColor: colors.success + "20" }]}>
          <IconSymbol name="checkmark.circle.fill" size={56} color={colors.success} />
        </View>
        <Text style={[styles.doneTitle, { color: colors.foreground }]}>Invoice Saved!</Text>
        <Text style={[styles.doneDesc, { color: colors.muted }]}>
          The receipt has been saved. You can export it to Google Sheets from the Receipts list.
        </Text>
        <Pressable
          onPress={resetScan}
          style={[styles.primaryBtn, { backgroundColor: colors.primary }]}
        >
          <IconSymbol name="camera.fill" size={18} color="#fff" />
          <Text style={styles.primaryBtnText}>Scan Another</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push("/(tabs)/receipts" as never)}
          style={[styles.secondaryBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
        >
          <Text style={[styles.secondaryBtnText, { color: colors.primary }]}>View All Receipts</Text>
        </Pressable>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  captureContainer: { flex: 1, padding: 24, gap: 20 },
  captureTitle: { fontSize: 26, fontWeight: "700" },
  captureSubtitle: { fontSize: 14, lineHeight: 20, marginTop: -12 },
  captureArea: {
    flex: 1,
    borderRadius: 20,
    borderWidth: 2,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 32,
  },
  captureIcon: { width: 96, height: 96, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  captureHint: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  captureActions: { gap: 12 },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 14,
  },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 14,
    borderWidth: 1,
  },
  secondaryBtnText: { fontSize: 15, fontWeight: "500" },
  previewContainer: { flex: 1, padding: 24, gap: 16 },
  previewImage: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 1,
    maxHeight: 400,
    width: "100%",
  },
  processingBox: { alignItems: "center", gap: 12, paddingVertical: 20 },
  processingText: { fontSize: 14 },
  previewActions: { flexDirection: "row", gap: 12 },
  reviewContent: { padding: 20, paddingBottom: 48, gap: 16 },
  reviewThumb: {
    width: "100%",
    height: 160,
    borderRadius: 12,
    borderWidth: 1,
  },
  formCard: { borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  fieldRow: { padding: 14, borderBottomWidth: 1, borderBottomColor: "transparent" },
  fieldLabel: { fontSize: 11, fontWeight: "600", letterSpacing: 0.3, marginBottom: 6 },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  categoryScroll: { marginBottom: 8 },
  catPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    marginRight: 8,
  },
  catPillText: { fontSize: 13, fontWeight: "500" },
  reviewActions: { flexDirection: "row", gap: 12, marginTop: 8 },
  doneContainer: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 16 },
  doneIcon: { width: 100, height: 100, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  doneTitle: { fontSize: 26, fontWeight: "700" },
  doneDesc: { fontSize: 14, textAlign: "center", lineHeight: 22 },
});
