// Picker groups. These sort by PROVENANCE, not by look: "VS Code" is a port of
// a theme people already know from their editor, "Retro" is an homage to a
// specific machine or piece of software, and everything PilotSwarm made for
// itself falls to "Others". Sorting by look instead would put Terminal Green
// and Hacker X - Matrix together and then have nowhere to put GitHub Light.
export const THEME_GROUP_VSCODE = "VS Code";
export const THEME_GROUP_RETRO = "Retro";
export const THEME_GROUP_OTHER = "Others";

// Display order for the picker. Not alphabetical: "Others" is the leftover
// bucket and reads wrong anywhere but last.
export const THEME_GROUP_ORDER = Object.freeze([
    THEME_GROUP_VSCODE,
    THEME_GROUP_RETRO,
    THEME_GROUP_OTHER,
]);

function freezeTheme(theme) {
    return Object.freeze({
        ...theme,
        page: Object.freeze({ ...(theme.page || {}) }),
        terminal: Object.freeze({ ...(theme.terminal || {}) }),
        tui: Object.freeze({ ...(theme.tui || {}) }),
    });
}

function parseHexChannel(value) {
    return Number.parseInt(value, 16) / 255;
}

function normalizeHexColor(value) {
    const color = String(value || "").trim();
    if (/^#[0-9a-f]{3}$/iu.test(color)) {
        return `#${color.slice(1).split("").map((channel) => channel + channel).join("")}`;
    }
    return /^#[0-9a-f]{6}$/iu.test(color) ? color : null;
}

function toRelativeLuminanceChannel(value) {
    return value <= 0.03928
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
}

function getRelativeLuminance(color) {
    const normalized = normalizeHexColor(color);
    if (!normalized) return 0;

    const red = toRelativeLuminanceChannel(parseHexChannel(normalized.slice(1, 3)));
    const green = toRelativeLuminanceChannel(parseHexChannel(normalized.slice(3, 5)));
    const blue = toRelativeLuminanceChannel(parseHexChannel(normalized.slice(5, 7)));

    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

export function isThemeLight(theme) {
    const background = theme?.page?.background || theme?.tui?.background || theme?.terminal?.background;
    return getRelativeLuminance(background) >= 0.5;
}

export function createTheme({ id, label, description, group = THEME_GROUP_OTHER, page, terminal, tui = {}, icon = null }) {
    const baseTui = {
        background: page?.background || terminal?.background || "#000000",
        surface: terminal?.background || page?.background || "#000000",
        foreground: terminal?.foreground || page?.foreground || "#ffffff",
        white: terminal?.foreground || page?.foreground || "#ffffff",
        gray: page?.hintColor || terminal?.brightBlack || terminal?.white || "#999999",
        black: terminal?.black || "#000000",
        red: terminal?.red || "#ff5555",
        green: terminal?.green || "#55ff55",
        yellow: terminal?.yellow || "#ffff55",
        blue: terminal?.blue || "#5555ff",
        magenta: terminal?.magenta || "#ff55ff",
        cyan: terminal?.cyan || "#55ffff",
        userChat: "#ffd866",
        userChatLabel: "#ffec99",
        // Speaker label for a message from ANOTHER person in a shared session
        // (distinct from the viewer's gold "You", the agent's green, and
        // System's yellow). Every theme inherits this; a theme may override it.
        otherUserChatLabel: terminal?.brightMagenta || terminal?.magenta || "#c9a3ff",
        activeHighlightBackground: terminal?.blue || "#5555ff",
        activeHighlightForeground: terminal?.background || "#000000",
        selectionBackground: terminal?.cursor || terminal?.blue || "#5555ff",
        selectionForeground: terminal?.cursorAccent || terminal?.background || "#000000",
        promptCursorBackground: terminal?.cursor || terminal?.green || "#55ff55",
        promptCursorForeground: terminal?.cursorAccent || terminal?.background || "#000000",
    };

    return freezeTheme({
        id,
        label,
        description,
        // Which section of the picker this theme lands in. Defaulting to
        // "Others" rather than throwing means a theme added without a group
        // still shows up — it just shows up in the leftover bucket.
        group,
        // Portal-only: an optional brand mark carried BY the theme. When set it
        // outranks the deployment's own logo, because a theme that restyles the
        // whole shell and then leaves a foreign logo in the corner reads as
        // broken. Data, not markup — ui/core has no framework and must not
        // inject HTML. Shape: { viewBox, paths: [{ d, fill }] }.
        icon: icon || null,
        page,
        terminal,
        tui: {
            ...baseTui,
            ...tui,
        },
    });
}
