import { FOCUS_REGIONS, INSPECTOR_TABS } from "./commands.js";
import { DEFAULT_THEME_ID } from "./themes/index.js";

const ARTIFACT_SOURCES = new Set(["agent", "user", "system"]);

export function normalizeSessionOwnerFilter(filter) {
    const ownerKeys = Array.isArray(filter?.ownerKeys)
        ? [...new Set(filter.ownerKeys.map((key) => String(key || "").trim()).filter(Boolean))]
        : [];
    const hasExplicitFilter = filter && typeof filter === "object";
    return {
        all: hasExplicitFilter ? filter?.all === true : true,
        includeSystem: filter?.includeSystem === true,
        includeUnowned: filter?.includeUnowned === true,
        includeMe: filter?.includeMe === true,
        ownerKeys,
    };
}

export function normalizeArtifactEntry(entry) {
    if (typeof entry === "string") {
        const filename = entry.trim();
        if (!filename) return null;
        return {
            filename,
            sizeBytes: null,
            contentType: "",
            isBinary: false,
            uploadedAt: "",
            source: "agent",
        };
    }
    if (!entry || typeof entry !== "object") return null;
    const filename = String(entry.filename || "").trim();
    if (!filename) return null;
    const sizeBytes = Number(entry.sizeBytes);
    const contentType = typeof entry.contentType === "string" ? entry.contentType : "";
    return {
        filename,
        sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null,
        contentType,
        isBinary: entry.isBinary === true,
        uploadedAt: typeof entry.uploadedAt === "string" ? entry.uploadedAt : "",
        source: ARTIFACT_SOURCES.has(entry.source) ? entry.source : "agent",
    };
}

export function normalizeArtifactEntries(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const normalized = [];
    const seen = new Set();
    for (const entry of list) {
        const candidate = normalizeArtifactEntry(entry);
        if (!candidate || seen.has(candidate.filename)) continue;
        seen.add(candidate.filename);
        normalized.push(candidate);
    }
    return normalized;
}

export function findArtifactEntry(entries, filename) {
    const target = String(filename || "").trim();
    if (!target) return null;
    return normalizeArtifactEntries(entries).find((entry) => entry.filename === target) || null;
}

export function createInitialState({ mode = "local", branding = null, themeId = null, sessionOwnerFilter = null } = {}) {
    const hasStoredSessionOwnerFilter = sessionOwnerFilter != null;
    return {
        branding: branding || {
            title: "PilotSwarm",
            splash: "{bold}{cyan-fg}PilotSwarm{/cyan-fg}{/bold}",
        },
        auth: {
            principal: null,
            authorization: null,
        },
        ui: {
            focusRegion: FOCUS_REGIONS.SESSIONS,
            inspectorTab: INSPECTOR_TABS[0],
            statsViewMode: "session",
            prompt: "",
            promptCursor: 0,
            promptRows: 1,
            promptAttachments: [],
            statusText: "Starting PilotSwarm...",
            themeId: themeId || DEFAULT_THEME_ID,
            modal: null,
            fullscreenPane: null,
            layout: {
                paneAdjust: 0,
                sessionPaneAdjust: 0,
                viewportWidth: 120,
                viewportHeight: 40,
            },
            scroll: {
                chat: 0,
                inspector: 0,
                activity: 0,
                filePreview: 0,
            },
            followBottom: {
                inspector: true,
                activity: true,
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
            filterQuery: "",
            ownerFilterExplicit: hasStoredSessionOwnerFilter,
            ownerFilter: normalizeSessionOwnerFilter(sessionOwnerFilter),
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
                query: "",
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
        sessionStats: {
            bySessionId: {},
        },
        fleetStats: {
            loading: false,
            data: null,
            userStats: null,
            fetchedAt: 0,
        },
    };
}
