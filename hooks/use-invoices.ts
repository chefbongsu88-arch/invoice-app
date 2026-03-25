import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import type { DashboardStats, Invoice } from "@/shared/invoice-types";

const STORAGE_KEY = "invoices_v1";

export function useInvoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

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
      await save(updated);
    },
    [invoices, save]
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

  const getStats = useCallback((): DashboardStats => {
    const now = new Date();
    const thisMonth = invoices.filter((inv) => {
      const d = new Date(inv.date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });

    return {
      totalInvoices: invoices.length,
      totalAmount: invoices.reduce((s, i) => s + i.totalAmount, 0),
      totalIva: invoices.reduce((s, i) => s + i.ivaAmount, 0),
      pendingExport: invoices.filter((i) => !i.exportedToSheets).length,
      thisMonthCount: thisMonth.length,
      thisMonthAmount: thisMonth.reduce((s, i) => s + i.totalAmount, 0),
    };
  }, [invoices]);

  return { invoices, loading, addInvoice, updateInvoice, deleteInvoice, getStats, reload: load };
}
