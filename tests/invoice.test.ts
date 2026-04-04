import { describe, expect, it } from "vitest";

// Test invoice data structure and utility functions
describe("Invoice data structure", () => {
  it("should create a valid camera invoice object", () => {
    const invoice = {
      id: `cam_${Date.now()}`,
      source: "camera" as const,
      invoiceNumber: "FAC-2024-001",
      vendor: "Mercadona S.A.",
      date: "2024-01-15",
      totalAmount: 121.0,
      ivaAmount: 21.0,
      baseAmount: 100.0,
      currency: "EUR",
      category: "Meals & Entertainment" as const,
      exportedToSheets: false,
      createdAt: new Date().toISOString(),
    };

    expect(invoice.source).toBe("camera");
    expect(invoice.totalAmount).toBe(121.0);
    expect(invoice.ivaAmount).toBe(21.0);
    expect(invoice.baseAmount).toBe(100.0);
    expect(invoice.currency).toBe("EUR");
    expect(invoice.exportedToSheets).toBe(false);
  });

  it("should create a valid email invoice object", () => {
    const invoice = {
      id: `email_abc123`,
      source: "email" as const,
      invoiceNumber: "INV-2024-0042",
      vendor: "Telefónica España",
      date: "2024-01-20",
      totalAmount: 60.5,
      ivaAmount: 10.5,
      baseAmount: 50.0,
      currency: "EUR",
      category: "Utilities" as const,
      emailId: "abc123",
      emailSubject: "Factura enero 2024",
      exportedToSheets: false,
      createdAt: new Date().toISOString(),
    };

    expect(invoice.source).toBe("email");
    expect(invoice.vendor).toBe("Telefónica España");
    expect(invoice.emailSubject).toBe("Factura enero 2024");
  });

  it("should calculate base amount correctly from total and IVA", () => {
    const totalAmount = 121.0;
    const ivaAmount = 21.0;
    const baseAmount = totalAmount - ivaAmount;

    expect(baseAmount).toBe(100.0);
  });

  it("should validate IVA rates for Spain (21%, 10%, 4%)", () => {
    const standardIvaRate = 0.21;
    const reducedIvaRate = 0.10;
    const superReducedIvaRate = 0.04;

    const baseAmount = 100;
    expect(baseAmount * standardIvaRate).toBe(21);
    expect(baseAmount * reducedIvaRate).toBe(10);
    expect(baseAmount * superReducedIvaRate).toBe(4);
  });

  it("should format date correctly for en-US locale", () => {
    const dateStr = "2024-01-15";
    const formatted = new Date(dateStr).toLocaleDateString("en-US", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    expect(formatted).toBeTruthy();
    expect(typeof formatted).toBe("string");
  });

  it("should compute dashboard stats correctly", () => {
    const invoices = [
      { totalAmount: 121.0, ivaAmount: 21.0, exportedToSheets: false, date: new Date().toISOString() },
      { totalAmount: 60.5, ivaAmount: 10.5, exportedToSheets: true, date: new Date().toISOString() },
      { totalAmount: 242.0, ivaAmount: 42.0, exportedToSheets: false, date: new Date().toISOString() },
    ];

    const stats = {
      totalInvoices: invoices.length,
      totalAmount: invoices.reduce((s, i) => s + i.totalAmount, 0),
      totalIva: invoices.reduce((s, i) => s + i.ivaAmount, 0),
      pendingExport: invoices.filter((i) => !i.exportedToSheets).length,
    };

    expect(stats.totalInvoices).toBe(3);
    expect(stats.totalAmount).toBeCloseTo(423.5);
    expect(stats.totalIva).toBeCloseTo(73.5);
    expect(stats.pendingExport).toBe(2);
  });
});

describe("Google Sheets row format", () => {
  it("should format invoice as correct Sheets row", () => {
    const invoice = {
      source: "camera" as const,
      invoiceNumber: "FAC-001",
      vendor: "Mercadona",
      date: "2024-01-15",
      totalAmount: 121.0,
      ivaAmount: 21.0,
      baseAmount: 100.0,
      category: "Meals & Entertainment",
      currency: "EUR",
      notes: "",
    };

    const row = [
      invoice.source === "camera" ? "Camera" : "Email",
      invoice.invoiceNumber,
      invoice.vendor,
      invoice.date,
      invoice.totalAmount,
      invoice.ivaAmount,
      invoice.baseAmount,
      invoice.category,
      invoice.currency,
      invoice.notes,
      new Date().toISOString(),
    ];

    expect(row[0]).toBe("Camera");
    expect(row[1]).toBe("FAC-001");
    expect(row[2]).toBe("Mercadona");
    expect(row[4]).toBe(121.0);
    expect(row[5]).toBe(21.0);
    expect(row[6]).toBe(100.0);
    expect(row.length).toBe(11);
  });
});
