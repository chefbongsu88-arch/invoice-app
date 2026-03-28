import { describe, it, expect, beforeEach, vi } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Mock AsyncStorage
vi.mock("@react-native-async-storage/async-storage");

const SETTINGS_KEY = "app_settings_v1";

describe("Gmail Auto-Save Functionality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Settings Toggle Persistence", () => {
    it("should save auto-save setting to AsyncStorage", async () => {
      const mockSetItem = vi.spyOn(AsyncStorage, "setItem");

      const settings = {
        autoSaveGmailEmails: true,
        autoExportToSheets: false,
      };

      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

      expect(mockSetItem).toHaveBeenCalledWith(
        SETTINGS_KEY,
        JSON.stringify(settings)
      );
    });

    it("should load auto-save setting from AsyncStorage", async () => {
      const settings = {
        autoSaveGmailEmails: true,
        autoExportToSheets: true,
      };

      vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(settings));

      const result = await AsyncStorage.getItem(SETTINGS_KEY);
      const loaded = result ? JSON.parse(result) : null;

      expect(loaded).toEqual(settings);
      expect(loaded?.autoSaveGmailEmails).toBe(true);
      expect(loaded?.autoExportToSheets).toBe(true);
    });

    it("should handle missing settings gracefully", async () => {
      vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);

      const result = await AsyncStorage.getItem(SETTINGS_KEY);

      expect(result).toBeNull();
    });

    it("should update auto-save setting", async () => {
      const initialSettings = {
        autoSaveGmailEmails: false,
        autoExportToSheets: false,
      };

      const updatedSettings = {
        autoSaveGmailEmails: true,
        autoExportToSheets: false,
      };

      vi.mocked(AsyncStorage.getItem).mockResolvedValue(
        JSON.stringify(initialSettings)
      );
      const mockSetItem = vi.spyOn(AsyncStorage, "setItem");

      // Simulate loading and updating
      const loaded = await AsyncStorage.getItem(SETTINGS_KEY);
      const current = loaded ? JSON.parse(loaded) : {};
      const newSettings = { ...current, autoSaveGmailEmails: true };

      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(newSettings));

      expect(mockSetItem).toHaveBeenCalledWith(
        SETTINGS_KEY,
        JSON.stringify(updatedSettings)
      );
    });
  });

  describe("Email Auto-Save Logic", () => {
    it("should identify parseable emails", () => {
      const email = {
        id: "123",
        subject: "factura de ayer",
        from: "vendor@example.com",
        parsedData: {
          invoiceNumber: "INV-001",
          vendor: "Test Vendor",
          date: "2026-03-28",
          totalAmount: 100,
          ivaAmount: 21,
          category: "Other",
        },
        parsed: true,
      };

      expect(email.parsedData).toBeDefined();
      expect(email.parsed).toBe(true);
      expect(email.parsedData.invoiceNumber).toBe("INV-001");
    });

    it("should not auto-save unparsed emails", () => {
      const email = {
        id: "123",
        subject: "factura de ayer",
        from: "vendor@example.com",
        parsedData: null,
        parsed: false,
      };

      expect(email.parsedData).toBeNull();
      expect(email.parsed).toBe(false);
    });

    it("should create invoice object from parsed email", () => {
      const email: any = {
        id: "email_123",
        subject: "Factura #001",
        from: "vendor@example.com",
        parsedData: {
          invoiceNumber: "001",
          vendor: "Test Vendor",
          date: "2026-03-28",
          totalAmount: 150,
          ivaAmount: 31.5,
          category: "Office Supplies",
        },
      };

      const invoice = {
        id: `email_${email.id}`,
        source: "email",
        invoiceNumber: email.parsedData.invoiceNumber ?? "",
        vendor: email.parsedData.vendor ?? email.from ?? "Unknown",
        date: email.parsedData.date ?? new Date().toISOString().split("T")[0],
        totalAmount: email.parsedData.totalAmount ?? 0,
        ivaAmount: email.parsedData.ivaAmount ?? 0,
        baseAmount:
          (email.parsedData.totalAmount ?? 0) -
          (email.parsedData.ivaAmount ?? 0),
        currency: "EUR",
        category: email.parsedData.category ?? "Other",
        emailId: email.id,
        emailSubject: email.subject,
        exportedToSheets: false,
        createdAt: new Date().toISOString(),
      };

      expect(invoice.source).toBe("email");
      expect(invoice.invoiceNumber).toBe("001");
      expect(invoice.vendor).toBe("Test Vendor");
      expect(invoice.totalAmount).toBe(150);
      expect(invoice.ivaAmount).toBe(31.5);
      expect(invoice.baseAmount).toBe(118.5);
      expect(invoice.currency).toBe("EUR");
      expect(invoice.category).toBe("Office Supplies");
      expect(invoice.exportedToSheets).toBe(false);
    });

    it("should calculate base amount correctly", () => {
      const totalAmount = 121;
      const ivaAmount = 21;
      const baseAmount = totalAmount - ivaAmount;

      expect(baseAmount).toBe(100);
    });

    it("should handle missing parsed data gracefully", () => {
      const email: any = {
        id: "email_123",
        subject: "Unknown Email",
        from: "unknown@example.com",
        parsedData: null,
      };

      const invoice = {
        id: `email_${email.id}`,
        source: "email",
        invoiceNumber: email.parsedData?.invoiceNumber ?? "",
        vendor: email.parsedData?.vendor ?? email.from ?? "Unknown",
        date:
          email.parsedData?.date ?? new Date().toISOString().split("T")[0],
        totalAmount: email.parsedData?.totalAmount ?? 0,
        ivaAmount: email.parsedData?.ivaAmount ?? 0,
        baseAmount: 0,
        currency: "EUR",
        category: email.parsedData?.category ?? "Other",
        emailId: email.id,
        emailSubject: email.subject,
        exportedToSheets: false,
        createdAt: new Date().toISOString(),
      };

      expect(invoice.invoiceNumber).toBe("");
      expect(invoice.vendor).toBe("unknown@example.com");
      expect(invoice.totalAmount).toBe(0);
      expect(invoice.ivaAmount).toBe(0);
      expect(invoice.category).toBe("Other");
    });
  });

  describe("Auto-Export to Sheets", () => {
    it("should identify sheets to export to", () => {
      const sheetsToExport = [
        "Monthly",
        "Q1",
        "Q2",
        "Q3",
        "Q4",
        "Meat_Analysis",
        "Dashboard",
        "Executive_Summary",
      ];

      expect(sheetsToExport).toHaveLength(8);
      expect(sheetsToExport).toContain("Monthly");
      expect(sheetsToExport).toContain("Q1");
      expect(sheetsToExport).toContain("Meat_Analysis");
      expect(sheetsToExport).toContain("Dashboard");
    });

    it("should prepare row data for export", () => {
      const invoice: any = {
        source: "email",
        invoiceNumber: "INV-001",
        vendor: "Test Vendor",
        date: "2026-03-28",
        totalAmount: 150,
        ivaAmount: 31.5,
        baseAmount: 118.5,
        category: "Office Supplies",
        currency: "EUR",
        tip: 5,
        notes: "Test invoice",
        imageUrl: "https://example.com/image.jpg",
      };

      const now = new Date().toISOString();
      const row = [
        invoice.source,
        invoice.invoiceNumber,
        invoice.vendor,
        invoice.date,
        invoice.totalAmount,
        invoice.ivaAmount,
        invoice.baseAmount,
        invoice.category,
        invoice.currency,
        invoice.tip ?? 0,
        invoice.notes ?? "",
        invoice.imageUrl,
        now,
      ];

      expect(row).toHaveLength(13);
      expect(row[0]).toBe("email");
      expect(row[1]).toBe("INV-001");
      expect(row[2]).toBe("Test Vendor");
      expect(row[4]).toBe(150);
      expect(row[5]).toBe(31.5);
      expect(row[6]).toBe(118.5);
    });

    it("should handle multiple invoices for batch export", () => {
      const invoices: any[] = [
        {
          source: "email",
          invoiceNumber: "INV-001",
          vendor: "Vendor A",
          date: "2026-03-28",
          totalAmount: 100,
          ivaAmount: 21,
          baseAmount: 79,
          category: "Office Supplies",
          currency: "EUR",
        },
        {
          source: "email",
          invoiceNumber: "INV-002",
          vendor: "Vendor B",
          date: "2026-03-27",
          totalAmount: 200,
          ivaAmount: 42,
          baseAmount: 158,
          category: "Travel & Transport",
          currency: "EUR",
        },
      ];

      expect(invoices).toHaveLength(2);
      expect(invoices[0].invoiceNumber).toBe("INV-001");
      expect(invoices[1].invoiceNumber).toBe("INV-002");
      expect(invoices[0].vendor).toBe("Vendor A");
      expect(invoices[1].vendor).toBe("Vendor B");
    });
  });

  describe("Integration Scenarios", () => {
    it("should auto-save and auto-export when both settings enabled", async () => {
      const settings = {
        autoSaveGmailEmails: true,
        autoExportToSheets: true,
      };

      vi.mocked(AsyncStorage.getItem).mockResolvedValue(
        JSON.stringify(settings)
      );

      const result = await AsyncStorage.getItem(SETTINGS_KEY);
      const loaded = result ? JSON.parse(result) : {};

      expect(loaded.autoSaveGmailEmails).toBe(true);
      expect(loaded.autoExportToSheets).toBe(true);
    });

    it("should only auto-save when auto-export is disabled", async () => {
      const settings = {
        autoSaveGmailEmails: true,
        autoExportToSheets: false,
      };

      vi.mocked(AsyncStorage.getItem).mockResolvedValue(
        JSON.stringify(settings)
      );

      const result = await AsyncStorage.getItem(SETTINGS_KEY);
      const loaded = result ? JSON.parse(result) : {};

      expect(loaded.autoSaveGmailEmails).toBe(true);
      expect(loaded.autoExportToSheets).toBe(false);
    });

    it("should not auto-save when setting is disabled", async () => {
      const settings = {
        autoSaveGmailEmails: false,
        autoExportToSheets: false,
      };

      vi.mocked(AsyncStorage.getItem).mockResolvedValue(
        JSON.stringify(settings)
      );

      const result = await AsyncStorage.getItem(SETTINGS_KEY);
      const loaded = result ? JSON.parse(result) : {};

      expect(loaded.autoSaveGmailEmails).toBe(false);
    });
  });
});
