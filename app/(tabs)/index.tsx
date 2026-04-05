import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useInvoices } from "@/hooks/use-invoices";
import type { DashboardStats, Invoice } from "@/shared/invoice-types";

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  const colors = useColors();
  return (
    <View style={[styles.statCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color: accent ?? colors.foreground }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.muted }]}>{label}</Text>
      {sub ? <Text style={[styles.statSub, { color: colors.muted }]}>{sub}</Text> : null}
    </View>
  );
}

function QuickAction({
  icon,
  label,
  color,
  onPress,
}: {
  icon: React.ComponentProps<typeof IconSymbol>["name"];
  label: string;
  color: string;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.quickAction,
        { backgroundColor: colors.surface, borderColor: colors.border },
        pressed && { opacity: 0.75, transform: [{ scale: 0.97 }] },
      ]}
    >
      <View style={[styles.quickActionIcon, { backgroundColor: color + "20" }]}>
        <IconSymbol name={icon} size={24} color={color} />
      </View>
      <Text style={[styles.quickActionLabel, { color: colors.foreground }]}>{label}</Text>
    </Pressable>
  );
}

function RecentItem({ invoice }: { invoice: Invoice }) {
  const colors = useColors();
  const router = useRouter();
  const sourceColor = invoice.source === "camera" ? colors.camera : colors.email;
  const sourceLabel = invoice.source === "camera" ? "Camera" : "Email";

  return (
    <Pressable
      onPress={() => router.push(`/receipt/${invoice.id}` as never)}
      style={({ pressed }) => [
        styles.recentItem,
        { backgroundColor: colors.surface, borderColor: colors.border },
        pressed && { opacity: 0.75 },
      ]}
    >
      <View style={[styles.recentIcon, { backgroundColor: sourceColor + "15" }]}>
        <IconSymbol
          name={invoice.source === "camera" ? "camera.fill" : "envelope.fill"}
          size={18}
          color={sourceColor}
        />
      </View>
      <View style={styles.recentInfo}>
        <Text style={[styles.recentVendor, { color: colors.foreground }]} numberOfLines={1}>
          {invoice.vendor || "Unknown Vendor"}
        </Text>
        <Text style={[styles.recentDate, { color: colors.muted }]}>
          {new Date(invoice.date).toLocaleDateString("en-US", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })}
        </Text>
      </View>
      <View style={styles.recentRight}>
        <Text style={[styles.recentAmount, { color: colors.foreground }]}>
          €{invoice.totalAmount.toFixed(2)}
        </Text>
        <View style={[styles.sourceBadge, { backgroundColor: sourceColor + "20" }]}>
          <Text style={[styles.sourceBadgeText, { color: sourceColor }]}>{sourceLabel}</Text>
        </View>
      </View>
    </Pressable>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const router = useRouter();
  const { invoices, loading, getStats, reload } = useInvoices();
  const [stats, setStats] = useState<DashboardStats>({
    totalInvoices: 0,
    totalAmount: 0,
    totalIva: 0,
    pendingExport: 0,
    thisMonthCount: 0,
    thisMonthAmount: 0,
  });
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setStats(getStats());
  }, [invoices, getStats]);

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

  const recent = invoices.slice(0, 5);

  return (
    <ScreenContainer containerClassName="bg-background">
      <FlatList
        style={{ flex: 1, backgroundColor: colors.background }}
        data={recent}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            {/* Header */}
            <View style={styles.topRow}>
              <View>
                <Text style={[styles.greeting, { color: colors.muted }]}>Good day</Text>
                <Text style={[styles.title, { color: colors.foreground }]}>Invoice Tracker</Text>
              </View>
              <Pressable
                onPress={() => router.navigate("/settings")}
                style={({ pressed }) => [pressed && { opacity: 0.6 }]}
              >
                <IconSymbol name="gearshape.fill" size={24} color={colors.muted} />
              </Pressable>
            </View>

            {/* Stats Grid */}
            <View style={styles.statsGrid}>
              <StatCard
                label="Total Invoices"
                value={stats.totalInvoices.toString()}
                sub={`${stats.thisMonthCount} this month`}
              />
              <StatCard
                label="Total Amount"
                value={`€${stats.totalAmount.toFixed(0)}`}
                sub={`€${stats.thisMonthAmount.toFixed(0)} this month`}
                accent={colors.primary}
              />
              <StatCard
                label="Total IVA"
                value={`€${stats.totalIva.toFixed(0)}`}
                accent={colors.warning}
              />
              <StatCard
                label="Pending Export"
                value={stats.pendingExport.toString()}
                accent={stats.pendingExport > 0 ? colors.error : colors.success}
              />
            </View>

            {/* Quick Actions */}
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Quick Actions</Text>
            <View style={styles.quickActions}>
              <QuickAction
                icon="camera.fill"
                label="Scan Receipt"
                color={colors.camera}
                onPress={() => router.navigate("/scan")}
              />
              <QuickAction
                icon="tablecells"
                label="View Sheets"
                color={colors.success}
                onPress={() => Linking.openURL("https://docs.google.com/spreadsheets/d/1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E")}
              />
              <QuickAction
                icon="doc.text.fill"
                label="All Receipts"
                color={colors.primary}
                onPress={() => router.navigate("/receipts")}
              />
            </View>

            {/* Recent Section Header */}
            {recent.length > 0 && (
              <View style={styles.recentHeader}>
                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
                  Recent Invoices
                </Text>
                <Pressable onPress={() => router.navigate("/receipts")}>
                  <Text style={[styles.seeAll, { color: colors.primary }]}>See all</Text>
                </Pressable>
              </View>
            )}
          </View>
        }
        renderItem={({ item }) => <RecentItem invoice={item} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          loading ? null : (
            <View style={styles.emptyState}>
              <IconSymbol name="doc.text.fill" size={48} color={colors.border} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No invoices yet</Text>
              <Text style={[styles.emptyDesc, { color: colors.muted }]}>
                Scan a receipt to get started
              </Text>
            </View>
          )
        }
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 16 },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  greeting: { fontSize: 13, fontWeight: "500" },
  title: { fontSize: 26, fontWeight: "700", marginTop: 2 },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 10,
    marginBottom: 24,
  },
  statCard: {
    width: "48%",
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
  },
  statValue: { fontSize: 22, fontWeight: "700" },
  statLabel: { fontSize: 11, fontWeight: "500", marginTop: 2 },
  statSub: { fontSize: 10, marginTop: 2 },
  sectionTitle: { fontSize: 17, fontWeight: "600", marginBottom: 12 },
  quickActions: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 24,
  },
  quickAction: {
    flex: 1,
    minWidth: 0,
    minHeight: 88,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 6,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  quickActionIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  quickActionLabel: { fontSize: 12, fontWeight: "600", textAlign: "center" },
  recentHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  seeAll: { fontSize: 14, fontWeight: "500" },
  listContent: { paddingBottom: 32 },
  recentItem: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 20,
    marginBottom: 8,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    gap: 12,
  },
  recentIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  recentInfo: { flex: 1 },
  recentVendor: { fontSize: 14, fontWeight: "600" },
  recentDate: { fontSize: 12, marginTop: 2 },
  recentRight: { alignItems: "flex-end", gap: 4 },
  recentAmount: { fontSize: 15, fontWeight: "700" },
  sourceBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20 },
  sourceBadgeText: { fontSize: 10, fontWeight: "600" },
  emptyState: { alignItems: "center", paddingTop: 60, paddingHorizontal: 40, gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "600" },
  emptyDesc: { fontSize: 14, textAlign: "center", lineHeight: 20 },
});
