/**
 * Theme tokens — CSS custom properties matching the TUI color palette.
 *
 * These are applied in index.css and referenced by Tailwind utilities.
 * Kept as a JS module for programmatic access (e.g. inline styles on
 * dynamic elements like agent splash borders).
 */

export const theme = {
  bgPrimary: "#1a1a2e",
  bgSecondary: "#16213e",
  bgSurface: "#0f3460",
  bgDeep: "#0d0d1a",

  textPrimary: "#e0e0e0",
  textMuted: "#888888",

  cyan: "#00d4ff",
  green: "#00ff88",
  yellow: "#ffd700",
  red: "#ff4444",
  magenta: "#ff00ff",
  blue: "#0088ff",

  borderDefault: "#333333",
  borderFocus: "#ff4444",
} as const;

/**
 * Splash color classes — map blessed color tag names to CSS color values.
 * Used by blessedToHtml.ts (the CSS classes) and for inline styles.
 */
export const splashColors: Record<string, string> = {
  "splash-cyan": theme.cyan,
  "splash-magenta": theme.magenta,
  "splash-yellow": theme.yellow,
  "splash-green": theme.green,
  "splash-red": theme.red,
  "splash-blue": theme.blue,
  "splash-white": "#ffffff",
  "splash-gray": "#888888",
};
