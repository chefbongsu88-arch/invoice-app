// Fallback for using MaterialIcons on Android and web.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { SymbolWeight, SymbolViewProps } from "expo-symbols";
import { ComponentProps } from "react";
import { OpaqueColorValue, type StyleProp, type TextStyle } from "react-native";

type IconMapping = Record<SymbolViewProps["name"], ComponentProps<typeof MaterialIcons>["name"]>;
type IconSymbolName = keyof typeof MAPPING;

/**
 * SF Symbols to Material Icons mappings for Invoice Tracker app.
 */
const MAPPING = {
  // Navigation
  "house.fill": "home",
  "doc.text.fill": "description",
  "camera.fill": "camera-alt",
  "envelope.fill": "email",
  "gearshape.fill": "settings",
  // Actions
  "paperplane.fill": "send",
  "plus": "add",
  "plus.circle.fill": "add-circle",
  "checkmark.circle.fill": "check-circle",
  "xmark.circle.fill": "cancel",
  "trash.fill": "delete",
  "pencil": "edit",
  "square.and.arrow.up": "ios-share",
  "arrow.clockwise": "refresh",
  "magnifyingglass": "search",
  "chevron.right": "chevron-right",
  "chevron.left": "chevron-left",
  "chevron.down": "keyboard-arrow-down",
  // Status
  "exclamationmark.triangle.fill": "warning",
  "info.circle.fill": "info",
  "checkmark.seal.fill": "verified",
  "clock.fill": "schedule",
  // Invoice specific
  "doc.text.magnifyingglass": "find-in-page",
  "tablecells": "table-chart",
  "link": "link",
  "photo.fill": "photo",
  "bolt.fill": "bolt",
  "tag.fill": "label",
  "building.2.fill": "business",
  "calendar": "calendar-today",
  "eurosign.circle.fill": "euro",
  "chevron.left.forwardslash.chevron.right": "code",
  "arrow.right.circle.fill": "arrow-circle-right",
  "wifi.slash": "wifi-off",
  "chart.bar.fill": "bar-chart",
} as IconMapping;

/**
 * An icon component that uses native SF Symbols on iOS, and Material Icons on Android and web.
 */
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;
}) {
  return <MaterialIcons color={color} size={size} name={MAPPING[name]} style={style} />;
}
