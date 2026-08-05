import { createTheme, THEME_GROUP_RETRO } from "./helpers.js";

// DOOM (id Software, 1993) — the status bar, not the shooter.
//
// The recognizable thing about DOOM's UI is STBAR: a band of hammered brown
// metal carrying big red numerals and the marine's face. That maps onto a
// portal header almost directly, so this theme is warm brown chrome around a
// near-black ground, with bone-coloured type.
//
// The semantic palette is the THREE KEYCARDS — blue, yellow, red. Every player
// already reads that triad as progress / caution / stop without being taught,
// and it happens to be exactly the distinction a session list needs. Armor
// green is held back for "completed".
//
// The ground is a red-biased near-black rather than pure #000: DOOM's letterbox
// was black but everything in frame was warm, and a neutral black underneath
// warm chrome reads as two unrelated themes stacked.
const doomTheme = createTheme({
    id: "doom",
    label: "DOOM",
    description: "STBAR brown metal, bone type, and the three keycards as the status palette.",
    group: THEME_GROUP_RETRO,
    // The face, drawn as data rather than markup so ui/core stays free of any
    // framework and nothing has to inject raw HTML. The portal renders it in
    // place of the deployment's logo; the TUI ignores it.
    //
    // In DOOM the face was never decoration — it reported your state. Keeping
    // it as the mark leaves that door open.
    icon: {
        viewBox: "0 0 32 32",
        paths: [
            { d: "M0 0h32v32H0z", fill: "#2a1d14" },              // recessed frame
            { d: "M6 7h20v20H6z", fill: "#c89a6a" },              // face
            { d: "M5 6h22v6H5z", fill: "#4a2f1a" },               // hair
            { d: "M9 15h5v3.4H9z", fill: "#1a1008" },             // left eye
            { d: "M18 15h5v3.4h-5z", fill: "#1a1008" },           // right eye
            { d: "M8.6 13.6l6 1 -.3 1.7-6-1z", fill: "#3a2412" }, // brows, angled in
            { d: "M23.4 13.6l-6 1 .3 1.7 6-1z", fill: "#3a2412" },
            { d: "M14.5 18.5h3v2.4h-3z", fill: "#a8734a" },       // nose
            { d: "M11 22h10v1.8H11z", fill: "#7a3a2a" },          // mouth
        ],
    },
    page: {
        background: "#100b09",
        foreground: "#d9cba8",
        overlayBackground: "#1c1310",
        overlayForeground: "#d9cba8",
        // 6.2:1 on the ground. Authentic DOOM shadow browns sit nearer 3:1 and
        // would fail the muted-contrast bar the theme suite enforces, so this
        // is lifted — the same deliberate deviation ms-dos.js documents for CGA
        // dark grey.
        hintColor: "#a08d68",
        modalBackdrop: "rgba(16, 11, 9, 0.82)",
        modalBackground: "#1c1310",
        modalBorder: "#6f5432",
        modalForeground: "#d9cba8",
        modalMuted: "#a08d68",
        // Selection is the STBAR band itself, not a tint.
        modalSelectedBackground: "#6f5432",
        modalSelectedBorder: "#a4885c",
        modalSelectedForeground: "#fff4d6",
    },
    terminal: {
        background: "#100b09",
        foreground: "#d9cba8",
        cursor: "#b81c1c",
        cursorAccent: "#100b09",
        selectionBackground: "#6f5432",
        black: "#100b09",
        // Health red, lifted a shade: the sprite value lands at 2.9994:1 on
        // this ground — close enough to look fine and just under the 3:1 a
        // status mark needs.
        red: "#c42222",
        green: "#3f9e3f",        // armor bonus
        yellow: "#e8c020",       // yellow keycard
        // Lifted from the sprite's #3050d0, which measures 2.97:1 on this
        // ground — under the 3:1 a status dot needs. Still unmistakably the
        // blue keycard, now legible.
        blue: "#3a5ce0",
        magenta: "#a0446a",
        cyan: "#4a8f8f",
        white: "#d9cba8",        // bone
        brightBlack: "#a08d68",
        brightRed: "#ff3a1e",
        brightGreen: "#5fc45f",
        brightYellow: "#ffd84a",
        brightBlue: "#5a7ae8",
        brightMagenta: "#c46a94",
        brightCyan: "#6fb5b5",
        brightWhite: "#fff4d6",
    },
    tui: {
        border: "#6f5432",
        // The transcript is prose, so speakers keep the keycard colours rather
        // than everything collapsing into bone-on-brown.
        userChat: "#e8c020",
        userChatLabel: "#ffd84a",
        selectionBackground: "#6f5432",
        selectionForeground: "#fff4d6",
        activeHighlightBackground: "#6f5432",
        activeHighlightForeground: "#fff4d6",
        promptCursorBackground: "#b81c1c",
        promptCursorForeground: "#fff4d6",
    },
});

export default doomTheme;
