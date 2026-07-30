import { createTheme } from "./helpers.js";

/**
 * Workspace Light — the flat workspace structure on a light ground, with
 * win95-style CONTRAST DETAILS: panels are white surfaces on a cool gray
 * page, and every pane wears a deep-blue title band with light text (the
 * chrome layer's workspace-light overrides), the way Win95's colored title
 * bars make each panel unmistakable. Palette is GitHub-Light-derived so
 * status colors stay crisp on white.
 */
const workspaceLightTheme = createTheme({
    id: "workspace-light",
    label: "Workspace Light",
    description: "Flat workspace chrome on a light ground with deep-blue title bands — win95-grade panel contrast.",
    page: {
        background: "#e9edf2",
        foreground: "#1f2328",
        overlayBackground: "#ffffff",
        overlayForeground: "#1f2328",
        hintColor: "#57606a",
        modalBackdrop: "rgba(31, 35, 40, 0.34)",
        modalBackground: "#ffffff",
        modalBorder: "#c8d1db",
        modalForeground: "#1f2328",
        modalMuted: "#57606a",
        modalSelectedBackground: "#ddf4ff",
        modalSelectedBorder: "#0969da",
        modalSelectedForeground: "#0550ae",
    },
    terminal: {
        background: "#ffffff",
        foreground: "#1f2328",
        cursor: "#0969da",
        cursorAccent: "#ffffff",
        selectionBackground: "#ddf4ff",
        black: "#24292f",
        red: "#cf222e",
        green: "#1a7f37",
        yellow: "#9a6700",
        blue: "#0969da",
        magenta: "#8250df",
        cyan: "#1b7c83",
        white: "#6e7781",
        brightBlack: "#57606a",
        brightRed: "#a40e26",
        brightGreen: "#116329",
        brightYellow: "#7d4e00",
        brightBlue: "#0550ae",
        brightMagenta: "#6639ba",
        brightCyan: "#0f6f78",
        brightWhite: "#1f2328",
    },
    tui: {
        surface: "#ffffff",
        border: "#c8d1db",
        userChat: "#0969da",
        userChatLabel: "#0550ae",
        activeHighlightBackground: "#ddf4ff",
        activeHighlightForeground: "#0550ae",
        selectionBackground: "#0969da",
        selectionForeground: "#ffffff",
        promptCursorBackground: "#0969da",
        promptCursorForeground: "#ffffff",
    },
});

export default workspaceLightTheme;
