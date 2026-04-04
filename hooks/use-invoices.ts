import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import type { DashboardStats, Invoice } from "@/shared/invoice-types";

const STORAGE_KEY = "invoices_v1";

async function readStoredInvoices(): Promise<Invoice[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((inv) => {
      const row = inv as Invoice;
      return {
        ...row,
        exportedToSheets: Boolean(row.exportedToSheets),
      };
    });
  } catch {
    return [];
  }
}

async function writeStoredInvoices(updated: Invoice[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function useInvoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const list = await readStoredInvoices();
      setInvoices(list);
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
    await writeStoredInvoices(updated);
    setInvoices(updated);
  }, []);

  /**
   * Always merge with the latest AsyncStorage so we never overwrite the full list with a stale
   * in-memory snapshot (e.g. Scan tab saved before another tab’s state finished loading).
   */
  const addInvoice = useCallback(async (invoice: Invoice) => {
    const existing = await readStoredInvoices();
    const updated = [invoice, ...existing];
    await writeStoredInvoices(updated);
    setInvoices(updated);
  }, []);

  const updateInvoice = useCallback(async (id: string, patch: Partial<Invoice>) => {
    const existing = await readStoredInvoices();
    const updated = existing.map((inv) =>
      inv.id === id ? { ...inv, ...patch } : inv,
    );
    await writeStoredInvoices(updated);
    setInvoices(updated);
  }, []);

  const deleteInvoice = useCallback(async (id: string) => {
    const existing = await readStoredInvoices();
    const updated = existing.filter((inv) => inv.id !== id);
    await writeStoredInvoices(updated);
    setInvoices(updated);
  }, []);

  const checkDuplicate = useCallback(
    async (invoice: Invoice): Promise<Invoice | null> => {
      const list = await readStoredInvoices();
      if (invoice.invoiceNumber && invoice.invoiceNumber !== "AUTO-" + Date.now()) {
        const byNumber = list.find((inv) => inv.invoiceNumber === invoice.invoiceNumber);
        if (byNumber) return byNumber;
      }
      const byVendorAmountDate = list.find(
        (inv) =>
          inv.vendor.toLowerCase() === invoice.vendor.toLowerCase() &&
          Math.abs(inv.totalAmount - invoice.totalAmount) < 0.01 &&
          inv.date === invoice.date,
      );
      if (byVendorAmountDate) return byVendorAmountDate;
      return null;
    },
    [],
  );

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
