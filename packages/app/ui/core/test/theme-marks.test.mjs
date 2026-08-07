/**
 * The retro themes that ship a mark (DOOM, WinAMP), and the theme-icon
 * contract they introduced.
 *
 * The icon is the first case of a theme carrying BRANDING rather than only
 * colour, so the shape is pinned here: data (not markup, because ui/core has
 * no framework and must never inject HTML), optional, and null everywhere it
 * is not declared — a theme without one must leave the deployment's own logo
 * alone.
 *
 * Run: node --test test/theme-doom.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getTheme, listThemes } from "../src/index.js";

function luminance(hex) {
    const v = String(hex).replace("#", "");
    const ch = (i) => {
        const c = parseInt(v.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/** Every theme that ships a mark must meet the same bar. */
const ICON_THEMES = [
    { id: "doom", label: "DOOM" },
    { id: "winamp", label: "WinAMP" },
    { id: "duroxide", label: "Duroxide" },
];

for (const { id, label } of ICON_THEMES) {
    test(`${label} is registered and selectable`, () => {
        const theme = getTheme(id);
        assert.ok(theme, `getTheme('${id}') should resolve`);
        assert.equal(theme.label, label);
        assert.ok(
            listThemes().some((entry) => entry.id === id),
            `${label} must appear in the picker list, not only by direct lookup`,
        );
    });

    test(`${label} muted text clears 4.5:1 and status marks clear 3:1`, () => {
        const theme = getTheme(id);
        for (const [what, fg, bg] of [
            ["TUI gray", theme.tui.gray, theme.tui.background],
            ["modal muted", theme.page.modalMuted, theme.page.modalBackground],
            ["terminal gray", theme.terminal.brightBlack, theme.terminal.background],
        ]) {
            assert.ok(contrast(fg, bg) >= 4.5, `${label} ${what}: ${contrast(fg, bg).toFixed(2)}:1`);
        }
        // Status dots are 6px — under 3:1 they simply are not there.
        for (const [what, colour] of [
            ["red", theme.terminal.red],
            ["green", theme.terminal.green],
            ["yellow", theme.terminal.yellow],
            ["blue", theme.terminal.blue],
        ]) {
            const ratio = contrast(colour, theme.terminal.background);
            assert.ok(ratio >= 3, `${label} ${what} ${colour}: ${ratio.toFixed(2)}:1 on the ground`);
        }
    });

    test(`${label} body text and the selection bar are legible`, () => {
        const theme = getTheme(id);
        assert.ok(contrast(theme.page.foreground, theme.page.background) >= 7);
        assert.ok(
            contrast(theme.page.modalSelectedForeground, theme.page.modalSelectedBackground) >= 4.5,
            `${label} selected text on its selection bar`,
        );
    });

    test(`${label} carries an icon as DATA, not markup`, () => {
        const { icon } = getTheme(id);
        assert.ok(icon, `${label} declares an icon`);
        assert.match(icon.viewBox, /^[\d\s.]+$/, "viewBox is plain numbers");
        assert.ok(Array.isArray(icon.paths) && icon.paths.length > 0);
        for (const path of icon.paths) {
            assert.equal(typeof path.d, "string", "every shape is a path");
            assert.match(path.fill, /^#[0-9a-f]{6}$/i, "every shape names its own fill");
            assert.ok(!/[<>]/.test(path.d), "path data must not contain markup");
        }
    });
}


test("themes without an icon leave the deployment's logo alone", () => {
    // Precedence only kicks in when a theme opts in. If this ever regressed to
    // a truthy default, every layered app would lose its own branding.
    const withoutIcons = listThemes().filter((entry) => !getTheme(entry.id).icon);
    assert.ok(withoutIcons.length > 0, "most themes declare no icon");
    for (const entry of withoutIcons) {
        assert.equal(getTheme(entry.id).icon, null, `${entry.id} icon must be null, not undefined`);
    }
});



test("WinAMP spends the spectrum ramp on status, in order", () => {
    const { terminal } = getTheme("winamp");
    // green -> lime -> amber -> red, so a column of dots reads like a meter.
    assert.equal(terminal.green, "#00e337");
    assert.equal(terminal.yellow, "#ffb400");
    assert.equal(terminal.red, "#ff3b00");
    // The frame is METAL, not green. This one value is most of what keeps the
    // theme from reading as Terminal Green.
    assert.equal(getTheme("winamp").tui.border, "#5e5e5e");
    assert.notEqual(getTheme("winamp").tui.gray, getTheme("winamp").page.foreground);
});

test("DOOM's keycard triad is the status palette, and the three stay distinct", () => {
    const { terminal } = getTheme("doom");
    assert.equal(terminal.blue, "#3a5ce0", "blue keycard, lifted for 3:1 on the ground");
    assert.equal(terminal.yellow, "#e8c020", "yellow keycard");
    assert.equal(terminal.red, "#c42222", "red keycard, lifted for 3:1 on the ground");
    const keys = [terminal.blue, terminal.yellow, terminal.red];
    assert.equal(new Set(keys).size, 3, "three distinct keycards");
    for (const key of keys) {
        assert.ok(
            contrast(key, terminal.background) >= 3,
            `${key} must read against the ground (${contrast(key, terminal.background).toFixed(2)}:1)`,
        );
    }
});


test("Duroxide spends the brand oxide on chrome and never on text", () => {
    // #a35838 is the colour measured off the banner mark, and it is 2.87:1 on
    // the ground — below the 4.5:1 this suite holds muted text to. The theme
    // is only coherent because the exact brand colour is reserved for the
    // logo and borders while a brightened sibling carries the interactive
    // role. If someone "fixes" the accent back to the brand hex to make it
    // match the banner, this catches it.
    const theme = getTheme("duroxide");
    const BRAND = "#a35838";

    assert.ok(contrast(BRAND, theme.terminal.background) < 4.5,
        "precondition: the brand oxide is genuinely too low-contrast for text");
    assert.equal(theme.icon.paths[0].fill, BRAND, "the mark is drawn in the true brand colour");
    // The point of this assertion is that the border is NOT the brand oxide,
    // not that it is one specific grey — pinning the hex made a legitimate
    // contrast fix look like a regression. Assert the property that matters.
    assert.notEqual(theme.tui.border, BRAND, "borders are chrome, not the brand hex");
    assert.ok(contrast(theme.tui.border, theme.terminal.background) >= 2,
        `border ${theme.tui.border} must actually divide: ${contrast(theme.tui.border, theme.terminal.background).toFixed(2)}:1`);

    // The accent — what --ps-accent is derived from — must be readable.
    assert.notEqual(theme.terminal.cyan, BRAND, "the accent is not the raw brand colour");
    assert.ok(contrast(theme.terminal.cyan, theme.terminal.background) >= 4.5,
        `accent ${theme.terminal.cyan}: ${contrast(theme.terminal.cyan, theme.terminal.background).toFixed(2)}:1`);
    assert.ok(contrast(theme.terminal.cyan, theme.page.background) >= 4.5, "accent on the page ground too");
});

test("Duroxide's mark is ONE path, so nonzero can punch its holes", () => {
    // ThemeIconMark renders each entry as its own <path> and emits no
    // fill-rule. Winding only cancels WITHIN a single element, so splitting
    // the four subpaths across four entries fills the hexagon ring and the
    // gear bore solid — the mark renders as a plain blob. It did, once.
    const { icon } = getTheme("duroxide");
    assert.equal(icon.paths.length, 1, "all subpaths must live in one d string");
    const subpaths = icon.paths[0].d.match(/M/g) || [];
    assert.equal(subpaths.length, 4, "hexagon outer + inner, gear/arrow outer + bore");
});

test("Duroxide is a different theme from Rust, not a re-skin", () => {
    // Both are warm-dark and both are Rust-adjacent; the repo already warns
    // that they must not collapse into each other. Ground and accent are the
    // two decisions that keep them apart.
    const dx = getTheme("duroxide");
    const rust = getTheme("rust");
    assert.notEqual(dx.page.background, rust.page.background);
    assert.notEqual(dx.terminal.cyan, rust.terminal.cyan);
    // Duroxide's accent is the more muted of the two: brand pigment, not
    // Ferris orange. Saturation is the measurable form of that claim.
    const sat = (hex) => {
        const v = hex.replace("#", "");
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        return max === 0 ? 0 : (max - min) / max;
    };
    assert.ok(sat(dx.terminal.cyan) < sat(rust.terminal.cyan),
        `duroxide accent should be the more muted pigment (${sat(dx.terminal.cyan).toFixed(2)} vs ${sat(rust.terminal.cyan).toFixed(2)})`);
});
