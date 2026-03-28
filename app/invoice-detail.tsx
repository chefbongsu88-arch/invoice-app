import { ScrollView, Text, View, TouchableOpacity, Alert } from "react-native";
import { useState, useEffect } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { getGoogleSheetsConfig, exportInvoiceToSheets } from "@/lib/google-sheets";
import { trpc } from "@/lib/trpc";

interface Invoice {
  id: string;
  source: string;
  invoiceNumber: string;
  vendor: string;
  date: string;
  totalAmount: number;
  ivaAmount: number;
  baseAmount: number;
  category: string;
  currency: string;
  tip?: number;
  notes?: string;
  imageUrl?: string;
}

export default function InvoiceDetailScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [config, setConfig] = useState<any>(null);

  useEffect(() => {
    loadInvoice();
    loadConfig();
  }, []);

  const loadInvoice = async () => {
    try {
      // Parse invoice from params
      if (params.invoice) {
        const invoiceData = JSON.parse(params.invoice as string);
        setInvoice(invoiceData);
      }
    } catch (error) {
      console.error("Failed to load invoice:", error);
      Alert.alert("Error", "Failed to load invoice details");
    }
  };

  const loadConfig = async () => {
    try {
      const googleConfig = await getGoogleSheetsConfig();
      setConfig(googleConfig);
    } catch (error) {
      console.error("Failed to load config:", error);
    }
  };

  const handleExport = async () => {
    if (!invoice) {
      Alert.alert("Error", "No invoice to export");
      return;
    }

    if (!config) {
      Alert.alert("Error", "Please configure Google Sheets settings first");
      router.push("/(tabs)/settings");
      return;
    }

    setIsExporting(true);
    try {
      // Get the API URL from environment or use default
      const apiUrl = process.env.EXPO_PUBLIC_API_URL || "http://localhost:3000";

      const result = await exportInvoiceToSheets(
        {
          source: invoice.source,
          invoiceNumber: invoice.invoiceNumber,
          vendor: invoice.vendor,
          date: invoice.date,
          totalAmount: invoice.totalAmount,
          ivaAmount: invoice.ivaAmount,
          baseAmount: invoice.baseAmount,
          category: invoice.category,
          currency: invoice.currency,
          tip: invoice.tip,
          notes: invoice.notes,
          imageUrl: invoice.imageUrl,
        },
        config,
        apiUrl
      );

      if (result.success) {
        Alert.alert("Success", result.message);
      } else {
        Alert.alert("Error", result.message);
      }
    } catch (error) {
      console.error("Export error:", error);
      Alert.alert("Error", "Failed to export invoice");
    } finally {
      setIsExporting(false);
    }
  };

  if (!invoice) {
    return (
      <ScreenContainer className="p-6 justify-center items-center">
        <Text className="text-foreground">Loading...</Text>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer className="p-6">
      <ScrollView contentContainerStyle={{ flexGrow: 1 }}>
        <View className="gap-6">
          {/* Header */}
          <View className="flex-row justify-between items-center">
            <TouchableOpacity onPress={() => router.back()}>
              <Text className="text-lg font-semibold text-primary">← Back</Text>
            </TouchableOpacity>
            <Text className="text-2xl font-bold text-foreground">{invoice.vendor}</Text>
            <View style={{ width: 60 }} />
          </View>

          {/* Amount Summary */}
          <View className="bg-surface rounded-lg p-4 gap-3">
            <View className="flex-row justify-between">
              <Text className="text-muted">Total Amount</Text>
              <Text className="text-lg font-semibold text-foreground">€{invoice.totalAmount.toFixed(2)}</Text>
            </View>
            <View className="flex-row justify-between">
              <Text className="text-muted">IVA</Text>
              <Text className="text-foreground">€{invoice.ivaAmount.toFixed(2)}</Text>
            </View>
            <View className="flex-row justify-between">
              <Text className="text-muted">Base</Text>
              <Text className="text-foreground">€{invoice.baseAmount.toFixed(2)}</Text>
            </View>
          </View>

          {/* Details */}
          <View className="bg-surface rounded-lg p-4 gap-3">
            <View>
              <Text className="text-xs text-muted mb-1">Invoice Number</Text>
              <Text className="text-foreground">{invoice.invoiceNumber}</Text>
            </View>
            <View>
              <Text className="text-xs text-muted mb-1">Date</Text>
              <Text className="text-foreground">{new Date(invoice.date).toLocaleDateString()}</Text>
            </View>
            <View>
              <Text className="text-xs text-muted mb-1">Category</Text>
              <Text className="text-foreground">{invoice.category}</Text>
            </View>
            <View>
              <Text className="text-xs text-muted mb-1">Currency</Text>
              <Text className="text-foreground">{invoice.currency}</Text>
            </View>
            {invoice.notes && (
              <View>
                <Text className="text-xs text-muted mb-1">Notes</Text>
                <Text className="text-foreground">{invoice.notes}</Text>
              </View>
            )}
          </View>

          {/* Export Button */}
          <TouchableOpacity
            onPress={handleExport}
            disabled={isExporting}
            className={`rounded-lg p-4 items-center ${isExporting ? "opacity-50" : ""}`}
            style={{ backgroundColor: colors.primary }}
          >
            <Text className="text-white font-semibold">
              {isExporting ? "Exporting..." : "Export to Google Sheets"}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}
