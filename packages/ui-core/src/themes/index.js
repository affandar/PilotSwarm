import githubDarkTheme from "./github-dark.js";
import cobalt2Theme from "./cobalt2.js";
import draculaTheme from "./dracula.js";
import catppuccinMochaTheme from "./catppuccin-mocha.js";
import hackerXMatrixTheme from "./hacker-x-matrix.js";
import hackerXOrionPrimeTheme from "./hacker-x-orion-prime.js";
import nordTheme from "./nord.js";
import tokyoNightTheme from "./tokyo-night.js";
import gruvboxDarkTheme from "./gruvbox-dark.js";
import solarizedDarkTheme from "./solarized-dark.js";
import noctisTheme from "./noctis.js";
import noctisObscuroTheme from "./noctis-obscuro.js";
import noctisViolaTheme from "./noctis-viola.js";
import darkHighContrastTheme from "./dark-high-contrast.js";

const THEMES = Object.freeze([
    draculaTheme,
    githubDarkTheme,
    cobalt2Theme,
    hackerXOrionPrimeTheme,
    hackerXMatrixTheme,
    catppuccinMochaTheme,
    nordTheme,
    tokyoNightTheme,
    gruvboxDarkTheme,
    solarizedDarkTheme,
    noctisTheme,
    noctisObscuroTheme,
    noctisViolaTheme,
    darkHighContrastTheme,
].sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" })));

const THEME_MAP = new Map(THEMES.map((theme) => [theme.id, theme]));

export const DEFAULT_THEME_ID = draculaTheme.id;

export function listThemes() {
    return THEMES;
}

export function getTheme(themeId) {
    if (!themeId) return null;
    return THEME_MAP.get(themeId) ?? null;
}
