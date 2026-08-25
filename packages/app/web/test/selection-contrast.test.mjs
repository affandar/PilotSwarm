// Selected rows must have readable text in EVERY theme.
//
// WHY THIS EXISTS: three rules painted a selected row with
// `background: var(--ps-modal-selected-background)` and
// `color: var(--ps-selection-background)`. The second is a FILL colour — it is
// what sits BEHIND text, so nothing ever constrained it against the fill in
// front of it. In 9 of 20 themes those two tokens are the same colour, and 8 of
// those are an exact match: the selected row rendered as a solid coloured bar
// with the label invisible inside it.
//
// It survived so long because the two DEFAULT themes (workspace-dark,
// github-dark) are the only ones where the two tokens happen to agree, so the
// bug never appeared during development — only after someone switched theme.
//
// Two checks, deliberately of different kinds:
//   1. the palette — every theme's selected pair is actually readable
//   2. the stylesheet — no rule pairs the selection fill with a fill as text
//
// Check 2 is a source scan, which is normally a weak detector. It is narrow on
// purpose: it looks only at declaration blocks that set the selected
// background, and asserts about the one property in them that has burned us
// twice. It is not a general "does the CSS look right" regex.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listThemes } from "../../ui/core/src/themes/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Comments are stripped before any structural scan. They are not incidental
// here: the rules this test guards carry a comment explaining the fix, and that
// comment NAMES --ps-selection-background. Leaving comments in both hides the
// declaration behind them from a `;`-anchored match and offers the token itself
// as a false positive.
const css = fs
    .readFileSync(path.resolve(__dirname, "../src/index.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

// WCAG relative luminance / contrast ratio. Returns null for anything this
// cannot read (named colours, rgba(), 8-digit hex) rather than guessing — a
// theme whose colour is unparseable is skipped, not silently passed as 0.
function parseHex(colour) {
    if (!colour) return null;
    const match = String(colour).trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return null;
    let hex = match[1];
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function luminance(rgb) {
    const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
    const rgbA = parseHex(a);
    const rgbB = parseHex(b);
    if (!rgbA || !rgbB) return null;
    const lumA = luminance(rgbA);
    const lumB = luminance(rgbB);
    return (Math.max(lumA, lumB) + 0.05) / (Math.min(lumA, lumB) + 0.05);
}

// 3:1 is the WCAG floor for large/bold UI text. Every theme clears 6:1 today,
// so this leaves room for a new palette without waving through an unreadable
// one. The failure this guards against lands at 1.00, nowhere near the line.
const MIN_CONTRAST = 3;

test("every theme's selected-row text is readable on its selected background", () => {
    const unreadable = [];
    let checked = 0;

    for (const theme of listThemes()) {
        const background = theme.page?.modalSelectedBackground;
        const foreground = theme.page?.modalSelectedForeground;
        const ratio = contrast(foreground, background);
        if (ratio === null) continue; // translucent fill — composites over the panel, not measurable here
        checked += 1;
        if (ratio < MIN_CONTRAST) {
            unreadable.push(`${theme.id}: ${foreground} on ${background} = ${ratio.toFixed(2)}:1`);
        }
    }

    assert.ok(checked >= 15, `expected to measure most themes, only measured ${checked}`);
    assert.deepEqual(
        unreadable,
        [],
        "these themes would render a selected row as a coloured bar with unreadable text:\n  " +
            unreadable.join("\n  "),
    );
});

test("no rule paints the selection fill and then uses a fill colour as its text", () => {
    // Pull each declaration block that sets the selected background, then look
    // at what it sets `color` to. --ps-selection-background and
    // --ps-modal-selected-background are both fills; neither can be the text on
    // top of a fill.
    const FILL_TOKENS = ["--ps-selection-background", "--ps-modal-selected-background"];
    const offenders = [];

    for (const match of css.matchAll(/([^{}]+)\{([^{}]*--ps-modal-selected-background[^{}]*)\}/g)) {
        const selector = match[1].trim().split("\n").pop().trim();
        const body = match[2];
        // Only blocks where it is used AS the background, not in a color-mix().
        if (!/background:\s*var\(\s*--ps-modal-selected-background\s*\)/.test(body)) continue;
        // Split into declarations so `color` is matched as a whole property —
        // anchoring on the preceding `;` breaks the moment a comment or another
        // declaration sits in between, and `border-color` must not count.
        for (const declaration of body.split(";")) {
            const colour = declaration.trim().match(/^color:\s*var\(\s*(--ps-[a-z0-9-]+)/);
            if (colour && FILL_TOKENS.includes(colour[1])) {
                offenders.push(`${selector} → color: var(${colour[1]})`);
            }
        }
    }

    assert.deepEqual(
        offenders,
        [],
        "a fill colour is being used as the text on top of that same fill:\n  " + offenders.join("\n  "),
    );
});
