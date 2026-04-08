import { describe, it } from "vitest";
import { shouldDimGrayTextForTheme } from "../../../cli/src/platform.js";
import { getTheme } from "../../../ui-core/src/themes/index.js";
import { assertGreaterOrEqual, assertNotNull, assertEqual } from "../helpers/assertions.js";

function toRgb(hex) {
    const normalized = String(hex || "").trim();
    const fullHex = normalized.length === 4
        ? `#${normalized.slice(1).split("").map((channel) => channel + channel).join("")}`
        : normalized;

    return {
        red: Number.parseInt(fullHex.slice(1, 3), 16),
        green: Number.parseInt(fullHex.slice(3, 5), 16),
        blue: Number.parseInt(fullHex.slice(5, 7), 16),
    };
}

function toRelativeChannel(value) {
    const normalized = value / 255;
    return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
}

function getRelativeLuminance(hex) {
    const { red, green, blue } = toRgb(hex);
    return (0.2126 * toRelativeChannel(red))
        + (0.7152 * toRelativeChannel(green))
        + (0.0722 * toRelativeChannel(blue));
}

function getContrastRatio(foreground, background) {
    const foregroundLuminance = getRelativeLuminance(foreground);
    const backgroundLuminance = getRelativeLuminance(background);
    const lighter = Math.max(foregroundLuminance, backgroundLuminance);
    const darker = Math.min(foregroundLuminance, backgroundLuminance);
    return (lighter + 0.05) / (darker + 0.05);
}

describe("theme muted text contrast", () => {
    it("keeps shared light-theme gray text readable across TUI and portal surfaces", () => {
        for (const themeId of ["github-light-high-contrast", "catppuccin-latte", "solarized-light"]) {
            const theme = getTheme(themeId);
            assertNotNull(theme, `${themeId} should exist`);

            assertGreaterOrEqual(
                getContrastRatio(theme.tui.gray, theme.tui.background),
                4.5,
                `${themeId} TUI gray contrast`,
            );
            assertGreaterOrEqual(
                getContrastRatio(theme.page.modalMuted, theme.page.modalBackground),
                4.5,
                `${themeId} modal muted contrast`,
            );
            assertGreaterOrEqual(
                getContrastRatio(theme.terminal.brightBlack, theme.terminal.background),
                4.5,
                `${themeId} terminal gray contrast`,
            );
        }
    });

    it("only dims gray runs for dark themes in the Ink TUI renderer", () => {
        assertEqual(
            shouldDimGrayTextForTheme(getTheme("github-dark")),
            true,
            "dark themes should keep dim gray treatment",
        );
        assertEqual(
            shouldDimGrayTextForTheme(getTheme("github-light-high-contrast")),
            false,
            "github light should not dim gray treatment",
        );
        assertEqual(
            shouldDimGrayTextForTheme(getTheme("catppuccin-latte")),
            false,
            "catppuccin latte should not dim gray treatment",
        );
        assertEqual(
            shouldDimGrayTextForTheme(getTheme("solarized-light")),
            false,
            "solarized light should not dim gray treatment",
        );
    });
});
