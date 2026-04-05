import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  FlatList,
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
import { useColors } from "@/hooks/use-colors";
import { useInvoices } from "@/hooks/use-invoices";
import { displayInvoiceNumberWithHash } from "@/lib/invoice-display";
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
  const router = useRouter();
  const sourceColor = invoice.source === "camera" ? colors.camera : colors.email;
  const sourceLabel = invoice.source === "camera" ? "Camera" : "Email";

  return (
    <Pressable
      onPress={() => router.push(`/receipt/${invoice.id}` as never)}
      onLongPress={() => onLongPress(invoice)}
      delayLongPress={400}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.border },
        pressed && { opacity: 0.75 },
      ]}
    >
      <View style={styles.cardTop}>
        <View style={styles.cardLeft}>
          <View style={[styles.cardIcon, { backgroundColor: sourceColor + "15" }]}>
            <IconSymbol
              name={invoice.source === "camera" ? "camera.fill" : "envelope.fill"}
              size={18}
              color={sourceColor}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.cardVendor, { color: colors.foreground }]} numberOfLines={1}>
              {invoice.vendor || "Unknown Vendor"}
            </Text>
            <Text style={[styles.cardInvNum, { color: colors.muted }]}>
              {displayInvoiceNumberWithHash(invoice.invoiceNumber)}
            </Text>
          </View>
        </View>
        <View style={styles.cardRight}>
          <Text style={[styles.cardAmount, { color: colors.foreground }]}>
            €{invoice.totalAmount.toFixed(2)}
          </Text>
          <View style={[styles.sourceBadge, { backgroundColor: sourceColor + "20" }]}>
            <Text style={[styles.sourceBadgeText, { color: sourceColor }]}>{sourceLabel}</Text>
          </View>
        </View>
      </View>

      <View style={[styles.cardDivider, { backgroundColor: colors.border }]} />

      <View style={styles.cardBottom}>
        <View style={styles.cardMeta}>
          <IconSymbol name="calendar" size={12} color={colors.muted} />
          <Text style={[styles.cardMetaText, { color: colors.muted }]}>
            {new Date(invoice.date).toLocaleDateString("en-US", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </Text>
        </View>
        <View style={styles.cardMeta}>
          <IconSymbol name="tag.fill" size={12} color={colors.muted} />
          <Text style={[styles.cardMetaText, { color: colors.muted }]}>{invoice.category}</Text>
        </View>
        <View style={styles.cardMeta}>
          <Text style={[styles.ivaLabel, { color: colors.muted }]}>IVA</Text>
          <Text style={[styles.cardMetaText, { color: colors.warning }]}>
            €{invoice.ivaAmount.toFixed(2)}
          </Text>
        </View>
        {invoice.exportedToSheets ? (
          <View style={styles.cardMeta}>
            <IconSymbol name="checkmark.circle.fill" size={12} color={colors.success} />
            <Text style={[styles.cardMetaText, { color: colors.success }]}>Exported</Text>
          </View>
        ) : (
          <View style={styles.cardMeta}>
            <IconSymbol name="clock.fill" size={12} color={colors.warning} />
            <Text style={[styles.cardMetaText, { color: colors.warning }]}>Pending</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

export default function ReceiptsScreen() {
  const colors = useColors();
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

            {/* Search bar */}
            <View
              style={[
                styles.searchBar,
                { backgroundColor: colors.surface, borderColor: colors.border },
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
                    { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface },
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
                    { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface },
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
                  { borderColor: colors.border, backgroundColor: colors.surface },
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
                  { backgroundColor: colors.surface, borderColor: colors.border },
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

            {/* Add Manual Invoice Button */}
            <Pressable
              onPress={() => router.push("/manual-invoice" as never)}
              style={({ pressed }) => [
                styles.addBtn,
                { backgroundColor: colors.primary },
                pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
              ]}
            >
              <IconSymbol name="plus.circle.fill" size={20} color="#fff" />
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
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 14 },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    marginBottom: 10,
  },
  searchInput: { flex: 1, fontSize: 15 },
  dateRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
  dateField: { flex: 1, gap: 4 },
  dateLabel: { fontSize: 12, fontWeight: "500" },
  dateInput: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  categoryRow: { gap: 4, marginBottom: 4 },
  categoryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  categoryBtnText: { fontSize: 14, fontWeight: "500" },
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
    marginTop: 8,
    marginBottom: 12,
  },
  countText: { fontSize: 13 },
  clearText: { fontSize: 13, fontWeight: "600" },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 8,
  },
  addBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  listContent: { paddingBottom: 32 },
  card: {
    marginHorizontal: 20,
    marginBottom: 10,
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
  },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardLeft: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  cardVendor: { fontSize: 15, fontWeight: "600" },
  cardInvNum: { fontSize: 12, marginTop: 1 },
  cardRight: { alignItems: "flex-end", gap: 4 },
  cardAmount: { fontSize: 17, fontWeight: "700" },
  sourceBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20 },
  sourceBadgeText: { fontSize: 10, fontWeight: "600" },
  cardDivider: { height: 1, marginVertical: 10 },
  cardBottom: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  cardMeta: { flexDirection: "row", alignItems: "center", gap: 4 },
  cardMetaText: { fontSize: 11, fontWeight: "500" },
  ivaLabel: { fontSize: 10, fontWeight: "700" },
  emptyState: { alignItems: "center", paddingTop: 60, paddingHorizontal: 40, gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "600" },
  emptyDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  emptyBtn: { marginTop: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  emptyBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
