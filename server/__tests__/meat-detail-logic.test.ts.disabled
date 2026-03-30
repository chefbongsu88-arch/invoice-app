import { describe, it, expect } from "vitest";
import { getMonthName } from "../sheets-automation-enhanced";

/**
 * Test the logic for meat detail sheet creation
 * These tests verify the data transformation logic without mocking Google Sheets API
 */

interface MeatItem {
  partName: string;
  quantity: number;
  unit: string;
  pricePerUnit: number;
  total: number;
}

interface InvoiceRecord {
  source: string;
  invoiceNumber: string;
  vendor: string;
  date: string;
  totalAmount: number;
  ivaAmount: number;
  baseAmount: number;
  category: string;
  currency: string;
  items?: MeatItem[];
}

function extractMeatDetails(
  invoiceData: InvoiceRecord[],
  meatVendors: string[] = ["La portenia", "es cuco"]
): Array<[string, string, string, string, string, string, string]> {
  const meatDetailRows: Array<[string, string, string, string, string, string, string]> = [];

  for (const invoice of invoiceData) {
    const isMeatVendor = meatVendors.some((vendor) =>
      invoice.vendor.toLowerCase().includes(vendor.toLowerCase())
    );
    if (isMeatVendor && invoice.items && invoice.items.length > 0) {
      const monthName = getMonthName(invoice.date);

      for (const item of invoice.items) {
        meatDetailRows.push([
          invoice.date,
          invoice.vendor,
          item.partName,
          item.quantity.toFixed(2),
          item.pricePerUnit.toFixed(2),
          item.total.toFixed(2),
          monthName,
        ]);
      }
    }
  }

  return meatDetailRows;
}

describe("Meat Detail Logic", () => {
  it("should extract meat items from La portenia invoices", () => {
    const invoiceData: InvoiceRecord[] = [
      {
        source: "camera",
        invoiceNumber: "FV26/1499",
        vendor: "La portenia carnes premium",
        date: "2026-03-25",
        totalAmount: 500,
        ivaAmount: 50,
        baseAmount: 450,
        category: "Meat",
        currency: "EUR",
        items: [
          {
            partName: "A5 Beef",
            quantity: 2,
            unit: "kg",
            pricePerUnit: 150,
            total: 300,
          },
          {
            partName: "Wagyu",
            quantity: 1,
            unit: "kg",
            pricePerUnit: 200,
            total: 200,
          },
        ],
      },
    ];

    const result = extractMeatDetails(invoiceData);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([
      "2026-03-25",
      "La portenia carnes premium",
      "A5 Beef",
      "2.00",
      "150.00",
      "300.00",
      "March",
    ]);
    expect(result[1]).toEqual([
      "2026-03-25",
      "La portenia carnes premium",
      "Wagyu",
      "1.00",
      "200.00",
      "200.00",
      "March",
    ]);
  });

  it("should extract meat items from Es cuco invoices", () => {
    const invoiceData: InvoiceRecord[] = [
      {
        source: "camera",
        invoiceNumber: "RF1F/67",
        vendor: "Es cuco",
        date: "2026-03-26",
        totalAmount: 200,
        ivaAmount: 20,
        baseAmount: 180,
        category: "Meat",
        currency: "EUR",
        items: [
          {
            partName: "Pork Ribs",
            quantity: 3,
            unit: "kg",
            pricePerUnit: 50,
            total: 150,
          },
        ],
      },
    ];

    const result = extractMeatDetails(invoiceData);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([
      "2026-03-26",
      "Es cuco",
      "Pork Ribs",
      "3.00",
      "50.00",
      "150.00",
      "March",
    ]);
  });

  it("should skip invoices without items", () => {
    const invoiceData: InvoiceRecord[] = [
      {
        source: "camera",
        invoiceNumber: "INV001",
        vendor: "La portenia",
        date: "2026-03-25",
        totalAmount: 324,
        ivaAmount: 56.23,
        baseAmount: 267.77,
        category: "Meat",
        currency: "EUR",
        items: undefined,
      },
    ];

    const result = extractMeatDetails(invoiceData);

    expect(result).toHaveLength(0);
  });

  it("should skip non-meat vendors", () => {
    const invoiceData: InvoiceRecord[] = [
      {
        source: "camera",
        invoiceNumber: "INV001",
        vendor: "Mercadona",
        date: "2026-03-25",
        totalAmount: 100,
        ivaAmount: 10,
        baseAmount: 90,
        category: "Groceries",
        currency: "EUR",
        items: [
          {
            partName: "Vegetables",
            quantity: 5,
            unit: "kg",
            pricePerUnit: 2,
            total: 10,
          },
        ],
      },
    ];

    const result = extractMeatDetails(invoiceData);

    expect(result).toHaveLength(0);
  });

  it("should handle multiple invoices with mixed vendors", () => {
    const invoiceData: InvoiceRecord[] = [
      {
        source: "camera",
        invoiceNumber: "FV26/1499",
        vendor: "La portenia carnes premium",
        date: "2026-03-25",
        totalAmount: 300,
        ivaAmount: 30,
        baseAmount: 270,
        category: "Meat",
        currency: "EUR",
        items: [
          {
            partName: "A5 Beef",
            quantity: 2,
            unit: "kg",
            pricePerUnit: 150,
            total: 300,
          },
        ],
      },
      {
        source: "camera",
        invoiceNumber: "INV002",
        vendor: "IKEA",
        date: "2026-03-25",
        totalAmount: 324,
        ivaAmount: 56.23,
        baseAmount: 267.77,
        category: "Furniture",
        currency: "EUR",
        items: undefined,
      },
      {
        source: "camera",
        invoiceNumber: "RF1F/67",
        vendor: "Es cuco",
        date: "2026-03-26",
        totalAmount: 200,
        ivaAmount: 20,
        baseAmount: 180,
        category: "Meat",
        currency: "EUR",
        items: [
          {
            partName: "Pork Ribs",
            quantity: 3,
            unit: "kg",
            pricePerUnit: 50,
            total: 150,
          },
        ],
      },
    ];

    const result = extractMeatDetails(invoiceData);

    expect(result).toHaveLength(2);
    expect(result[0][2]).toBe("A5 Beef");
    expect(result[1][2]).toBe("Pork Ribs");
  });

  it("should format quantities and prices with 2 decimal places", () => {
    const invoiceData: InvoiceRecord[] = [
      {
        source: "camera",
        invoiceNumber: "FV26/1499",
        vendor: "La portenia",
        date: "2026-03-25",
        totalAmount: 123.456,
        ivaAmount: 12.3456,
        baseAmount: 111.1104,
        category: "Meat",
        currency: "EUR",
        items: [
          {
            partName: "Beef",
            quantity: 2.5,
            unit: "kg",
            pricePerUnit: 45.678,
            total: 114.195,
          },
        ],
      },
    ];

    const result = extractMeatDetails(invoiceData);

    expect(result).toHaveLength(1);
    expect(result[0][3]).toBe("2.50");
    expect(result[0][4]).toBe("45.68");
    expect(result[0][5]).toBe("114.19");  // JavaScript rounding: 114.195 -> 114.19
  });

  it("should handle empty invoice data", () => {
    const invoiceData: InvoiceRecord[] = [];

    const result = extractMeatDetails(invoiceData);

    expect(result).toHaveLength(0);
  });

  it("should handle multiple items from same invoice", () => {
    const invoiceData: InvoiceRecord[] = [
      {
        source: "camera",
        invoiceNumber: "FV26/1499",
        vendor: "La portenia",
        date: "2026-03-25",
        totalAmount: 1000,
        ivaAmount: 100,
        baseAmount: 900,
        category: "Meat",
        currency: "EUR",
        items: [
          {
            partName: "A5 Beef",
            quantity: 2,
            unit: "kg",
            pricePerUnit: 150,
            total: 300,
          },
          {
            partName: "Wagyu",
            quantity: 1,
            unit: "kg",
            pricePerUnit: 200,
            total: 200,
          },
          {
            partName: "Lamb",
            quantity: 3,
            unit: "kg",
            pricePerUnit: 100,
            total: 300,
          },
          {
            partName: "Pork",
            quantity: 2,
            unit: "kg",
            pricePerUnit: 50,
            total: 100,
          },
        ],
      },
    ];

    const result = extractMeatDetails(invoiceData);

    expect(result).toHaveLength(4);
    expect(result.map((r) => r[2])).toEqual(["A5 Beef", "Wagyu", "Lamb", "Pork"]);
  });

  it("should correctly identify meat vendors with partial name match", () => {
    const invoiceData: InvoiceRecord[] = [
      {
        source: "camera",
        invoiceNumber: "FV26/1499",
        vendor: "La portenia carnes premium",
        date: "2026-03-25",
        totalAmount: 300,
        ivaAmount: 30,
        baseAmount: 270,
        category: "Meat",
        currency: "EUR",
        items: [
          {
            partName: "Beef",
            quantity: 2,
            unit: "kg",
            pricePerUnit: 150,
            total: 300,
          },
        ],
      },
      {
        source: "camera",
        invoiceNumber: "RF1F/67",
        vendor: "es cuco restaurant",
        date: "2026-03-26",
        totalAmount: 200,
        ivaAmount: 20,
        baseAmount: 180,
        category: "Meat",
        currency: "EUR",
        items: [
          {
            partName: "Pork",
            quantity: 3,
            unit: "kg",
            pricePerUnit: 50,
            total: 150,
          },
        ],
      },
    ];

    const result = extractMeatDetails(invoiceData);

    expect(result).toHaveLength(2);
  });
});
