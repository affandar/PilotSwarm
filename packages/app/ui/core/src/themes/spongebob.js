import { createTheme, THEME_GROUP_OTHER } from "./helpers.js";

// SpongeBob SquarePants (Stephen Hillenburg, 1999) — Bikini Bottom, not a
// yellow screen.
//
// The obvious version of this theme is a yellow background, and it is
// unusable: SpongeBob yellow is a 16:1 scream that no one can read a session
// list on for eight hours. The show itself never does that either — SpongeBob
// is yellow BECAUSE the ocean around him is deep blue-green. So the ground
// here is Bikini Bottom at depth and the yellow is spent only where a portal
// actually wants a bright accent.
//
// The cast supplies the status palette, which is the part that earns its keep:
// Patrick pink, Squidward teal, Krabby-Patty lettuce green, the tie's red, and
// the pineapple's orange are five hues that are already distinct in everyone's
// head, which is exactly what a column of status dots needs.
//
// Note the cyan slot carries the sponge yellow: the portal derives
// `--ps-accent` from `tui.cyan`, so that slot is the accent role regardless of
// its name. Squidward's actual teal takes `blue`.
const spongebobTheme = createTheme({
    id: "spongebob",
    label: "SpongeBob",
    description: "Bikini Bottom at depth, sponge-yellow accents, and the cast as the status palette.",
    group: THEME_GROUP_OTHER,
    // The face. Big eyes and buck teeth are the whole silhouette — freckles
    // and the nose are below the resolution that survives a 32px frame, so
    // they are dropped rather than drawn as mud.
    icon: {
        viewBox: "0 0 32 32",
        paths: [
            { d: "M0 0h32v32H0z", fill: "#1a7fa8" },                 // the water
            { d: "M7 2h18a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3z", fill: "#ffe01b" },
            // Pores. The one texture that says "sponge" rather than "square".
            { d: "M6.2 6.4a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0-2.8 0z", fill: "#e3c00c" },
            { d: "M23.4 4.8a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0z", fill: "#e3c00c" },
            { d: "M5.4 18.2a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0z", fill: "#e3c00c" },
            { d: "M24 19a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0-2.6 0z", fill: "#e3c00c" },
            // Eyes
            { d: "M7.3 10a4.2 4.2 0 1 0 8.4 0a4.2 4.2 0 1 0-8.4 0z", fill: "#ffffff" },
            { d: "M16.3 10a4.2 4.2 0 1 0 8.4 0a4.2 4.2 0 1 0-8.4 0z", fill: "#ffffff" },
            { d: "M9.4 10a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0-4.2 0z", fill: "#3fa9d8" },
            { d: "M18.4 10a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0-4.2 0z", fill: "#3fa9d8" },
            { d: "M10.5 10a1 1 0 1 0 2 0a1 1 0 1 0-2 0z", fill: "#10202b" },
            { d: "M19.5 10a1 1 0 1 0 2 0a1 1 0 1 0-2 0z", fill: "#10202b" },
            // Smile and the two teeth
            { d: "M10 16.6c2 3.6 10 3.6 12 0c-1.2 5-10.8 5-12 0z", fill: "#6b4e00" },
            { d: "M14 17.6h1.9v2.1H14z", fill: "#ffffff" },
            { d: "M16.1 17.6H18v2.1h-1.9z", fill: "#ffffff" },
            // Collar and tie
            { d: "M6 23h20v3H6z", fill: "#ffffff" },
            { d: "M14.4 24.6h3.2v2h-3.2z", fill: "#d2232a" },
            { d: "M13 26.4h6l-3 5.2z", fill: "#d2232a" },
        ],
    },
    page: {
        background: "#07293c",
        foreground: "#e6f4fb",
        overlayBackground: "#0e3852",
        overlayForeground: "#e6f4fb",
        hintColor: "#8fb9cf",
        modalBackdrop: "rgba(7, 41, 60, 0.84)",
        modalBackground: "#0e3852",
        modalBorder: "#1d6a8c",
        modalForeground: "#e6f4fb",
        modalMuted: "#95bed3",
        // Selection is the sponge himself: a filled yellow block with the type
        // knocked back to the water. Anything subtler on this ground reads as
        // a bug rather than a highlight.
        modalSelectedBackground: "#ffe01b",
        modalSelectedBorder: "#fff08a",
        modalSelectedForeground: "#07293c",
    },
    terminal: {
        background: "#07293c",
        foreground: "#e6f4fb",
        cursor: "#ffe01b",
        cursorAccent: "#07293c",
        selectionBackground: "#ffe01b",
        black: "#07293c",
        red: "#ff6152",          // the tie, lifted off #d2232a to clear 3:1
        green: "#7ed957",        // Krabby Patty lettuce
        yellow: "#ffa62b",       // the pineapple
        blue: "#7fd4c1",         // Squidward
        magenta: "#ff9bd2",      // Patrick
        cyan: "#ffe01b",         // SpongeBob, and therefore --ps-accent
        white: "#e6f4fb",
        brightBlack: "#8fb9cf",
        brightRed: "#ff9084",
        brightGreen: "#a5e888",
        brightYellow: "#ffc46b",
        brightBlue: "#a8e5d8",
        brightMagenta: "#ffbde1",
        brightCyan: "#fff08a",
        brightWhite: "#ffffff",
    },
    tui: {
        border: "#1d6a8c",
        userChat: "#ffa62b",
        userChatLabel: "#ffc46b",
        selectionBackground: "#ffe01b",
        selectionForeground: "#07293c",
        activeHighlightBackground: "#ffe01b",
        activeHighlightForeground: "#07293c",
        promptCursorBackground: "#ffe01b",
        promptCursorForeground: "#07293c",
    },
});

export default spongebobTheme;
