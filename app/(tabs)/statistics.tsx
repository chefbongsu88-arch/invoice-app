import { ScrollView, Text, View, Pressable, Dimensions, StyleSheet } from "react-native";
import { useState, useMemo } from "react";
import { ScreenContainer } from "@/components/screen-container";
import { useInvoices } from "@/hooks/use-invoices";
import { calculateStatistics, formatMonthlyChartData, formatCategoryChartData } from "@/lib/statistics-utils";
import { LineChart, PieChart } from "react-native-chart-kit";
import { useColors } from "@/hooks/use-colors";

const screenWidth = Dimensions.get("window").width;
const STATS_CHART_WIDTH = screenWidth - 48;

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
    <ScreenContainer className="p-4">
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { backgroundColor: colors.background }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.sectionGap}>
          <View style={styles.headerBlock}>
            <Text style={[styles.screenTitle, { color: colors.foreground }]}>Statistics</Text>
            <Text style={[styles.screenSubtitle, { color: colors.muted }]}>
              Track your expenses by month and category
            </Text>
          </View>

          <View style={styles.cardCol}>
            <View style={styles.cardRow}>
              <View style={[styles.statCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.statLabel, { color: colors.muted }]}>Total Invoices</Text>
                <Text style={[styles.statValue, { color: colors.foreground }]}>{stats.totalCount}</Text>
              </View>
              <View style={[styles.statCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.statLabel, { color: colors.muted }]}>Total Amount</Text>
                <Text style={[styles.statValue, { color: colors.primary }]}>€{stats.totalAmount.toFixed(2)}</Text>
              </View>
            </View>
            <View style={styles.cardRow}>
              <View style={[styles.statCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.statLabel, { color: colors.muted }]}>Total VAT</Text>
                <Text style={[styles.statValue, { color: colors.warning }]}>€{stats.totalIVA.toFixed(2)}</Text>
              </View>
              <View style={[styles.statCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Text style={[styles.statLabel, { color: colors.muted }]}>Average</Text>
                <Text style={[styles.statValue, { color: colors.foreground }]}>
                  €{stats.averageAmount.toFixed(2)}
                </Text>
              </View>
            </View>
          </View>

          <View style={[styles.tabBar, { backgroundColor: colors.surface }]}>
            <Pressable
              onPress={() => setActiveTab("monthly")}
              style={[
                styles.tabBtn,
                activeTab === "monthly" && { backgroundColor: colors.primary },
              ]}
            >
              <Text
                style={[
                  styles.tabBtnText,
                  { color: activeTab === "monthly" ? colors.background : colors.foreground },
                ]}
              >
                Monthly
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setActiveTab("category")}
              style={[
                styles.tabBtn,
                activeTab === "category" && { backgroundColor: colors.primary },
              ]}
            >
              <Text
                style={[
                  styles.tabBtnText,
                  { color: activeTab === "category" ? colors.background : colors.foreground },
                ]}
              >
                Category
              </Text>
            </Pressable>
          </View>

          {activeTab === "monthly" && stats.monthlyStats.length > 0 ? (
            <View style={styles.sectionGap}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Monthly Trend</Text>
              <View
                style={[styles.chartCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
              >
                <LineChart
                  data={monthlyChartData}
                  width={STATS_CHART_WIDTH}
                  height={220}
                  chartConfig={chartConfig}
                  bezier
                  style={{ marginLeft: -20 }}
                />
              </View>

              <View style={styles.listGap}>
                {stats.monthlyStats.map((month) => (
                  <View
                    key={month.month}
                    style={[styles.listRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
                  >
                    <View>
                      <Text style={[styles.rowTitle, { color: colors.foreground }]}>{month.month}</Text>
                      <Text style={[styles.rowSub, { color: colors.muted }]}>{month.count} invoices</Text>
                    </View>
                    <View style={styles.rowRight}>
                      <Text style={[styles.rowAmount, { color: colors.primary }]}>€{month.total.toFixed(2)}</Text>
                      <Text style={[styles.rowSub, { color: colors.warning }]}>VAT: €{month.iva.toFixed(2)}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ) : activeTab === "monthly" ? (
            <View
              style={[styles.emptyCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <Text style={{ color: colors.muted }}>No monthly data available</Text>
            </View>
          ) : null}

          {activeTab === "category" && stats.categoryStats.length > 0 ? (
            <View style={styles.sectionGap}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Category Distribution</Text>
              <View
                style={[styles.chartCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
              >
                <PieChart
                  data={categoryChartData}
                  width={STATS_CHART_WIDTH}
                  height={220}
                  chartConfig={chartConfig}
                  accessor="population"
                  backgroundColor="transparent"
                  paddingLeft="15"
                  style={{ marginLeft: -20 }}
                />
              </View>

              <View style={styles.listGap}>
                {stats.categoryStats.map((category) => (
                  <View
                    key={category.category}
                    style={[styles.categoryCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
                  >
                    <View style={styles.categoryTop}>
                      <Text style={[styles.rowTitle, { color: colors.foreground }]}>{category.category}</Text>
                      <Text style={[styles.rowAmount, { color: colors.primary }]}>
                        {category.percentage.toFixed(1)}%
                      </Text>
                    </View>
                    <View style={styles.categoryBottom}>
                      <Text style={[styles.rowSub, { color: colors.muted }]}>{category.count} invoices</Text>
                      <Text style={[styles.rowSub, { color: colors.primary }]}>€{category.total.toFixed(2)}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ) : activeTab === "category" ? (
            <View
              style={[styles.emptyCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
            >
              <Text style={{ color: colors.muted }}>No category data available</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
    paddingBottom: 24,
  },
  sectionGap: { gap: 24 },
  headerBlock: { gap: 8 },
  screenTitle: { fontSize: 30, fontWeight: "700" },
  screenSubtitle: { fontSize: 14, lineHeight: 20 },
  cardCol: { gap: 12 },
  cardRow: { flexDirection: "row", gap: 12 },
  statCard: {
    flex: 1,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  statLabel: { fontSize: 12, marginBottom: 4 },
  statValue: { fontSize: 24, fontWeight: "700" },
  tabBar: { flexDirection: "row", gap: 8, borderRadius: 8, padding: 4 },
  tabBtn: { flex: 1, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6, alignItems: "center" },
  tabBtnText: { fontSize: 14, fontWeight: "600", textAlign: "center" },
  sectionTitle: { fontSize: 18, fontWeight: "600" },
  chartCard: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    overflow: "hidden",
    alignItems: "center",
  },
  listGap: { gap: 8 },
  listRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
  },
  rowTitle: { fontSize: 14, fontWeight: "600" },
  rowSub: { fontSize: 12, marginTop: 2 },
  rowRight: { alignItems: "flex-end" },
  rowAmount: { fontSize: 14, fontWeight: "700" },
  emptyCard: {
    borderRadius: 12,
    padding: 24,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  categoryCard: { borderRadius: 8, padding: 12, borderWidth: 1 },
  categoryTop: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  categoryBottom: { flexDirection: "row", justifyContent: "space-between" },
});
