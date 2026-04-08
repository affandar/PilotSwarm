import githubDarkTheme from "./github-dark.js";
import githubLightHighContrastTheme from "./github-light-high-contrast.js";
import cobalt2Theme from "./cobalt2.js";
import draculaTheme from "./dracula.js";
import catppuccinLatteTheme from "./catppuccin-latte.js";
import catppuccinMochaTheme from "./catppuccin-mocha.js";
import hackerXMatrixTheme from "./hacker-x-matrix.js";
import hackerXOrionPrimeTheme from "./hacker-x-orion-prime.js";
import nordTheme from "./nord.js";
import tokyoNightTheme from "./tokyo-night.js";
import gruvboxDarkTheme from "./gruvbox-dark.js";
import solarizedLightTheme from "./solarized-light.js";
import solarizedDarkTheme from "./solarized-dark.js";

const THEMES = Object.freeze([
    draculaTheme,
    githubDarkTheme,
    githubLightHighContrastTheme,
    cobalt2Theme,
    hackerXOrionPrimeTheme,
    hackerXMatrixTheme,
    catppuccinLatteTheme,
    catppuccinMochaTheme,
    nordTheme,
    tokyoNightTheme,
    gruvboxDarkTheme,
    solarizedLightTheme,
    solarizedDarkTheme,
]);

const THEME_MAP = new Map(THEMES.map((theme) => [theme.id, theme]));

export const DEFAULT_THEME_ID = draculaTheme.id;

export function listThemes() {
    return THEMES;
}

export function getTheme(themeId) {
    if (!themeId) return null;
    return THEME_MAP.get(themeId) ?? null;
}
