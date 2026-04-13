import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import { useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { APP_SCAN_STEP_TITLE } from "@/constants/app-typography";
import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useInvoices } from "@/hooks/use-invoices";
import {
  type Invoice,
  type InvoiceCategory,
  type MeatItem,
  hasMeatLineItems,
} from "@/shared/invoice-types";
import { getOcrAlertForUser } from "@/lib/ocr-user-message";
import { trpc } from "@/lib/trpc";
import { translucentTile } from "@/lib/translucent-ui";

/** iOS 15+ ImagePicker defaults to `.current` (keeps HEIC). Use `.compatible` so library/camera return JPEG when possible — avoids server sharp/heic issues. */
const IOS_PICKER_HEIC_SAFE =
  Platform.OS === "ios"
    ? {
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      }
    : {};

function approxDecodedBytesFromBase64(b64: string): number {
  const s = b64.replace(/\s/g, "");
  if (!s.length) return 0;
  return Math.floor((s.length * 3) / 4);
}

/**
 * Max decoded size we send from the client (Express accepts 50mb; server shrinks for Claude).
 * Avoids `expo-image-manipulator`, which requires native code and breaks on Web / some Expo Go setups.
 */
const MAX_CLIENT_RECEIPT_DECODED_BYTES = 14_000_000;

/** Encode image as base64 for OCR/upload — server-side sharp normalizes size & format. */
async function encodeReceiptImageForServer(
  uri: string,
  fallbackBase64: string | null,
): Promise<string | undefined> {
  const okPayload = (b64: string): string | undefined => {
    const b = b64.replace(/\s/g, "");
    if (b.length < 64) return undefined;
    if (approxDecodedBytesFromBase64(b) > MAX_CLIENT_RECEIPT_DECODED_BYTES) return undefined;
    return b;
  };

  if (fallbackBase64) {
    const v = okPayload(fallbackBase64);
    if (v) return v;
  }
  try {
    const raw = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return okPayload(raw);
  } catch {
    return undefined;
  }
}

type ScanStep = "capture" | "preview" | "review" | "done";

const PREDEFINED_CATEGORIES: InvoiceCategory[] = [
  "Meat",
  "Seafood",
  "Vegetables",
  "Restaurant",
  "Gas Station",
  "Water",
  "Other",
  "Asian Market",
  "Caviar",
  "Truffle",
  "Organic Farm",
  "Beverages",
  "Hardware Store",
];

function CategoryPicker({
  value,
  onChange,
  onCustomInput,
}: {
  value: InvoiceCategory;
  onChange: (v: InvoiceCategory) => void;
  onCustomInput?: () => void;
}) {
  const colors = useColors();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}>
      {PREDEFINED_CATEGORIES.map((cat: InvoiceCategory) => (
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
      {onCustomInput && (
        <Pressable
          onPress={onCustomInput}
          style={[styles.catPill, { borderStyle: "dashed" }]}
        >
          <Text style={[styles.catPillText, { color: colors.muted }]}>+ Custom</Text>
        </Pressable>
      )}
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
  const tile = translucentTile(colors);
  const router = useRouter();
  const { addInvoice, checkDuplicate } = useInvoices();
  const [step, setStep] = useState<ScanStep>("capture");
  const [imageUri, setImageUri] = useState<string | null>(null);
  /** Prefer Expo ImagePicker base64 (reliable on iOS/Android); FileSystem read is fallback */
  const [imageBase64FromPicker, setImageBase64FromPicker] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  // Extracted fields
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [vendor, setVendor] = useState("");
  const [date, setDate] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [ivaAmount, setIvaAmount] = useState("");
  const [category, setCategory] = useState<InvoiceCategory>("Other");
  const [notes, setNotes] = useState("");
  const [tip, setTip] = useState("");
  const [items, setItems] = useState<MeatItem[]>([]);
  const [showCustomCategoryInput, setShowCustomCategoryInput] = useState(false);
  const [customCategoryInput, setCustomCategoryInput] = useState("");

  const [duplicateWarning, setDuplicateWarning] = useState<Invoice | null>(null);
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);
  const [pendingInvoice, setPendingInvoice] = useState<Invoice | null>(null);
  /** Prevents double Save / Continue / Process from creating duplicate rows (rapid taps). */
  const persistScanRef = useRef(false);
  const processScanRef = useRef(false);

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
      quality: 0.7,
      base64: true,
      allowsEditing: false,
      ...IOS_PICKER_HEIC_SAFE,
    });
    if (!result.canceled && result.assets[0]) {
      const a = result.assets[0];
      setImageUri(a.uri);
      setImageBase64FromPicker(a.base64 ?? null);
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
      quality: 0.7,
      base64: true,
      allowsEditing: false,
      ...IOS_PICKER_HEIC_SAFE,
    });
    if (!result.canceled && result.assets[0]) {
      const a = result.assets[0];
      setImageUri(a.uri);
      setImageBase64FromPicker(a.base64 ?? null);
      setStep("preview");
    }
  }, []);

  const processImage = useCallback(async () => {
    if (!imageUri) return;
    if (processScanRef.current) return;
    processScanRef.current = true;
    setProcessing(true);
    try {
      let base64 = await encodeReceiptImageForServer(imageUri, imageBase64FromPicker);

      if (!base64) {
        try {
          const response = await fetch(imageUri);
          const blob = await response.blob();
          const reader = new FileReader();
          base64 = await new Promise<string>((resolve, reject) => {
            reader.onloadend = () => {
              const r = reader.result as string;
              const b64 = r.split(",")[1];
              if (!b64) reject(new Error("Failed to extract base64 from blob"));
              else resolve(b64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch (fetchErr) {
          console.warn("Fetch fallback for image failed:", fetchErr);
        }
      }

      if (!base64) {
        Alert.alert(
          "Could not read image",
          "This photo could not be loaded for scanning. Try the camera, or pick one photo at a time.",
        );
        return;
      }

      const b64Payload = base64.replace(/\s/g, "");
      if (b64Payload.length < 64) {
        Alert.alert(
          "Could not read image",
          "This photo could not be loaded for scanning. Try the camera, or pick one photo at a time. If it keeps happening, choose a different photo or lower resolution in system settings.",
        );
        return;
      }

      const parsed = await ocrMutation.mutateAsync({ imageBase64: b64Payload });

      const nextCategory = (parsed.category as InvoiceCategory) ?? "Other";
      setCategory(nextCategory);
      // Keep butcher-style line items whenever the model returned them (category is often wrong for carnicería).
      if (hasMeatLineItems(parsed.items)) {
        setItems(parsed.items as MeatItem[]);
      } else {
        setItems([]);
      }

      setInvoiceNumber(parsed.invoiceNumber ?? "");
      setVendor(parsed.vendor ?? "");
      setDate(
        parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date)) ? String(parsed.date) : "",
      );
      setTotalAmount(parsed.totalAmount?.toString() ?? "");
      setIvaAmount(parsed.ivaAmount?.toString() ?? "");
      setTip(""); // Reset tip for manual entry
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStep("review");
    } catch (err) {
      console.error("OCR error:", err);
      const { title, message } = getOcrAlertForUser(err);
      setStep("review");
      Alert.alert(title, message);
    } finally {
      processScanRef.current = false;
      setProcessing(false);
    }
  }, [imageUri, ocrMutation, imageBase64FromPicker]);

  const handleSave = useCallback(async () => {
    if (!vendor.trim()) {
      Alert.alert("Required", "Please enter the vendor name.");
      return;
    }
    if (persistScanRef.current) return;
    persistScanRef.current = true;
    try {
      const total = parseFloat(totalAmount) || 0;
      const iva = parseFloat(ivaAmount) || 0;
      const tipAmount = parseFloat(tip) || 0;

      // Same resize path as OCR — smaller payload for storage upload + Sheets.
      let imageUrl: string | undefined = undefined;
      if (imageUri) {
        const b64 = await encodeReceiptImageForServer(imageUri, imageBase64FromPicker);
        if (b64) {
          imageUrl = `data:image/jpeg;base64,${b64}`;
        }
      }

      const invoice: Invoice = {
        id: `cam_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        source: "camera",
        invoiceNumber: invoiceNumber.trim() || `AUTO-${Date.now()}`,
        vendor: vendor.trim(),
        date: date.trim() || new Date().toISOString().split("T")[0],
        totalAmount: total,
        ivaAmount: iva,
        baseAmount: total - iva,
        currency: "EUR",
        category,
        notes: notes.trim(),
        tip: tipAmount > 0 ? tipAmount : undefined,
        imageUri: imageUrl ?? undefined,
        items: hasMeatLineItems(items) ? items : undefined,
        exportedToSheets: false,
        createdAt: new Date().toISOString(),
      };

      const duplicate = await checkDuplicate(invoice);
      if (duplicate) {
        setDuplicateWarning(duplicate);
        setPendingInvoice(invoice);
        setShowDuplicateDialog(true);
        return;
      }

      await addInvoice(invoice);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStep("done");
    } finally {
      persistScanRef.current = false;
    }
  }, [
    vendor,
    totalAmount,
    ivaAmount,
    tip,
    invoiceNumber,
    date,
    category,
    notes,
    imageUri,
    imageBase64FromPicker,
    addInvoice,
    checkDuplicate,
    items,
  ]);

  const resetScan = useCallback(() => {
    setStep("capture");
    setImageUri(null);
    setImageBase64FromPicker(null);
    setInvoiceNumber("");
    setVendor("");
    setDate("");
    setTotalAmount("");
    setIvaAmount("");
    setCategory("Other");
    setNotes("");
    setTip("");
    setItems([]);
    setShowDuplicateDialog(false);
    setDuplicateWarning(null);
    setPendingInvoice(null);
  }, []);

  const handleDuplicateAction = useCallback(
    async (action: "skip" | "continue") => {
      setShowDuplicateDialog(false);

      if (action === "continue" && pendingInvoice) {
        if (persistScanRef.current) {
          setPendingInvoice(null);
          setDuplicateWarning(null);
          return;
        }
        persistScanRef.current = true;
        try {
          await addInvoice(pendingInvoice);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          setStep("done");
        } finally {
          persistScanRef.current = false;
        }
      } else {
        resetScan();
      }

      setPendingInvoice(null);
      setDuplicateWarning(null);
    },
    [pendingInvoice, addInvoice, resetScan],
  );

  // Duplicate warning dialog
  if (showDuplicateDialog && duplicateWarning) {
    return (
      <ScreenContainer containerClassName="bg-background">
        <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 16 }}>
          <View style={{ alignItems: "center", gap: 12 }}>
            <View style={[{ width: 80, height: 80, borderRadius: 40, alignItems: "center", justifyContent: "center" }, { backgroundColor: colors.warning + "20" }]}>
              <IconSymbol name="exclamationmark.triangle.fill" size={40} color={colors.warning} />
            </View>
            <Text style={[styles.captureTitle, { color: colors.foreground, textAlign: "center" }]}>Duplicate Receipt</Text>
          </View>

          <View style={[styles.formCard, { backgroundColor: colors.surface, borderColor: colors.border, padding: 16 }]}>
            <Text style={[styles.fieldLabel, { color: colors.muted, marginBottom: 8 }]}>
              This matches an invoice already saved in the app (and may already be in Google Sheets if you exported it):
            </Text>
            <Text style={[styles.fieldLabel, { color: colors.foreground, fontSize: 14, marginBottom: 4 }]}>Vendor: {duplicateWarning.vendor}</Text>
            <Text style={[styles.fieldLabel, { color: colors.foreground, fontSize: 14, marginBottom: 4 }]}>Date: {duplicateWarning.date}</Text>
            <Text style={[styles.fieldLabel, { color: colors.foreground, fontSize: 14 }]}>Amount: €{duplicateWarning.totalAmount.toFixed(2)}</Text>
          </View>

          <View style={styles.reviewActions}>
            <Pressable
              onPress={() => handleDuplicateAction("skip")}
              style={[styles.secondaryBtn, { borderColor: colors.border, backgroundColor: colors.surface, flex: 1 }]}
            >
              <Text style={[styles.secondaryBtnText, { color: colors.muted }]}>Skip</Text>
            </Pressable>
            <Pressable
              onPress={() => handleDuplicateAction("continue")}
              style={[styles.primaryBtn, { backgroundColor: colors.primary, flex: 1 }]}
            >
              <Text style={[styles.primaryBtnText, styles.primaryBtnLabel, { color: "#FFFFFF" }]}>
                Continue Anyway
              </Text>
            </Pressable>
          </View>
        </View>
      </ScreenContainer>
    );
  }

  // STEP: CAPTURE
  if (step === "capture") {
    return (
      <ScreenContainer containerClassName="bg-background">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.captureScrollContent}
        >
          <View style={styles.captureContainer}>
            <Text style={[styles.captureTitle, { color: colors.foreground }]}>Scan Receipt</Text>
            <Text style={[styles.captureSubtitle, { color: colors.muted }]}>
              Add a clear photo — paper receipts work best in good light
            </Text>

            <View
              style={[
                styles.captureActionsShell,
                { backgroundColor: tile.bg, borderColor: tile.border },
              ]}
            >
              <Text style={[styles.captureIntro, { color: colors.muted }]}>
                Use the camera for a new shot, or Photos if you already saved the receipt.
              </Text>
              <View style={styles.captureActions}>
                <Pressable
                  onPress={pickFromCamera}
                  accessibilityRole="button"
                  accessibilityLabel="Take a new photo with the camera"
                  style={({ pressed }) => [
                    styles.captureActionBtn,
                    styles.capturePrimaryAction,
                    { backgroundColor: colors.camera },
                    pressed && { opacity: 0.88, transform: [{ scale: 0.985 }] },
                  ]}
                >
                  <View style={[styles.captureActionIcon, { backgroundColor: "#FFFFFF26" }]}>
                    <IconSymbol name="camera.fill" size={24} color="#FFFFFF" />
                  </View>
                  <View style={styles.captureActionText}>
                    <Text style={[styles.capturePrimaryTitle, { color: "#FFFFFF" }]}>Take photo</Text>
                    <Text style={[styles.capturePrimarySub, { color: "#FFFFFFCC" }]}>
                      Opens your camera — hold the receipt flat and fill the frame
                    </Text>
                  </View>
                  <IconSymbol name="chevron.right" size={18} color="#FFFFFF99" />
                </Pressable>

                <Pressable
                  onPress={() => pickFromLibrary()}
                  accessibilityRole="button"
                  accessibilityLabel="Choose an existing image from your photo library"
                  style={({ pressed }) => [
                    styles.captureActionBtn,
                    styles.captureSecondaryAction,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.surface,
                    },
                    pressed && { opacity: 0.82 },
                  ]}
                >
                  <View style={[styles.captureActionIcon, { backgroundColor: colors.primary + "20" }]}>
                    <IconSymbol name="photo.on.rectangle.angled" size={22} color={colors.primary} />
                  </View>
                  <View style={styles.captureActionText}>
                    <Text style={[styles.captureSecondaryTitle, { color: colors.foreground }]}>Choose from Photos</Text>
                    <Text style={[styles.captureSecondarySub, { color: colors.muted }]}>
                      Pick a receipt image you already saved
                    </Text>
                  </View>
                  <IconSymbol name="chevron.right" size={18} color={colors.muted} />
                </Pressable>
              </View>
            </View>
          </View>
        </ScrollView>
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
                <Text style={[styles.primaryBtnText, styles.primaryBtnLabel, { color: "#FFFFFF" }]}>
                  Process with AI
                </Text>
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
            <FieldRow
              label="Invoice Number"
              value={invoiceNumber}
              onChange={setInvoiceNumber}
              placeholder="e.g. FAC-2024-001 (optional if not on receipt)"
            />
            <FieldRow label="Date (YYYY-MM-DD)" value={date} onChange={setDate} placeholder="2024-01-15" />
            <FieldRow label="Total Amount (€)" value={totalAmount} onChange={setTotalAmount} keyboardType="decimal-pad" placeholder="0.00" />
            <FieldRow label="IVA amount (€)" value={ivaAmount} onChange={setIvaAmount} keyboardType="decimal-pad" placeholder="0.00" />
            <FieldRow label="Tip (€) - optional" value={tip} onChange={setTip} keyboardType="decimal-pad" placeholder="0.00" />
            <FieldRow label="Notes (optional)" value={notes} onChange={setNotes} placeholder="Any additional notes" />
          </View>

          <Text style={[styles.fieldLabel, { color: colors.muted, marginBottom: 8 }]}>Category</Text>
          <CategoryPicker value={category} onChange={setCategory} onCustomInput={() => setShowCustomCategoryInput(true)} />
          {showCustomCategoryInput && (
            <View style={[styles.customCategoryBox, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: 12 }]}>
              <Text style={[styles.customCategoryLabel, { color: colors.foreground }]}>Enter Custom Category</Text>
              <TextInput
                style={[
                  styles.customCategoryInput,
                  { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background },
                ]}
                value={customCategoryInput}
                onChangeText={setCustomCategoryInput}
                placeholder="e.g., Bakery, Pharmacy"
                placeholderTextColor={colors.muted}
                returnKeyType="done"
              />
              <View style={styles.customCategoryActions}>
                <Pressable
                  onPress={() => {
                    setShowCustomCategoryInput(false);
                    setCustomCategoryInput("");
                  }}
                  style={[styles.customCategoryBtn, { borderColor: colors.border }]}
                >
                  <Text style={[styles.customCategoryBtnText, { color: colors.muted }]}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    if (customCategoryInput.trim()) {
                      setCategory(customCategoryInput.trim() as InvoiceCategory);
                      setShowCustomCategoryInput(false);
                      setCustomCategoryInput("");
                    }
                  }}
                  style={[styles.customCategoryBtn, { backgroundColor: colors.primary }]}
                >
                  <Text style={[styles.customCategoryBtnText, { color: "#fff" }]}>Save</Text>
                </Pressable>
              </View>
            </View>
          )}

          {items.length > 0 && (
            <View style={[styles.formCard, { backgroundColor: colors.surface, borderColor: colors.border, marginTop: 16 }]}>
              <Text style={[styles.fieldLabel, { color: colors.foreground, marginBottom: 12 }]}>Meat / butcher line items</Text>
              {items.map((item, idx) => (
                <View key={idx} style={[styles.meatItemCard, { borderColor: colors.border, backgroundColor: colors.background }]}>
                  <Text style={[styles.meatItemText, { color: colors.foreground }]}>
                    {item.partName}
                  </Text>
                  <Text style={[styles.meatItemSubtext, { color: colors.muted }]}>
                    {item.quantity.toFixed(2)} {item.unit} @ {item.pricePerUnit.toFixed(2)} €/{item.unit} = {item.total.toFixed(2)} €
                  </Text>
                </View>
              ))}
            </View>
          )}

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
              <Text style={[styles.primaryBtnText, styles.primaryBtnLabel, { color: "#FFFFFF" }]}>
                Save Invoice
              </Text>
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
          <Text style={[styles.primaryBtnText, styles.primaryBtnLabel, { color: "#FFFFFF" }]}>Scan Another</Text>
        </Pressable>
        <Pressable
          onPress={() => router.navigate("/receipts")}
          style={[styles.secondaryBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
        >
          <Text style={[styles.secondaryBtnText, { color: colors.primary }]}>View All Receipts</Text>
        </Pressable>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  captureScrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 32,
  },
  captureContainer: { gap: 16 },
  captureTitle: APP_SCAN_STEP_TITLE,
  captureSubtitle: { fontSize: 14, lineHeight: 20, marginTop: -10 },
  captureIntro: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 6,
    paddingTop: 4,
    paddingBottom: 12,
  },
  captureActionsShell: {
    borderRadius: 18,
    borderWidth: 1.5,
    padding: 12,
    marginTop: 0,
  },
  captureActions: { gap: 10 },
  captureActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 72,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  capturePrimaryAction: {
    minHeight: 84,
  },
  captureSecondaryAction: {
    borderWidth: 1,
  },
  capturePrimaryTitle: { fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
  capturePrimarySub: { fontSize: 12, lineHeight: 16, marginTop: 2, fontWeight: "500" },
  captureSecondaryTitle: { fontSize: 16, fontWeight: "700", letterSpacing: -0.2 },
  captureSecondarySub: { fontSize: 12, lineHeight: 16, marginTop: 2, fontWeight: "500" },
  captureActionIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  captureActionText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  captureActionSubtleText: {
    color: "#D8DEEA",
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "500",
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
  },
  primaryBtnText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  primaryBtnLabel: { flexShrink: 0, includeFontPadding: false },
  secondaryBtnLabel: { flexShrink: 0, includeFontPadding: false },
  secondaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
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
  meatItemCard: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginBottom: 8,
  },
  meatItemText: { fontSize: 14, fontWeight: "600", marginBottom: 4 },
  meatItemSubtext: { fontSize: 12, lineHeight: 16 },
  customCategoryBox: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  customCategoryLabel: { fontSize: 13, fontWeight: "600" },
  customCategoryInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  customCategoryActions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  customCategoryBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  customCategoryBtnText: { fontSize: 13, fontWeight: "600" },
  doneContainer: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 16 },
  doneIcon: { width: 100, height: 100, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  doneTitle: APP_SCAN_STEP_TITLE,
  doneDesc: { fontSize: 14, textAlign: "center", lineHeight: 22 },
});
