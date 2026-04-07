import type { ThemeColorPalette } from "@/lib/_core/theme";

/**
 * Bottom-tab–style tiles: soft grey translucent fill + hairline border on `colors.background`.
 * Uses `foreground` at low alpha so light/dark themes both read correctly.
 */
export function translucentTile(colors: ThemeColorPalette) {
  return {
    bg: `${colors.foreground}14`,
    bgPressed: `${colors.foreground}22`,
    bgStrong: `${colors.foreground}18`,
    border: `${colors.foreground}18`,
    borderSoft: `${colors.foreground}10`,
  };
}
