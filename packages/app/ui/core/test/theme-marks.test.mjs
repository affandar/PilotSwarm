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
