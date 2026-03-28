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
import type { Invoice, InvoiceCategory, MeatItem } from "@/shared/invoice-types";
import { trpc } from "@/lib/trpc";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

type ScanStep = "capture" | "preview" | "review" | "done" | "batch-review";

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
  const router = useRouter();
  const { addInvoice, checkDuplicate } = useInvoices();
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
  const [items, setItems] = useState<MeatItem[]>([]);
  const [showCustomCategoryInput, setShowCustomCategoryInput] = useState(false);
  const [customCategoryInput, setCustomCategoryInput] = useState("");

  // Batch upload state
  const [batchImages, setBatchImages] = useState<string[]>([]);
  const [currentBatchIndex, setCurrentBatchIndex] = useState(0);
  const [batchInvoices, setBatchInvoices] = useState<Invoice[]>([]);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<Invoice | null>(null);
  const [showDuplicateDialog, setShowDuplicateDialog] = useState(false);
  const [pendingInvoice, setPendingInvoice] = useState<Invoice | null>(null);
  const [duplicateAction, setDuplicateAction] = useState<"skip" | "continue" | null>(null);

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

  const pickFromLibrary = useCallback(async (allowMultiple: boolean = false) => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission Required", "Photo library permission is needed.");
      return;
    }
    const options: any = {
      mediaTypes: ["images"],
      quality: 0.85,
      base64: true,
      allowsEditing: !allowMultiple,
    };
    
    if (allowMultiple) {
      options.allowsMultiple = true;
    } else {
      options.aspect = [3, 4];
    }
    
    const result = await ImagePicker.launchImageLibraryAsync(options);
    if (!result.canceled && result.assets.length > 0) {
      if (allowMultiple && result.assets.length > 1) {
        const imageUris = result.assets.map((asset) => asset.uri);
        setBatchImages(imageUris);
        setCurrentBatchIndex(0);
        setIsBatchMode(true);
        setBatchInvoices([]);
        setImageUri(imageUris[0]);
        setStep("preview");
      } else {
        setImageUri(result.assets[0].uri);
        setIsBatchMode(false);
        setStep("preview");
      }
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
      
      // Extract items if present (for meat vendors)
      if (parsed.items && Array.isArray(parsed.items)) {
        setItems(parsed.items);
      }

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

  const handleBatchNext = useCallback(async () => {
    // Save current invoice
    if (vendor.trim()) {
      const total = parseFloat(totalAmount) || 0;
      const iva = parseFloat(ivaAmount) || 0;
      const tipAmount = parseFloat(tip) || 0;
      const invoice: Invoice = {
        id: `cam_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
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
        items: items.length > 0 ? items : undefined,
        exportedToSheets: false,
        createdAt: new Date().toISOString(),
      };
      setBatchInvoices([...batchInvoices, invoice]);
    }

    // Move to next image
    if (currentBatchIndex < batchImages.length - 1) {
      setCurrentBatchIndex(currentBatchIndex + 1);
      setImageUri(batchImages[currentBatchIndex + 1]);
      setInvoiceNumber("");
      setVendor("");
      setDate(new Date().toISOString().split("T")[0]);
      setTotalAmount("");
      setIvaAmount("");
      setCategory("Other");
      setNotes("");
      setTip("");
      setItems([]);
      setProcessing(false);
      setStep("preview");
    } else {
      setStep("batch-review");
    }
  }, [currentBatchIndex, batchImages, vendor, totalAmount, ivaAmount, tip, invoiceNumber, date, category, notes, imageUri, items, batchInvoices]);

  const handleBatchPrevious = useCallback(() => {
    if (currentBatchIndex > 0) {
      setCurrentBatchIndex(currentBatchIndex - 1);
      setImageUri(batchImages[currentBatchIndex - 1]);
      setInvoiceNumber("");
      setVendor("");
      setDate(new Date().toISOString().split("T")[0]);
      setTotalAmount("");
      setIvaAmount("");
      setCategory("Other");
      setNotes("");
      setTip("");
      setItems([]);
      setProcessing(false);
      setStep("preview");
    }
  }, [currentBatchIndex, batchImages]);

  const handleSave = useCallback(async () => {
    if (!vendor.trim()) {
      Alert.alert("Required", "Please enter the vendor name.");
      return;
    }
    const total = parseFloat(totalAmount) || 0;
    const iva = parseFloat(ivaAmount) || 0;
    const tipAmount = parseFloat(tip) || 0;
    const invoice: Invoice = {
      id: `cam_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
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
      items: items.length > 0 ? items : undefined,
      exportedToSheets: false,
      createdAt: new Date().toISOString(),
    };
    
    // Check for duplicates
    const duplicate = checkDuplicate(invoice);
    if (duplicate) {
      setDuplicateWarning(duplicate);
      setPendingInvoice(invoice);
      setShowDuplicateDialog(true);
      return;
    }
    
    if (isBatchMode) {
      await handleBatchNext();
    } else {
      await addInvoice(invoice);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStep("done");
    }
  }, [vendor, totalAmount, ivaAmount, tip, invoiceNumber, date, category, notes, imageUri, addInvoice, isBatchMode, handleBatchNext, checkDuplicate]);

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
    setItems([]);
    setBatchImages([]);
    setCurrentBatchIndex(0);
    setBatchInvoices([]);
    setIsBatchMode(false);
    setShowDuplicateDialog(false);
    setDuplicateWarning(null);
    setPendingInvoice(null);
  }, []);

  const handleDuplicateAction = useCallback(async (action: "skip" | "continue") => {
    setShowDuplicateDialog(false);
    
    if (action === "continue" && pendingInvoice) {
      if (isBatchMode) {
        setBatchInvoices([...batchInvoices, pendingInvoice]);
        if (currentBatchIndex < batchImages.length - 1) {
          setCurrentBatchIndex(currentBatchIndex + 1);
          setImageUri(batchImages[currentBatchIndex + 1]);
          setInvoiceNumber("");
          setVendor("");
          setDate(new Date().toISOString().split("T")[0]);
          setTotalAmount("");
          setIvaAmount("");
          setCategory("Other");
          setNotes("");
          setTip("");
          setItems([]);
          setProcessing(false);
          setStep("preview");
        } else {
          setStep("batch-review");
        }
      } else {
        await addInvoice(pendingInvoice);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setStep("done");
      }
    } else {
      if (isBatchMode) {
        if (currentBatchIndex < batchImages.length - 1) {
          setCurrentBatchIndex(currentBatchIndex + 1);
          setImageUri(batchImages[currentBatchIndex + 1]);
          setInvoiceNumber("");
          setVendor("");
          setDate(new Date().toISOString().split("T")[0]);
          setTotalAmount("");
          setIvaAmount("");
          setCategory("Other");
          setNotes("");
          setTip("");
          setItems([]);
          setProcessing(false);
          setStep("preview");
        } else {
          setStep("batch-review");
        }
      } else {
        resetScan();
      }
    }
    
    setPendingInvoice(null);
    setDuplicateWarning(null);
  }, [pendingInvoice, isBatchMode, currentBatchIndex, batchImages, batchInvoices, addInvoice, resetScan]);

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
            <Text style={[styles.fieldLabel, { color: colors.muted, marginBottom: 8 }]}>This receipt appears to be a duplicate:</Text>
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
              <Text style={styles.primaryBtnText}>Continue Anyway</Text>
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
              onPress={() => pickFromLibrary(false)}
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

            <Pressable
              onPress={() => pickFromLibrary(true)}
              style={({ pressed }) => [
                styles.secondaryBtn,
                { borderColor: colors.border, backgroundColor: colors.surface },
                pressed && { opacity: 0.75 },
              ]}
            >
              <IconSymbol name="photo.fill" size={20} color={colors.primary} />
              <Text style={[styles.secondaryBtnText, { color: colors.primary }]}>
                Batch Upload (Multiple)
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

          {isBatchMode && batchImages.length > 0 && (
            <View style={[styles.batchIndicator, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.batchIndicatorText, { color: colors.muted }]}>
                Photo {currentBatchIndex + 1} of {batchImages.length}
              </Text>
              <View style={styles.batchProgressBar}>
                <View
                  style={[
                    styles.batchProgressFill,
                    {
                      backgroundColor: colors.primary,
                      width: `${((currentBatchIndex + 1) / batchImages.length) * 100}%`,
                    },
                  ]}
                />
              </View>
            </View>
          )}

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
              {isBatchMode && currentBatchIndex < batchImages.length - 1 ? (
                <Pressable
                  onPress={() => {
                    setCurrentBatchIndex(currentBatchIndex + 1);
                    setImageUri(batchImages[currentBatchIndex + 1]);
                  }}
                  style={[styles.primaryBtn, { backgroundColor: colors.primary, flex: 1 }]}
                >
                  <IconSymbol name="plus.circle.fill" size={18} color="#fff" />
                  <Text style={styles.primaryBtnText}>Add Next Photo</Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={processImage}
                  style={[styles.primaryBtn, { backgroundColor: colors.primary, flex: 1 }]}
                >
                  <IconSymbol name="bolt.fill" size={18} color="#fff" />
                  <Text style={styles.primaryBtnText}>{isBatchMode ? "Analyze All" : "Process with AI"}</Text>
                </Pressable>
              )}
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
              <Text style={[styles.fieldLabel, { color: colors.foreground, marginBottom: 12 }]}>Meat Items</Text>
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
            {isBatchMode && currentBatchIndex > 0 && (
              <Pressable
                onPress={handleBatchPrevious}
                style={[styles.secondaryBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
              >
                <IconSymbol name="arrow.left" size={18} color={colors.muted} />
                <Text style={[styles.secondaryBtnText, { color: colors.muted }]}>Previous</Text>
              </Pressable>
            )}
            {isBatchMode && currentBatchIndex === 0 && (
              <Pressable
                onPress={resetScan}
                style={[styles.secondaryBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
              >
                <Text style={[styles.secondaryBtnText, { color: colors.muted }]}>Cancel</Text>
              </Pressable>
            )}
            {!isBatchMode && (
              <Pressable
                onPress={resetScan}
                style={[styles.secondaryBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
              >
                <Text style={[styles.secondaryBtnText, { color: colors.muted }]}>Cancel</Text>
              </Pressable>
            )}
            <Pressable
              onPress={handleSave}
              style={[styles.primaryBtn, { backgroundColor: colors.primary, flex: 1 }]}
            >
              <IconSymbol name={isBatchMode && currentBatchIndex < batchImages.length - 1 ? "arrow.right" : "checkmark.circle.fill"} size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>
                {isBatchMode ? (currentBatchIndex < batchImages.length - 1 ? "Next" : "Review All") : "Save Invoice"}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </ScreenContainer>
    );
  }

  // STEP: BATCH REVIEW
  if (step === "batch-review" && isBatchMode) {
    return (
      <ScreenContainer containerClassName="bg-background">
        <ScrollView contentContainerStyle={styles.reviewContent}>
          <Text style={[styles.captureTitle, { color: colors.foreground }]}>Review Batch ({batchInvoices.length} invoices)</Text>
          <Text style={[styles.captureSubtitle, { color: colors.muted }]}>
            All receipts processed. Ready to export?
          </Text>

          {batchInvoices.map((inv, idx) => (
            <View key={idx} style={[styles.formCard, { backgroundColor: colors.surface, borderColor: colors.border, marginBottom: 12 }]}>
              <View style={{ padding: 12 }}>
                <Text style={[styles.fieldLabel, { color: colors.foreground, marginBottom: 4 }]}>
                  {idx + 1}. {inv.vendor}
                </Text>
                <Text style={[styles.fieldLabel, { color: colors.muted, fontSize: 12 }]}>
                  {inv.date} • €{inv.totalAmount.toFixed(2)}
                </Text>
              </View>
            </View>
          ))}

          <View style={styles.reviewActions}>
            <Pressable
              onPress={() => {
                setCurrentBatchIndex(0);
                setImageUri(batchImages[0]);
                setStep("preview");
              }}
              style={[styles.secondaryBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
            >
              <Text style={[styles.secondaryBtnText, { color: colors.muted }]}>Edit</Text>
            </Pressable>
            <Pressable
              onPress={async () => {
                for (const invoice of batchInvoices) {
                  await addInvoice(invoice);
                }
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                setStep("done");
              }}
              style={[styles.primaryBtn, { backgroundColor: colors.success, flex: 1 }]}
            >
              <IconSymbol name="checkmark.circle.fill" size={18} color="#fff" />
              <Text style={styles.primaryBtnText}>Export All ({batchInvoices.length})</Text>
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
  batchIndicator: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginBottom: 12,
    gap: 8,
  },
  batchIndicatorText: { fontSize: 12, fontWeight: "600" },
  batchProgressBar: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  batchProgressFill: { height: 6, borderRadius: 3 },
  doneContainer: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 16 },
  doneIcon: { width: 100, height: 100, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  doneTitle: { fontSize: 26, fontWeight: "700" },
  doneDesc: { fontSize: 14, textAlign: "center", lineHeight: 22 },
});
