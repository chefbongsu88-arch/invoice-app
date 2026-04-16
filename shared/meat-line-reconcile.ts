import {
  isMeatLotOrigenTraceabilityLine,
  isTrackedMeatSupplierVendor,
} from "./invoice-types";

/** Parse amount from DB/OCR (Euro comma decimals, symbols). */
export function parseMoney(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined) return 0;
  const cleaned = String(value).replace(/[€$£¥₩,\s]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

const MONEY_EPS = 0.02;

/** Default IVA% on meat lines when OCR omits per-line rate (Spanish butcher albaranes). */
export const DEFAULT_MEAT_LINE_IVA_PERCENT = 10;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseLineIvaPercent(raw: Record<string, unknown>): number | null {
  const keys = ["ivaPercent", "iva", "lineIvaPercent", "iva_pct", "vatPercent", "vat"];
  for (const k of keys) {
    const v = raw[k as keyof typeof raw];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    const n = parseMoney(v);
    if (!Number.isFinite(n) || n < 0) continue;
    if (n > 0 && n <= 30) return n;
  }
  return null;
}

export type MeatLineDraft = {
  partName: string;
  quantity: number;
  unit: string;
  /** €/kg including IVA (P.V.P.) — Importe ÷ kg. */
  pricePerKgIncVat: number;
  total: number;
  /** IVA % on line — OCR, else default for tracked meat suppliers, else null. */
  ivaPercentResolved: number | null;
  /** €/kg before IVA (Precio). */
  pricePerKgExVat: number | null;
};

type WorkingLine = {
  partName: string;
  quantity: number;
  unit: string;
  total: number;
  /** Candidate €/kg from OCR (often Precio ex IVA) — reconciled to inc VAT. */
  priceKgHint: number;
  ivaFromOcr: number | null;
  /** Column N flagged `totalIsNet` / `totalIncludesVat: false` — already grossed up in the first pass. */
  explicitNet: boolean;
};

/**
 * Meat receipt line reconciliation for Sheets + OCR:
 *
 * 1. Per line: Spanish albaranes print Precio (ex IVA), P.V.P./kg (inc IVA), and Importe. OCR often mixes Precio with
 *    Importe — we keep **Importe** as truth, set **€/kg inc IVA** = Importe ÷ kg, then **€/kg ex IVA** = inc ÷ (1+IVA/100)
 *    when IVA % is known (from OCR or default 10% for tracked meat suppliers).
 * 2. Per invoice (tracked meat suppliers only): if sum(line totals) drifts from header `totalAmount` by a few %,
 *    scale line totals to match the header (fixes OCR digit drops on lines vs OK footer total).
 * 3. Column N may store **net** line `total` (matches Base (€)); use `totalIsNet`/`totalIncludesVat:false`, or for a single
 *    La Portenia-style line infer gross when `total × (1+IVA%)` matches the main Total (€).
 */
export function reconcileMeatLineItemsForInvoice(
  rawItems: unknown[] | null | undefined,
  invoice: { totalAmount?: unknown; vendor?: unknown },
): MeatLineDraft[] {
  const vendor = String(invoice.vendor ?? "");
  const headerTotal = parseMoney(invoice.totalAmount);
  const working: WorkingLine[] = [];

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

    const priceKgHint = parseMoney(
      o.pricePerUnit ?? o.price_per_unit ?? o.unitPrice ?? o.priceKg ?? o.price_kg,
    );
    /** When true, `total` is net/base (before line IVA); we convert to gross for sums vs main TOTAL column. */
    const totalIsNet =
      o.totalIsNet === true ||
      o.lineTotalIsNet === true ||
      o.totalIncludesVat === false;

    let lineTotal = parseMoney(o.total ?? o.amount ?? o.importe ?? o.lineTotal);
    const ivaFromLine = parseLineIvaPercent(o);
    if (totalIsNet) {
      const rate =
        ivaFromLine ??
        (isTrackedMeatSupplierVendor(vendor) ? DEFAULT_MEAT_LINE_IVA_PERCENT : null);
      if (rate != null && rate > 0) {
        lineTotal = round2(lineTotal * (1 + rate / 100));
      }
    }

    if (quantity <= 0 || lineTotal <= 0) continue;

    const unit = "kg";

    working.push({
      partName,
      quantity: Math.round(quantity * 1000) / 1000,
      unit,
      total: round2(lineTotal),
      priceKgHint: priceKgHint > 0 ? round2(priceKgHint) : 0,
      ivaFromOcr: ivaFromLine,
      explicitNet: totalIsNet,
    });
  }

  if (working.length === 0) return [];

  /** Legacy column N: one line, `total` is base (81.07) while main Total (€) is gross (89.18) — bump when it fits. */
  if (
    working.length === 1 &&
    !working[0]!.explicitNet &&
    headerTotal > 0 &&
    isTrackedMeatSupplierVendor(vendor)
  ) {
    const it = working[0]!;
    const iva = it.ivaFromOcr ?? DEFAULT_MEAT_LINE_IVA_PERCENT;
    if (iva > 0) {
      const bumped = round2(it.total * (1 + iva / 100));
      if (
        Math.abs(bumped - headerTotal) <= 0.06 &&
        Math.abs(it.total - headerTotal) > MONEY_EPS
      ) {
        it.total = bumped;
      }
    }
  }

  for (const it of working) {
    if (it.quantity <= 0) continue;
    const impliedInc = it.total / it.quantity;
    const fromHint = it.priceKgHint > 0 ? it.priceKgHint : impliedInc;
    const gap = Math.abs(it.quantity * fromHint - it.total);
    const rel = gap / Math.max(it.total, 0.01);
    let incPerKg: number;
    if (gap > MONEY_EPS && rel > 0.015) {
      incPerKg = round2(impliedInc);
    } else {
      incPerKg = round2(fromHint);
      const check = round2(it.quantity * incPerKg);
      if (Math.abs(check - it.total) > MONEY_EPS) {
        incPerKg = round2(it.total / it.quantity);
      }
    }
    it.priceKgHint = incPerKg;
  }

  const sumLines = round2(working.reduce((s, x) => s + x.total, 0));

  const relDiff =
    headerTotal > 0 && sumLines > 0
      ? Math.abs(sumLines - headerTotal) / Math.max(sumLines, headerTotal, 0.01)
      : 0;

  const allowHeaderScale =
    headerTotal > 0 &&
    sumLines > 0 &&
    working.length >= 1 &&
    Math.abs(sumLines - headerTotal) > MONEY_EPS &&
    isTrackedMeatSupplierVendor(vendor) &&
    relDiff <= 0.04;

  if (allowHeaderScale) {
    const factor = headerTotal / sumLines;
    let acc = 0;
    for (let i = 0; i < working.length; i++) {
      const last = i === working.length - 1;
      if (last) {
        working[i].total = round2(headerTotal - acc);
      } else {
        working[i].total = round2(working[i].total * factor);
        acc += working[i].total;
      }
    }
    for (const it of working) {
      if (it.quantity > 0) it.priceKgHint = round2(it.total / it.quantity);
    }
  }

  const out: MeatLineDraft[] = working.map((it) => {
    const inc = it.quantity > 0 ? round2(it.total / it.quantity) : 0;
    const ivaPct =
      it.ivaFromOcr ?? (isTrackedMeatSupplierVendor(vendor) ? DEFAULT_MEAT_LINE_IVA_PERCENT : null);
    let ex: number | null = null;
    if (ivaPct != null && ivaPct > 0 && inc > 0) {
      ex = round2(inc / (1 + ivaPct / 100));
    }
    return {
      partName: it.partName,
      quantity: it.quantity,
      unit: it.unit,
      pricePerKgIncVat: inc,
      total: it.total,
      ivaPercentResolved: ivaPct,
      pricePerKgExVat: ex,
    };
  });

  return out;
}
