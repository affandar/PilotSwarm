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

export function normalizeStoredLayoutAdjustments(layoutAdjustments) {
    const candidate = layoutAdjustments && typeof layoutAdjustments === "object"
        ? layoutAdjustments
        : {};
    const paneAdjust = Number(candidate.paneAdjust);
    const sessionPaneAdjust = Number(candidate.sessionPaneAdjust);
    const activityPaneAdjust = Number(candidate.activityPaneAdjust);
    return {
        paneAdjust: Number.isFinite(paneAdjust) ? Math.trunc(paneAdjust) : 0,
        sessionPaneAdjust: Number.isFinite(sessionPaneAdjust) ? Math.trunc(sessionPaneAdjust) : 0,
        activityPaneAdjust: Number.isFinite(activityPaneAdjust) ? Math.trunc(activityPaneAdjust) : 0,
    };
}

export function normalizeStoredPinnedSessionIds(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of value) {
        const id = String(entry || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

export function createInitialState({ mode = "local", branding = null, themeId = null, sessionOwnerFilter = null, layoutAdjustments = null, pinnedSessionIds = null } = {}) {
    const hasStoredSessionOwnerFilter = sessionOwnerFilter != null;
    const initialLayoutAdjustments = normalizeStoredLayoutAdjustments(layoutAdjustments);
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
            promptEdit: null,
            statusText: "Starting PilotSwarm...",
            themeId: themeId || DEFAULT_THEME_ID,
            modal: null,
            fullscreenPane: null,
            layout: {
                ...initialLayoutAdjustments,
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
            pinnedIds: normalizeStoredPinnedSessionIds(pinnedSessionIds),
            selectedIds: [],
            selectMode: false,
            orderById: {},
            nextOrderOrdinal: 0,
            filterQuery: "",
            ownerFilterExplicit: hasStoredSessionOwnerFilter,
            ownerFilter: normalizeSessionOwnerFilter(sessionOwnerFilter),
        },
        history: {
            bySessionId: new Map(),
        },
        outbox: {
            bySessionId: {},
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
        admin: {
            // Whether the Admin Console is taking over the workspace and
            // hiding the session/chat panes. Persisted only in-memory.
            visible: false,
            loading: false,
            loadError: null,
            // Public profile snapshot from the management API. Never holds
            // the raw GitHub Copilot key — only the `githubCopilotKeySet`
            // boolean flag.
            profile: null,
            ghcpKey: {
                // Editing flag is the single host-neutral signal that the
                // user is composing a new key. Both the portal's inline
                // form and the native TUI's overlay render against this.
                editing: false,
                draft: "",
                // cursorIndex is only consumed by the native TUI overlay
                // (browser <input> elements manage their own cursor). It
                // is kept in shared state so the controller mutators can
                // remain host-neutral.
                cursorIndex: 0,
                saving: false,
                error: null,
                lastSavedAt: 0,
            },
        },
    };
}
