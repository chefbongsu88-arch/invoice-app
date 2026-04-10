import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { APP_SCREEN_HEADER } from "@/constants/app-typography";
import {
  invoiceListAmountText,
  invoiceListBody,
  invoiceListRow1,
  invoiceListRowOuter,
  invoiceListVendorText,
  INVOICE_LIST_ICON_GLYPH,
  INVOICE_LIST_ICON_RADIUS,
  INVOICE_LIST_ICON_SIZE,
} from "@/constants/invoice-list-layout";
import { useColors } from "@/hooks/use-colors";
import { useInvoices } from "@/hooks/use-invoices";
import { displayInvoiceNumberWithHash, formatInvoiceDateShortEn } from "@/lib/invoice-display";
import { translucentTile } from "@/lib/translucent-ui";
import { trpc } from "@/lib/trpc";
import type { Invoice } from "@/shared/invoice-types";

const SPREADSHEET_ID = "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";

const CATEGORIES = [
  "All",
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

function InvoiceCard({
  invoice,
  onLongPress,
}: {
  invoice: Invoice;
  onLongPress: (invoice: Invoice) => void;
}) {
  const colors = useColors();
  const t = translucentTile(colors);
  const router = useRouter();
  const sourceColor = invoice.source === "camera" ? colors.camera : colors.email;
  const safeDate = formatInvoiceDateShortEn(invoice.date);

  return (
    <Pressable
      onPress={() => router.push(`/receipt/${invoice.id}` as never)}
      onLongPress={() => onLongPress(invoice)}
      delayLongPress={400}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: pressed ? t.bgPressed : t.bg,
          borderColor: t.border,
        },
      ]}
    >
      <View style={styles.cardTop}>
        <View style={[styles.cardIcon, { backgroundColor: sourceColor }]}>
          <IconSymbol
            name={invoice.source === "camera" ? "camera.fill" : "envelope.fill"}
            size={INVOICE_LIST_ICON_GLYPH}
            color="#fff"
          />
        </View>
        <View style={styles.cardTopBody}>
          <View style={styles.cardTopRow1}>
            <Text style={[styles.cardVendor, { color: colors.foreground }]} numberOfLines={2}>
              {invoice.vendor || "Unknown Vendor"}
            </Text>
            <View style={styles.cardAmountBlock}>
              <Text style={[styles.cardAmount, { color: colors.foreground }]} numberOfLines={1}>
                €{invoice.totalAmount.toFixed(2)}
              </Text>
              <View style={styles.cardAmountStatus}>
                {invoice.exportedToSheets ? (
                  <View style={styles.statusRow}>
                    <IconSymbol name="checkmark.circle.fill" size={13} color={colors.success} />
                    <Text style={[styles.cardMetaText, styles.cardStatusText, { color: colors.success }]}>
                      Exported
                    </Text>
                  </View>
                ) : (
                  <View style={styles.statusRow}>
                    <IconSymbol name="clock.fill" size={13} color={colors.warning} />
                    <Text style={[styles.cardMetaText, styles.cardStatusText, { color: colors.warning }]}>
                      Pending
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>
          <View style={styles.cardMetaInlineRow}>
            <Text style={[styles.cardInvNum, { color: colors.muted }]} numberOfLines={1}>
              {displayInvoiceNumberWithHash(invoice.invoiceNumber)}
            </Text>
            <Text style={[styles.cardMetaDivider, { color: colors.border }]}>•</Text>
            <IconSymbol name="calendar" size={12} color={colors.muted} />
            <Text style={[styles.cardMetaText, { color: colors.muted }]} numberOfLines={1}>
              {safeDate}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

export default function ReceiptsScreen() {
  const colors = useColors();
  const tile = translucentTile(colors);
  const router = useRouter();
  const { invoices, loading, deleteInvoice, reload } = useInvoices();
  const deleteFromSheetsMutation = trpc.invoices.deleteInvoiceFromSheets.useMutation();

  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const filtered = invoices.filter((inv) => {
    const matchSearch =
      search === "" || inv.vendor.toLowerCase().includes(search.toLowerCase());
    const matchFrom = fromDate === "" || inv.date >= fromDate;
    const matchTo = toDate === "" || inv.date <= toDate;
    const matchCategory = categoryFilter === "All" || inv.category === categoryFilter;
    return matchSearch && matchFrom && matchTo && matchCategory;
  });

  const hasActiveFilters =
    search !== "" || fromDate !== "" || toDate !== "" || categoryFilter !== "All";

  function clearFilters() {
    setSearch("");
    setFromDate("");
    setToDate("");
    setCategoryFilter("All");
    setShowCategoryDropdown(false);
  }

  function confirmDelete(invoice: Invoice) {
    Alert.alert(
      "Delete Invoice",
      "Are you sure you want to delete this invoice? This action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            await deleteInvoice(invoice.id);
            try {
              await deleteFromSheetsMutation.mutateAsync({
                spreadsheetId: SPREADSHEET_ID,
                invoiceNumber: invoice.invoiceNumber,
                vendor: invoice.vendor,
              });
            } catch {
              // Sheets deletion failure is non-blocking
            }
          },
        },
      ]
    );
  }

  function handleLongPress(invoice: Invoice) {
    Alert.alert(invoice.vendor || "Invoice", "Choose an action", [
      {
        text: "Edit",
        onPress: () => router.push(`/edit-invoice/${invoice.id}` as never),
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => confirmDelete(invoice),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  return (
    <ScreenContainer containerClassName="bg-background">
      <FlatList
        style={{ flex: 1, backgroundColor: colors.background }}
        data={filtered}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.foreground }]}>Receipts</Text>

            <View style={[styles.filtersCard, { backgroundColor: tile.bg, borderColor: tile.border }]}>
            {/* Search bar */}
            <View
              style={[
                styles.searchBar,
                { backgroundColor: colors.background, borderColor: colors.border },
              ]}
            >
              <IconSymbol name="magnifyingglass" size={18} color={colors.muted} />
              <TextInput
                style={[styles.searchInput, { color: colors.foreground }]}
                placeholder="Search by vendor..."
                placeholderTextColor={colors.muted}
                value={search}
                onChangeText={setSearch}
                returnKeyType="search"
              />
              {search.length > 0 && (
                <Pressable onPress={() => setSearch("")}>
                  <IconSymbol name="xmark.circle.fill" size={18} color={colors.muted} />
                </Pressable>
              )}
            </View>

            {/* Date range filters */}
            <View style={styles.dateRow}>
              <View style={styles.dateField}>
                <Text style={[styles.dateLabel, { color: colors.muted }]}>From</Text>
                <TextInput
                  style={[
                    styles.dateInput,
                    { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background },
                  ]}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.muted}
                  value={fromDate}
                  onChangeText={setFromDate}
                  returnKeyType="done"
                />
              </View>
              <View style={styles.dateField}>
                <Text style={[styles.dateLabel, { color: colors.muted }]}>To</Text>
                <TextInput
                  style={[
                    styles.dateInput,
                    { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background },
                  ]}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.muted}
                  value={toDate}
                  onChangeText={setToDate}
                  returnKeyType="done"
                />
              </View>
            </View>

            {/* Category dropdown */}
            <View style={styles.categoryRow}>
              <Text style={[styles.dateLabel, { color: colors.muted }]}>Category</Text>
              <Pressable
                onPress={() => setShowCategoryDropdown((v) => !v)}
                style={[
                  styles.categoryBtn,
                  { borderColor: colors.border, backgroundColor: colors.background },
                ]}
              >
                <Text style={[styles.categoryBtnText, { color: colors.foreground }]}>
                  {categoryFilter}
                </Text>
                <IconSymbol
                  name={showCategoryDropdown ? "chevron.up" : "chevron.down"}
                  size={14}
                  color={colors.muted}
                />
              </Pressable>
            </View>

            {showCategoryDropdown && (
              <View
                style={[
                  styles.dropdown,
                  { backgroundColor: colors.background, borderColor: colors.border },
                ]}
              >
                <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
                  {CATEGORIES.map((cat) => (
                    <Pressable
                      key={cat}
                      onPress={() => {
                        setCategoryFilter(cat);
                        setShowCategoryDropdown(false);
                      }}
                      style={[
                        styles.dropdownItem,
                        categoryFilter === cat && { backgroundColor: colors.primary + "15" },
                      ]}
                    >
                      <Text
                        style={[
                          styles.dropdownItemText,
                          {
                            color: categoryFilter === cat ? colors.primary : colors.foreground,
                            fontWeight: categoryFilter === cat ? "600" : "400",
                          },
                        ]}
                      >
                        {cat}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            )}

            {/* Clear Filters + count row */}
            <View style={styles.filterFooter}>
              <Text style={[styles.countText, { color: colors.muted }]}>
                Showing {filtered.length} of {invoices.length} invoice
                {invoices.length !== 1 ? "s" : ""}
              </Text>
              {hasActiveFilters && (
                <Pressable onPress={clearFilters}>
                  <Text style={[styles.clearText, { color: colors.primary }]}>Clear Filters</Text>
                </Pressable>
              )}
            </View>
            </View>

            {/* Add Manual Invoice Button */}
            <Pressable
              onPress={() => router.push("/manual-invoice" as never)}
              accessibilityRole="button"
              accessibilityLabel="Add manual invoice"
              style={({ pressed }) => [
                styles.addBtn,
                { backgroundColor: colors.primary },
                pressed && { opacity: 0.9, transform: [{ scale: 0.99 }] },
              ]}
            >
              <IconSymbol name="plus.circle.fill" size={22} color="#fff" />
              <Text style={styles.addBtnText}>Add Manual Invoice</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => (
          <InvoiceCard invoice={item} onLongPress={handleLongPress} />
        )}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          loading ? null : (
            <View style={styles.emptyState}>
              <IconSymbol name="doc.text.fill" size={48} color={colors.border} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                {hasActiveFilters ? "No matching invoices" : "No invoices yet"}
              </Text>
              <Text style={[styles.emptyDesc, { color: colors.muted }]}>
                {hasActiveFilters
                  ? "Try adjusting your search or filters"
                  : "Scan a receipt to add invoices"}
              </Text>
              {!hasActiveFilters && (
                <Pressable
                  onPress={() => router.navigate("/scan")}
                  style={[styles.emptyBtn, { backgroundColor: colors.primary }]}
                >
                  <Text style={styles.emptyBtnText}>Scan Receipt</Text>
                </Pressable>
              )}
            </View>
          )
        }
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 22, paddingBottom: 8 },
  title: { ...APP_SCREEN_HEADER, marginBottom: 14 },
  filtersCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 4,
    marginBottom: 16,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
    marginBottom: 14,
  },
  searchInput: { flex: 1, fontSize: 16 },
  dateRow: { flexDirection: "row", gap: 10, marginBottom: 12 },
  dateField: { flex: 1, gap: 6 },
  dateLabel: { fontSize: 12, fontWeight: "700" },
  dateInput: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 14,
    fontWeight: "500",
  },
  categoryRow: { gap: 6, marginBottom: 2 },
  categoryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  categoryBtnText: { fontSize: 15, fontWeight: "700" },
  dropdown: {
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 2,
    overflow: "hidden",
    marginBottom: 4,
  },
  dropdownItem: { paddingHorizontal: 14, paddingVertical: 10 },
  dropdownItemText: { fontSize: 14 },
  filterFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 10,
    marginBottom: 4,
  },
  countText: { fontSize: 13, fontWeight: "600" },
  clearText: { fontSize: 13, fontWeight: "800" },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 10,
    paddingVertical: 16,
    paddingHorizontal: 20,
    minHeight: 54,
    borderRadius: 16,
    marginBottom: 12,
    ...(Platform.OS === "ios"
      ? {
          shadowColor: "#000",
          shadowOpacity: 0.2,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 5 },
        }
      : { elevation: 5 }),
  },
  addBtnText: { color: "#fff", fontSize: 16, fontWeight: "800", letterSpacing: -0.25 },
  listContent: { paddingBottom: 32 },
  card: {
    marginHorizontal: 20,
    marginBottom: 16,
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 16,
    paddingHorizontal: 16,
    overflow: "hidden",
  },
  cardTop: {
    ...invoiceListRowOuter,
    alignItems: "flex-start",
  },
  cardTopBody: {
    ...invoiceListBody,
    gap: 3,
  },
  cardTopRow1: invoiceListRow1,
  cardIcon: {
    width: INVOICE_LIST_ICON_SIZE,
    height: INVOICE_LIST_ICON_SIZE,
    borderRadius: INVOICE_LIST_ICON_RADIUS,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  cardVendor: {
    ...invoiceListVendorText,
    flex: 1,
    minWidth: 0,
    paddingRight: 4,
  },
  cardInvNum: { fontSize: 12, fontWeight: "600", lineHeight: 16 },
  cardAmount: {
    ...invoiceListAmountText,
    minWidth: 72,
    flexShrink: 0,
  },
  cardAmountBlock: {
    alignItems: "flex-end",
    gap: 2,
    minWidth: 92,
    flexShrink: 0,
  },
  cardAmountStatus: {
    minHeight: 16,
  },
  cardMetaInlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
    minHeight: 18,
  },
  cardMetaDivider: {
    fontSize: 10,
    lineHeight: 12,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
  },
  cardMetaText: { fontSize: 12, fontWeight: "600", lineHeight: 16 },
  cardStatusText: { fontWeight: "800" },
  emptyState: { alignItems: "center", paddingTop: 60, paddingHorizontal: 40, gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: "700" },
  emptyDesc: { fontSize: 15, textAlign: "center", lineHeight: 22 },
  emptyBtn: { marginTop: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 14 },
  emptyBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
