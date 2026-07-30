import { createTheme } from "./helpers.js";

/**
 * Workspace Light — the flat workspace chrome on a Solarized-Light-inspired
 * ground. The dark theme separates surfaces by darkness; a light theme needs
 * the same hierarchy with actual CONTRAST, and Solarized's warm two-tone
 * ground (paper `#fdf6e3` canvas over parchment `#eee8d5` rails) plus its
 * saturated accent set is purpose-built for that: panels read as distinctly
 * colored surfaces, hairlines stay visible, and status colors (blue actions,
 * green ok, red draining) carry on cream without washing out. Structure
 * comes from the shared `[data-ps-theme]` workspace chrome layer.
 */
const workspaceLightTheme = createTheme({
    id: "workspace-light",
    label: "Workspace Light",
    description: "Flat workspace chrome on a warm Solarized ground: paper canvas, parchment panels, saturated accents.",
    page: {
        background: "#fdf6e3",
        foreground: "#073642",
        overlayBackground: "#fdf6e3",
        overlayForeground: "#073642",
        hintColor: "#657b83",
        modalBackdrop: "rgba(0, 43, 54, 0.38)",
        modalBackground: "#fdf6e3",
        modalBorder: "#d9cfb2",
        modalForeground: "#073642",
        modalMuted: "#657b83",
        modalSelectedBackground: "#e3ecf0",
        modalSelectedBorder: "#268bd2",
        modalSelectedForeground: "#0f5a8c",
    },
    terminal: {
        background: "#fdf6e3",
        foreground: "#073642",
        cursor: "#268bd2",
        cursorAccent: "#fdf6e3",
        selectionBackground: "#e3ecf0",
        black: "#073642",
        red: "#dc322f",
        green: "#859900",
        yellow: "#b58900",
        blue: "#268bd2",
        magenta: "#d33682",
        cyan: "#2aa198",
        white: "#93a1a1",
        brightBlack: "#586e75",
        brightRed: "#cb4b16",
        brightGreen: "#657b83",
        brightYellow: "#8a6d00",
        brightBlue: "#0f5a8c",
        brightMagenta: "#a82963",
        brightCyan: "#1e7d78",
        brightWhite: "#002b36",
    },
    tui: {
        surface: "#eee8d5",
        border: "#d9cfb2",
        userChat: "#b58900",
        userChatLabel: "#8a6d00",
        activeHighlightBackground: "#268bd2",
        activeHighlightForeground: "#fdf6e3",
        selectionBackground: "#268bd2",
        selectionForeground: "#fdf6e3",
        promptCursorBackground: "#268bd2",
        promptCursorForeground: "#fdf6e3",
    },
});

export default workspaceLightTheme;
