import { ScrollView, Text, View, Pressable, Dimensions, StyleSheet } from "react-native";
import { useState, useMemo } from "react";
import { ScreenContainer } from "@/components/screen-container";
import { useInvoices } from "@/hooks/use-invoices";
import { calculateStatistics, formatMonthlyChartData, formatCategoryChartData } from "@/lib/statistics-utils";
import { LineChart, PieChart } from "react-native-chart-kit";
import { useColors } from "@/hooks/use-colors";

const screenWidth = Dimensions.get("window").width;

export default function StatisticsScreen() {
  const colors = useColors();
  const { invoices } = useInvoices();
  const [activeTab, setActiveTab] = useState<"monthly" | "category">("monthly");

  const stats = useMemo(() => calculateStatistics(invoices), [invoices]);
  const monthlyChartData = useMemo(() => formatMonthlyChartData(stats.monthlyStats), [stats.monthlyStats]);
  const categoryChartData = useMemo(() => formatCategoryChartData(stats.categoryStats), [stats.categoryStats]);

  const chartConfig = {
    backgroundColor: colors.background,
    backgroundGradientFrom: colors.background,
    backgroundGradientTo: colors.background,
    color: () => colors.primary,
    strokeWidth: 2,
    barPercentage: 0.5,
    useShadowColorFromDataset: false,
    labelColor: () => colors.foreground,
  };

  return (
    <ScreenContainer style={{ padding: 16 }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <View style={styles.container}>

          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.foreground }]}>Statistics</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>Track your expenses by month and category</Text>
          </View>

          {/* Summary Cards */}
          <View style={styles.cardsContainer}>
            <View style={styles.cardRow}>
              <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.cardLabel, { color: colors.muted }]}>Total Invoices</Text>
                <Text style={[styles.cardValue, { color: colors.foreground }]}>{stats.totalCount}</Text>
              </View>
              <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.cardLabel, { color: colors.muted }]}>Total Amount</Text>
                <Text style={[styles.cardValue, { color: colors.primary }]}>€{stats.totalAmount.toFixed(2)}</Text>
              </View>
            </View>
            <View style={styles.cardRow}>
              <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.cardLabel, { color: colors.muted }]}>Total IVA</Text>
                <Text style={[styles.cardValue, { color: colors.warning }]}>€{stats.totalIVA.toFixed(2)}</Text>
              </View>
              <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.cardLabel, { color: colors.muted }]}>Average</Text>
                <Text style={[styles.cardValue, { color: colors.foreground }]}>€{stats.averageAmount.toFixed(2)}</Text>
              </View>
            </View>
          </View>

          {/* Tab Selector */}
          <View style={[styles.tabContainer, { backgroundColor: colors.surface }]}>
            <Pressable
              onPress={() => setActiveTab("monthly")}
              style={[styles.tab, activeTab === "monthly" && { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.tabText, { color: activeTab === "monthly" ? colors.background : colors.foreground }]}>
                Monthly
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setActiveTab("category")}
              style={[styles.tab, activeTab === "category" && { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.tabText, { color: activeTab === "category" ? colors.background : colors.foreground }]}>
                Category
              </Text>
            </Pressable>
          </View>

          {/* Monthly Charts */}
          {activeTab === "monthly" && stats.monthlyStats.length > 0 ? (
            <View style={styles.chartSection}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Monthly Trend</Text>
              <View style={[styles.chartBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <LineChart
                  data={monthlyChartData}
                  width={screenWidth - 48}
                  height={220}
                  chartConfig={chartConfig}
                  bezier
                  style={{ marginLeft: -20 }}
                />
              </View>
              <View style={styles.listSection}>
                {stats.monthlyStats.map((month) => (
                  <View key={month.month} style={[styles.listItem, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                    <View>
                      <Text style={[styles.listItemTitle, { color: colors.foreground }]}>{month.month}</Text>
                      <Text style={[styles.listItemSub, { color: colors.muted }]}>{month.count} invoices</Text>
                    </View>
                    <View style={styles.listItemRight}>
                      <Text style={[styles.listItemAmount, { color: colors.primary }]}>€{month.total.toFixed(2)}</Text>
                      <Text style={[styles.listItemIva, { color: colors.warning }]}>IVA: €{month.iva.toFixed(2)}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ) : activeTab === "monthly" ? (
            <View style={[styles.emptyBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>No monthly data available</Text>
            </View>
          ) : null}

          {/* Category Charts */}
          {activeTab === "category" && stats.categoryStats.length > 0 ? (
            <View style={styles.chartSection}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Category Distribution</Text>
              <View style={[styles.chartBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <PieChart
                  data={categoryChartData as any}
                  width={screenWidth - 48}
                  height={220}
                  chartConfig={chartConfig}
                  accessor="data"
                  backgroundColor="transparent"
                  paddingLeft="15"
                  style={{ marginLeft: -20 }}
                />
              </View>
              <View style={styles.listSection}>
                {stats.categoryStats.map((category) => (
                  <View key={category.category} style={[styles.categoryItem, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                    <View style={styles.categoryRow}>
                      <Text style={[styles.listItemTitle, { color: colors.foreground }]}>{category.category}</Text>
                      <Text style={[styles.listItemAmount, { color: colors.primary }]}>{category.percentage.toFixed(1)}%</Text>
                    </View>
                    <View style={styles.categoryRow}>
                      <Text style={[styles.listItemSub, { color: colors.muted }]}>{category.count} invoices</Text>
                      <Text style={[styles.listItemSub, { color: colors.primary }]}>€{category.total.toFixed(2)}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ) : activeTab === "category" ? (
            <View style={[styles.emptyBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>No category data available</Text>
            </View>
          ) : null}

        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { gap: 24, paddingBottom: 32 },
  header: { gap: 8 },
  title: { fontSize: 28, fontWeight: "700" },
  subtitle: { fontSize: 14 },
  cardsContainer: { gap: 12 },
  cardRow: { flexDirection: "row", gap: 12 },
  card: { flex: 1, borderRadius: 12, padding: 16, borderWidth: 1 },
  cardLabel: { fontSize: 12, marginBottom: 4 },
  cardValue: { fontSize: 22, fontWeight: "700" },
  tabContainer: { flexDirection: "row", gap: 8, borderRadius: 10, padding: 4 },
  tab: { flex: 1, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8 },
  tabText: { textAlign: "center", fontWeight: "600", fontSize: 14 },
  chartSection: { gap: 16 },
  sectionTitle: { fontSize: 18, fontWeight: "600" },
  chartBox: { borderRadius: 12, padding: 16, borderWidth: 1, overflow: "hidden" },
  listSection: { gap: 8 },
  listItem: { borderRadius: 10, padding: 12, borderWidth: 1, flexDirection: "row", justifyContent: "space-between" },
  listItemTitle: { fontSize: 14, fontWeight: "600" },
  listItemSub: { fontSize: 12, marginTop: 2 },
  listItemRight: { alignItems: "flex-end" },
  listItemAmount: { fontSize: 14, fontWeight: "700" },
  listItemIva: { fontSize: 12 },
  categoryItem: { borderRadius: 10, padding: 12, borderWidth: 1, gap: 4 },
  categoryRow: { flexDirection: "row", justifyContent: "space-between" },
  emptyBox: { borderRadius: 12, padding: 24, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 14 },
});
