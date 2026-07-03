import { createTheme } from "./helpers.js";

// Light counterpart of Dark High Contrast: pure black on white with the
// darkest usable accent set. Every slot clears AAA (7:1) where practical —
// the theme to reach for when any other light theme feels washed out.
const lightHighContrastTheme = createTheme({
    id: "light-high-contrast",
    label: "Light High Contrast",
    description: "Pure black on white with maximum-contrast accents — nothing washes out, ever.",
    page: {
        background: "#ffffff",
        foreground: "#000000",
        overlayBackground: "#ffffff",
        overlayForeground: "#000000",
        hintColor: "#333333",
        modalBackdrop: "rgba(0, 0, 0, 0.4)",
        modalBackground: "#ffffff",
        modalBorder: "#767676",
        modalForeground: "#000000",
        modalMuted: "#333333",
        modalSelectedBackground: "#cce5ff",
        modalSelectedBorder: "#0000cc",
        modalSelectedForeground: "#00008b",
    },
    terminal: {
        background: "#ffffff",
        foreground: "#000000",
        cursor: "#0000cc",
        cursorAccent: "#ffffff",
        selectionBackground: "#b3d7ff",
        black: "#000000",
        red: "#a80000",
        green: "#006400",
        yellow: "#5c4500",
        blue: "#0000cc",
        magenta: "#77008c",
        cyan: "#005f6b",
        white: "#333333",
        brightBlack: "#1a1a1a",
        brightRed: "#8b0000",
        brightGreen: "#004b00",
        brightYellow: "#4a3700",
        brightBlue: "#0000a0",
        brightMagenta: "#5f0070",
        brightCyan: "#004a54",
        brightWhite: "#000000",
    },
    tui: {
        surface: "#ffffff",
        border: "#767676",
        userChat: "#0000cc",
        userChatLabel: "#00008b",
        activeHighlightBackground: "#cce5ff",
        activeHighlightForeground: "#00008b",
        selectionBackground: "#0000cc",
        selectionForeground: "#ffffff",
        promptCursorBackground: "#0000cc",
        promptCursorForeground: "#ffffff",
    },
});

export default lightHighContrastTheme;
