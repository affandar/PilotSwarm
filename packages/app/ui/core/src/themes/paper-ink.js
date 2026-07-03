import { createTheme } from "./helpers.js";

// Warm light theme: paper background, true-ink text, letterpress accents.
// Warmth comes from the background — the text colors stay deep so agent
// output never washes out.
const paperInkTheme = createTheme({
    id: "paper-ink",
    label: "Paper Ink",
    description: "Warm paper background with true-ink text and letterpress accents — warmth without washed-out output.",
    page: {
        background: "#faf6ef",
        foreground: "#1c1917",
        overlayBackground: "#fffdf8",
        overlayForeground: "#1c1917",
        hintColor: "#57534e",
        modalBackdrop: "rgba(28, 25, 23, 0.35)",
        modalBackground: "#fffdf8",
        modalBorder: "#d6cfc2",
        modalForeground: "#1c1917",
        modalMuted: "#57534e",
        modalSelectedBackground: "#f1e4c7",
        modalSelectedBorder: "#854d0e",
        modalSelectedForeground: "#713f12",
    },
    terminal: {
        background: "#faf6ef",
        foreground: "#1c1917",
        cursor: "#9f1239",
        cursorAccent: "#fffdf8",
        selectionBackground: "#f1e4c7",
        black: "#1c1917",
        red: "#9f1239",
        green: "#3f6212",
        yellow: "#854d0e",
        blue: "#1e40af",
        magenta: "#86198f",
        cyan: "#0f766e",
        white: "#57534e",
        brightBlack: "#44403c",
        brightRed: "#881337",
        brightGreen: "#365314",
        brightYellow: "#713f12",
        brightBlue: "#1e3a8a",
        brightMagenta: "#701a75",
        brightCyan: "#115e59",
        brightWhite: "#1c1917",
    },
    tui: {
        surface: "#fffdf8",
        border: "#d6cfc2",
        userChat: "#1e40af",
        userChatLabel: "#1e3a8a",
        activeHighlightBackground: "#f1e4c7",
        activeHighlightForeground: "#713f12",
        selectionBackground: "#854d0e",
        selectionForeground: "#fffdf8",
        promptCursorBackground: "#9f1239",
        promptCursorForeground: "#fffdf8",
    },
});

export default paperInkTheme;
