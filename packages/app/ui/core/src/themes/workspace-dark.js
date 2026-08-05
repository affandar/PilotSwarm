import { createTheme, THEME_GROUP_OTHER } from "./helpers.js";

/**
 * Workspace Dark — the admin-console language as a theme: tone-separated
 * surfaces, hairlines, quiet uppercase labels, no panel borders. The palette
 * derives from GitHub Dark; the LOOK lives in the portal's
 * `[data-ps-theme="workspace-dark"]` chrome layer (win95 pattern — a theme
 * may carry chrome, not just colours). The TUI renders it as a plain
 * dark palette and keeps its borders, which are correct in a terminal.
 */
const workspaceDarkTheme = createTheme({
    id: "workspace-dark",
    label: "Workspace Dark",
    description: "Flat workspace chrome: tone surfaces and hairlines instead of panel borders.",
    group: THEME_GROUP_OTHER,
    page: {
        background: "#0d1117",
        foreground: "#e6edf3",
        overlayBackground: "#0d1117",
        overlayForeground: "#e6edf3",
        hintColor: "#8b949e",
        modalBackdrop: "rgba(1, 4, 9, 0.64)",
        modalBackground: "#161b22",
        modalBorder: "#272e37",
        modalForeground: "#e6edf3",
        modalMuted: "#8b949e",
        modalSelectedBackground: "#1f6feb33",
        modalSelectedBorder: "#2f81f7",
        modalSelectedForeground: "#79c0ff",
    },
    terminal: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#2f81f7",
        cursorAccent: "#0d1117",
        selectionBackground: "rgba(56, 139, 253, 0.28)",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
    },
    tui: {
        surface: "#161b22",
        border: "#272e37",
        activeHighlightBackground: "#1f4b7a",
        activeHighlightForeground: "#f0f6fc",
        selectionBackground: "#79c0ff",
        selectionForeground: "#0d1117",
        promptCursorBackground: "#2f81f7",
        promptCursorForeground: "#0d1117",
    },
});

export default workspaceDarkTheme;
