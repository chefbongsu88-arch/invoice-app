import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";

export const OFFLINE_INVOICES_KEY = "offline_invoices";
const SPREADSHEET_ID = "1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E";

export type UploadStatus = "idle" | "uploading" | "success" | "failed";

export interface OfflineInvoiceEntry {
  sheetName: string;
  row: {
    source: string;
    invoiceNumber: string;
    vendor: string;
    date: string;
    totalAmount: number;
    ivaAmount: number;
    baseAmount: number;
    tip?: number;
    category: string;
    currency: string;
    notes?: string;
    imageUrl?: string;
    items?: any[];
  };
}

export function useOfflineSync() {
  const [isOnline, setIsOnline]         = useState(true);
  const [offlineCount, setOfflineCount] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const wasOnline = useRef(true);
  const exportMutation = trpc.invoices.exportToSheets.useMutation();

  // Load pending count on mount
  useEffect(() => {
    AsyncStorage.getItem(OFFLINE_INVOICES_KEY).then((raw) => {
      if (raw) setOfflineCount((JSON.parse(raw) as OfflineInvoiceEntry[]).length);
    });
  }, []);

  const uploadOfflineInvoices = useCallback(async () => {
    const raw = await AsyncStorage.getItem(OFFLINE_INVOICES_KEY);
    if (!raw) return;
    const entries: OfflineInvoiceEntry[] = JSON.parse(raw);
    if (entries.length === 0) return;

    setUploadStatus("uploading");
    try {
      for (const entry of entries) {
        await exportMutation.mutateAsync({
          spreadsheetId: SPREADSHEET_ID,
          sheetName: entry.sheetName,
          rows: [entry.row],
          automateSheets: true,
        });
      }
      await AsyncStorage.removeItem(OFFLINE_INVOICES_KEY);
      setOfflineCount(0);
      setUploadStatus("success");
      setTimeout(() => setUploadStatus("idle"), 4000);
    } catch {
      setUploadStatus("failed");
    }
  }, [exportMutation]);

  // Monitor connectivity
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const online = state.isConnected === true && state.isInternetReachable !== false;
      setIsOnline(online);

      // Auto-upload when going from offline → online
      if (online && !wasOnline.current) {
        AsyncStorage.getItem(OFFLINE_INVOICES_KEY).then((raw) => {
          if (raw) {
            const entries: OfflineInvoiceEntry[] = JSON.parse(raw);
            if (entries.length > 0) uploadOfflineInvoices();
          }
        });
      }
      wasOnline.current = online;
    });
    return () => unsub();
  }, [uploadOfflineInvoices]);

  const saveOfflineInvoice = useCallback(async (entry: OfflineInvoiceEntry) => {
    const raw = await AsyncStorage.getItem(OFFLINE_INVOICES_KEY);
    const existing: OfflineInvoiceEntry[] = raw ? JSON.parse(raw) : [];
    const updated = [...existing, entry];
    await AsyncStorage.setItem(OFFLINE_INVOICES_KEY, JSON.stringify(updated));
    setOfflineCount(updated.length);
  }, []);

  return {
    isOnline,
    offlineCount,
    uploadStatus,
    saveOfflineInvoice,
    retryUpload: uploadOfflineInvoices,
  };
}
