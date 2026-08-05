import { createTheme, THEME_GROUP_OTHER } from "./helpers.js";

// Rust (2010–) — oxidised iron, and the compiler that talks to you.
//
// The obvious move is "orange theme". The better one is to notice that Rust's
// real visual signature is not the logo, it is RUSTC OUTPUT: a warm accent on
// cold graphite, a blue gutter rail down the left of every diagnostic, and a
// strict three-level vocabulary — error red, warning yellow, help cyan — with
// cargo's green reserved for the two lines that mean "it worked". That is a
// status palette a session list can use directly, so it is the one this theme
// adopts wholesale.
//
// The ground is stone graphite rather than the brown DOOM already owns. Iron
// oxide is the ACCENT here, not the chrome; the frame stays cold so the orange
// has something to be warm against. That single decision is what keeps the two
// warm-dark themes from collapsing into each other.
//
// Note the cyan slot carries Ferris orange. The portal derives `--ps-accent`
// from `tui.cyan` (see applyDocumentTheme), so the accent role travels on that
// slot regardless of its name — and an orange accent is the entire point of a
// Rust theme. rustc's cyan `help:` register is given to `blue` instead, which
// is where the gutter rail lives anyway.
const rustTheme = createTheme({
    id: "rust",
    label: "Rust",
    description: "Graphite and iron oxide, Ferris in the corner, and rustc's diagnostic levels as the status palette.",
    group: THEME_GROUP_OTHER,
    // Ferris, drawn in blocks rather than curves — the repo's other marks are
    // pixel art (see doom.js, winamp.js), and a smooth crab beside a 32px
    // DOOM face would read as a different set. Blocks also survive favicon
    // size, which a thin-limbed vector crab does not.
    icon: {
        viewBox: "0 0 32 32",
        paths: [
            { d: "M0 0h32v32H0z", fill: "#241f1c" },              // recessed bay
            // Eyes sit just clear of the shell on stubby stalks. They were
            // tall at first and the whole mark read as a Space Invader —
            // Ferris is WIDE and LOW, and the silhouette only says crab once
            // the shell is much broader than the gap above it.
            { d: "M11.5 9.5h1.5v2h-1.5z", fill: "#d63a00" },
            { d: "M19 9.5h1.5v2h-1.5z", fill: "#d63a00" },
            { d: "M10.5 6h3.5v3.5h-3.5z", fill: "#ffe9dd" },
            { d: "M18 6h3.5v3.5H18z", fill: "#ffe9dd" },
            { d: "M11.5 7h1.5v1.5h-1.5z", fill: "#1a1210" },
            { d: "M19 7h1.5v1.5H19z", fill: "#1a1210" },
            // Shell, stepped out to a flat oval.
            { d: "M10 11.5h12v2H10z", fill: "#ff7a3d" },          // top-lit dome
            { d: "M7 13.5h18v3H7z", fill: "#f74c00" },
            { d: "M5 16.5h22v4H5z", fill: "#f74c00" },
            { d: "M7 20.5h18v1.8H7z", fill: "#f74c00" },
            { d: "M14.5 18h3v1.4h-3z", fill: "#c23c00" },         // mouth
            // Pincers: a solid block with the opening cut back out in the
            // ground colour, which is cheaper than describing a C in one path.
            // They are held ABOVE the shell's widest row with a sliver of
            // ground between — butted straight onto it they merged into one
            // wide mass and stopped reading as claws at all.
            { d: "M0 11h4.5v6.5H0z", fill: "#d63a00" },
            { d: "M0 13.2h3v2H0z", fill: "#241f1c" },
            { d: "M27.5 11h4.5v6.5h-4.5z", fill: "#d63a00" },
            { d: "M29 13.2h3v2h-3z", fill: "#241f1c" },
            // Legs
            { d: "M8.5 22.3h2.5v2.4H8.5z", fill: "#d63a00" },
            { d: "M14.75 22.3h2.5v2.4h-2.5z", fill: "#d63a00" },
            { d: "M21 22.3h2.5v2.4H21z", fill: "#d63a00" },
        ],
    },
    page: {
        background: "#1c1917",
        foreground: "#e7e0d8",
        overlayBackground: "#262220",
        overlayForeground: "#e7e0d8",
        hintColor: "#a39a8f",
        modalBackdrop: "rgba(28, 25, 23, 0.82)",
        modalBackground: "#262220",
        modalBorder: "#4a4038",
        modalForeground: "#e7e0d8",
        modalMuted: "#a9a096",
        // Selection is oxide, not a tint of the accent: a filled band of the
        // colour iron actually goes when it rusts.
        modalSelectedBackground: "#7c2d12",
        modalSelectedBorder: "#ce422b",
        modalSelectedForeground: "#ffeadf",
    },
    terminal: {
        background: "#1c1917",
        foreground: "#e7e0d8",
        cursor: "#f74c00",
        cursorAccent: "#1c1917",
        selectionBackground: "#7c2d12",
        black: "#1c1917",
        red: "#f3554a",          // error[E0382]
        green: "#6cc24a",        // Compiling / Finished
        yellow: "#e5b02b",       // warning:
        blue: "#58a6ff",         // the --> gutter rail and help:
        magenta: "#c98bdf",
        // Ferris, and therefore the portal accent. Measured at 5.0:1 on the
        // ground, which clears the 4.5:1 the theme suite holds muted text to
        // — so it stays usable for links and not just for decoration.
        cyan: "#f74c00",
        white: "#e7e0d8",
        brightBlack: "#a39a8f",
        brightRed: "#ff7b70",
        brightGreen: "#8fdd6e",
        brightYellow: "#ffcc55",
        brightBlue: "#83c0ff",
        brightMagenta: "#dcaaef",
        brightCyan: "#ff7a3d",
        brightWhite: "#fdf6ee",
    },
    tui: {
        border: "#4a4038",
        // Speakers keep the diagnostic register: the human is the amber
        // `warning:` line, the accent stays reserved for the machine.
        userChat: "#ffb454",
        userChatLabel: "#ffd08a",
        selectionBackground: "#7c2d12",
        selectionForeground: "#ffeadf",
        activeHighlightBackground: "#7c2d12",
        activeHighlightForeground: "#ffeadf",
        promptCursorBackground: "#f74c00",
        promptCursorForeground: "#1c1917",
    },
});

export default rustTheme;
