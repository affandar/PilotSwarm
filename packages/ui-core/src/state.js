import { FOCUS_REGIONS, INSPECTOR_TABS } from "./commands.js";
import { DEFAULT_THEME_ID, getTheme } from "./themes/index.js";

export function createInitialState({ mode = "local", branding = null, themeId = null } = {}) {
    const resolvedThemeId = (themeId && getTheme(themeId)) ? themeId : DEFAULT_THEME_ID;
    return {
        branding: branding || {
            title: "PilotSwarm",
            splash: "{bold}{cyan-fg}PilotSwarm{/cyan-fg}{/bold}",
        },
        ui: {
            focusRegion: FOCUS_REGIONS.SESSIONS,
            inspectorTab: INSPECTOR_TABS[0],
            prompt: "",
            promptCursor: 0,
            promptAttachments: [],
            statusText: "Starting PilotSwarm...",
            themeId: resolvedThemeId,
            modal: null,
            layout: {
                paneAdjust: 0,
                viewportWidth: 120,
                viewportHeight: 40,
            },
            scroll: {
                chat: 0,
                inspector: 0,
                activity: 0,
                filePreview: 0,
            },
        },
        connection: {
            mode,
            connected: false,
            workersOnline: null,
            error: null,
        },
        sessions: {
            byId: {},
            flat: [],
            activeSessionId: null,
            collapsedIds: new Set(),
            orderById: {},
            nextOrderOrdinal: 0,
        },
        history: {
            bySessionId: new Map(),
        },
        orchestration: {
            bySessionId: {},
        },
        executionHistory: {
            bySessionId: {},
            format: "pretty",
        },
        files: {
            bySessionId: {},
            fullscreen: false,
            selectedArtifactId: null,
            filter: {
                scope: "selectedSession",
            },
        },
        logs: {
            available: false,
            availabilityReason: "Log tailing disabled: no K8S_CONTEXT configured in the env file.",
            tailing: false,
            entries: [],
            filter: {
                source: "allNodes",
                level: "all",
                format: "pretty",
            },
        },
    };
}
