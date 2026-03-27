import { ScrollView, Text, View, Pressable, Dimensions } from "react-native";
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
    <ScreenContainer className="p-4">
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <View className="gap-6">
          {/* Header */}
          <View className="gap-2">
            <Text className="text-3xl font-bold text-foreground">Statistics</Text>
            <Text className="text-sm text-muted">Track your expenses by month and category</Text>
          </View>

          {/* Summary Cards */}
          <View className="gap-3">
            <View className="flex-row gap-3">
              <View className="flex-1 bg-surface rounded-xl p-4 border border-border">
                <Text className="text-xs text-muted mb-1">Total Invoices</Text>
                <Text className="text-2xl font-bold text-foreground">{stats.totalCount}</Text>
              </View>
              <View className="flex-1 bg-surface rounded-xl p-4 border border-border">
                <Text className="text-xs text-muted mb-1">Total Amount</Text>
                <Text className="text-2xl font-bold text-primary">€{stats.totalAmount.toFixed(2)}</Text>
              </View>
            </View>
            <View className="flex-row gap-3">
              <View className="flex-1 bg-surface rounded-xl p-4 border border-border">
                <Text className="text-xs text-muted mb-1">Total IVA</Text>
                <Text className="text-2xl font-bold text-warning">€{stats.totalIVA.toFixed(2)}</Text>
              </View>
              <View className="flex-1 bg-surface rounded-xl p-4 border border-border">
                <Text className="text-xs text-muted mb-1">Average</Text>
                <Text className="text-2xl font-bold text-foreground">€{stats.averageAmount.toFixed(2)}</Text>
              </View>
            </View>
          </View>

          {/* Tab Selector */}
          <View className="flex-row gap-2 bg-surface rounded-lg p-1">
            <Pressable
              onPress={() => setActiveTab("monthly")}
              className={`flex-1 py-2 px-3 rounded-md ${activeTab === "monthly" ? "bg-primary" : ""}`}
            >
              <Text
                className={`text-center font-semibold text-sm ${
                  activeTab === "monthly" ? "text-background" : "text-foreground"
                }`}
              >
                Monthly
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setActiveTab("category")}
              className={`flex-1 py-2 px-3 rounded-md ${activeTab === "category" ? "bg-primary" : ""}`}
            >
              <Text
                className={`text-center font-semibold text-sm ${
                  activeTab === "category" ? "text-background" : "text-foreground"
                }`}
              >
                Category
              </Text>
            </Pressable>
          </View>

          {/* Charts */}
          {activeTab === "monthly" && stats.monthlyStats.length > 0 ? (
            <View className="gap-4">
              <Text className="text-lg font-semibold text-foreground">Monthly Trend</Text>
              <View className="bg-surface rounded-xl p-4 border border-border overflow-hidden">
                <LineChart
                  data={monthlyChartData}
                  width={screenWidth - 48}
                  height={220}
                  chartConfig={chartConfig}
                  bezier
                  style={{ marginLeft: -20 }}
                />
              </View>

              {/* Monthly Details */}
              <View className="gap-2">
                {stats.monthlyStats.map((month) => (
                  <View key={month.month} className="bg-surface rounded-lg p-3 border border-border flex-row justify-between">
                    <View>
                      <Text className="text-sm font-semibold text-foreground">{month.month}</Text>
                      <Text className="text-xs text-muted">{month.count} invoices</Text>
                    </View>
                    <View className="items-end">
                      <Text className="text-sm font-bold text-primary">€{month.total.toFixed(2)}</Text>
                      <Text className="text-xs text-warning">IVA: €{month.iva.toFixed(2)}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ) : activeTab === "monthly" ? (
            <View className="bg-surface rounded-xl p-6 border border-border items-center justify-center">
              <Text className="text-muted">No monthly data available</Text>
            </View>
          ) : null}

          {activeTab === "category" && stats.categoryStats.length > 0 ? (
            <View className="gap-4">
              <Text className="text-lg font-semibold text-foreground">Category Distribution</Text>
              <View className="bg-surface rounded-xl p-4 border border-border overflow-hidden">
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

              {/* Category Details */}
              <View className="gap-2">
                {stats.categoryStats.map((category) => (
                  <View key={category.category} className="bg-surface rounded-lg p-3 border border-border">
                    <View className="flex-row justify-between mb-1">
                      <Text className="text-sm font-semibold text-foreground">{category.category}</Text>
                      <Text className="text-sm font-bold text-primary">{category.percentage.toFixed(1)}%</Text>
                    </View>
                    <View className="flex-row justify-between">
                      <Text className="text-xs text-muted">{category.count} invoices</Text>
                      <Text className="text-xs text-primary">€{category.total.toFixed(2)}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ) : activeTab === "category" ? (
            <View className="bg-surface rounded-xl p-6 border border-border items-center justify-center">
              <Text className="text-muted">No category data available</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}
