import { createTheme } from "./helpers.js";

// Sharp neutral light theme. Every ANSI slot — including `white`, which agent
// output renders through constantly — holds ≥ 4.5:1 contrast on the white
// background, so assistant text, dims, and code stay readable.
const daylightTheme = createTheme({
    id: "daylight",
    label: "Daylight",
    description: "Crisp white workspace with near-black text and deep saturated accents — every color slot holds AA contrast.",
    page: {
        background: "#ffffff",
        foreground: "#111827",
        overlayBackground: "#ffffff",
        overlayForeground: "#111827",
        hintColor: "#4b5563",
        modalBackdrop: "rgba(17, 24, 39, 0.35)",
        modalBackground: "#ffffff",
        modalBorder: "#d1d5db",
        modalForeground: "#111827",
        modalMuted: "#4b5563",
        modalSelectedBackground: "#dbeafe",
        modalSelectedBorder: "#1d4ed8",
        modalSelectedForeground: "#1e3a8a",
    },
    terminal: {
        background: "#ffffff",
        foreground: "#111827",
        cursor: "#1d4ed8",
        cursorAccent: "#ffffff",
        selectionBackground: "#bfdbfe",
        black: "#111827",
        red: "#b91c1c",
        green: "#047857",
        yellow: "#92400e",
        blue: "#1d4ed8",
        magenta: "#6d28d9",
        cyan: "#0e7490",
        white: "#4b5563",
        brightBlack: "#374151",
        brightRed: "#991b1b",
        brightGreen: "#065f46",
        brightYellow: "#78350f",
        brightBlue: "#1e40af",
        brightMagenta: "#5b21b6",
        brightCyan: "#155e75",
        brightWhite: "#111827",
    },
    tui: {
        surface: "#ffffff",
        border: "#d1d5db",
        userChat: "#1e40af",
        userChatLabel: "#1e3a8a",
        activeHighlightBackground: "#dbeafe",
        activeHighlightForeground: "#1e3a8a",
        selectionBackground: "#1d4ed8",
        selectionForeground: "#ffffff",
        promptCursorBackground: "#1d4ed8",
        promptCursorForeground: "#ffffff",
    },
});

export default daylightTheme;
