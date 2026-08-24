import { FOCUS_REGIONS, INSPECTOR_TABS } from "./commands.js";
import { DEFAULT_THEME_ID, getTheme } from "./themes/index.js";

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
        includeShared: filter?.includeShared === true,
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
    const portalSessionColumnAdjust = Number(candidate.portalSessionColumnAdjust);
    const activityPaneAdjust = Number(candidate.activityPaneAdjust);
    // Canvas is a column of its own now rather than a face the right column
    // wears, so it needs its own remembered width. Same mechanism as the rest:
    // a pixel delta from the computed base, persisted per user.
    const canvasPaneAdjust = Number(candidate.canvasPaneAdjust);
    const diagnosticsPaneAdjust = Number(candidate.diagnosticsPaneAdjust);
    const diagnosticsSplitAdjust = Number(candidate.diagnosticsSplitAdjust);
    return {
        paneAdjust: Number.isFinite(paneAdjust) ? Math.trunc(paneAdjust) : 0,
        sessionPaneAdjust: Number.isFinite(sessionPaneAdjust) ? Math.trunc(sessionPaneAdjust) : 0,
        portalSessionColumnAdjust: Number.isFinite(portalSessionColumnAdjust) ? Math.trunc(portalSessionColumnAdjust) : 0,
        activityPaneAdjust: Number.isFinite(activityPaneAdjust) ? Math.trunc(activityPaneAdjust) : 0,
        canvasPaneAdjust: Number.isFinite(canvasPaneAdjust) ? Math.trunc(canvasPaneAdjust) : 0,
        diagnosticsPaneAdjust: Number.isFinite(diagnosticsPaneAdjust) ? Math.trunc(diagnosticsPaneAdjust) : 0,
        // The inspector/activity seam inside Diagnostics, in PIXELS from an
        // even split. The old row-quantized TUI adjust made browser drags
        // jump in ~20px notches.
        diagnosticsSplitAdjust: Number.isFinite(diagnosticsSplitAdjust) ? Math.trunc(diagnosticsSplitAdjust) : 0,
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

/**
 * The user's explicit row placement, as an ordered id list.
 *
 * Same shape and same discipline as the pinned list — deduped, trimmed, and
 * tolerant of anything a stored profile might hold. Ids of sessions that no
 * longer exist are NOT dropped here: the list is written from the desktop but
 * read on every surface, and pruning on read would let a phone or a TUI
 * (which may hold a narrower slice of the fleet) quietly erase placements for
 * sessions it simply cannot see.
 */
export function normalizeStoredSessionOrder(value) {
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

export function normalizeStoredCollapsedSessionIds(value) {
    if (!Array.isArray(value)) return new Set();
    const out = new Set();
    for (const entry of value) {
        const id = String(entry || "").trim();
        if (!id) continue;
        out.add(id);
    }
    return out;
}

/**
 * Right-column mode: the inspector/activity split, or the session canvas.
 * Anything unrecognized falls back to panes — a stored value from a newer
 * build must not strand an older portal in a mode it cannot render.
 *
 * @deprecated Superseded by the independent `canvasOpen` / `diagnosticsOpen`
 * booleans. Kept only to migrate a value written by an older build — see
 * normalizeStoredDesktopPanes.
 */
export function normalizeStoredRightPaneMode(value) {
    return value === "canvas" ? "canvas" : "panes";
}

/**
 * Which of the two optional desktop columns are on screen.
 *
 * Canvas and Diagnostics used to be one enum (`rightPaneMode`), so the right
 * column could only ever wear one face. They are independent now: either, both,
 * or neither. Diagnostics is the old inspector/activity split, moved out of the
 * chat pane and travelling as one unit.
 *
 * Both default to OFF. A pane that is off has no width and no resizer — it is
 * absent, not collapsed to nothing.
 *
 * Migrating a stored `rightPaneMode`:
 *   "canvas" -> canvas on. That was a deliberate choice, so it is honored.
 *   "panes"  -> both off. "panes" was the default value rather than a choice,
 *               and the new default is a clean two-column workspace.
 */
export function normalizeStoredDesktopPanes(value, legacyRightPaneMode) {
    const candidate = value && typeof value === "object" ? value : null;
    if (candidate && (typeof candidate.canvasOpen === "boolean" || typeof candidate.diagnosticsOpen === "boolean")) {
        return {
            canvasOpen: candidate.canvasOpen === true,
            diagnosticsOpen: candidate.diagnosticsOpen === true,
            // Zen: chat as a narrow rail, canvas as the workbench. Only
            // meaningful with the canvas open.
            zen: candidate.zen === true && candidate.canvasOpen === true,
        };
    }
    return {
        canvasOpen: legacyRightPaneMode === "canvas",
        diagnosticsOpen: false,
        zen: false,
    };
}

/**
 * The store key for one canvas surface. Slot 1 keeps the bare session id so
 * every reader written before slots existed keeps working untouched; slots
 * 2-5 append "#<slot>". Used for canvas.bySessionId AND canvas.prefs.
 */
export function canvasKey(sessionId, slot) {
    const id = String(sessionId || "");
    const n = Number(slot);
    return Number.isInteger(n) && n >= 2 && n <= 5 ? `${id}#${n}` : id;
}

/** The inverse: `sessionId#3` -> { sessionId, slot: 3 }; bare id -> slot 1. */
export function parseCanvasKey(key) {
    const m = /^(.*)#([2-5])$/.exec(String(key || ""));
    return m ? { sessionId: m[1], slot: Number(m[2]) } : { sessionId: String(key || ""), slot: 1 };
}

/**
 * Per-session canvas preferences: what this user has chosen and seen.
 *
 * `optedOut` — the user manually left canvas mode this session, so agent
 * draws badge instead of flipping. `lastViewedRev` — the highest revision
 * this user has had on screen; the yellow badge is latestRev > lastViewedRev.
 * Persisted (like pinned ids) so the overnight case lights the badge on
 * reopen with no extra query.
 */
export function normalizeStoredCanvasPrefs(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out = {};
    for (const [sessionId, entry] of Object.entries(value)) {
        const id = String(sessionId || "").trim();
        if (!id || !entry || typeof entry !== "object") continue;
        const lastViewedRev = Number(entry.lastViewedRev);
        const lastViewedDataRev = Number(entry.lastViewedDataRev);
        const zenRailPx = Number(entry.zenRailPx);
        out[id] = {
            optedOut: entry.optedOut === true,
            lastViewedRev: Number.isFinite(lastViewedRev) && lastViewedRev > 0 ? Math.floor(lastViewedRev) : 0,
            lastViewedDataRev: Number.isFinite(lastViewedDataRev) && lastViewedDataRev > 0 ? Math.floor(lastViewedDataRev) : 0,
            // Zen chat-rail width, remembered for THIS session only.
            ...(Number.isFinite(zenRailPx) && zenRailPx > 0 ? { zenRailPx: Math.floor(zenRailPx) } : {}),
        };
    }
    return out;
}

export function normalizeStoredActiveSessionId(value) {
    if (value == null) return null;
    const id = String(value).trim();
    return id ? id : null;
}

/**
 * Why a session is waiting on a budget. Four reasons, four remedies: a limit
 * needs raising, an allowance needs widening, a hold needs releasing, and a
 * missing provider needs creating (or the session switching model).
 */
export const BUDGET_PAUSE_KINDS = Object.freeze(["limit", "allowance", "hold", "no_provider"]);

/**
 * A session's `pauseState` record, or null when it is not paused.
 *
 * Lives here rather than in the selectors because the REDUCER stamps the
 * debounced row status from it and the selectors colour the row from it, and
 * the two must agree — see computeRawSessionVisualStatus.
 *
 * An unrecognized `kind` reads as no pause at all. A newer server that
 * invents a fifth reason must not make an older portal draw a mark it has no
 * words for.
 */
export function normalizeSessionPause(session) {
    const pause = session?.pauseState;
    if (!pause || typeof pause !== "object") return null;
    const kind = String(pause.kind || "");
    if (!BUDGET_PAUSE_KINDS.includes(kind)) return null;
    const text = (value) => {
        const trimmed = String(value ?? "").trim();
        return trimmed ? trimmed : null;
    };
    const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
    return {
        kind,
        provider: text(pause.provider),
        period: ["day", "week", "month"].includes(String(pause.period)) ? String(pause.period) : null,
        modelQualified: text(pause.modelQualified),
        limitTokens: num(pause.limitTokens),
        usedTokens: num(pause.usedTokens),
        ceilingTokens: num(pause.ceilingTokens),
        yourUsedTokens: num(pause.yourUsedTokens),
        // Null for a hold with no end, and for a provider that is simply
        // absent — both wait until a person does something.
        resetsAtUtc: text(pause.resetsAtUtc),
    };
}

/** The three period columns the provider table draws, left to right. */
export const BUDGET_PERIODS = Object.freeze(["day", "week", "month"]);

/** Supported usage-history windows; the daily quota line remains today's. */
export const BUDGET_SERIES_RANGES = Object.freeze([14, 30, 90]);
export const BUDGET_SERIES_DAYS = 14;

export function createInitialState({ mode = "local", branding = null, docs = null, themeId = null, sessionOwnerFilter = null, layoutAdjustments = null, pinnedSessionIds = null, collapsedSessionIds = null, activeSessionId = null, sessionOrder = null, rightPaneMode = null, desktopPanes: storedDesktopPanes = null, canvasPrefs = null } = {}) {
    const desktopPanes = normalizeStoredDesktopPanes(
        storedDesktopPanes,
        normalizeStoredRightPaneMode(rightPaneMode),
    );
    const hasStoredSessionOwnerFilter = sessionOwnerFilter != null;
    const hasStoredCollapsedSessionIds = collapsedSessionIds != null;
    const initialLayoutAdjustments = normalizeStoredLayoutAdjustments(layoutAdjustments);
    return {
        branding: branding || {
            title: "PilotSwarm",
            splash: "{bold}{cyan-fg}PilotSwarm{/cyan-fg}{/bold}",
        },
        // Deployment documentation links. A layered app (waldemort) ships its
        // own agent-authoring guide - the base instructions PLUS the skills,
        // tools and MCP servers that exist only on that fleet - so the portal
        // links to whatever that deployment configured, not a fixed URL.
        docs: {
            agentPackageGuideUrl: docs?.agentPackageGuideUrl
                || "https://github.com/affandar/PilotSwarm/blob/main/docs/building-agent-packages.md",
        },
        auth: {
            principal: null,
            authorization: null,
        },
        ui: {
            focusRegion: FOCUS_REGIONS.SESSIONS,
            // The Providers & Budgets surface (the coin button in the header).
            // It REPLACES the workspace under the header — the same slot the
            // admin console takes — so the two close each other. Never
            // persisted: it is a place you go, not a layout you keep.
            budgetOpen: false,
            inspectorTab: INSPECTOR_TABS[0],
            /** Node Map selection: short node label, scopes the Activity pane. */
            nodeMapSelectedNode: null,
            sequenceExpandedTurns: [],
            sequenceSelectedTurn: null,
            // "rich" was retired as a view mode; a persisted "rich" falls
            // through to the transcript.
            // Which face the right column wears: the inspector/activity panes
            // or the session canvas. Persisted.
            //
            // @deprecated Read by nothing that decides layout any more — the
            // two booleans below do that. Still derived so a build that rolls
            // back, and anything still reading the old key, sees a sane value.
            rightPaneMode: desktopPanes.canvasOpen ? "canvas" : "panes",
            // The two optional desktop columns, independent of each other.
            // Both off is the default workspace: sessions and chat only.
            canvasOpen: desktopPanes.canvasOpen,
            diagnosticsOpen: desktopPanes.diagnosticsOpen,
            // Chat-rail + canvas-workbench mode. Persisted with the columns.
            canvasZen: desktopPanes.zen,
            // Canvas filling the workspace. Deliberately NOT persisted: it is
            // a "look at this now" gesture, and returning to a portal with no
            // chat and no session list would read as a broken app.
            canvasMaximized: false,
            statsViewMode: "session",
            prompt: "",
            promptCursor: 0,
            promptRows: 1,
            promptAttachments: [],
            promptEdit: null,
            statusText: "Starting PilotSwarm...",
            // A persisted theme id may name a theme that no longer ships —
            // fall back to the default instead of crashing theme consumers.
            themeId: getTheme(themeId)?.id || DEFAULT_THEME_ID,
            // Touch-friendly scale: bumps type and control sizes one step. A phone in
            // portrait is not the only case — a wall display or a shared screen wants
            // the same thing — so it is a preference, not a viewport query.
            touchScale: false,
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
            // Per-session chat scroll memory (rows from bottom), restored on
            // sessions/selected and evicted with the session's history.
            chatScrollBySession: {},
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
            // Folders live in their OWN slice: a session-list refresh rebuilds
            // byId from its payload, so anything that only exists there gets
            // deleted whenever the payload lacks it. Groups are re-seeded from
            // here on every rebuild and only change when the group fetch says so.
            groupRows: [],
            flat: [],
            activeSessionId: normalizeStoredActiveSessionId(activeSessionId),
            collapsedIds: normalizeStoredCollapsedSessionIds(collapsedSessionIds),
            collapsedIdsExplicit: hasStoredCollapsedSessionIds,
            pinnedIds: normalizeStoredPinnedSessionIds(pinnedSessionIds),
            // Explicit user placement (desktop drag); read by every surface.
            manualOrder: normalizeStoredSessionOrder(sessionOrder),
            // Whether a listing of each kind has been processed. "This row is
            // new" is only answerable against a previous listing OF THE SAME
            // KIND — inferring it from byId being non-empty was wrong, because
            // a groups listing populates byId without saying anything about
            // which sessions existed.
            listingSeen: false,
            groupsListingSeen: false,
            selectedIds: [],
            selectMode: false,
            // Clicking empty space in the list clears the LIST highlight while
            // the chat/inspector panes keep showing the session.
            listDeselected: false,
            orderById: {},
            nextOrderOrdinal: 0,
            filterQuery: "",
            ownerFilterExplicit: hasStoredSessionOwnerFilter,
            ownerFilter: normalizeSessionOwnerFilter(sessionOwnerFilter),
            navigationIntent: null,
            filterExceptionId: null,
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
            // Bulk selection. Deliberately separate from selectedArtifactId:
            // marking rows must not move the preview, which keeps showing the
            // originally selected artifact.
            markedIds: [],
            // How the preview was opened. "chat" must back out to the chat
            // pane and leave the artifact list exactly as it was; "list" backs
            // out to the list. One back button cannot serve both without this.
            previewOrigin: null,
            // Selection to restore when leaving a chat-opened preview, so
            // following a chat link never disturbs the list.
            restoreArtifactId: null,
            // The portal's artifact takeover pane: a full-height reader that
            // replaces the inspector AND activity panes in the right column.
            // Opened by chat artifact cards and artifact deep links; the Files
            // list keeps its own stacked list-above-preview view, because
            // taking over the column would hide the list being browsed.
            //
            // The TUI ignores this entirely — it has no such pane.
            paneOpen: false,
            // What the right column looked like BEFORE the pane opened, so ✕
            // can put it back. When the user had already resized the column
            // out of existence, closing must return to that — not conjure an
            // inspector they had deliberately dismissed.
            paneRestoresToHidden: false,
            // Rendered page vs. HTML source. Lifted out of the preview
            // component so the reader pane's single header can own the toggle
            // — the alternative was a second header row stacked under the
            // first, which is exactly the box-in-a-box the pane exists to undo.
            htmlViewMode: "rendered",
            // Zoom for the rendered HTML frame ONLY. Browser zoom scales the
            // whole workspace — the session list and transcript included —
            // when all you wanted was to read a dense chart. This scales the
            // artifact and nothing else.
            htmlZoom: 1,
            // Fit-to-width for the rendered HTML frame. Lifted here for the
            // same reason htmlViewMode is: on mobile the panel is chromeless
            // and the artifact bar owns the controls, so the two surfaces have
            // to read one value.
            htmlFitWidth: false,
            filter: {
                scope: "selectedSession",
                query: "",
            },
        },
        canvas: {
            // Runtime knowledge of each session's canvas, fed by the
            // selection-burst snapshot and then by canvas_updated events.
            // { latestRev, note, sizeBytes, snapshotLoaded } per session.
            bySessionId: {},
            // Persisted per-user attention state — see normalizeStoredCanvasPrefs.
            prefs: normalizeStoredCanvasPrefs(canvasPrefs),
            // Ticks on every agent-driven flip. Hosts whose pane state lives
            // outside ui.rightPaneMode (the phone's tab strip) watch this to
            // bring their canvas surface forward.
            flipSeq: 0,
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
        // Providers & Budgets — one table, and what it needs to draw itself.
        // The table's numbers come from ONE read (getProviderUsageGrid); the
        // paused list is a second read, kept because a stopped session says
        // why on the session row too, not only on this screen. See
        // docs/proposals/providers-and-budgets-meters.md.
        budget: {
            // A first load, with nothing on screen yet.
            loading: false,
            // A re-read WITH numbers already on screen. Separate from
            // `loading` so a refresh does not blank the table someone is
            // reading mid-sentence.
            refreshing: false,
            // Set by a successful load and never cleared by a failure.
            // Without it an empty `grid` is ambiguous: "this namespace has no
            // providers" and "we never found out" would look the same, and
            // only one of them is safe to act on.
            loaded: false,
            // The message the SERVER wrote. It is written for a person and
            // names the remedy, so it is passed through, never replaced.
            error: null,
            fetchedAt: 0,
            // getProviderUsageGrid, verbatim and in render order: shared
            // providers first, then the viewer's own, each immediately
            // followed by its model rows. Never re-sorted.
            grid: [],
            // The "show overall usage" tick. Off = your usage against your
            // share; on = everyone's usage against the limit. The two pairs
            // of numbers are never mixed, so which one is on screen is a
            // fact the table has to carry.
            overall: false,
            // Usage history window for both user and system reports.
            rangeDays: BUDGET_SERIES_DAYS,
            // The provider whose model rows are expanded and whose chart is
            // drawn. Null means nothing is selected — this screen shows no
            // provider until one is picked.
            selectedProvider: null,
            // Which row under that provider: '*' is the provider itself, and
            // a qualified model reference is one of its per-model limits. The
            // chart follows this, so standing on a model row shows that
            // model's days alone.
            selectedScope: "*",
            // A name that was asked for and is not in the table. Set when a
            // load drops the selection, because that is the case where
            // somebody arrived here BY that name — from a session stopped on
            // a provider that no longer exists — and clearing the selection
            // silently would leave them with nothing to read and nothing to do.
            missingProvider: null,
            // The selected provider's day-by-day usage, read separately so a
            // failed chart never blanks the table above it.
            series: {
                provider: null,
                scope: "*",
                rangeDays: BUDGET_SERIES_DAYS,
                days: [],
                loading: false,
                loaded: false,
                error: null,
                fetchedAt: 0,
            },
            // Admin-only machinery spend for the selected provider. Kept
            // separate from `series`: system turns are metered but exempt
            // from user limits, so they must never borrow the quota line.
            systemUsage: {
                provider: null,
                scope: "*",
                rangeDays: BUDGET_SERIES_DAYS,
                totals: null,
                days: [],
                breakdown: [],
                loading: false,
                loaded: false,
                error: null,
                fetchedAt: 0,
            },
            /** listPausedSessions: sessions waiting, each with its reason. */
            paused: [],
            // That list's OWN failure. Separate from `error`, which is the
            // table's: one flag for both meant a failed waiting-list read
            // marked freshly-read numbers as stale, and left the actually
            // stale waiting line unmarked.
            pausedError: null,
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
                // Admin-only target switch: when true, Set/Replace/Clear
                // act on the SYSTEM user's key (used by ownerless system
                // sessions) instead of the caller's own key.
                storeAsSystem: false,
            },
            // Status of the SYSTEM user's Copilot key (admins only; never
            // the key itself). `supported` flips on the first successful
            // status load so non-admin/legacy transports hide the toggle.
            systemGhcpKey: {
                supported: false,
                loading: false,
                configured: false,
                changedBy: null,
                changedAt: null,
                error: null,
            },
            modelProviders: {
                loading: false,
                error: null,
                page: "mine",
                providers: [],
                models: [],
                defaults: null,
                fetchedAt: 0,
                mutation: { pending: null, error: null },
                selection: { focus: "providers", providerName: null, agentId: null },
                create: {
                    editing: false,
                    stage: "name",
                    name: "",
                    typeId: "",
                    shared: false,
                    draft: "",
                    cursorIndex: 0,
                    saving: false,
                    error: null,
                },
            },
            // Which settings-tree node is active. The provider/default page
            // replaces the legacy GitHub-key editor in new UI; the legacy
            // state remains available for rollback compatibility only.
            section: "providers",
            // Agent packages (docs/proposals/agent-packages.md) — registry
            // list, selected package detail, and the workspace viewer.
            packages: {
                loading: false,
                error: null,
                list: [],
                workerState: [],
                fetchedAt: 0,
                selectedName: null,
                detail: null,
                detailLoading: false,
                detailError: null,
                /** Raw CHANGELOG.md of the selected package, or null when it has none. */
                changelog: null,
                workspace: {
                    tree: null,
                    treeLoading: false,
                    treeError: null,
                    expandedDirs: [],
                    selectedPath: null,
                    file: null,
                    fileLoading: false,
                    fileError: null,
                },
                action: { pending: null, error: null },
                addDialog: {
                    open: false,
                    kind: "repo",
                    scope: "user",
                    // Set => the dialog is updating THIS package rather than
                    // adding one: same fields, same import, but the publish is
                    // refused unless the manifest names the same package.
                    updateName: null,
                    repoUrl: "",
                    ref: "",
                    path: "",
                    url: "",
                    authToken: "",
                    submitting: false,
                    progress: null,
                    error: null,
                },
            },
            workers: {
                loading: false,
                error: null,
                list: [],
                fetchedAt: 0,
                // Refresh-attempt telemetry (surfaced in the Node Map): tells
                // "never called" apart from "called and failed".
                attempts: 0,
                lastAttemptAt: 0,
                lastSkip: null,
            },
        },
    };
}
