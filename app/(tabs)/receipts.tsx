import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useInvoices } from "@/hooks/use-invoices";
import type { Invoice, InvoiceSource } from "@/shared/invoice-types";

type FilterSource = "all" | InvoiceSource;

function FilterPill({
  label,
  active,
  color,
  onPress,
}: {
  label: string;
  active: boolean;
  color: string;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.pill,
        {
          backgroundColor: active ? color : colors.surface,
          borderColor: active ? color : colors.border,
        },
      ]}
    >
      <Text style={[styles.pillText, { color: active ? "#fff" : colors.muted }]}>{label}</Text>
    </Pressable>
  );
}

function InvoiceCard({ invoice }: { invoice: Invoice }) {
  const colors = useColors();
  const router = useRouter();
  const sourceColor = invoice.source === "camera" ? colors.camera : colors.email;
  const sourceLabel = invoice.source === "camera" ? "Camera" : "Email";

  return (
    <Pressable
      onPress={() => router.push(`/receipt/${invoice.id}` as never)}
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
          <View>
            <Text style={[styles.cardVendor, { color: colors.foreground }]} numberOfLines={1}>
              {invoice.vendor || "Unknown Vendor"}
            </Text>
            <Text style={[styles.cardInvNum, { color: colors.muted }]}>
              {invoice.invoiceNumber ? `#${invoice.invoiceNumber}` : "No invoice #"}
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
            {new Date(invoice.date).toLocaleDateString("en-ES", {
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
  const { invoices, loading, reload } = useInvoices();
  const [filter, setFilter] = useState<FilterSource>("all");
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const filtered = invoices.filter((inv) => {
    const matchSource = filter === "all" || inv.source === filter;
    const matchSearch =
      search === "" ||
      inv.vendor.toLowerCase().includes(search.toLowerCase()) ||
      inv.invoiceNumber.toLowerCase().includes(search.toLowerCase());
    return matchSource && matchSearch;
  });

  return (
    <ScreenContainer containerClassName="bg-background">
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.foreground }]}>Receipts</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>
              {filtered.length} invoice{filtered.length !== 1 ? "s" : ""}
            </Text>

            {/* Search */}
            <View style={[styles.searchBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <IconSymbol name="magnifyingglass" size={18} color={colors.muted} />
              <TextInput
                style={[styles.searchInput, { color: colors.foreground }]}
                placeholder="Search vendor or invoice #"
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

            {/* Filter Pills */}
            <View style={styles.filters}>
              <FilterPill
                label="All"
                active={filter === "all"}
                color={colors.primary}
                onPress={() => setFilter("all")}
              />
              <FilterPill
                label="Camera"
                active={filter === "camera"}
                color={colors.camera}
                onPress={() => setFilter("camera")}
              />
              <FilterPill
                label="Email"
                active={filter === "email"}
                color={colors.email}
                onPress={() => setFilter("email")}
              />
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
        renderItem={({ item }) => <InvoiceCard invoice={item} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          loading ? null : (
            <View style={styles.emptyState}>
              <IconSymbol name="doc.text.fill" size={48} color={colors.border} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
                {search || filter !== "all" ? "No matching invoices" : "No invoices yet"}
              </Text>
              <Text style={[styles.emptyDesc, { color: colors.muted }]}>
                {search || filter !== "all"
                  ? "Try adjusting your search or filter"
                  : "Scan a receipt or sync Gmail to add invoices"}
              </Text>
              {filter === "all" && !search && (
                <Pressable
                  onPress={() => router.push("/(tabs)/scan" as never)}
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
  title: { fontSize: 28, fontWeight: "700" },
  subtitle: { fontSize: 14, marginTop: 2, marginBottom: 16 },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    marginBottom: 12,
  },
  searchInput: { flex: 1, fontSize: 15 },
  filters: { flexDirection: "row", gap: 8, marginBottom: 12 },
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
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  pillText: { fontSize: 13, fontWeight: "600" },
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
