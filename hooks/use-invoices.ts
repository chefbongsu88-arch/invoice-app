import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import type { DashboardStats, Invoice } from "@/shared/invoice-types";
import { getSheetsExportTarget } from "@/lib/sheets-settings";
import { trpc } from "@/lib/trpc";
import { OFFLINE_INVOICES_KEY, type OfflineInvoiceEntry } from "@/hooks/use-offline-sync";

const STORAGE_KEY = "invoices_v1";

export function useInvoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const exportMutation = trpc.invoices.exportToSheets.useMutation();

  const load = useCallback(async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) setInvoices(JSON.parse(raw));
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async (updated: Invoice[]) => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    setInvoices(updated);
  }, []);

  const addInvoice = useCallback(
    async (invoice: Invoice) => {
      const updated = [invoice, ...invoices];
      setInvoices(updated); // Update state immediately
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); // Then save to storage
      
      // Auto-export to Google Sheets (main tracker tab from Settings, default: 2026 Invoice tracker)
      try {
        const { spreadsheetId, sheetName } = await getSheetsExportTarget();

        // Prepare row data for Google Sheets
        const rowData = {
          source: invoice.source || 'Camera',
          invoiceNumber: invoice.invoiceNumber,
          vendor: invoice.vendor,
          date: invoice.date,
          totalAmount: invoice.totalAmount,
          ivaAmount: invoice.ivaAmount,
          baseAmount: invoice.baseAmount,
          category: invoice.category,
          currency: invoice.currency || 'EUR',
          notes: invoice.notes,
          imageUrl: invoice.imageUri || '',
          tip: invoice.tip || 0,
          items: invoice.items || [],
        };
        
        const exportResult = await exportMutation.mutateAsync({
          spreadsheetId,
          sheetName,
          rows: [rowData],
        });

        if (exportResult.rowsAdded === 0) {
          Alert.alert(
            "Already in Google Sheets",
            "This invoice matches a row already in your spreadsheet (same invoice number, or same store + date + amount). It was not added again.",
            [{ text: "OK" }],
          );
          return;
        }

        if (exportResult.receiptImageMissing && invoice.imageUri) {
          Alert.alert(
            "Image not attached",
            "The invoice was added to Google Sheets, but the receipt image could not be uploaded. The row was saved without the photo. Check server storage settings or try again later.",
            [{ text: "OK" }],
          );
        }

        const updatedWithExport = updated.map((inv) =>
          inv.id === invoice.id ? { ...inv, exportedToSheets: true } : inv,
        );
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updatedWithExport));
        setInvoices(updatedWithExport);
      } catch (error) {
        console.error('[Export] Failed to export to Google Sheets, saving offline:', error);
        // Keep invoice in local state — save to offline queue for auto-upload later
        const { sheetName } = await getSheetsExportTarget();
        const offlineRaw = await AsyncStorage.getItem(OFFLINE_INVOICES_KEY);
        const offlineEntries: OfflineInvoiceEntry[] = offlineRaw ? JSON.parse(offlineRaw) : [];
        offlineEntries.push({
          sheetName,
          row: {
            source: invoice.source || 'camera',
            invoiceNumber: invoice.invoiceNumber,
            vendor: invoice.vendor,
            date: invoice.date,
            totalAmount: invoice.totalAmount,
            ivaAmount: invoice.ivaAmount,
            baseAmount: invoice.baseAmount,
            tip: invoice.tip || 0,
            category: invoice.category,
            currency: invoice.currency || 'EUR',
            notes: invoice.notes,
            imageUrl: invoice.imageUri || '',
            items: invoice.items || [],
          },
        });
        await AsyncStorage.setItem(OFFLINE_INVOICES_KEY, JSON.stringify(offlineEntries));
        // Do not throw — invoice is saved locally and will be synced when online
      }
    },
    [invoices, exportMutation]
  );

  const updateInvoice = useCallback(
    async (id: string, patch: Partial<Invoice>) => {
      const updated = invoices.map((inv) =>
        inv.id === id ? { ...inv, ...patch } : inv
      );
      await save(updated);
    },
    [invoices, save]
  );

  const deleteInvoice = useCallback(
    async (id: string) => {
      const updated = invoices.filter((inv) => inv.id !== id);
      await save(updated);
    },
    [invoices, save]
  );

  const checkDuplicate = useCallback((invoice: Invoice): Invoice | null => {
    // Check by invoice number first
    if (invoice.invoiceNumber && invoice.invoiceNumber !== "AUTO-" + Date.now()) {
      const byNumber = invoices.find((inv) => inv.invoiceNumber === invoice.invoiceNumber);
      if (byNumber) return byNumber;
    }

    // Check by vendor + amount + date
    const byVendorAmountDate = invoices.find(
      (inv) =>
        inv.vendor.toLowerCase() === invoice.vendor.toLowerCase() &&
        Math.abs(inv.totalAmount - invoice.totalAmount) < 0.01 &&
        inv.date === invoice.date
    );
    if (byVendorAmountDate) return byVendorAmountDate;

    return null;
  }, [invoices]);

  const getStats = useCallback((): DashboardStats => {
    const now = new Date();
    const thisMonth = invoices.filter((inv) => {
      const d = new Date(inv.date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });

    const totalAmount = invoices.reduce((sum, inv) => sum + inv.totalAmount, 0);
    const thisMonthAmount = thisMonth.reduce((sum, inv) => sum + inv.totalAmount, 0);
    const totalIva = invoices.reduce((sum, inv) => sum + inv.ivaAmount, 0);
    const pendingExport = invoices.filter((inv) => !inv.exportedToSheets).length;

    return {
      totalInvoices: invoices.length,
      totalAmount,
      totalIva,
      pendingExport,
      thisMonthCount: thisMonth.length,
      thisMonthAmount,
    };
  }, [invoices]);

  return {
    invoices,
    loading,
    addInvoice,
    updateInvoice,
    deleteInvoice,
    checkDuplicate,
    getStats,
    reload: load,
  };
}
