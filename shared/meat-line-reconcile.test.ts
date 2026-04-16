import { describe, expect, it } from "vitest";
import { reconcileMeatLineItemsForInvoice } from "./meat-line-reconcile";

describe("reconcileMeatLineItemsForInvoice", () => {
  it("derives €/kg from line total when ex-VAT price does not match Importe (Es Cuco style)", () => {
    const raw = [
      { partName: "CHULETON TOMAHAWK ANGUS", quantity: 1.83, pricePerUnit: 47.9, total: 96.42 },
      { partName: "TAPA DE VACUNO", quantity: 2.335, pricePerUnit: 14.31, total: 36.76 },
    ];
    const out = reconcileMeatLineItemsForInvoice(raw, {
      totalAmount: 133.18,
      vendor: "Es Cuco",
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.pricePerUnit).toBe(52.69);
    expect(out[0]?.total).toBe(96.42);
    expect(out[1]?.pricePerUnit).toBe(15.74);
    expect(out[1]?.total).toBe(36.76);
    const sum = out.reduce((s, x) => s + x.total, 0);
    expect(Math.round(sum * 100) / 100).toBe(133.18);
  });

  it("scales line totals toward header when OCR lines sum low but footer total OK (tracked vendor)", () => {
    const raw = [
      { partName: "A", quantity: 1.83, pricePerUnit: 47.9, total: 95.62 },
      { partName: "B", quantity: 2.335, pricePerUnit: 14.31, total: 35.78 },
    ];
    const out = reconcileMeatLineItemsForInvoice(raw, {
      totalAmount: 133.18,
      vendor: "Es Cuco",
    });
    expect(out).toHaveLength(2);
    const sum = out.reduce((s, x) => s + x.total, 0);
    expect(Math.round(sum * 100) / 100).toBe(133.18);
  });

  it("skips LOTE traceability rows", () => {
    const raw = [
      { partName: "LOTE: 05 EAPV ORIGEN: ESPAÑA", quantity: 1, pricePerUnit: 0, total: 0 },
      { partName: "CHULETON", quantity: 1.8, pricePerUnit: 50, total: 90 },
    ];
    const out = reconcileMeatLineItemsForInvoice(raw, { totalAmount: 90, vendor: "Es Cuco" });
    expect(out).toHaveLength(1);
    expect(out[0]?.partName).toBe("CHULETON");
  });
});
