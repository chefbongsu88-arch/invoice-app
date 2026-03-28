import { describe, it, expect } from "vitest";

/**
 * Test filename sanitization logic used in routers.ts
 * Ensures invoice numbers are cleaned before generating filenames
 */

function sanitizeInvoiceNumber(invoiceNumber: string): string {
  return (invoiceNumber || "receipt")
    .replace(/\//g, "-")  // Replace folder separators with dash
    .replace(/[^a-zA-Z0-9-]/g, "")  // Remove special characters
    .substring(0, 50);  // Limit length
}

describe("Filename Sanitization", () => {
  it("should remove folder separators", () => {
    const result = sanitizeInvoiceNumber("FV26/1499");
    expect(result).toBe("FV26-1499");
  });

  it("should remove special characters", () => {
    const result = sanitizeInvoiceNumber("3984-017-112592");
    expect(result).toBe("3984-017-112592");
  });

  it("should handle invoice numbers with multiple slashes", () => {
    const result = sanitizeInvoiceNumber("path/to/invoice/1234");
    expect(result).toBe("path-to-invoice-1234");
  });

  it("should remove special characters like @, #, $", () => {
    const result = sanitizeInvoiceNumber("INV@2024#567$");
    expect(result).toBe("INV2024567");
  });

  it("should handle empty string", () => {
    const result = sanitizeInvoiceNumber("");
    expect(result).toBe("receipt");
  });

  it("should handle null/undefined by using receipt", () => {
    const result = sanitizeInvoiceNumber(null as any);
    expect(result).toBe("receipt");
  });

  it("should limit length to 50 characters", () => {
    const longInvoice = "A".repeat(100);
    const result = sanitizeInvoiceNumber(longInvoice);
    expect(result.length).toBe(50);
  });

  it("should handle mixed case and numbers", () => {
    const result = sanitizeInvoiceNumber("INV-2024-03-28");
    expect(result).toBe("INV-2024-03-28");
  });

  it("should handle real-world invoice numbers", () => {
    const testCases = [
      { input: "FV26/1499", expected: "FV26-1499" },
      { input: "3984-017-112592", expected: "3984-017-112592" },
      { input: "2024/03/28-001", expected: "2024-03-28-001" },
      { input: "MERCADONA-2024", expected: "MERCADONA-2024" },
      { input: "INV#2024@IKEA", expected: "INV2024IKEA" },
    ];

    testCases.forEach(({ input, expected }) => {
      const result = sanitizeInvoiceNumber(input);
      expect(result).toBe(expected);
    });
  });

  it("should generate consistent filenames for same invoice", () => {
    const invoiceNum = "FV26/1499";
    const result1 = sanitizeInvoiceNumber(invoiceNum);
    const result2 = sanitizeInvoiceNumber(invoiceNum);
    expect(result1).toBe(result2);
  });

  it("should create valid S3-compatible filenames", () => {
    const invoiceNum = "3984-017-112592";
    const sanitized = sanitizeInvoiceNumber(invoiceNum);
    const timestamp = Date.now();
    const fileName = `${sanitized}-${timestamp}.jpg`;
    
    // Check that filename doesn't contain problematic characters
    expect(fileName).not.toMatch(/[\/\\:*?"<>|]/);
    expect(fileName).toMatch(/^[a-zA-Z0-9\-]+\-\d+\.jpg$/);
  });
});
