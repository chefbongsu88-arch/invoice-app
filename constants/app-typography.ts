import type { TextStyle } from "react-native";

/**
 * Phone-first type scale: slightly smaller than desktop defaults so rows stay
 * aligned and long vendor names fit. Pair every fontSize with an explicit lineHeight.
 */

/** Home only — main workbook title */
export const APP_HOME_HERO_TITLE: TextStyle = {
  fontSize: 28,
  fontWeight: "800",
  letterSpacing: -0.45,
  lineHeight: 34,
  marginTop: 4,
};

/** Receipts, Settings, Stats, Gmail headers, Scan step titles */
export const APP_SCREEN_HEADER: TextStyle = {
  fontSize: 26,
  fontWeight: "800",
  letterSpacing: -0.4,
  lineHeight: 32,
};

export const APP_GREETING: TextStyle = {
  fontSize: 12,
  fontWeight: "500",
  letterSpacing: 0.12,
  lineHeight: 16,
};

export const APP_SECTION_TITLE: TextStyle = {
  fontSize: 16,
  fontWeight: "800",
  letterSpacing: -0.22,
  lineHeight: 20,
  marginBottom: 10,
};

export const APP_LINK: TextStyle = {
  fontSize: 13,
  fontWeight: "500",
  lineHeight: 18,
};

export const APP_STAT_VALUE: TextStyle = {
  fontSize: 22,
  fontWeight: "800",
  letterSpacing: -0.38,
  lineHeight: 26,
};

export const APP_STAT_LABEL: TextStyle = {
  fontSize: 11,
  fontWeight: "700",
  lineHeight: 14,
  marginTop: 3,
};

export const APP_STAT_SUB: TextStyle = {
  fontSize: 10,
  fontWeight: "500",
  lineHeight: 13,
  marginTop: 2,
};

export const APP_QUICK_ICON_BOX = 46;
export const APP_QUICK_ICON_RADIUS = 13;
export const APP_QUICK_ICON_GLYPH = 24;

export const APP_QUICK_LABEL: TextStyle = {
  fontSize: 11,
  fontWeight: "800",
  lineHeight: 14,
  letterSpacing: -0.06,
  textAlign: "center",
  paddingHorizontal: 2,
};

export const APP_QUICK_MIN_H = 96;
export const APP_QUICK_FULL_MIN_H = 90;

export const APP_EMPTY_TITLE: TextStyle = {
  fontSize: 18,
  fontWeight: "700",
  lineHeight: 22,
};

export const APP_EMPTY_DESC: TextStyle = {
  fontSize: 14,
  lineHeight: 20,
  textAlign: "center",
};

export const APP_EMPTY_ICON = 44;

/** Statistics — section under chart */
export const APP_STATS_SECTION: TextStyle = {
  fontSize: 17,
  fontWeight: "700",
  lineHeight: 22,
};

export const APP_STATS_SUBTITLE: TextStyle = {
  fontSize: 13,
  lineHeight: 18,
};

/** Scan flow main headings */
export const APP_SCAN_STEP_TITLE: TextStyle = {
  fontSize: 24,
  fontWeight: "700",
  lineHeight: 30,
};

/** Receipt detail — merchant line */
export const APP_RECEIPT_VENDOR: TextStyle = {
  fontSize: 24,
  fontWeight: "700",
  lineHeight: 30,
};
