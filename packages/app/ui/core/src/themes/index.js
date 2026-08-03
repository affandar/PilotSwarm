import githubDarkTheme from "./github-dark.js";
import githubLightTheme from "./github-light.js";
import workspaceDarkTheme from "./workspace-dark.js";
import workspaceDarkRichTheme from "./workspace-dark-rich.js";
import cobalt2Theme from "./cobalt2.js";
import draculaTheme from "./dracula.js";
import catppuccinMochaTheme from "./catppuccin-mocha.js";
import hackerXMatrixTheme from "./hacker-x-matrix.js";
import hackerXOrionPrimeTheme from "./hacker-x-orion-prime.js";
import gruvboxDarkTheme from "./gruvbox-dark.js";
import noctisTheme from "./noctis.js";
import noctisObscuroTheme from "./noctis-obscuro.js";
import darkHighContrastTheme from "./dark-high-contrast.js";
import terminalGreenTheme from "./terminal-green.js";
import highContrastMonoTheme from "./high-contrast-mono.js";
import win95Theme from "./win95.js";
import msDosTheme from "./ms-dos.js";
import doomTheme from "./doom.js";
import winampTheme from "./winamp.js";

const THEMES = Object.freeze([
    workspaceDarkTheme,
    workspaceDarkRichTheme,
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
    darkHighContrastTheme,
    terminalGreenTheme,
    highContrastMonoTheme,
    win95Theme,
    msDosTheme,
    doomTheme,
    winampTheme,
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
