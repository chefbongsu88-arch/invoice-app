import { isMeatLotOrigenTraceabilityLine, isTrackedMeatSupplierVendor } from "./invoice-types";

/** Parse amount from DB/OCR (Euro comma decimals, symbols). */
export function parseMoney(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined) return 0;
  const cleaned = String(value).replace(/[€$£¥₩,\s]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

const MONEY_EPS = 0.02;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type MeatLineDraft = {
  partName: string;
  quantity: number;
  unit: string;
  pricePerUnit: number;
  total: number;
};

/**
 * Meat receipt line reconciliation for Sheets + OCR:
 *
 * 1. Per line: Spanish albaranes often give ex-VAT €/kg (Precio) but line total = Importe (incl. IVA on that line).
 *    We treat line **total** as authoritative and set €/kg = total/qty so Quantity × €/kg ≈ Total.
 * 2. Per invoice (tracked meat suppliers only): if sum(line totals) drifts from header `totalAmount` by a few %,
 *    scale line totals to match the header (fixes OCR digit drops on lines vs OK footer total).
 */
export function reconcileMeatLineItemsForInvoice(
  rawItems: unknown[] | null | undefined,
  invoice: { totalAmount?: unknown; vendor?: unknown },
): MeatLineDraft[] {
  const items: MeatLineDraft[] = [];

  for (const raw of rawItems ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const partName = String(o.partName ?? "").trim();
    if (!partName || isMeatLotOrigenTraceabilityLine(partName)) continue;

    const rawUnit = String(o.unit ?? o.uom ?? "kg").trim().toLowerCase();
    let quantity = parseMoney(o.quantity ?? o.qty ?? o.kg);
    if (rawUnit === "g" || rawUnit === "gram" || rawUnit === "grams" || rawUnit === "gr") {
      quantity = quantity / 1000;
    }

    let pricePerUnit = parseMoney(
      o.pricePerUnit ?? o.price_per_unit ?? o.unitPrice ?? o.priceKg ?? o.price_kg,
    );
    let total = parseMoney(o.total ?? o.amount ?? o.importe ?? o.lineTotal);

    if (quantity <= 0 || total <= 0) continue;

    const unit = rawUnit === "g" || rawUnit === "gram" || rawUnit === "grams" || rawUnit === "gr" ? "kg" : "kg";

    items.push({
      partName,
      quantity: Math.round(quantity * 1000) / 1000,
      unit,
      pricePerUnit: pricePerUnit > 0 ? round2(pricePerUnit) : 0,
      total: round2(total),
    });
  }

  if (items.length === 0) return items;

  for (const it of items) {
    if (it.quantity <= 0) continue;
    const implied = it.total / it.quantity;
    const fromPp = it.pricePerUnit > 0 ? it.pricePerUnit : implied;
    const gap = Math.abs(it.quantity * fromPp - it.total);
    const rel = gap / Math.max(it.total, 0.01);
    if (gap > MONEY_EPS && rel > 0.015) {
      it.pricePerUnit = round2(implied);
    } else {
      it.pricePerUnit = round2(fromPp);
      const check = round2(it.quantity * it.pricePerUnit);
      if (Math.abs(check - it.total) > MONEY_EPS) {
        it.pricePerUnit = round2(it.total / it.quantity);
      }
    }
  }

  const headerTotal = parseMoney(invoice.totalAmount);
  const sumLines = round2(items.reduce((s, x) => s + x.total, 0));
  const vendor = String(invoice.vendor ?? "");

  const relDiff =
    headerTotal > 0 && sumLines > 0
      ? Math.abs(sumLines - headerTotal) / Math.max(sumLines, headerTotal, 0.01)
      : 0;

  const allowHeaderScale =
    headerTotal > 0 &&
    sumLines > 0 &&
    items.length >= 1 &&
    Math.abs(sumLines - headerTotal) > MONEY_EPS &&
    isTrackedMeatSupplierVendor(vendor) &&
    relDiff <= 0.04;

  if (allowHeaderScale) {
    const factor = headerTotal / sumLines;
    let acc = 0;
    for (let i = 0; i < items.length; i++) {
      const last = i === items.length - 1;
      if (last) {
        items[i].total = round2(headerTotal - acc);
      } else {
        items[i].total = round2(items[i].total * factor);
        acc += items[i].total;
      }
    }
    for (const it of items) {
      if (it.quantity > 0) it.pricePerUnit = round2(it.total / it.quantity);
    }
  }

  return items;
}
