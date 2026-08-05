import { createTheme, THEME_GROUP_RETRO } from "./helpers.js";

// MS-DOS 2.0 (1983) — MDA/CGA, text only, no windows.
//
// The detail that makes or breaks this: DOS's default attribute was 0x07,
// which is LIGHT GREY on black, not white. White (#ffffff) was attribute 15,
// used sparingly for emphasis. A pure white-on-black theme reads as "modern
// terminal"; #aaaaaa reads as DOS instantly.
//
// The palette is the CGA 16, including the quirk everyone remembers — dark
// yellow rendered as BROWN (#aa5500), never as olive.
//
// DOS 2.0 itself drew no boxes; the shell was an 80x25 scrolling field. The
// code-page-437 framing that index.css adds is how DOS APPLICATIONS looked,
// and CP437 shipped with the original PC, so it is era-correct even though the
// 2.0 command line never used it. A multi-pane portal needs some framing, and
// this is the honest period answer.
const msDosTheme = createTheme({
    id: "ms-dos",
    label: "MS-DOS 2.0",
    description: "CGA light-grey on black, the 16-colour CGA palette with brown, and CP437 box framing.",
    group: THEME_GROUP_RETRO,
    page: {
        background: "#000000",
        foreground: "#aaaaaa",
        overlayBackground: "#000000",
        overlayForeground: "#aaaaaa",
        // DEVIATION, deliberate: authentic CGA dark grey is #555555, which is
        // roughly 3:1 on black and fails the muted-contrast bar the theme suite
        // enforces. This is the lightest grey that still reads as secondary
        // against #aaaaaa body text while staying legible.
        hintColor: "#8f8f8f",
        modalBackdrop: "rgba(0, 0, 0, 0.78)",
        modalBackground: "#000000",
        modalBorder: "#aaaaaa",
        modalForeground: "#aaaaaa",
        modalMuted: "#8f8f8f",
        // Reverse video — exactly how CGA highlighted a selection.
        modalSelectedBackground: "#aaaaaa",
        modalSelectedBorder: "#ffffff",
        modalSelectedForeground: "#000000",
    },
    terminal: {
        background: "#000000",
        foreground: "#aaaaaa",
        cursor: "#aaaaaa",
        cursorAccent: "#000000",
        selectionBackground: "#aaaaaa",
        // The CGA 16, unmodified.
        black: "#000000",
        red: "#aa0000",
        green: "#00aa00",
        yellow: "#aa5500",      // brown — the CGA quirk, not olive
        blue: "#0000aa",
        magenta: "#aa00aa",
        cyan: "#00aaaa",
        white: "#aaaaaa",       // attribute 7, the DOS default
        brightBlack: "#8f8f8f",
        brightRed: "#ff5555",
        brightGreen: "#55ff55",
        brightYellow: "#ffff55",
        brightBlue: "#5555ff",
        brightMagenta: "#ff55ff",
        brightCyan: "#55ffff",
        brightWhite: "#ffffff", // attribute 15, emphasis only
    },
    tui: {
        surface: "#000000",
        // Frames are drawn in body grey so they read as CP437 line characters
        // rather than as chrome borrowed from a modern UI.
        border: "#aaaaaa",
        // Bright white is reserved for emphasis, so the operator's own turns
        // get it — the one place attribute 15 is worth spending.
        userChat: "#ffffff",
        userChatLabel: "#ffffff",
        activeHighlightBackground: "#aaaaaa",
        activeHighlightForeground: "#000000",
        selectionBackground: "#aaaaaa",
        selectionForeground: "#000000",
        promptCursorBackground: "#aaaaaa",
        promptCursorForeground: "#000000",
    },
});

export default msDosTheme;
