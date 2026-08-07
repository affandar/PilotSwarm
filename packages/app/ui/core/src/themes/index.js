import { THEME_GROUP_ORDER } from "./helpers.js";
import githubDarkTheme from "./github-dark.js";
import githubLightTheme from "./github-light.js";
import workspaceDarkTheme from "./workspace-dark.js";
import cobalt2Theme from "./cobalt2.js";
import draculaTheme from "./dracula.js";
import catppuccinMochaTheme from "./catppuccin-mocha.js";
import hackerXMatrixTheme from "./hacker-x-matrix.js";
import hackerXOrionPrimeTheme from "./hacker-x-orion-prime.js";
import gruvboxDarkTheme from "./gruvbox-dark.js";
import noctisTheme from "./noctis.js";
import noctisObscuroTheme from "./noctis-obscuro.js";
import terminalGreenTheme from "./terminal-green.js";
import highContrastMonoTheme from "./high-contrast-mono.js";
import win95Theme from "./win95.js";
import msDosTheme from "./ms-dos.js";
import doomTheme from "./doom.js";
import winampTheme from "./winamp.js";
import rustTheme from "./rust.js";
import duroxideTheme from "./duroxide.js";
import spongebobTheme from "./spongebob.js";

// Themes are ordered by GROUP first, then alphabetically inside it — the
// picker renders a heading whenever the group changes, so this sort IS the
// picker's structure. Sorting alphabetically across the whole list (which is
// what this did before groups existed) would interleave the sections and the
// headings would repeat.
function byGroupThenLabel(left, right) {
    const leftGroup = THEME_GROUP_ORDER.indexOf(left.group);
    const rightGroup = THEME_GROUP_ORDER.indexOf(right.group);
    // An unknown group sorts last rather than first: indexOf gives -1, which
    // would otherwise float a mis-tagged theme above every real section.
    const leftRank = leftGroup === -1 ? Number.MAX_SAFE_INTEGER : leftGroup;
    const rightRank = rightGroup === -1 ? Number.MAX_SAFE_INTEGER : rightGroup;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
}

const THEMES = Object.freeze([
    workspaceDarkTheme,
    draculaTheme,
    githubDarkTheme,
    githubLightTheme,
    cobalt2Theme,
    hackerXOrionPrimeTheme,
    hackerXMatrixTheme,
    catppuccinMochaTheme,
    gruvboxDarkTheme,
    noctisTheme,
    noctisObscuroTheme,
    terminalGreenTheme,
    highContrastMonoTheme,
    win95Theme,
    msDosTheme,
    doomTheme,
    winampTheme,
    rustTheme,
    duroxideTheme,
    spongebobTheme,
].sort(byGroupThenLabel));

const THEME_MAP = new Map(THEMES.map((theme) => [theme.id, theme]));

export const DEFAULT_THEME_ID = noctisObscuroTheme.id;

export { THEME_GROUP_ORDER } from "./helpers.js";

export function listThemes() {
    return THEMES;
}

export function getTheme(themeId) {
    if (!themeId) return null;
    return THEME_MAP.get(themeId) ?? null;
}
