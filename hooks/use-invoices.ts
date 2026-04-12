import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import type { DashboardStats, Invoice } from "@/shared/invoice-types";

const STORAGE_KEY = "invoices_v1";

function invoiceDedupKey(invoice: Invoice): string {
  if (invoice.source === "email" && String(invoice.emailId ?? "").trim()) {
    return `email:${String(invoice.emailId).trim()}`;
  }
  return `id:${String(invoice.id ?? "").trim()}`;
}

function mergeInvoiceRecords(primary: Invoice, incoming: Invoice): Invoice {
  return {
    ...incoming,
    ...primary,
    exportedToSheets: primary.exportedToSheets || incoming.exportedToSheets,
    exportedAt: primary.exportedAt ?? incoming.exportedAt,
    imageUri: primary.imageUri ?? incoming.imageUri,
    items: primary.items && primary.items.length > 0 ? primary.items : incoming.items,
    notes: primary.notes ?? incoming.notes,
  };
}

function normalizeInvoiceList(list: Invoice[]): Invoice[] {
  const deduped: Invoice[] = [];
  const indexByKey = new Map<string, number>();

  for (const invoice of list) {
    const key = invoiceDedupKey(invoice);
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, deduped.length);
      deduped.push(invoice);
      continue;
    }
    deduped[existingIndex] = mergeInvoiceRecords(deduped[existingIndex], invoice);
  }

  return deduped;
}

async function readStoredInvoices(): Promise<Invoice[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeInvoiceList(
      parsed.map((inv) => {
        const row = inv as Invoice;
        return {
          ...row,
          exportedToSheets: Boolean(row.exportedToSheets),
        };
      }),
    );
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
    const next = [invoice, ...existing.filter((inv) => invoiceDedupKey(inv) !== invoiceDedupKey(invoice))];
    const updated = normalizeInvoiceList(next);
    await writeStoredInvoices(updated);
    setInvoices(updated);
  }, []);

  const updateInvoice = useCallback(async (id: string, patch: Partial<Invoice>) => {
    const existing = await readStoredInvoices();
    const updated = normalizeInvoiceList(
      existing.map((inv) =>
        inv.id === id ? { ...inv, ...patch } : inv,
      ),
    );
    await writeStoredInvoices(updated);
    setInvoices(updated);
  }, []);

  const deleteInvoice = useCallback(async (id: string) => {
    const existing = await readStoredInvoices();
    const target = existing.find((inv) => inv.id === id);
    const targetKey = target ? invoiceDedupKey(target) : `id:${id}`;
    const updated = existing.filter((inv) => invoiceDedupKey(inv) !== targetKey);
    await writeStoredInvoices(updated);
    setInvoices(updated);
  }, []);

  const checkDuplicate = useCallback(
    async (invoice: Invoice): Promise<Invoice | null> => {
      const list = await readStoredInvoices();
      const num = String(invoice.invoiceNumber ?? "").trim();
      // Skip invoice# match for auto ids (was broken: compared to Date.now() at check time, not creation time).
      const isAutoNumber = /^AUTO-\d+$/.test(num);
      if (num && !isAutoNumber) {
        const byNumber = list.find((inv) => inv.invoiceNumber === num);
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
