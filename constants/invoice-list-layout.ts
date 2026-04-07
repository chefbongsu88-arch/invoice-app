import type { TextStyle, ViewStyle } from "react-native";

/**
 * Home “Recent Invoices”, Receipts cards, and similar rows:
 * row1 = title (flex) + amount (right), row2 = meta + pill.
 * Vendor + € use the same fontSize + lineHeight so the first line stays level on phones.
 */
export const INVOICE_LIST_ICON_SIZE = 44;
export const INVOICE_LIST_ICON_RADIUS = 11;
/** Symbol size inside the square (SF Symbol / Material). */
export const INVOICE_LIST_ICON_GLYPH = 20;
export const INVOICE_LIST_ROW_GAP = 12;
export const INVOICE_LIST_INNER_GAP = 4;

export const invoiceListVendorText: TextStyle = {
  fontSize: 15,
  fontWeight: "800",
  letterSpacing: -0.28,
  lineHeight: 21,
};

export const invoiceListAmountText: TextStyle = {
  fontSize: 15,
  fontWeight: "800",
  letterSpacing: -0.3,
  lineHeight: 21,
  textAlign: "right",
};

export const invoiceListMetaText: TextStyle = {
  fontSize: 12,
  fontWeight: "500",
  lineHeight: 16,
};

export const invoiceListPillLabelText: TextStyle = {
  fontSize: 10,
  fontWeight: "800",
  lineHeight: 12,
};

export const invoiceListRowOuter: ViewStyle = {
  flexDirection: "row",
  alignItems: "center",
  gap: INVOICE_LIST_ROW_GAP,
};

export const invoiceListBody: ViewStyle = {
  flex: 1,
  minWidth: 0,
  gap: INVOICE_LIST_INNER_GAP,
};

/** Title + amount: tops align; amount does not float above vendor. */
export const invoiceListRow1: ViewStyle = {
  flexDirection: "row",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
};

export const invoiceListRow2: ViewStyle = {
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

/** Statistics / category summary rows — same first-line alignment idea. */
export const statsRowTitleText: TextStyle = {
  fontSize: 14,
  fontWeight: "600",
  lineHeight: 20,
};

export const statsRowAmountText: TextStyle = {
  fontSize: 14,
  fontWeight: "700",
  lineHeight: 20,
  textAlign: "right",
};

export const statsRowSubText: TextStyle = {
  fontSize: 11,
  fontWeight: "500",
  lineHeight: 15,
  marginTop: 3,
};
