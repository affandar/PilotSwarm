import { createTheme } from "./helpers.js";

// WinAMP 2.x (Nullsoft, 1997) — grey rack metal around a pane of lit glass.
//
// The skin everyone remembers is not colourful. It is bevelled grey chrome
// with ONE lit display in the middle, which happens to be the shape of a
// portal: quiet frame, bright content. So the panes are black glass, the
// chrome is machined grey, and the phosphor green is spent only on content.
//
// The semantic palette is the SPECTRUM ANALYSER ramp — green, lime, amber,
// red. A column of status dots then reads like a levels meter, which is the
// one thing this theme gets for free that no other retro theme does.
//
// The deliberate anti-goal: not looking like Terminal Green. Green text on
// black is most of that theme already, so the separation here is carried by
// the GREY frame and the amber accents rather than the text colour. Borders,
// muted labels and chrome are all machined grey; only content is green.
const winampTheme = createTheme({
    id: "winamp",
    label: "WinAMP",
    description: "Bevelled grey chrome, black glass panes, phosphor green, and the spectrum ramp as the status palette.",
    // The spectrum analyser: one bar per agent, coloured along the status
    // ramp. Five rectangles, so it stays legible at favicon size — and it is
    // the rare mark that could legitimately animate off live fleet load.
    icon: {
        viewBox: "0 0 32 32",
        paths: [
            { d: "M0 0h32v32H0z", fill: "#000000" },      // the glass
            { d: "M3 17h4v11H3z", fill: "#00e337" },
            { d: "M9 11h4v17H9z", fill: "#7ad91e" },
            { d: "M15 6h4v22h-4z", fill: "#b6e000" },
            { d: "M21 13h4v15h-4z", fill: "#ffb400" },
            { d: "M27 20h3v8h-3z", fill: "#ff3b00" },
            // Peak markers — the detail that makes it read as an analyser
            // rather than a bar chart.
            { d: "M3 15h4v1.6H3z", fill: "#d6d6cc" },
            { d: "M9 9h4v1.6H9z", fill: "#d6d6cc" },
            { d: "M15 4h4v1.6h-4z", fill: "#d6d6cc" },
            { d: "M21 11h4v1.6h-4z", fill: "#d6d6cc" },
            { d: "M27 18h3v1.6h-3z", fill: "#d6d6cc" },
        ],
    },
    page: {
        background: "#000000",
        foreground: "#00e337",
        overlayBackground: "#1c1c1c",
        overlayForeground: "#00e337",
        // Machined grey, not a dim green: muted labels are CHROME in this
        // theme, and keeping them grey is most of what stops it reading as
        // Terminal Green. 5.9:1 on the glass.
        hintColor: "#949494",
        modalBackdrop: "rgba(0, 0, 0, 0.82)",
        modalBackground: "#1c1c1c",
        modalBorder: "#5e5e5e",
        modalForeground: "#00e337",
        modalMuted: "#a0a0a0",
        // Selection is the playlist editor's navy bar, exactly as Winamp did.
        modalSelectedBackground: "#0000c6",
        modalSelectedBorder: "#5e5e5e",
        modalSelectedForeground: "#ffffff",
    },
    terminal: {
        background: "#000000",
        foreground: "#00e337",
        cursor: "#ffb400",
        cursorAccent: "#000000",
        selectionBackground: "#0000c6",
        black: "#000000",
        red: "#ff3b00",          // ramp: clipping
        green: "#00e337",        // ramp: idle
        yellow: "#ffb400",       // ramp: the kbps/kHz amber
        // Lifted well off the #0000c6 playlist navy, which is a SELECTION
        // colour and unreadable as text on black (1.3:1).
        blue: "#4a7cf0",
        magenta: "#cc66cc",
        cyan: "#29c8c8",
        white: "#d6d6cc",        // chrome label grey
        brightBlack: "#949494",
        brightRed: "#ff6a3d",
        brightGreen: "#5cff7a",
        brightYellow: "#ffd24a",
        brightBlue: "#7fa5ff",
        brightMagenta: "#e08ae0",
        brightCyan: "#6fe0e0",
        brightWhite: "#ffffff",
    },
    tui: {
        // The frame is METAL. This one value does more to separate the theme
        // from Terminal Green than any other, because it is the outline of
        // every pane on screen.
        border: "#5e5e5e",
        gray: "#949494",
        userChat: "#ffb400",
        userChatLabel: "#ffd24a",
        selectionBackground: "#0000c6",
        selectionForeground: "#ffffff",
        activeHighlightBackground: "#0000c6",
        activeHighlightForeground: "#ffffff",
        promptCursorBackground: "#ffb400",
        promptCursorForeground: "#000000",
    },
});

export default winampTheme;
