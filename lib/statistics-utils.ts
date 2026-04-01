import { Invoice } from "@/shared/invoice-types";

export interface MonthlyStats {
  month: string; // "2024-01"
  total: number;
  iva: number;
  count: number;
  base: number;
}

export interface CategoryStats {
  category: string;
  total: number;
  iva: number;
  count: number;
  percentage: number;
}

export interface StatisticsData {
  monthlyStats: MonthlyStats[];
  categoryStats: CategoryStats[];
  totalAmount: number;
  totalIVA: number;
  totalCount: number;
  averageAmount: number;
}

/**
 * Calculate monthly statistics
 */
export function calculateMonthlyStats(invoices: Invoice[]): MonthlyStats[] {
  const monthMap = new Map<string, { total: number; iva: number; count: number; base: number }>();

  invoices.forEach((invoice) => {
    const date = new Date(invoice.date);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

    const existing = monthMap.get(monthKey) || { total: 0, iva: 0, count: 0, base: 0 };
    existing.total += invoice.totalAmount || 0;
    existing.iva += invoice.ivaAmount || 0;
    existing.count += 1;
    existing.base += invoice.baseAmount || 0;

    monthMap.set(monthKey, existing);
  });

  return Array.from(monthMap.entries())
    .map(([month, data]) => ({
      month,
      ...data,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Calculate per-category statistics
 */
export function calculateCategoryStats(invoices: Invoice[]): CategoryStats[] {
  const categoryMap = new Map<string, { total: number; iva: number; count: number }>();
  let totalAmount = 0;

  invoices.forEach((invoice) => {
    const category = invoice.category || "Uncategorized";
    const existing = categoryMap.get(category) || { total: 0, iva: 0, count: 0 };

    existing.total += invoice.totalAmount || 0;
    existing.iva += invoice.ivaAmount || 0;
    existing.count += 1;
    totalAmount += invoice.totalAmount || 0;

    categoryMap.set(category, existing);
  });

  return Array.from(categoryMap.entries())
    .map(([category, data]) => ({
      category,
      ...data,
      percentage: totalAmount > 0 ? (data.total / totalAmount) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Calculate overall statistics
 */
export function calculateStatistics(invoices: Invoice[]): StatisticsData {
  const monthlyStats = calculateMonthlyStats(invoices);
  const categoryStats = calculateCategoryStats(invoices);

  const totalAmount = invoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
  const totalIVA = invoices.reduce((sum, inv) => sum + (inv.ivaAmount || 0), 0);
  const totalCount = invoices.length;
  const averageAmount = totalCount > 0 ? totalAmount / totalCount : 0;

  return {
    monthlyStats,
    categoryStats,
    totalAmount,
    totalIVA,
    totalCount,
    averageAmount,
  };
}

/**
 * Format monthly chart data
 */
export function formatMonthlyChartData(monthlyStats: MonthlyStats[]) {
  return {
    labels: monthlyStats.map((m) => {
      const [year, month] = m.month.split("-");
      return `${month}/${year.slice(-2)}`;
    }),
    datasets: [
      {
        data: monthlyStats.map((m) => m.total),
        strokeWidth: 2,
      },
    ],
  };
}

/**
 * Format per-category chart data
 */
export function formatCategoryChartData(categoryStats: CategoryStats[]) {
  const colors = [
    "#0a7ea4",
    "#9b59b6",
    "#e74c3c",
    "#f39c12",
    "#16a085",
    "#2980b9",
    "#c0392b",
    "#27ae60",
  ];

  return {
    labels: categoryStats.map((c) => c.category),
    datasets: [
      {
        data: categoryStats.map((c) => c.percentage),
      },
    ],
    colors: categoryStats.map((_, i) => colors[i % colors.length]),
  };
}
