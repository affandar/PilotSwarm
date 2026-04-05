function freezeTheme(theme) {
    return Object.freeze({
        ...theme,
        page: Object.freeze({ ...(theme.page || {}) }),
        terminal: Object.freeze({ ...(theme.terminal || {}) }),
        tui: Object.freeze({ ...(theme.tui || {}) }),
    });
}

export function createTheme({ id, label, description, page, terminal, tui = {} }) {
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
        page,
        terminal,
        tui: {
            ...baseTui,
            ...tui,
        },
    });
}
