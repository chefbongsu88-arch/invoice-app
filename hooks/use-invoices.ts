import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import type { DashboardStats, Invoice } from "@/shared/invoice-types";
import { trpc } from "@/lib/trpc";

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
      
      // Auto-export to Google Sheets
      try {
        const spreadsheetId = '1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E';
        const sheetName = new Date(invoice.date).toLocaleString('en-US', { month: 'long' });
        
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
        
        // Call exportToSheets endpoint
        await exportMutation.mutateAsync({
          spreadsheetId,
          sheetName,
          rows: [rowData],
        });
        
        // Mark as exported
        const updatedWithExport = updated.map(inv => 
          inv.id === invoice.id ? { ...inv, exportedToSheets: true } : inv
        );
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updatedWithExport));
        setInvoices(updatedWithExport);
      } catch (error) {
        console.error('[Export] Failed to export to Google Sheets:', error);
        // Continue anyway - local storage is still updated
      }
    },
    [invoices]
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
