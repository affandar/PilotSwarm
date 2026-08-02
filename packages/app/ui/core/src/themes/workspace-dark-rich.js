import { createTheme } from "./helpers.js";

/**
 * Workspace Dark — Rich Text: the Workspace Dark palette with the portal's
 * rich (desktop-style) chat transcript baked in as a THEME property instead
 * of a toolbar toggle. Applying it switches the chat canvas to rich blocks;
 * every other theme renders the terminal transcript. The TUI treats it as
 * plain Workspace Dark.
 */
const workspaceDarkRichTheme = createTheme({
    id: "workspace-dark-rich",
    label: "Workspace Dark — Rich Text",
    description: "Workspace Dark with the rich desktop-style chat transcript (portal only).",
    richChat: true,
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

export default workspaceDarkRichTheme;
