import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import {
  APP_EMPTY_DESC,
  APP_EMPTY_ICON,
  APP_EMPTY_TITLE,
  APP_GREETING,
  APP_HOME_HERO_TITLE,
  APP_LINK,
  APP_QUICK_ICON_GLYPH,
  APP_QUICK_ICON_RADIUS,
  APP_SECTION_TITLE,
  APP_STAT_LABEL,
  APP_STAT_SUB,
  APP_STAT_VALUE,
} from "@/constants/app-typography";
import {
  invoiceListAmountText,
  invoiceListBody,
  invoiceListMetaText,
  invoiceListPillLabelText,
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
  const t = translucentTile(colors);
  return (
    <View style={[styles.statCard, { backgroundColor: t.bg, borderColor: t.border }]}>
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
  icon: ComponentProps<typeof IconSymbol>["name"];
  label: string;
  color: string;
  onPress: () => void;
}) {
  const colors = useColors();
  const t = translucentTile(colors);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.quickActionGridCell,
        {
          backgroundColor: pressed ? t.bgPressed : t.bg,
          borderColor: pressed ? `${colors.foreground}28` : t.border,
        },
        pressed && { transform: [{ scale: 0.98 }] },
      ]}
    >
      <View style={[styles.quickActionIcon, { backgroundColor: color + "24" }]}>
        <IconSymbol name={icon} size={APP_QUICK_ICON_GLYPH - 2} color={color} />
      </View>
      <Text style={[styles.quickActionLabelGrid, { color: colors.foreground }]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

function RecentItem({ invoice }: { invoice: Invoice }) {
  const colors = useColors();
  const t = translucentTile(colors);
  const router = useRouter();
  const sourceColor = invoice.source === "camera" ? colors.camera : colors.email;
  const safeDate = formatInvoiceDateShortEn(invoice.date);
  const invoiceNumberLabel = displayInvoiceNumberWithHash(invoice.invoiceNumber);

  return (
    <Pressable
      onPress={() => router.push(`/receipt/${invoice.id}` as never)}
      accessibilityRole="button"
      accessibilityLabel={`${invoice.vendor}, ${safeDate}, €${invoice.totalAmount.toFixed(2)}`}
      style={({ pressed }) => [
        styles.recentItem,
        {
          backgroundColor: pressed ? t.bgPressed : t.bg,
          borderColor: t.border,
        },
      ]}
    >
      <View style={[styles.recentIcon, { backgroundColor: sourceColor }]}>
        <IconSymbol
          name={invoice.source === "camera" ? "camera.fill" : "envelope.fill"}
          size={INVOICE_LIST_ICON_GLYPH}
          color="#fff"
        />
      </View>
      <View style={styles.recentBody}>
        <View style={styles.recentTextBlock}>
          <Text style={[styles.recentVendor, { color: colors.foreground }]} numberOfLines={1}>
            {invoice.vendor || "Unknown Vendor"}
          </Text>
          <View style={styles.recentMetaRow}>
            <Text style={[styles.recentInvoiceNumber, { color: colors.muted }]} numberOfLines={1}>
              {invoiceNumberLabel}
            </Text>
            <Text style={[styles.recentMetaDivider, { color: colors.border }]}>•</Text>
            <IconSymbol name="calendar" size={12} color={colors.muted} />
            <Text style={[styles.recentDateInline, { color: colors.muted }]} numberOfLines={1}>
              {safeDate}
            </Text>
          </View>
        </View>
        <View style={styles.recentAmountWrap}>
          <Text style={[styles.recentAmount, { color: colors.foreground }]} numberOfLines={1}>
            €{invoice.totalAmount.toFixed(2)}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const tile = translucentTile(colors);
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
                accessibilityRole="button"
                accessibilityLabel="Settings"
                style={({ pressed }) => [
                  {
                    padding: 10,
                    borderRadius: 14,
                    borderWidth: 1,
                    backgroundColor: pressed ? tile.bgPressed : tile.bg,
                    borderColor: tile.border,
                  },
                ]}
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

            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Quick Actions</Text>
            <View style={styles.quickActionsRow}>
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
              <IconSymbol name="doc.text.fill" size={APP_EMPTY_ICON} color={colors.border} />
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
  header: { paddingHorizontal: 20, paddingTop: 20 },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 18,
  },
  greeting: APP_GREETING,
  title: APP_HOME_HERO_TITLE,
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 10,
    marginBottom: 20,
  },
  statCard: {
    width: "48%",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
  },
  statValue: APP_STAT_VALUE,
  statLabel: APP_STAT_LABEL,
  statSub: APP_STAT_SUB,
  sectionTitle: APP_SECTION_TITLE,
  quickActionsRow: {
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 22,
  },
  quickActionGridCell: {
    flex: 1,
    minHeight: 114,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 10,
    borderWidth: 1.5,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  quickActionIcon: {
    width: 48,
    height: 48,
    borderRadius: APP_QUICK_ICON_RADIUS,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  quickActionLabelGrid: {
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 16,
    letterSpacing: -0.06,
    textAlign: "center",
  },
  recentHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  seeAll: APP_LINK,
  listContent: { paddingBottom: 32 },
  recentItem: {
    ...invoiceListRowOuter,
    alignItems: "center",
    marginHorizontal: 20,
    marginBottom: 10,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    overflow: "hidden",
    gap: 10,
  },
  recentIcon: {
    width: 40,
    height: 40,
    borderRadius: INVOICE_LIST_ICON_RADIUS,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  recentBody: invoiceListBody,
  recentBody: {
    ...invoiceListBody,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  recentTextBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  recentVendor: {
    ...invoiceListVendorText,
    lineHeight: 19,
  },
  recentMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 18,
  },
  recentInvoiceNumber: {
    ...invoiceListMetaText,
    flexShrink: 1,
  },
  recentMetaDivider: {
    fontSize: 12,
    lineHeight: 16,
  },
  recentDateInline: {
    ...invoiceListMetaText,
    flexShrink: 1,
    fontSize: 12,
    lineHeight: 16,
  },
  recentAmountWrap: {
    width: 92,
    alignItems: "flex-end",
    justifyContent: "center",
    alignSelf: "center",
  },
  recentAmount: {
    ...invoiceListAmountText,
    width: "100%",
    paddingTop: 0,
  },
  emptyState: { alignItems: "center", paddingTop: 70, paddingHorizontal: 40, gap: 12 },
  emptyTitle: APP_EMPTY_TITLE,
  emptyDesc: APP_EMPTY_DESC,
});
