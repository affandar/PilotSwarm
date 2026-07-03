import githubDarkTheme from "./github-dark.js";
import githubLightTheme from "./github-light.js";
import daylightTheme from "./daylight.js";
import paperInkTheme from "./paper-ink.js";
import lightHighContrastTheme from "./light-high-contrast.js";
import cobalt2Theme from "./cobalt2.js";
import draculaTheme from "./dracula.js";
import catppuccinMochaTheme from "./catppuccin-mocha.js";
import hackerXMatrixTheme from "./hacker-x-matrix.js";
import hackerXOrionPrimeTheme from "./hacker-x-orion-prime.js";
import tokyoNightTheme from "./tokyo-night.js";
import gruvboxDarkTheme from "./gruvbox-dark.js";
import noctisTheme from "./noctis.js";
import noctisObscuroTheme from "./noctis-obscuro.js";
import darkHighContrastTheme from "./dark-high-contrast.js";
import terminalGreenTheme from "./terminal-green.js";
import solarizedOpsTheme from "./solarized-ops.js";
import highContrastMonoTheme from "./high-contrast-mono.js";

const THEMES = Object.freeze([
    draculaTheme,
    githubDarkTheme,
    githubLightTheme,
    daylightTheme,
    paperInkTheme,
    lightHighContrastTheme,
    cobalt2Theme,
    hackerXOrionPrimeTheme,
    hackerXMatrixTheme,
    catppuccinMochaTheme,
    tokyoNightTheme,
    gruvboxDarkTheme,
    noctisTheme,
    noctisObscuroTheme,
    darkHighContrastTheme,
    terminalGreenTheme,
    solarizedOpsTheme,
    highContrastMonoTheme,
].sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" })));

const THEME_MAP = new Map(THEMES.map((theme) => [theme.id, theme]));

export const DEFAULT_THEME_ID = noctisObscuroTheme.id;

export function listThemes() {
    return THEMES;
}

export function getTheme(themeId) {
    if (!themeId) return null;
    return THEME_MAP.get(themeId) ?? null;
}
