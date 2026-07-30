import { createTheme } from "./helpers.js";

/**
 * Workspace Light — the flat workspace chrome on a light ground: the same
 * treatment as Workspace Dark (tone surfaces, hairlines, quiet labels, no
 * panel borders — the shared `[data-ps-theme]` chrome layer covers both),
 * with a GitHub-Light-derived palette. The chat canvas is white; rails sit
 * one tone below it, the inverse of the dark theme's relationship, so the
 * same "canvas above surfaces" reading holds on both grounds.
 */
const workspaceLightTheme = createTheme({
    id: "workspace-light",
    label: "Workspace Light",
    description: "Flat workspace chrome on a light ground: tone surfaces and hairlines instead of panel borders.",
    page: {
        background: "#ffffff",
        foreground: "#1f2328",
        overlayBackground: "#ffffff",
        overlayForeground: "#1f2328",
        hintColor: "#656d76",
        modalBackdrop: "rgba(31, 35, 40, 0.34)",
        modalBackground: "#ffffff",
        modalBorder: "#d8dee4",
        modalForeground: "#1f2328",
        modalMuted: "#656d76",
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
        surface: "#f6f8fa",
        border: "#d8dee4",
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
