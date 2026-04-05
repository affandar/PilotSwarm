import githubDarkTheme from "./github-dark.js";
import cobalt2Theme from "./cobalt2.js";
import draculaTheme from "./dracula.js";
import catppuccinMochaTheme from "./catppuccin-mocha.js";
import nordTheme from "./nord.js";
import tokyoNightTheme from "./tokyo-night.js";
import gruvboxDarkTheme from "./gruvbox-dark.js";
import solarizedDarkTheme from "./solarized-dark.js";

const THEMES = Object.freeze([
    draculaTheme,
    githubDarkTheme,
    cobalt2Theme,
    catppuccinMochaTheme,
    nordTheme,
    tokyoNightTheme,
    gruvboxDarkTheme,
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
