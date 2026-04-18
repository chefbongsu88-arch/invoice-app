import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
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
import { useInvoices } from "@/hooks/use-invoices";
import { getSheetsExportTarget } from "@/lib/sheets-settings";
import { trpc } from "@/lib/trpc";
import type { InvoiceCategory } from "@/shared/invoice-types";

const CATEGORIES: InvoiceCategory[] = [
  "Meat",
  "Mercadona",
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

export default function EditInvoiceScreen() {
  const colors = useColors();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { invoices, updateInvoice } = useInvoices();
  const updateInSheetsMutation = trpc.invoices.updateInvoiceInSheets.useMutation();

  const invoice = invoices.find((inv) => inv.id === id);

  const [saving, setSaving] = useState(false);
  const [vendor, setVendor] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [date, setDate] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [ivaAmount, setIvaAmount] = useState("");
  const [baseAmount, setBaseAmount] = useState("");
  const [category, setCategory] = useState<InvoiceCategory>("Other");
  const [notes, setNotes] = useState("");

  // Pre-fill fields when invoice loads
  useEffect(() => {
    if (invoice) {
      setVendor(invoice.vendor ?? "");
      setInvoiceNumber(invoice.invoiceNumber ?? "");
      setDate(invoice.date ?? "");
      setTotalAmount(String(invoice.totalAmount ?? ""));
      setIvaAmount(String(invoice.ivaAmount ?? ""));
      setBaseAmount(String(invoice.baseAmount ?? ""));
      setCategory((invoice.category as InvoiceCategory) ?? "Other");
      setNotes(invoice.notes ?? "");
    }
  }, [invoice?.id]);

  const handleSave = useCallback(async () => {
    if (!vendor.trim()) {
      Alert.alert("Vendor Required", "Please enter the vendor/company name.");
      return;
    }
    if (!totalAmount.trim()) {
      Alert.alert("Amount Required", "Please enter the total amount.");
      return;
    }
    if (!invoice) return;

    setSaving(true);
    try {
      const total  = parseFloat(totalAmount);
      const iva    = parseFloat(ivaAmount || "0");
      const base   = parseFloat(baseAmount || String(total - iva));

      const patch = {
        vendor:        vendor.trim(),
        invoiceNumber: invoiceNumber.trim() || invoice.invoiceNumber,
        date,
        totalAmount:   total,
        ivaAmount:     iva,
        baseAmount:    base,
        category,
        notes:         notes.trim() || undefined,
        exportedToSheets: false, // mark for re-export
      };

      await updateInvoice(invoice.id, patch);

      // Update in Sheets if previously exported
      if (invoice.exportedToSheets) {
        try {
          const { spreadsheetId } = await getSheetsExportTarget();
          await updateInSheetsMutation.mutateAsync({
            spreadsheetId,
            originalInvoiceNumber: invoice.invoiceNumber,
            originalVendor:        invoice.vendor,
            source:                invoice.source,
            invoiceNumber:         patch.invoiceNumber,
            vendor:                patch.vendor,
            date:                  patch.date,
            totalAmount:           patch.totalAmount,
            ivaAmount:             patch.ivaAmount,
            baseAmount:            patch.baseAmount,
            category:              patch.category,
            currency:              invoice.currency || "EUR",
            notes:                 patch.notes,
            tip:                   invoice.tip,
          });
          await updateInvoice(invoice.id, { exportedToSheets: true });
        } catch {
          // Sheets update failure is non-fatal — local is saved
        }
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Saved", "Invoice updated successfully.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch {
      Alert.alert("Error", "Could not save the invoice. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [vendor, invoiceNumber, date, totalAmount, ivaAmount, baseAmount, category, notes, invoice, updateInvoice, updateInSheetsMutation, router]);

  if (!invoice) {
    return (
      <ScreenContainer containerClassName="bg-background">
        <View style={styles.notFound}>
          <Text style={[styles.notFoundText, { color: colors.muted }]}>Invoice not found.</Text>
          <Pressable onPress={() => router.back()}>
            <Text style={[styles.backLink, { color: colors.primary }]}>Go back</Text>
          </Pressable>
        </View>
      </ScreenContainer>
    );
  }

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
          <Text style={[styles.title, { color: colors.foreground }]}>Edit Invoice</Text>
          <View style={{ width: 22 }} />
        </View>

        <FieldRow
          label="Vendor / Company"
          value={vendor}
          onChange={setVendor}
          placeholder="e.g. MERCADONA"
        />

        <FieldRow
          label="Invoice Number"
          value={invoiceNumber}
          onChange={setInvoiceNumber}
          placeholder="e.g. INV-2024-001"
        />

        <FieldRow
          label="Date"
          value={date}
          onChange={setDate}
          placeholder="YYYY-MM-DD"
        />

        <View style={styles.fieldRow}>
          <Text style={[styles.fieldLabel, { color: colors.muted }]}>Category</Text>
          <CategoryPicker value={category} onChange={setCategory} />
        </View>

        <View
          style={[
            styles.amountCard,
            { backgroundColor: colors.primary + "10", borderColor: colors.primary + "30" },
          ]}
        >
          <FieldRow
            label="Total Amount (€)"
            value={totalAmount}
            onChange={setTotalAmount}
            keyboardType="decimal-pad"
            placeholder="0.00"
          />
          <FieldRow
            label="IVA (€)"
            value={ivaAmount}
            onChange={setIvaAmount}
            keyboardType="decimal-pad"
            placeholder="0.00"
          />
          <FieldRow
            label="Base Amount (€)"
            value={baseAmount}
            onChange={setBaseAmount}
            keyboardType="decimal-pad"
            placeholder="0.00"
          />
        </View>

        <FieldRow
          label="Notes (Optional)"
          value={notes}
          onChange={setNotes}
          placeholder="Any additional notes..."
        />

        <Pressable
          onPress={handleSave}
          disabled={saving}
          style={({ pressed }) => [
            styles.saveBtn,
            { backgroundColor: colors.primary },
            pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
            saving && { opacity: 0.7 },
          ]}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <IconSymbol name="checkmark.circle.fill" size={20} color="#fff" />
          )}
          <Text style={styles.saveBtnText}>{saving ? "Saving..." : "Save Changes"}</Text>
        </Pressable>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 48, gap: 16 },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  backText: { fontSize: 16, fontWeight: "500" },
  title: { fontSize: 18, fontWeight: "600" },
  fieldRow: { gap: 8 },
  fieldLabel: { fontSize: 14, fontWeight: "500" },
  fieldInput: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  categoryScroll: { marginHorizontal: -20, paddingHorizontal: 20 },
  catPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    marginRight: 8,
  },
  catPillText: { fontSize: 13, fontWeight: "600" },
  amountCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    borderRadius: 14,
    marginTop: 8,
  },
  saveBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  notFoundText: { fontSize: 16 },
  backLink: { fontSize: 16, fontWeight: "600" },
});
