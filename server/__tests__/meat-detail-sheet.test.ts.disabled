import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMeatDetailSheet, getMonthName } from "../sheets-automation-enhanced";

// Mock the appendToSheet and ensureSheetExists functions
vi.mock("../sheets-automation-enhanced", async () => {
  const actual = await vi.importActual("../sheets-automation-enhanced");
  return {
    ...actual,
    appendToSheet: vi.fn(),
    ensureSheetExists: vi.fn(),
  };
});

describe("Meat_Detail Sheet Creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create Meat_Detail sheet with correct headers", async () => {
    const { ensureSheetExists } = await import("../sheets-automation-enhanced");
    
    const config = {
      spreadsheetId: "test-sheet-id",
      accessToken: "test-token",
      invoiceData: [],
    };

    await createMeatDetailSheet(config);

    expect(ensureSheetExists).toHaveBeenCalledWith(
      "test-sheet-id",
      "Meat_Detail",
      "test-token",
      expect.arrayContaining([
        "Date",
        "Vendor",
        "Part Name",
        "Quantity (kg)",
        "Price/kg (€)",
        "Total (€)",
        "Month",
      ])
    );
  });

  it("should extract meat items from invoices", async () => {
    const { appendToSheet } = await import("../sheets-automation-enhanced");
    
    const config = {
      spreadsheetId: "test-sheet-id",
      accessToken: "test-token",
      invoiceData: [
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
      ],
    };

    await createMeatDetailSheet(config);

    expect(appendToSheet).toHaveBeenCalledWith(
      "test-sheet-id",
      "Meat_Detail",
      "test-token",
      expect.arrayContaining([
        ["2026-03-25", "La portenia carnes premium", "A5 Beef", "2.00", "150.00", "300.00", "March"],
        ["2026-03-25", "La portenia carnes premium", "Wagyu", "1.00", "200.00", "200.00", "March"],
      ])
    );
  });

  it("should skip invoices without items", async () => {
    const { appendToSheet } = await import("../sheets-automation-enhanced");
    
    const config = {
      spreadsheetId: "test-sheet-id",
      accessToken: "test-token",
      invoiceData: [
        {
          source: "camera",
          invoiceNumber: "INV001",
          vendor: "IKEA",
          date: "2026-03-25",
          totalAmount: 324,
          ivaAmount: 56.23,
          baseAmount: 267.77,
          category: "Furniture",
          currency: "EUR",
          items: undefined,
        },
      ],
    };

    await createMeatDetailSheet(config);

    expect(appendToSheet).not.toHaveBeenCalled();
  });

  it("should skip non-meat vendors", async () => {
    const { appendToSheet } = await import("../sheets-automation-enhanced");
    
    const config = {
      spreadsheetId: "test-sheet-id",
      accessToken: "test-token",
      invoiceData: [
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
      ],
    };

    await createMeatDetailSheet(config);

    expect(appendToSheet).not.toHaveBeenCalled();
  });

  it("should handle multiple meat vendors", async () => {
    const { appendToSheet } = await import("../sheets-automation-enhanced");
    
    const config = {
      spreadsheetId: "test-sheet-id",
      accessToken: "test-token",
      invoiceData: [
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
      ],
    };

    await createMeatDetailSheet(config);

    expect(appendToSheet).toHaveBeenCalledWith(
      "test-sheet-id",
      "Meat_Detail",
      "test-token",
      expect.arrayContaining([
        ["2026-03-25", "La portenia carnes premium", "A5 Beef", "2.00", "150.00", "300.00", "March"],
        ["2026-03-26", "Es cuco", "Pork Ribs", "3.00", "50.00", "150.00", "March"],
      ])
    );
  });

  it("should format quantities and prices with 2 decimal places", async () => {
    const { appendToSheet } = await import("../sheets-automation-enhanced");
    
    const config = {
      spreadsheetId: "test-sheet-id",
      accessToken: "test-token",
      invoiceData: [
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
      ],
    };

    await createMeatDetailSheet(config);

    expect(appendToSheet).toHaveBeenCalledWith(
      "test-sheet-id",
      "Meat_Detail",
      "test-token",
      expect.arrayContaining([
        ["2026-03-25", "La portenia", "Beef", "2.50", "45.68", "114.20", "March"],
      ])
    );
  });
});
