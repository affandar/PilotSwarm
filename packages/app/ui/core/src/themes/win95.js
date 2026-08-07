import { createTheme, THEME_GROUP_RETRO } from "./helpers.js";

// Windows 95, as it actually was — not a pastel homage.
//
// The palette is the real one: #C0C0C0 button face, #000080 active title bar,
// #008080 desktop teal, and the 16-colour VGA set for terminal output. Those
// exact values are what make it read as Win95 rather than "grey theme"; the
// bevels that complete the look are in index.css, keyed on the theme id, since
// this file can only carry colours.
//
// One deliberate departure: the chat pane keeps readable accent colours rather
// than pure VGA on grey, because a transcript is prose, not a DOS screen.
const win95Theme = createTheme({
    id: "win95",
    label: "Windows 95",
    description: "Authentic 3D-bevelled grey, navy title bars, teal desktop, and the 16-colour VGA terminal set.",
    group: THEME_GROUP_RETRO,
    page: {
        // Desktop teal behind the panes — the single most recognizable colour
        // of the era, and it makes the grey panes read as raised windows.
        background: "#008080",
        foreground: "#000000",
        overlayBackground: "#c0c0c0",
        overlayForeground: "#000000",
        // The classic disabled/secondary grey; darker than the face so it
        // stays legible on #c0c0c0 rather than vanishing into it.
        // Darker than the authentic #808080 system grey, which sat at 2.2:1
        // on the #c0c0c0 chrome. Even #5a5a5a only reached 3.79:1; this
        // clears 4.5:1 so muted text is readable wherever the chrome shows.
        hintColor: "#4a4a4a",
        modalBackdrop: "rgba(0, 0, 0, 0.45)",
        modalBackground: "#c0c0c0",
        modalBorder: "#808080",
        modalForeground: "#000000",
        modalMuted: "#5a5a5a",
        // Selection is the title-bar navy, exactly as Explorer did it.
        modalSelectedBackground: "#000080",
        modalSelectedBorder: "#000080",
        modalSelectedForeground: "#ffffff",
    },
    terminal: {
        // Button face, not white: this is a Win95 window, and pure white would
        // break the bevel illusion the whole theme depends on.
        background: "#c0c0c0",
        foreground: "#000000",
        cursor: "#000080",
        cursorAccent: "#c0c0c0",
        selectionBackground: "#000080",
        // The 16-colour VGA palette, unmodified.
        black: "#000000",
        red: "#800000",
        green: "#008000",
        yellow: "#808000",
        blue: "#000080",
        magenta: "#800080",
        cyan: "#008080",
        white: "#c0c0c0",
        brightBlack: "#5a5a5a",
        brightRed: "#c00000",
        brightGreen: "#006000",
        brightYellow: "#7a5c00",
        brightBlue: "#0000c0",
        brightMagenta: "#a000a0",
        brightCyan: "#006a6a",
        brightWhite: "#000000",
    },
    tui: {
        surface: "#c0c0c0",
        // Mid-grey is the Win95 shadow edge; it separates panes from the teal
        // desktop without the black hairline a modern theme would use.
        border: "#808080",
        // Navy on grey for the operator's own turns — the highest-contrast
        // pairing available in this palette.
        userChat: "#000080",
        userChatLabel: "#000080",
        activeHighlightBackground: "#000080",
        activeHighlightForeground: "#ffffff",
        selectionBackground: "#000080",
        selectionForeground: "#ffffff",
        promptCursorBackground: "#000080",
        promptCursorForeground: "#ffffff",
    },
});

export default win95Theme;
