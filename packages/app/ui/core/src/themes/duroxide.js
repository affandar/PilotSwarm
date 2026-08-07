import { createTheme, THEME_GROUP_OTHER } from "./helpers.js";

// Duroxide (2025-) - the durable execution runtime, wearing its own brand.
//
// This is NOT the Rust theme with a different accent. Rust is rustc OUTPUT:
// hot Ferris orange on cold graphite, with the compiler's error/warning/help
// levels as the status palette. Duroxide is the PROJECT BRAND: the banner is
// a sheet of near-black felt with the mark pressed into it, and the mark is
// not orange at all - it is iron oxide, a terracotta so muted it reads as a
// material rather than a highlight. Ground, accent and mood all differ, which
// is what keeps two warm-dark themes from collapsing into one.
//
// Every value below is MEASURED off the banner artwork rather than picked by
// eye. The ground is #282627 with a paper grain running about +/-12 levels
// either side; the mark's modal colour is #a35838, its lit edge #ba714c.
//
// The catch: #a35838 on #282627 is 2.87:1. The exact brand colour cannot be
// text. So the brand oxide is spent on CHROME - the logo, borders, rules -
// and the interactive accent is a brightened sibling, #d2764a, which clears
// 4.5:1 on both grounds while staying recognisably the same pigment. Getting
// that backwards is how a brand palette becomes an unreadable interface.
//
// Rust's DNA survives where it earns its place: the status slots keep rustc's
// three-level vocabulary (error red, warning amber, help blue) with cargo
// green for success - a status palette a session list can use directly - but
// each is desaturated to sit inside the brand's restraint rather than shout
// over it.
//
// The banner's felt grain is not expressible as a palette entry, so it rides
// on [data-ps-theme="duroxide"] in the stylesheet, the same hook Win95 uses
// for its bevels.

// The brand oxide, sampled from the mark itself. Chrome only - see above.
const OXIDE = "#a35838";

// The mark itself, traced from the banner artwork at 1.8px tolerance: hexagon
// ring, eight-tooth gear, and the replay arrow sweeping its lower arc. Four
// subpaths in one string - outers wound clockwise, holes counter-clockwise.
const DUROXIDE_MARK =
    "M4.14 33.09L4.14 18.89L5.7 15.77L30.05 1.4L33.95 1.4L43.32 6.56L57.99 15.3L59.08 16.7L59.7"
    + "1 18.58L59.71 45.27L59.08 47.14L56.9 49.64L41.44 58.38L38.32 60.57L33.64 62.91L30.52 62.91"
    + "L27.71 61.66L14.6 53.7L6.79 49.48L5.54 48.23L4.45 46.2L4.14 44.49L4.14 33.09ZM55.8 26.07L5"
    + "5.8 19.36L55.02 18.42L33.8 6.09L31.45 5.78L30.05 6.24L8.51 18.89L8.51 45.11L10.22 46.67L18"
    + ".03 50.89L30.05 58.22L31.77 58.85L33.17 58.69L53.93 46.67L55.65 44.96L55.8 26.07ZM17.09 34"
    + ".81L16.78 33.56L13.19 32.62L13.19 27.0L17.09 26.54L18.97 23.26L16.94 19.67L21.0 15.61L24.4"
    + "3 17.95L27.86 16.86L29.11 12.8L34.58 12.8L35.51 16.86L38.63 17.95L39.57 17.8L42.69 15.61L4"
    + "6.6 19.67L46.28 20.92L44.88 22.95L44.88 23.73L46.28 26.38L50.65 27.16L50.65 32.47L47.69 33"
    + ".4L47.06 34.03L42.54 32.0L42.54 29.97L41.91 27.63L40.82 25.6L38.63 23.26L34.73 21.39L32.55"
    + " 21.07L29.11 21.39L26.3 22.48L23.96 24.35L22.4 26.54L21.31 29.97L21.31 33.25L22.87 37.46L2"
    + "4.12 39.18L27.4 41.83L24.59 42.77L19.9 42.93L16.0 41.68L15.22 40.12L17.72 37.31L17.09 34.8"
    + "1ZM36.76 35.59L35.51 32.62L35.82 32.0L50.19 39.34L49.25 41.99L43.32 51.2L42.54 51.04L41.6 "
    + "46.2L35.51 49.64L31.3 50.58L28.49 50.58L21.93 49.01L18.97 47.3L16.47 45.11L16.78 44.8L19.1"
    + "2 45.58L22.09 45.74L25.21 45.42L28.18 44.33L29.74 44.49L33.48 42.46L37.39 39.18L37.85 37.9"
    + "3L36.76 35.59Z";

const duroxideTheme = createTheme({
    id: "duroxide",
    label: "Duroxide",
    description: "Iron oxide pressed into black felt - the durable-execution runtime's own mark, traced from the banner.",
    group: THEME_GROUP_OTHER,
    // Traced from the banner artwork, not redrawn: the hexagon, the eight-tooth
    // gear, and the replay arrow sweeping its lower arc. Subpaths are wound so
    // the default nonzero fill rule punches the holes - ThemeIconMark renders
    // a bare <path d fill> with no fill-rule to lean on.
    icon: {
        viewBox: "0 0 64 64",
        // ONE path, not four. ThemeIconMark renders each entry as its own
        // <path>, and the nonzero fill rule can only cancel windings WITHIN a
        // single element - split across four, the hexagon ring and the gear
        // hole both filled solid and the mark came out as a plain blob.
        paths: [
            { d: DUROXIDE_MARK, fill: OXIDE },
        ],
    },
    page: {
        // Deeper than the banner so panels sit ON the sheet rather than in it.
        background: "#201e1f",
        foreground: "#e5e0dc",
        overlayBackground: "#2e2c2d",
        overlayForeground: "#e5e0dc",
        hintColor: "#a89f99",
        modalBackdrop: "rgba(23, 21, 23, 0.86)",
        modalBackground: "#2e2c2d",
        modalBorder: "#4d4643",
        modalForeground: "#e5e0dc",
        modalMuted: "#a89f99",
        // Selection is the oxide at its deepest measured shadow, not a tint of
        // the accent - the colour the pressed edge of the mark actually goes.
        modalSelectedBackground: "#7c3f26",
        modalSelectedBorder: "#a35838",
        modalSelectedForeground: "#ffeee4",
    },
    terminal: {
        // The banner tone, exactly.
        background: "#282627",
        foreground: "#e5e0dc",
        cursor: "#d2764a",
        cursorAccent: "#201e1f",
        selectionBackground: "#7c3f26",
        black: "#201e1f",
        // rustc's levels, desaturated into the brand's register.
        red: "#e86a5f",        // error[E0382]
        green: "#7fb069",      // Compiling / Finished
        yellow: "#d9a441",     // warning:
        blue: "#6a9fd4",       // the --> gutter rail and help:
        magenta: "#b98bc4",
        // The accent slot. The portal derives --ps-accent from tui.cyan, so the
        // interactive colour travels here regardless of the slot's name.
        cyan: "#d2764a",
        white: "#e5e0dc",
        brightBlack: "#a89f99",
        brightRed: "#f4897f",
        brightGreen: "#9bc888",
        brightYellow: "#efc069",
        brightBlue: "#8fbce4",
        brightMagenta: "#d0a8d9",
        // The banner's lit edge, measured where the press catches the light.
        brightCyan: "#ba714c",
        brightWhite: "#fdf7f2",
    },
    tui: {
        // 2.49:1 on the surface. The old #46403d was 1.48:1 — enough to
        // suggest an edge on a flat panel, and nothing at all once the felt
        // texture ran over it or it was drawn as a one-pixel seam. Every
        // structural line in the theme reads from this: panel edges, the
        // joined-workspace seams, and the table rules.
        border: "#6a615b",
        // The human speaks in the warning register, as in the Rust theme: the
        // accent stays reserved for the machine and what it produces.
        userChat: "#e0b070",
        userChatLabel: "#f0cf9a",
        selectionBackground: "#7c3f26",
        selectionForeground: "#ffeee4",
        activeHighlightBackground: "#7c3f26",
        activeHighlightForeground: "#ffeee4",
        promptCursorBackground: "#d2764a",
        promptCursorForeground: "#201e1f",
    },
});

export default duroxideTheme;
