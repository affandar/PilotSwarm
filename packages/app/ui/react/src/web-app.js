import React from "react";
// createPortal is only invoked when an IconButton tooltip renders (portal only,
// never in the TUI); the import itself is side-effect-free and react-dom is a
// dependency wherever this file loads, so it is safe in the shared module.
import { createPortal } from "react-dom";
import { appendAnimatedDotsToRuns, useAnimatedDots, useSpinnerFrame } from "./chat-status.js";
import {
    UI_COMMANDS,
    INSPECTOR_TABS,
    appReducer,
    canStopSessionTurn,
    computeLegacyLayout,
    createInitialState,
    createStore,
    AUTO_HISTORY_EVENT_SOFT_CAP,
    formatCompactNumber,
    formatCronTimestampForClient,
    formatHumanDurationSeconds,
    getPromptInputRows,
    getTheme,
    isThemeLight,
    parseTerminalMarkupRuns,
    PilotSwarmUiController,
    tokenizeInlineMarkdown,
    selectActivityPane,
    selectWorkerDetailsPane,
    selectAdminConsole,
    selectArtifactPickerModal,
    selectArtifactUploadModal,
    selectLiveActivityLines,
    selectChatBlocks,
    selectChatLines,
    selectChatPaneChrome,
    selectOutboxOverlayLines,
    selectFileBrowserItems,
    selectFilesFilterModal,
    selectFilesScope,
    selectFilesView,
    selectHistoryFormatModal,
    selectInspector,
    selectLogFilterModal,
    selectModelPickerModal,
    selectNavigationError,
    selectReasoningEffortPickerModal,
    selectContextTierPickerModal,
    selectRenameSessionModal,
    selectSessionAgentPickerModal,
    selectSessionGroupNameModal,
    selectSessionGroupPickerModal,
    selectSessionOwnerFilterModal,
    selectSessionRows,
    selectStatusBar,
    selectThemePickerModal,
    selectConfirmModal,
    defaultOwnerFilterForPrincipal,
    normalizeStoredLayoutAdjustments,
    normalizeStoredPinnedSessionIds,
    normalizeStoredSessionOrder,
} from "pilotswarm/ui-core";
import { useControllerSelector } from "./use-controller-state.js";

const MOBILE_BREAKPOINT = 920;
const GRID_CELL_WIDTH = 7;
const GRID_CELL_HEIGHT = 19;
const PORTAL_SESSION_COLUMN_RATIO = 0.24;
const PORTAL_SESSION_CHAT_DIVIDER_PX = 16;
const PORTAL_WORKSPACE_GAP_PX = 8;
const PORTAL_MIN_CHAT_COLUMN_PX = 224;
const PORTAL_SESSION_COMPACT_COLUMN_PX = 190;
const PORTAL_SESSION_HIDDEN_COLUMN_PX = 48;
const SCROLL_ROW_HEIGHT = 16;
const SCROLL_BOTTOM_EPSILON_PX = 0.5;
const PROGRAMMATIC_SCROLL_TOLERANCE_PX = SCROLL_BOTTOM_EPSILON_PX;
// Minimum downward finger travel (px) while at the top of the chat pane before
// a touch pull counts as a load-older-history request.
const TOUCH_TOP_PULL_THRESHOLD_PX = 24;
// How long after the last user-driven scroll event the pane still counts as
// momentum-scrolling (native flick glide), during which programmatic scrollTop
// restores are suppressed so they don't kill the glide.
const TOUCH_MOMENTUM_GRACE_MS = 700;
const PROFILE_SETTINGS_POLL_MS = 5000;
const REASONING_EFFORT_LABELS = new Set(["low", "medium", "high", "xhigh"]);
const LEGACY_BROWSER_PREFERENCE_STORAGE_KEYS = [
    "pilotswarm.theme",
    "pilotswarm.sessionOwnerFilter",
    "pilotswarm.chatFocus",
    "pilotswarm.layoutAdjustments",
    "pilotswarm.pinnedSessions",
];
const LEGACY_BROWSER_PREFERENCE_COOKIE_NAMES = [
    "pilotswarm_theme",
    "pilotswarm_session_owner_filter",
];
const INSPECTOR_TAB_LABELS = {
    sequence: "Sequence",
    logs: "Logs",
    nodes: "Node Map",
    history: "Duroxide Event History",
    files: "Files",
    stats: "Stats",
};
// Glyphs for the icon-only Inspector tab row (labels move into hover/long-press
// tooltips via IconButton, matching the session toolbar treatment).
// COMPONENTS, not codepoints: the text glyphs this row used to carry rendered a
// stroke-weight lighter than the SVG session-toolbar icons, fell back per
// platform, and duplicated each other ("≣" was both Logs and the header Summary
// button). Function declarations hoist, so referencing them up here is fine.
const INSPECTOR_TAB_ICONS = {
    sequence: SequenceGlyph,
    logs: LogsGlyph,
    nodes: NodeMapGlyph,
    history: DuroxideGlyph,
    files: FilesGlyph,
    stats: StatsGlyph,
};

function cycleTabs(tabs, current, delta) {
    const values = Array.isArray(tabs) ? tabs.filter(Boolean) : [];
    if (values.length === 0) return current;
    const index = values.indexOf(current);
    const safeIndex = index === -1 ? 0 : index;
    const nextIndex = (safeIndex + delta + values.length) % values.length;
    return values[nextIndex];
}

function supportsBrowserFileUploads(controller) {
    return typeof controller?.transport?.uploadArtifactFromFile === "function";
}

function supportsPathArtifactUploads(controller) {
    return typeof controller?.transport?.uploadArtifactFromPath === "function";
}

function supportsArtifactBrowser(controller) {
    return typeof controller?.transport?.listArtifacts === "function";
}

function supportsArtifactDelete(controller) {
    return typeof controller?.transport?.deleteArtifact === "function";
}

function supportsLocalFileOpen(controller) {
    return typeof controller?.transport?.openPathInDefaultApp === "function";
}

const SESSION_LINK_COPIED_STATUS = "Session link copied to clipboard";
// Mirrors SESSION_NAV_SETTLE_MS in the controller: the access probe rides the
// same "wait for the selection to stop moving" rule as the session fetch.
const SESSION_ACCESS_SETTLE_MS = 140;
const SESSION_LINK_PRIVATE_WARNING = "Only people with access can open this link.";

function buildSessionLinkUrl(sessionId) {
    if (!sessionId || typeof window === "undefined" || !window.location) return null;
    return `${window.location.origin}${window.location.pathname}?session=${encodeURIComponent(sessionId)}`;
}

function copySessionLinkText(url) {
    if (navigator?.clipboard?.writeText) navigator.clipboard.writeText(url).catch(() => {});
}

// Best-effort probe: is this session's deep link openable only by the owner/
// admins right now (private, with no targeted grants)? Used to warn in the
// copy-link dialog. Failure resolves false (no warning).
async function resolveSessionLinkWarn(controller, sessionId) {
    try {
        const transport = controller.transport;
        if (typeof transport?.getSessionAccess === "function") {
            const access = await transport.getSessionAccess(sessionId);
            if ((access?.visibility || "private") === "private") {
                const shares = typeof transport.listSessionShares === "function"
                    ? await transport.listSessionShares(sessionId).catch(() => [])
                    : [];
                return !Array.isArray(shares) || shares.length === 0;
            }
        }
    } catch {
        // Fall through to no warning.
    }
    return false;
}

function clearBrowserPreferenceCache() {
    if (typeof window === "undefined") return;
    try {
        for (const key of LEGACY_BROWSER_PREFERENCE_STORAGE_KEYS) {
            window.localStorage.removeItem(key);
        }
    } catch {}
    try {
        for (const name of LEGACY_BROWSER_PREFERENCE_COOKIE_NAMES) {
            document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
        }
    } catch {}
}

function normalizeProfileSettings(settings) {
    const candidate = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
    const normalized = {};
    if (typeof candidate.themeId === "string" && candidate.themeId.trim()) {
        normalized.themeId = candidate.themeId.trim();
    }
    if (hasOwn(candidate, "sessionOwnerFilter") && candidate.sessionOwnerFilter && typeof candidate.sessionOwnerFilter === "object") {
        const storedFilter = candidate.sessionOwnerFilter;
        // Profiles saved before the "Shared with me" bucket existed have no
        // includeShared key; default it on so shared sessions stay visible for
        // existing users. An explicit false (the user turned it off) is kept.
        normalized.sessionOwnerFilter = hasOwn(storedFilter, "includeShared")
            ? storedFilter
            : { ...storedFilter, includeShared: true };
    }
    if (hasOwn(candidate, "layoutAdjustments")) {
        normalized.layoutAdjustments = normalizeStoredLayoutAdjustments(candidate.layoutAdjustments);
    }
    if (hasOwn(candidate, "pinnedSessionIds")) {
        normalized.pinnedSessionIds = normalizeStoredPinnedSessionIds(candidate.pinnedSessionIds);
    }
    if (hasOwn(candidate, "sessionOrder")) {
        normalized.sessionOrder = normalizeStoredSessionOrder(candidate.sessionOrder);
    }
    if (hasOwn(candidate, "collapsedSessionIds")) {
        normalized.collapsedSessionIds = normalizeStoredCollapsedSessionIdsToArray(candidate.collapsedSessionIds);
    }
    if (hasOwn(candidate, "activeSessionId")) {
        const id = candidate.activeSessionId == null ? null : String(candidate.activeSessionId).trim();
        normalized.activeSessionId = id || null;
    }
    if (isChatViewMode(candidate.chatViewMode)) {
        normalized.chatViewMode = candidate.chatViewMode;
    }
    // Phones and desktops keep SEPARATE view preferences: rich prose reads well
    // on a wide transcript and poorly in a 390px column, so a single shared
    // value would have each device overwriting the other's choice.
    if (isChatViewMode(candidate.chatViewModeMobile)) {
        normalized.chatViewModeMobile = candidate.chatViewModeMobile;
    }
    return normalized;
}

function isChatViewMode(value) {
    return value === "summary" || value === "transcript" || value === "rich";
}

/** True on phone-sized viewports — the device class that owns the mobile slot. */
function isNarrowViewport() {
    return typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia("(max-width: 920px)").matches;
}

/** Profile key this device reads and writes. */
function chatViewModeKey() {
    return isNarrowViewport() ? "chatViewModeMobile" : "chatViewMode";
}

/** The key belonging to the OTHER device class. */
function otherChatViewModeKey() {
    return isNarrowViewport() ? "chatViewMode" : "chatViewModeMobile";
}

function normalizeStoredCollapsedSessionIdsToArray(value) {
    if (value instanceof Set) {
        const out = [];
        for (const entry of value) {
            const id = String(entry || "").trim();
            if (id) out.push(id);
        }
        out.sort();
        return out;
    }
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const entry of value) {
        const id = String(entry || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    out.sort();
    return out;
}

function hasOwn(value, key) {
    return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function profileSettingsFromViewState(state, preservedOtherChatViewMode = null) {
    return normalizeProfileSettings({
        themeId: state.themeId,
        sessionOwnerFilter: state.ownerFilter,
        layoutAdjustments: {
            paneAdjust: state.paneAdjust,
            sessionPaneAdjust: state.sessionPaneAdjust,
            portalSessionColumnAdjust: state.portalSessionColumnAdjust,
            activityPaneAdjust: state.activityPaneAdjust,
        },
        pinnedSessionIds: state.pinnedIds,
        sessionOrder: state.manualOrder,
        collapsedSessionIds: state.collapsedSessionIds,
        activeSessionId: state.activeSessionId,
        [chatViewModeKey()]: state.chatViewMode,
        // setCurrentUserProfileSettings REPLACES the settings object, so the
        // other device class's slot has to be written back verbatim or saving
        // from a desktop would wipe the phone's preference (and vice versa).
        ...(isChatViewMode(preservedOtherChatViewMode)
            ? { [otherChatViewModeKey()]: preservedOtherChatViewMode }
            : {}),
    });
}

function buildDefaultProfileSettingsFromState(state, preservedOtherChatViewMode = null) {
    return normalizeProfileSettings({
        themeId: state?.ui?.themeId,
        // Derive the owner-filter default from the RESOLVED principal, never a
        // snapshot of state.sessions.ownerFilter — at mount that snapshot is
        // still {all:true} (principal not yet applied), and using it as the
        // "no persisted filter" fallback would drift an authenticated user's
        // saved filter to All (or, mid-resolve, hide their own sessions). This
        // guarantees the fallback is always Me+System for a signed-in user.
        sessionOwnerFilter: defaultOwnerFilterForPrincipal(state?.auth?.principal ?? null),
        layoutAdjustments: state?.ui?.layout,
        pinnedSessionIds: state?.sessions?.pinnedIds,
        sessionOrder: state?.sessions?.manualOrder,
        collapsedSessionIds: state?.sessions?.collapsedIds,
        activeSessionId: state?.sessions?.activeSessionId,
        [chatViewModeKey()]: state?.ui?.chatViewMode,
        ...(isChatViewMode(preservedOtherChatViewMode)
            ? { [otherChatViewModeKey()]: preservedOtherChatViewMode }
            : {}),
    });
}

function materializeProfileSettings(remoteSettings, defaults) {
    const normalizedRemote = normalizeProfileSettings(remoteSettings);
    const normalizedDefaults = normalizeProfileSettings(defaults);
    // For chatViewMode specifically, do NOT fall back to defaults when the
    // remote profile lacks the field. The poll runs every few seconds; if
    // we synthesized a default here, every poll where the server hasn't
    // yet persisted the user's toggle would clobber the local choice and
    // snap the chat pane back from Summary to Chat. Leaving chatViewMode
    // off the materialized settings causes the `profileSettings/apply`
    // reducer's `hasChatViewMode` guard to preserve the current value.
    return normalizeProfileSettings({
        themeId: hasOwn(normalizedRemote, "themeId")
            ? normalizedRemote.themeId
            : normalizedDefaults.themeId,
        sessionOwnerFilter: hasOwn(normalizedRemote, "sessionOwnerFilter")
            ? normalizedRemote.sessionOwnerFilter
            : normalizedDefaults.sessionOwnerFilter,
        layoutAdjustments: hasOwn(normalizedRemote, "layoutAdjustments")
            ? normalizedRemote.layoutAdjustments
            : normalizedDefaults.layoutAdjustments,
        pinnedSessionIds: hasOwn(normalizedRemote, "pinnedSessionIds")
            ? normalizedRemote.pinnedSessionIds
            : normalizedDefaults.pinnedSessionIds,
        // This merge rebuilds the settings object key by key, so a key omitted
        // here is DROPPED at startup — and the save effect then writes the
        // empty value straight back over the stored one. Leaving sessionOrder
        // out made every placement survive exactly until the next reload.
        sessionOrder: hasOwn(normalizedRemote, "sessionOrder")
            ? normalizedRemote.sessionOrder
            : normalizedDefaults.sessionOrder,
        ...(hasOwn(normalizedRemote, "collapsedSessionIds")
            ? { collapsedSessionIds: normalizedRemote.collapsedSessionIds }
            : {}),
        ...(hasOwn(normalizedRemote, "activeSessionId")
            ? { activeSessionId: normalizedRemote.activeSessionId }
            : {}),
        // Apply only the slot this device owns. The other is preserved by the
        // save path (see profileSettingsFromViewState), not applied here — it
        // describes a screen size we are not on.
        ...(hasOwn(normalizedRemote, chatViewModeKey())
            ? { chatViewMode: normalizedRemote[chatViewModeKey()] }
            : {}),
    });
}

async function saveProfileSettings(controller, settings) {
    if (typeof controller?.transport?.setCurrentUserProfileSettings !== "function") return null;
    return controller.transport.setCurrentUserProfileSettings({
        settings: normalizeProfileSettings(settings),
    });
}

function getVisibleInspectorTabs(controller) {
    return supportsArtifactBrowser(controller)
        ? INSPECTOR_TABS
        : INSPECTOR_TABS.filter((tab) => tab !== "files");
}

function shallowEqualObject(left, right) {
    if (Object.is(left, right)) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
        if (!Object.is(left[key], right[key])) return false;
    }
    return true;
}

function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function portalSessionColumnBounds(width) {
    const safeWidth = Math.max(0, Number(width) || 0);
    const availableWidth = Math.max(
        0,
        safeWidth - PORTAL_SESSION_CHAT_DIVIDER_PX - (PORTAL_WORKSPACE_GAP_PX * 2),
    );
    const baseWidth = availableWidth * PORTAL_SESSION_COLUMN_RATIO;
    const maxSessionWidth = Math.max(0, availableWidth - PORTAL_MIN_CHAT_COLUMN_PX);
    return {
        minAdjust: -baseWidth,
        maxAdjust: maxSessionWidth - baseWidth,
    };
}

function portalSessionColumnWidth(width, adjust) {
    const bounds = portalSessionColumnBounds(width);
    const safeWidth = Math.max(0, Number(width) || 0);
    const availableWidth = Math.max(
        0,
        safeWidth - PORTAL_SESSION_CHAT_DIVIDER_PX - (PORTAL_WORKSPACE_GAP_PX * 2),
    );
    const baseWidth = availableWidth * PORTAL_SESSION_COLUMN_RATIO;
    return clampNumber(baseWidth + (Number(adjust) || 0), 0, baseWidth + bounds.maxAdjust);
}

function portalSessionColumnMode(width) {
    if (width <= PORTAL_SESSION_HIDDEN_COLUMN_PX) return "hidden";
    if (width <= PORTAL_SESSION_COMPACT_COLUMN_PX) return "compact";
    return "wrap";
}

function getStatePromptRows(state) {
    const promptRows = Number(state?.ui?.promptRows);
    return Number.isFinite(promptRows) && promptRows > 0
        ? promptRows
        : getPromptInputRows(state?.ui?.prompt || "");
}

function computeStateLayout(state) {
    return computeLegacyLayout({
        width: state.ui.layout?.viewportWidth ?? 120,
        height: state.ui.layout?.viewportHeight ?? 40,
    }, state.ui.layout?.paneAdjust ?? 0, getStatePromptRows(state), state.ui.layout?.sessionPaneAdjust ?? 0);
}

function getPortalInspectorContentWidth(paneWidth, inspectorTab) {
    // The sequence view once reserved 3 extra columns here so that "content
    // that fits visually does not trip a cosmetic x-scrollbar". That was a
    // fudge for a real bug: every sequence line was padded to the full width,
    // including the final column whose trailing spaces align nothing, so with
    // white-space:pre the content box always measured exactly the pane width
    // and any rounding tipped it into a permanent scrollbar. The padding is now
    // trimmed at the source (see trimTrailingRunPad in ui-core selectors), so
    // the guard would only throw away 3 usable columns.
    return Math.max(20, paneWidth - 4);
}

function normalizeLines(lines) {
    const normalized = [];

    const decodeEscapedNewlines = (value) => {
        const text = String(value || "");
        if (!text.includes("\\n") || text.includes("\n")) return text;
        return text.replace(/\\n/g, "\n");
    };

    for (const line of lines || []) {
        if (line?.kind === "markup") {
            // Markup lines carry preformatted art (splash screens). Tag them
            // so the chat renderer keeps each line intact: the pane's
            // pre-wrap/overflow-wrap rules would rewrap wide art lines at
            // arbitrary points and scramble the image. When a splashAlt is
            // present, emit BOTH variants tagged by name — CSS shows exactly
            // one based on the real device viewport, which beats character
            // metrics at deciding what actually fits.
            const variants = line.splashAlt
                ? [{ text: line.value, variant: "desktop" }, { text: line.splashAlt, variant: "mobile" }]
                : [{ text: line.value, variant: null }];
            for (const v of variants) {
                for (const parsedLine of parseTerminalMarkupRuns(v.text || "")) {
                    normalized.push({ kind: "runs", runs: parsedLine, preserve: true, splashVariant: v.variant });
                }
            }
            continue;
        }
        // Sentinel kinds preserved as-is so parseStructuredChatBlocks can
        // recognize and render them (e.g. markdownTable → HTML <table>,
        // cardStart/cardEnd → styled card with structured body,
        // imageAttachments → authenticated thumbnail strip).
        if (line?.kind === "markdownTable" || line?.kind === "cardStart" || line?.kind === "cardEnd" || line?.kind === "imageAttachments") {
            normalized.push(line);
            continue;
        }
        if (line?.kind === "runs") {
            const runs = Array.isArray(line.runs) ? line.runs : [];
            if (runs.length === 1) {
                const onlyRun = runs[0] || {};
                const decodedText = decodeEscapedNewlines(onlyRun.text || "");
                if (decodedText.includes("\n")) {
                    const fragments = decodedText.split("\n");
                    for (const fragment of fragments) {
                        normalized.push({
                            kind: "runs",
                            runs: [{ ...onlyRun, text: fragment }],
                        });
                    }
                    continue;
                }
                normalized.push({ kind: "runs", runs: [{ ...onlyRun, text: decodedText }] });
                continue;
            }
            normalized.push({
                kind: "runs",
                runs: runs.map((run) => ({
                    ...run,
                    text: decodeEscapedNewlines(run?.text || ""),
                })),
            });
            continue;
        }
        if (Array.isArray(line)) {
            normalized.push({ kind: "runs", runs: line });
            continue;
        }
        if (line && typeof line === "object" && typeof line.text === "string") {
            const decodedText = decodeEscapedNewlines(line.text);
            if (decodedText.includes("\n")) {
                const fragments = decodedText.split("\n");
                for (const fragment of fragments) {
                    normalized.push({ kind: "text", ...line, text: fragment });
                }
                continue;
            }
            normalized.push({ kind: "text", ...line, text: decodedText });
            continue;
        }
        normalized.push({ kind: "text", ...line });
    }
    return normalized;
}

function resolveColor(theme, token) {
    if (!token) return undefined;
    return theme?.tui?.[token] || theme?.terminal?.[token] || theme?.page?.[token] || token;
}

function runsToText(runs = []) {
    return runs.map((run) => String(run?.text || "")).join("");
}

function flattenTitleText(title) {
    if (Array.isArray(title)) return runsToText(title);
    return String(title || "");
}

function compactTitleRuns(title, maxWidth = 40) {
    if (!Array.isArray(title)) {
        const text = String(title || "");
        return [{ text: text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text, color: "white", bold: true }];
    }
    const compactRuns = [];
    // Gray runs are dropped on tight widths as decoration (ids, badges) —
    // EXCEPT pure separators (" · "). Dropping those fuses adjacent values:
    // "running · gpt-5.4 · ctx 33%" became "runninggpt-5.4ctx…".
    const isSeparator = (run) => /^[\s·—-]+$/.test(String(run?.text || ""));
    let remaining = Math.max(8, maxWidth);
    for (const run of title) {
        if (remaining <= 0) break;
        const color = run?.color;
        if (color === "gray" && compactRuns.length > 0 && !isSeparator(run)) continue;
        const text = String(run?.text || "");
        if (!text) continue;
        // Don't start a separator we can't follow with content.
        if (isSeparator(run) && remaining < text.length + 2) break;
        const chunk = text.length > remaining && remaining > 1
            ? `${text.slice(0, remaining - 1)}…`
            : text.slice(0, remaining);
        if (!chunk) continue;
        compactRuns.push({ ...run, text: chunk });
        remaining -= chunk.length;
    }
    // Never end on a dangling separator.
    while (compactRuns.length > 0 && isSeparator(compactRuns[compactRuns.length - 1])) {
        compactRuns.pop();
    }
    return compactRuns.length > 0 ? compactRuns : title;
}

function applyDocumentTheme(themeId) {
    const theme = getTheme(themeId);
    if (!theme || typeof document === "undefined") return;
    const root = document.documentElement;
    root.style.setProperty("--ps-page-background", theme.page.background);
    root.style.setProperty("--ps-page-foreground", theme.page.foreground);
    root.style.setProperty("--ps-surface", theme.tui.surface);
    root.style.setProperty("--ps-background", theme.tui.background);
    root.style.setProperty("--ps-foreground", theme.tui.foreground);
    root.style.setProperty("--ps-muted", theme.tui.gray);
    root.style.setProperty("--ps-border", theme.tui.border || theme.tui.gray);
    root.style.setProperty("--ps-selection-background", theme.tui.selectionBackground);
    root.style.setProperty("--ps-selection-foreground", theme.tui.selectionForeground);
    root.style.setProperty("--ps-highlight-background", theme.tui.activeHighlightBackground);
    root.style.setProperty("--ps-highlight-foreground", theme.tui.activeHighlightForeground);
    root.style.setProperty("--ps-modal-backdrop", theme.page.modalBackdrop);
    root.style.setProperty("--ps-modal-background", theme.page.modalBackground);
    root.style.setProperty("--ps-modal-border", theme.page.modalBorder);
    root.style.setProperty("--ps-modal-foreground", theme.page.modalForeground);
    root.style.setProperty("--ps-modal-muted", theme.page.modalMuted);
    root.style.setProperty("--ps-modal-selected-background", theme.page.modalSelectedBackground);
    root.style.setProperty("--ps-modal-selected-border", theme.page.modalSelectedBorder);
    root.style.setProperty("--ps-modal-selected-foreground", theme.page.modalSelectedForeground);
    // Semantic status colours, from the SAME palette the terminal rows read
    // through resolveColor(). The stylesheet already referenced these names in
    // a dozen rules; nothing published them, so those rules either fell back to
    // a hardcoded GitHub hex in every theme or were invalid and did nothing.
    root.style.setProperty("--ps-accent", theme.tui.cyan);
    root.style.setProperty("--ps-success", theme.tui.green);
    root.style.setProperty("--ps-warning", theme.tui.yellow);
    root.style.setProperty("--ps-danger", theme.tui.red);
    // Expose the theme id so a theme can carry CHROME, not just colours. Win95
    // is defined by its bevels — raised faces, inset wells, square corners —
    // and none of that is expressible as a palette entry.
    root.dataset.psTheme = theme.id;
}

function useMeasuredViewport(ref) {
    const [viewport, setViewport] = React.useState({ width: 0, height: 0 });

    React.useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return undefined;

        const update = () => {
            setViewport({
                width: element.clientWidth,
                height: element.clientHeight,
            });
        };

        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        window.addEventListener("resize", update);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", update);
        };
    }, [ref]);

    return viewport;
}

function computeGridViewport(viewport) {
    const width = Math.max(320, viewport.width || window.innerWidth || 1280);
    const height = Math.max(320, viewport.height || window.innerHeight || 800);
    return {
        width: Math.max(40, Math.floor(width / GRID_CELL_WIDTH)),
        height: Math.max(18, Math.floor(height / GRID_CELL_HEIGHT)),
    };
}

export function getScrollDistanceToBottom(node) {
    if (!node) return 0;
    const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
    return Math.max(0, maxScroll - node.scrollTop);
}

export function isScrollViewportAtBottom(node) {
    return getScrollDistanceToBottom(node) <= SCROLL_BOTTOM_EPSILON_PX;
}

export function computeAnchoredScrollTop(
    node,
    scrollOffset,
    scrollMode,
    preservePausedStickyScroll = false,
) {
    if (!node) return 0;
    const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
    if (preservePausedStickyScroll) {
        return Math.max(0, Math.min(node.scrollTop, maxScroll));
    }
    const offsetPixels = Math.max(0, Number(scrollOffset) || 0) * SCROLL_ROW_HEIGHT;
    return scrollMode === "bottom"
        ? Math.max(0, maxScroll - offsetPixels)
        : Math.min(maxScroll, offsetPixels);
}

function useScrollSync(ref, lines, scrollOffset, scrollMode, paneKey, controller, { stickyBottom = false } = {}) {
    const normalizedLines = React.useMemo(() => normalizeLines(lines), [lines]);
    // Programmatic scrollTop assignments fire a 'scroll' event that would
    // otherwise call onScroll → dispatch ui/scroll → clobber the user's
    // offset (especially when content briefly shrinks during a refresh
    // and clamps nextScrollTop downward). The flag tells onScroll to
    // ignore the matching scroll event after we set scrollTop ourselves.
    const programmaticScrollRef = React.useRef(null);
    const previousViewportStateRef = React.useRef({
        scrollMode,
        scrollOffset,
    });
    // Touch scrolling relies on native momentum for speed: a hard flick keeps
    // scrolling long after the finger lifts. Re-asserting scrollTop from state
    // on every render (live events, status updates) kills that momentum at the
    // first re-render, so flicks degrade to slow drags. While a touch gesture
    // or its momentum is in flight, the DOM is the source of truth and state
    // echoes of our own scroll dispatches must not snap the pane back.
    const userScrollRef = React.useRef({ touching: false, lastUserScrollAt: 0, lastDispatchedOffset: null });
    const viewportSizeRef = React.useRef({ width: null, height: null });
    const [viewportRevision, setViewportRevision] = React.useState(0);

    React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node || typeof ResizeObserver === "undefined") return;
        viewportSizeRef.current = { width: node.clientWidth, height: node.clientHeight };
        const observer = new ResizeObserver(() => {
            const next = { width: node.clientWidth, height: node.clientHeight };
            const previous = viewportSizeRef.current;
            if (next.width === previous.width && next.height === previous.height) return;
            viewportSizeRef.current = next;
            setViewportRevision((revision) => revision + 1);
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [ref]);

    React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node) return;
        const previousViewportState = previousViewportStateRef.current;
        const interaction = userScrollRef.current;
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        const interacting = interaction.touching
            || (now - (interaction.lastUserScrollAt || 0)) < TOUCH_MOMENTUM_GRACE_MS;
        const isEchoOffset = interaction.lastDispatchedOffset != null
            && Math.abs((Number(scrollOffset) || 0) - interaction.lastDispatchedOffset) < 2;
        if (
            interacting
            && scrollMode === previousViewportState?.scrollMode
            && (scrollOffset === previousViewportState?.scrollOffset || isEchoOffset)
        ) {
            previousViewportStateRef.current = { scrollMode, scrollOffset };
            return;
        }
        const preservePausedStickyScroll = stickyBottom
            && scrollMode === "top"
            && previousViewportState?.scrollMode === "top"
            && previousViewportState?.scrollOffset === scrollOffset;
        const nextScrollTop = computeAnchoredScrollTop(
            node,
            scrollOffset,
            scrollMode,
            preservePausedStickyScroll,
        );
        if (Math.abs(node.scrollTop - nextScrollTop) > PROGRAMMATIC_SCROLL_TOLERANCE_PX) {
            const pendingProgrammaticScroll = { target: nextScrollTop };
            programmaticScrollRef.current = pendingProgrammaticScroll;
            node.scrollTop = nextScrollTop;
            // Clear on the next frame — the scroll event from the assignment
            // above is queued synchronously and handled in the same task.
            window.requestAnimationFrame(() => {
                if (programmaticScrollRef.current === pendingProgrammaticScroll) {
                    programmaticScrollRef.current = null;
                }
            });
        }
        previousViewportStateRef.current = {
            scrollMode,
            scrollOffset,
        };
    }, [normalizedLines, ref, scrollMode, scrollOffset, stickyBottom, viewportRevision]);

    const dispatchScrollOffset = useFrameCoalescedCallback((offset) => {
        controller.dispatch({ type: "ui/scroll", pane: paneKey, offset });
    });

    const onScroll = React.useCallback(() => {
        const node = ref.current;
        if (!node || !paneKey) return;
        const pendingProgrammatic = programmaticScrollRef.current;
        if (pendingProgrammatic) {
            if (Math.abs(node.scrollTop - pendingProgrammatic.target) <= PROGRAMMATIC_SCROLL_TOLERANCE_PX) {
                return;
            }
            programmaticScrollRef.current = null;
        }
        userScrollRef.current.lastUserScrollAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        // When the pane has no scrollable content (transient loading state
        // that briefly collapses the body to one line), the browser auto-
        // clamps scrollTop to 0 and fires a scroll event we did NOT trigger.
        // Writing that into state would clobber the user's saved offset.
        // Skip the dispatch — next render with real content will restore
        // the desired scroll position from preserved state.
        if (maxScroll <= 0) return;
        if (stickyBottom && typeof controller.updatePaneScrollFromViewport === "function") {
            const rowOffset = Math.max(0, node.scrollTop) / SCROLL_ROW_HEIGHT;
            userScrollRef.current.lastDispatchedOffset = rowOffset;
            controller.updatePaneScrollFromViewport(
                paneKey,
                rowOffset,
                { atBottom: isScrollViewportAtBottom(node) },
            );
            return;
        }

        const pixels = scrollMode === "bottom"
            ? Math.max(0, maxScroll - node.scrollTop)
            : Math.max(0, node.scrollTop);
        userScrollRef.current.lastDispatchedOffset = pixels / SCROLL_ROW_HEIGHT;
        // One dispatch per frame. A scroll gesture fires far more events than
        // the browser paints, and every dispatch notifies each subscriber —
        // the offset the user actually sees is the last one in the frame.
        dispatchScrollOffset(pixels / SCROLL_ROW_HEIGHT);
        if (paneKey === "chat" && scrollMode === "bottom" && node.scrollTop <= PROGRAMMATIC_SCROLL_TOLERANCE_PX) {
            controller.armChatTopHistoryLoad?.();
        }
    }, [controller, dispatchScrollOffset, paneKey, ref, scrollMode, stickyBottom]);

    const onWheel = React.useCallback((event) => {
        const node = ref.current;
        if (!node || paneKey !== "chat" || scrollMode !== "bottom" || event.deltaY >= 0) return;
        if (node.scrollTop > PROGRAMMATIC_SCROLL_TOLERANCE_PX) return;
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        controller.handleChatTopHistoryScrollIntent?.(maxScroll / SCROLL_ROW_HEIGHT);
    }, [controller, paneKey, ref, scrollMode]);

    // Touch equivalent of the wheel-at-top gesture: touch devices never fire
    // wheel events, and once scrollTop sits at 0 a further swipe-down emits no
    // scroll events either — so mobile had no way to request older history.
    // A downward pull that starts while the pane is at (or near) the top fires
    // the same top-history intent, once per gesture.
    const touchPullRef = React.useRef({ startY: null, fired: false });
    const onTouchStart = React.useCallback((event) => {
        userScrollRef.current.touching = true;
        if (paneKey !== "chat" || scrollMode !== "bottom") return;
        touchPullRef.current = { startY: event.touches?.[0]?.clientY ?? null, fired: false };
    }, [paneKey, scrollMode]);
    const onTouchEnd = React.useCallback(() => {
        userScrollRef.current.touching = false;
        // Momentum continues past the finger lift; onScroll keeps refreshing
        // lastUserScrollAt for as long as the glide emits scroll events.
        userScrollRef.current.lastUserScrollAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    }, []);
    const onTouchMove = React.useCallback((event) => {
        const node = ref.current;
        const pull = touchPullRef.current;
        if (!node || paneKey !== "chat" || scrollMode !== "bottom") return;
        if (pull.fired || pull.startY == null) return;
        if (node.scrollTop > PROGRAMMATIC_SCROLL_TOLERANCE_PX) return;
        const y = event.touches?.[0]?.clientY;
        if (y == null || y - pull.startY < TOUCH_TOP_PULL_THRESHOLD_PX) return;
        pull.fired = true;
        // A deliberate pull at the top of the pane is an unambiguous request:
        // force the load, bypassing both the arm/load two-stage handshake and
        // the DOM-vs-render-metric offset gate (the two measurements disagree
        // on narrow viewports). The wheel path keeps the handshake — one
        // physical scroll emits MANY wheel events, so it needs debouncing.
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        controller.handleChatTopHistoryScrollIntent?.(maxScroll / SCROLL_ROW_HEIGHT + 1, { force: true });
    }, [controller, paneKey, ref, scrollMode]);

    return { normalizedLines, onScroll, onWheel, onTouchStart, onTouchMove, onTouchEnd };
}

function Runs({ runs, theme }) {
    return React.createElement(React.Fragment, null,
        (runs || []).map((run, index) => {
            const style = {
                color: resolveColor(theme, run.color),
                backgroundColor: resolveColor(theme, run.backgroundColor),
                fontWeight: run.bold ? 700 : 400,
                textDecoration: run.underline ? "underline" : "none",
            };
            // A run flagged trailingRule renders its text then a CSS rule that
            // fills the remaining width — see selectors.js for why this is not
            // a repeated box-drawing character.
            if (run?.trailingRule) {
                return React.createElement("span", {
                    key: `${index}:rule`,
                    className: "ps-line-trailing-rule",
                    style,
                }, run.text || "");
            }
            const href = String(run?.href || "").trim();
            const isExternalHref = /^https?:\/\//i.test(href);
            // artifact:// links used to render as an inert span — the only
            // affordance was "press a to download", which is the wrong verb
            // for a patch you want to READ. They now open the Files tab with
            // the artifact selected and previewed.
            const artifactRef = parseArtifactHref(href);

            if (artifactRef) {
                return React.createElement(ArtifactLink, {
                    key: `${index}:${run.text || ""}`,
                    label: run.text || "",
                    artifactRef,
                    style,
                });
            }

            return isExternalHref
                ? React.createElement("a", {
                    key: `${index}:${run.text || ""}`,
                    className: "ps-md-link",
                    href,
                    target: "_blank",
                    rel: "noreferrer",
                    style,
                }, run.text || "")
                : React.createElement("span", {
                    key: `${index}:${run.text || ""}`,
                    style,
                }, run.text || "");
        }),
    );
}

function SystemNoticeLine({ line, theme }) {
    const body = String(line?.body || "").trim();
    return React.createElement("details", { className: "ps-system-notice" },
        React.createElement("summary", {
            className: "ps-system-notice-summary",
            style: { color: resolveColor(theme, line?.color) || "var(--ps-muted)" },
        },
        React.createElement("span", { className: "ps-system-notice-summary-text" }, line?.text || "System notice")),
        body
            ? React.createElement("div", { className: "ps-system-notice-body" },
                React.createElement(MarkdownPreviewContent, { content: body, theme }))
            : null);
}

/**
 * Coalesce high-frequency dispatches to one per animation frame.
 *
 * pointermove and scroll fire many times per frame, and each dispatch
 * notifies every subscriber, so a loaded transcript re-renders repeatedly
 * between two painted frames — work that is thrown away before it is ever
 * seen. Collapsing to one dispatch per frame keeps the interaction
 * responsive without changing what the state ends up as: the LAST value in
 * the frame wins, which is the one the user is actually looking at.
 */
function useFrameCoalescedCallback(fn) {
    const frameRef = React.useRef(0);
    const argsRef = React.useRef(null);
    const fnRef = React.useRef(fn);
    fnRef.current = fn;

    React.useEffect(() => () => {
        if (frameRef.current) cancelAnimationFrame(frameRef.current);
    }, []);

    return React.useCallback((...args) => {
        argsRef.current = args;
        if (frameRef.current) return;
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = 0;
            const pending = argsRef.current;
            argsRef.current = null;
            if (pending) fnRef.current(...pending);
        });
    }, []);
}

/**
 * Rendering a transcript is proportional to its length, so it must not repeat
 * for state changes that do not alter the lines — scroll offset and pane
 * resize both notify every subscriber. Memoizing on the line object keeps
 * React from reconciling thousands of rows on every scroll event.
 */
const Line = React.memo(function Line({ line, theme, className = "" }) {
    const lineClassName = className ? `ps-line ${className}` : "ps-line";
    if (!line) {
        return React.createElement("div", { className: lineClassName }, " ");
    }
    if (line.kind === "systemNotice") {
        return React.createElement(SystemNoticeLine, { line, theme });
    }
    if (line.kind === "runs") {
        return React.createElement("div", { className: lineClassName },
            React.createElement(Runs, { runs: line.runs, theme }));
    }
    return React.createElement("div", {
        className: lineClassName,
        style: {
            color: resolveColor(theme, line.color),
            backgroundColor: resolveColor(theme, line.backgroundColor),
            fontWeight: line.bold ? 700 : 400,
            textDecoration: line.underline ? "underline" : "none",
        },
    }, line.text || " ");
});

function lineText(line) {
    if (!line) return "";
    if (line.kind === "runs") return runsToText(line.runs);
    return String(line.text || "");
}

function usePanePixelScroll(ref, scrollOffset, paneKey, controller) {
    // See useScrollSync for rationale on the programmatic-scroll guard.
    const programmaticScrollRef = React.useRef(false);

    React.useLayoutEffect(() => {
        const node = ref.current;
        // No paneKey means nobody is driving this pane's offset, so leave the
        // scroller entirely alone. Writing scrollTop back during a touch fling
        // interrupts momentum every frame — which is why the preview felt
        // stiff next to the transcript — and the SCROLL_ROW_HEIGHT
        // quantization makes it snap as well.
        if (!node || !paneKey) return;
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        const nextScrollTop = Math.min(maxScroll, Math.max(0, Number(scrollOffset) || 0) * SCROLL_ROW_HEIGHT);
        if (Math.abs(node.scrollTop - nextScrollTop) > 2) {
            programmaticScrollRef.current = true;
            node.scrollTop = nextScrollTop;
            window.requestAnimationFrame(() => {
                programmaticScrollRef.current = false;
            });
        }
    }, [ref, scrollOffset, paneKey]);

    return React.useCallback((event) => {
        if (programmaticScrollRef.current) return;
        const node = ref.current;
        if (!node || !paneKey) return;
        // React simulates bubbling for onScroll, so scrolling a code block or
        // table INSIDE the document also fires this handler. Acting on it
        // recorded the pane offset from an inner element's scroll state and
        // then wrote it back to the outer scroller — horizontally scrolling a
        // fenced code block snapped the whole markdown preview to the top.
        // Only the pane's own scroller may drive the pane's offset.
        if (event && event.target !== node) return;
        // See useScrollSync — ignore browser auto-clamp during a
        // transient empty/loading body.
        if (node.scrollHeight <= node.clientHeight) return;
        controller.dispatch({
            type: "ui/scroll",
            pane: paneKey,
            offset: Math.max(0, node.scrollTop) / SCROLL_ROW_HEIGHT,
        });
    }, [controller, paneKey, ref]);
}

// ── Code syntax highlighting ──────────────────────────────────────────────
// A dependency-free tokenizer. Vendoring a real highlighter (highlight.js,
// prism) is not worth the offline-vendor cost for what fenced blocks in a
// chat transcript need: comments, strings, numbers, keywords, and call
// targets. Token colors resolve through the active THEME (same path as
// markdown links), so every theme — light or dark — stays coherent.

const CODE_LANGUAGE_ALIASES = {
    js: "js", jsx: "js", mjs: "js", cjs: "js", javascript: "js",
    ts: "js", tsx: "js", typescript: "js",
    json: "json", jsonc: "json",
    py: "python", python: "python",
    sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell",
    sql: "sql", postgres: "sql", postgresql: "sql", psql: "sql",
    rs: "rust", rust: "rust",
    go: "go", golang: "go",
    yaml: "yaml", yml: "yaml",
    css: "css", scss: "css",
};

// ── Diff blocks ───────────────────────────────────────────────────────────
// A ```diff fence is line-oriented, not token-oriented: running it through
// the generic tokenizer colored Rust/JS keywords inside the payload while
// leaving the +/- semantics — the only thing that matters in a diff — as
// undifferentiated text. Diffs are classified per line instead.

const DIFF_LANGUAGES = new Set(["diff", "patch", "udiff"]);

/**
 * Diff-shaped artifacts. Recognized by extension AND by content type, because
 * an agent may write either `.patch`/`.diff` or a text/x-patch blob under some
 * other name.
 */
const DIFF_ARTIFACT_RE = /\.(patch|diff)$/i;
const IMAGE_CONTENT_TYPE_RE = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i;
const IMAGE_FILENAME_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;

/** Map an artifact filename to a highlighter language, or null for plain text. */
const CODE_ARTIFACT_LANGUAGES = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", jsonl: "json",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
    sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml",
    toml: "toml", sql: "sql", css: "css", html: "html", xml: "xml",
};

/**
 * Strip a leading YAML frontmatter block from markdown.
 *
 * The renderer has no concept of frontmatter, so `---\ntitle: x\n---` was
 * collapsed into a paragraph and rendered as prose above the document — which
 * read as the title being duplicated, since the doc's own H1 follows it.
 * Document viewers hide frontmatter; only strip a block that starts on line 1
 * and closes, so a document opening with a thematic break is untouched.
 */
function stripYamlFrontmatter(content) {
    const text = String(content || "");
    if (!/^---[ \t]*\r?\n/.test(text)) return text;
    const close = /\r?\n---[ \t]*(\r?\n|$)/.exec(text.slice(3));
    if (!close) return text;
    return text.slice(3 + close.index + close[0].length);
}

const TABULAR_ARTIFACT_RE = /\.(csv|tsv)$/i;

function isTabularArtifact(filename, contentType) {
    if (TABULAR_ARTIFACT_RE.test(String(filename || ""))) return true;
    return /^text\/(csv|tab-separated-values)$/i.test(String(contentType || "").trim());
}

/**
 * Tabular preview.
 *
 * Parsing is delegated to Papa Parse rather than split(",") because the cases
 * that break naive parsers are exactly the ones real exports contain: quoted
 * fields holding commas, embedded newlines inside a quoted cell, and escaped
 * quotes. It is loaded lazily so opening a .md never pays for the parser.
 *
 * Rendering is our own table, not a viewer library's: the preview has to
 * inherit the active theme's chrome (Win95 bevels, MS-DOS reverse video), and
 * a drop-in viewer ships its own styling that cannot participate in that.
 */
const TABULAR_MAX_ROWS = 2000;

/**
 * Quote a cell for TSV the way a spreadsheet expects: only when the value
 * would otherwise break the row/column framing.
 */
function tsvCell(value) {
    const text = String(value ?? "");
    return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function TabularPreview({ content, filename }) {
    const [parsed, setParsed] = React.useState(null);
    const wrapRef = React.useRef(null);
    const tableRef = React.useRef(null);
    const anchorCellRef = React.useRef(null);

    React.useEffect(() => {
        let cancelled = false;
        setParsed(null);
        import("papaparse")
            .then((mod) => {
                if (cancelled) return;
                const Papa = mod.default || mod;
                const delimiter = /\.tsv$/i.test(String(filename || "")) ? "\t" : "";
                const out = Papa.parse(String(content || "").trim(), {
                    delimiter,
                    skipEmptyLines: "greedy",
                });
                setParsed({ rows: out.data || [], errors: out.errors || [] });
            })
            .catch(() => { if (!cancelled) setParsed({ rows: null, errors: [{ message: "parser unavailable" }] }); });
        return () => { cancelled = true; };
    }, [content, filename]);

    // The drag can end anywhere, including outside the pane or the window.
    React.useEffect(() => {
        const release = () => { anchorCellRef.current = null; };
        window.addEventListener("mouseup", release);
        return () => window.removeEventListener("mouseup", release);
    }, []);

    /** Select whole cells: snap both range ends to cell boundaries. */
    const selectCellSpan = React.useCallback((a, b) => {
        if (!a || !b) return;
        const selection = window.getSelection();
        if (!selection) return;
        const backwards = !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING);
        const range = document.createRange();
        range.setStartBefore(backwards ? b : a);
        range.setEndAfter(backwards ? a : b);
        selection.removeAllRanges();
        selection.addRange(range);
    }, []);

    const cellFrom = (event) => (event.target?.closest ? event.target.closest("td,th") : null);

    const onMouseDown = React.useCallback((event) => {
        if (event.button !== 0) return;
        const cell = cellFrom(event);
        if (!cell) return;
        // Suppress the native character-level selection before it starts, then
        // take focus by hand (preventDefault would otherwise deny it, and the
        // wrapper needs focus for Ctrl+A to reach us).
        event.preventDefault();
        wrapRef.current?.focus();
        anchorCellRef.current = cell;
        selectCellSpan(cell, cell);
    }, [selectCellSpan]);

    const onMouseMove = React.useCallback((event) => {
        if (!anchorCellRef.current || !(event.buttons & 1)) return;
        const cell = cellFrom(event);
        if (cell) selectCellSpan(anchorCellRef.current, cell);
    }, [selectCellSpan]);

    // Ctrl/Cmd+A selects the TABLE, not the page. Scoped to the pane, so it only
    // applies once the table has focus.
    const onKeyDown = React.useCallback((event) => {
        if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
        if (event.key !== "a" && event.key !== "A") return;
        const table = tableRef.current;
        const selection = window.getSelection();
        if (!table || !selection) return;
        event.preventDefault();
        event.stopPropagation();
        const range = document.createRange();
        range.selectNodeContents(table);
        selection.removeAllRanges();
        selection.addRange(range);
    }, []);

    /**
     * Emit real TSV rather than trusting each browser's table serializer, so a
     * paste into a spreadsheet lands in the right cells every time.
     */
    const onCopy = React.useCallback((event) => {
        const table = tableRef.current;
        const selection = window.getSelection();
        if (!table || !selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const rows = new Map();
        for (const cell of table.querySelectorAll("th,td")) {
            if (!range.intersectsNode(cell)) continue;
            const row = cell.parentElement;
            if (!rows.has(row)) rows.set(row, []);
            rows.get(row).push(tsvCell(cell.textContent));
        }
        // Nothing of the table is selected — leave the event alone.
        if (rows.size === 0) return;
        event.clipboardData.setData("text/plain", Array.from(rows.values(), (cells) => cells.join("\t")).join("\n"));
        event.preventDefault();
    }, []);

    if (!parsed) {
        return React.createElement("div", { className: "ps-csv-status" }, "Parsing…");
    }
    // Fall back to the raw text rather than showing nothing: a file that will
    // not parse is still readable, and hiding it would be worse than plain.
    if (!parsed.rows || parsed.rows.length === 0) {
        return React.createElement("pre", { className: "ps-md-code-pre" },
            React.createElement("code", null, String(content || "")));
    }

    const [header, ...body] = parsed.rows;

    // Width is the WIDEST row, not the header's. A data row with more cells
    // than the header is malformed but common (trailing delimiters, a short
    // header), and papaparse reports no error for it — iterating the header
    // would silently drop those cells, which is the one thing a data viewer
    // must never do. Reduce, not Math.max(...rows): spreading tens of
    // thousands of arguments overflows the stack.
    const columnCount = body.reduce((max, row) => Math.max(max, row.length), header.length);
    const columns = Array.from({ length: columnCount }, (_, i) => header[i] ?? "");

    // Cap the DOM. A 1 MiB CSV (the artifact ceiling) can be ~20k rows, and
    // 20k × N cells makes the pane unusable. Showing a bounded window and
    // saying so is better than hanging the tab.
    const truncated = body.length > TABULAR_MAX_ROWS;
    const visible = truncated ? body.slice(0, TABULAR_MAX_ROWS) : body;

    // No row/column tally — it is not part of the file, and a footer under the
    // table is one more thing to avoid when copying. The only notes worth
    // showing are the ones that say the view is NOT the whole truth.
    const notes = [];
    if (truncated) notes.push(`showing first ${TABULAR_MAX_ROWS} of ${body.length} rows`);
    if (parsed.errors.length) notes.push(`${parsed.errors.length} parse warning${parsed.errors.length === 1 ? "" : "s"}`);

    return React.createElement("div", {
        className: "ps-csv-wrap",
        ref: wrapRef,
        tabIndex: 0,
        onMouseDown,
        onMouseMove,
        onKeyDown,
        onCopy,
    },
        React.createElement("table", { className: "ps-csv-table", ref: tableRef },
            React.createElement("thead", null,
                React.createElement("tr", null,
                    columns.map((cell, i) => React.createElement("th", { key: `h${i}` }, String(cell ?? ""))))),
            React.createElement("tbody", null,
                visible.map((row, r) => React.createElement("tr", { key: `r${r}` },
                    columns.map((_, c) => React.createElement("td", { key: `c${c}` }, String(row[c] ?? ""))))))),
        notes.length
            ? React.createElement("div", { className: "ps-csv-status" }, notes.join(" · "))
            : null);
}

function codeLanguageForArtifact(filename) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(String(filename || ""));
    if (!ext) return null;
    return CODE_ARTIFACT_LANGUAGES[ext[1].toLowerCase()] || null;
}

function isDiffArtifact(filename, contentType) {
    if (DIFF_ARTIFACT_RE.test(String(filename || ""))) return true;
    return /^text\/x-(patch|diff)$/i.test(String(contentType || "").trim());
}

/** Parse an `artifact://<sessionId>/<filename>` href. */
function parseArtifactHref(href) {
    const match = /^artifact:\/\/([^/]+)\/(.+)$/i.exec(String(href || "").trim());
    if (!match) return null;
    try {
        return { sessionId: match[1], filename: decodeURIComponent(match[2]) };
    } catch {
        return { sessionId: match[1], filename: match[2] };
    }
}

/**
 * Controller access for deeply-nested renderers.
 *
 * The markdown/run renderers are called from many places and never took a
 * controller — threading one through every call site to make a single link
 * type clickable would touch far more code than the feature is worth.
 */
const ControllerContext = React.createContext(null);

function ArtifactLink({ label, artifactRef, style }) {
    const controller = React.useContext(ControllerContext);
    const diff = isDiffArtifact(artifactRef.filename);
    const onOpen = React.useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!controller?.revealArtifact) return;
        // On a phone the preview takes the whole pane — a list/detail split has
        // no room to be useful at 390px.
        const fullscreen = typeof window !== "undefined"
            && typeof window.matchMedia === "function"
            && window.matchMedia("(max-width: 920px)").matches;
        Promise.resolve(controller.revealArtifact(artifactRef.sessionId, artifactRef.filename, { fullscreen }))
            .catch(() => {});
    }, [controller, artifactRef.sessionId, artifactRef.filename]);

    return React.createElement("button", {
        type: "button",
        className: `ps-artifact-link${diff ? " is-diff" : ""}`,
        onClick: onOpen,
        title: diff
            ? `Open ${artifactRef.filename} as a diff`
            : `Open ${artifactRef.filename} in Files`,
        style,
    },
    diff ? React.createElement("span", { className: "ps-artifact-link-glyph", "aria-hidden": "true" }, "±") : null,
    React.createElement("span", { className: "ps-artifact-link-label" }, label || artifactRef.filename));
}

function isDiffLanguage(language) {
    return DIFF_LANGUAGES.has(String(language || "").trim().toLowerCase());
}

// File/meta headers are matched BEFORE +/- so "--- a/x" and "+++ b/x" are not
// mistaken for removed/added lines.
const DIFF_META_PATTERN = /^(?:diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename (?:from|to) |copy (?:from|to) |Binary files |GIT binary patch|\\)/;

function classifyDiffLine(line) {
    if (DIFF_META_PATTERN.test(line)) return "meta";
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "context";
}

const DIFF_LINE_COLORS = { add: "green", del: "red", hunk: "cyan", meta: "gray" };

function renderDiffCode(content, theme) {
    const lines = String(content || "").replace(/\n$/, "").split("\n");
    return lines.map((line, index) => {
        const kind = classifyDiffLine(line);
        const color = DIFF_LINE_COLORS[kind];
        // Payload lines carry their +/-/space in column 1. Split it off into
        // a gutter (GitHub/GitLab/VS Code all do this) so the marker stops
        // colliding with the code, wrapped lines hang under the text column
        // instead of under the marker, and a copied selection yields clean
        // code — the gutter is user-select:none. Meta/hunk lines have no
        // marker but keep the empty gutter so every line stays aligned.
        // Only strip column 1 when it really IS a marker. "context" is the
        // fallback for every unrecognized line, so slicing it unconditionally
        // ate the first real character of anything that is not a unified-diff
        // body line — GIT binary patch payload ("delta 142", "zcmV;91Ru…"),
        // format-patch commit prose, mbox headers. Real context lines start
        // with a space; those still get their marker split off.
        const hasMarker = kind === "add" || kind === "del"
            || (kind === "context" && line.startsWith(" "));
        const marker = hasMarker ? line.slice(0, 1) : "";
        const text = hasMarker ? line.slice(1) : line;
        return React.createElement("span", {
            key: `d:${index}`,
            className: `ps-diff-line is-${kind}`,
            style: color ? { color: resolveColor(theme, color) || undefined } : undefined,
        },
            React.createElement("span", {
                className: "ps-diff-marker",
                // Decorative: the tint already carries the meaning visually,
                // and the row is announced by its text.
                "aria-hidden": "true",
            }, marker.trim()),
            React.createElement("span", { className: "ps-diff-text" }, text));
    });
}

function isMermaidLanguage(language) {
    return String(language || "").trim().toLowerCase() === "mermaid";
}

const CODE_KEYWORDS = {
    js: new Set(["async", "await", "break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else", "export", "extends", "finally", "for", "from", "function", "if", "import", "in", "instanceof", "let", "new", "of", "return", "static", "super", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "yield", "true", "false", "null", "undefined", "interface", "type", "enum", "implements", "readonly", "public", "private", "protected"]),
    python: new Set(["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "False", "try", "while", "with", "yield", "self"]),
    shell: new Set(["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "in", "function", "return", "export", "local", "set", "echo", "cd", "sudo", "source"]),
    sql: new Set(["select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "alter", "drop", "index", "join", "left", "right", "inner", "outer", "on", "group", "order", "by", "having", "limit", "offset", "and", "or", "not", "null", "as", "distinct", "union", "all", "case", "when", "then", "else", "end", "with", "returning", "primary", "key", "foreign", "references", "default", "constraint", "begin", "commit", "rollback"]),
    rust: new Set(["as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while"]),
    go: new Set(["break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var", "nil", "true", "false"]),
    json: new Set(["true", "false", "null"]),
    yaml: new Set(["true", "false", "null", "yes", "no"]),
    css: new Set(["important", "media", "keyframes", "import", "supports"]),
};

// Scanner rules per family. Order matters: comments and strings first so a
// `#` or quote inside them never re-enters another rule. Sticky (`y`) so a
// rule only ever matches at the current cursor.
function codeScannerRules(lang) {
    const hashComment = { type: "comment", re: /#[^\n]*/y };
    const slashComment = { type: "comment", re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y };
    const dashComment = { type: "comment", re: /--[^\n]*|\/\*[\s\S]*?\*\//y };
    const number = { type: "number", re: /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b0[xX][0-9a-fA-F]+\b/y };
    const identifier = { type: "identifier", re: /[A-Za-z_$][\w$]*/y };
    const dq = { type: "string", re: /"(?:\\.|[^"\\])*"?/y };
    const sq = { type: "string", re: /'(?:\\.|[^'\\])*'?/y };
    const backtick = { type: "string", re: /`(?:\\.|[^`\\])*`?/y };
    const pyTriple = { type: "string", re: /"""[\s\S]*?"""|'''[\s\S]*?'''/y };

    switch (lang) {
        case "python":
            return [hashComment, pyTriple, dq, sq, number, identifier];
        case "shell":
            return [hashComment, dq, sq, number, identifier];
        case "sql":
            return [dashComment, sq, dq, number, identifier];
        case "yaml":
            return [hashComment, dq, sq, number, identifier];
        case "json":
            return [dq, number, identifier];
        case "css":
            return [{ type: "comment", re: /\/\*[\s\S]*?\*\//y }, dq, sq, number, identifier];
        default:
            return [slashComment, dq, sq, backtick, number, identifier];
    }
}

const CODE_TOKEN_COLORS = {
    comment: "gray",
    string: "green",
    number: "yellow",
    keyword: "magenta",
    fn: "cyan",
};

// Blocks past this size skip highlighting — a chat transcript should never
// pay tokenizer cost for a dumped file.
const CODE_HIGHLIGHT_MAX_CHARS = 20000;

// Tokenizing runs inside the render path, so an unmemoized transcript
// re-highlights EVERY code block on every render (a keystroke in the
// composer re-renders the pane). Results are content-addressed and cached;
// the cap keeps a long-lived session from growing this without bound.
const CODE_TOKEN_CACHE = new Map();
const CODE_TOKEN_CACHE_MAX = 120;

function tokenizeCodeCached(source, language) {
    const key = `${language || ""}\u0000${source}`;
    const hit = CODE_TOKEN_CACHE.get(key);
    if (hit) {
        // Refresh LRU position.
        CODE_TOKEN_CACHE.delete(key);
        CODE_TOKEN_CACHE.set(key, hit);
        return hit;
    }
    const tokens = tokenizeCode(source, language);
    CODE_TOKEN_CACHE.set(key, tokens);
    if (CODE_TOKEN_CACHE.size > CODE_TOKEN_CACHE_MAX) {
        CODE_TOKEN_CACHE.delete(CODE_TOKEN_CACHE.keys().next().value);
    }
    return tokens;
}

function tokenizeCode(source, language) {
    const lang = CODE_LANGUAGE_ALIASES[String(language || "").trim().toLowerCase()] || "default";
    const keywords = CODE_KEYWORDS[lang] || CODE_KEYWORDS.js;
    const rules = codeScannerRules(lang);
    const tokens = [];
    let cursor = 0;
    let plainStart = 0;

    const flushPlain = (end) => {
        if (end > plainStart) tokens.push({ type: "plain", text: source.slice(plainStart, end) });
    };

    while (cursor < source.length) {
        let hit = null;
        for (const rule of rules) {
            rule.re.lastIndex = cursor;
            const match = rule.re.exec(source);
            if (match && match.index === cursor && match[0].length > 0) {
                hit = { type: rule.type, text: match[0] };
                break;
            }
        }
        if (!hit) {
            cursor += 1;
            continue;
        }
        let type = hit.type;
        if (type === "identifier") {
            if (keywords.has(hit.text)) {
                type = "keyword";
            } else {
                // A call target reads as a function; anything else is plain.
                const after = source.slice(cursor + hit.text.length);
                type = /^\s*\(/.test(after) ? "fn" : "plain";
            }
        }
        if (type === "plain") {
            cursor += hit.text.length;
            continue;
        }
        flushPlain(cursor);
        tokens.push({ type, text: hit.text });
        cursor += hit.text.length;
        plainStart = cursor;
    }
    flushPlain(source.length);
    return tokens;
}

function renderHighlightedCode(content, language, theme) {
    const source = String(content || "");
    if (!source || source.length > CODE_HIGHLIGHT_MAX_CHARS) return source;
    let tokens;
    try {
        tokens = tokenizeCodeCached(source, language);
    } catch {
        return source;
    }
    return tokens.map((token, index) => {
        const color = CODE_TOKEN_COLORS[token.type];
        if (!color) return React.createElement(React.Fragment, { key: `t:${index}` }, token.text);
        return React.createElement("span", {
            key: `t:${index}`,
            className: `ps-code-token is-${token.type}`,
            style: { color: resolveColor(theme, color) || undefined },
        }, token.text);
    });
}

// ── Mermaid diagrams ──────────────────────────────────────────────────────
// mermaid is ~2MB, so it is imported DYNAMICALLY: vite splits it into its own
// chunk that is fetched only when a transcript actually contains a ```mermaid
// fence. A failed parse (very common while a diagram is still streaming in)
// falls back to the highlighted source rather than an error box.

let mermaidModulePromise = null;

function loadMermaid() {
    if (!mermaidModulePromise) {
        mermaidModulePromise = import("mermaid")
            .then((module) => module.default || module)
            .catch((error) => {
                mermaidModulePromise = null;
                throw error;
            });
    }
    return mermaidModulePromise;
}

// initialize() must run per render, not once at import: the module promise is
// cached, so configuring the palette only on first load left every diagram
// frozen on whichever theme happened to be active when mermaid loaded (a
// dark->light switch kept rendering dark diagrams until a reload).
function configureMermaid(mermaid, light) {
    mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: light ? "default" : "dark",
        fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
    });
    return mermaid;
}

let mermaidRenderSeq = 0;

// mermaid.render() is NOT re-entrant: it stages each diagram through shared
// internal state, so two blocks in one message racing each other leaves one
// of them unrendered (whichever lost the race falls back to source). Renders
// are therefore serialized through a promise chain.
let mermaidRenderQueue = Promise.resolve();

function queueMermaidRender(task) {
    const run = mermaidRenderQueue.then(task, task);
    mermaidRenderQueue = run.then(() => undefined, () => undefined);
    return run;
}

function MermaidDiagram({ code, theme, fallback }) {
    const [svg, setSvg] = React.useState(null);
    const [failed, setFailed] = React.useState(false);
    const [errorText, setErrorText] = React.useState("");
    const light = React.useMemo(() => isThemeLight(theme), [theme]);

    React.useEffect(() => {
        let active = true;
        const source = String(code || "").trim();
        if (!source) return undefined;
        setFailed(false);
        loadMermaid()
            .then((mermaid) => queueMermaidRender(async () => {
                if (!active) return;
                configureMermaid(mermaid, light);
                mermaidRenderSeq += 1;
                const id = `ps-mermaid-${mermaidRenderSeq}`;
                // parse() first so a half-streamed diagram fails cheaply and
                // without mermaid injecting an error graphic into the DOM.
                await mermaid.parse(source);
                const { svg: rendered } = await mermaid.render(id, source);
                if (active) setSvg(rendered);
            }))
            .catch((error) => {
                if (active) { setSvg(null); setFailed(true); setErrorText(String(error?.message || error)); }
            });
        return () => { active = false; };
    }, [code, light]);

    if (svg && !failed) {
        return React.createElement("div", {
            className: "ps-mermaid",
            // mermaid output is generated from the diagram source with
            // securityLevel "strict" (HTML labels off, scripts stripped).
            dangerouslySetInnerHTML: { __html: svg },
        });
    }
    // A diagram mermaid cannot parse falls back to its source WITH the
    // reason: silently showing code left "why didn't this render?" a mystery.
    if (failed && errorText) {
        return React.createElement("div", { className: "ps-mermaid-failed" },
            React.createElement("div", { className: "ps-mermaid-error" },
                `Diagram could not be rendered — ${String(errorText).split("\n")[0]}`),
            fallback);
    }
    return fallback;
}

function renderInlineMarkdown(source, theme, keyPrefix = "md") {
    return tokenizeInlineMarkdown(source).map((token, index) => {
        const key = `${keyPrefix}:${index}`;
        if (token.type === "code") {
            return React.createElement("code", { key, className: "ps-md-inline-code" }, token.text);
        }
        if (token.type === "strong") {
            return React.createElement("strong", { key, className: "ps-md-strong" }, renderInlineMarkdown(token.text, theme, `${key}:strong`));
        }
        if (token.type === "em") {
            return React.createElement("em", { key, className: "ps-md-em" }, renderInlineMarkdown(token.text, theme, `${key}:em`));
        }
        if (token.type === "link") {
            const artifactRef = parseArtifactHref(token.href);
            if (artifactRef) {
                return React.createElement(ArtifactLink, {
                    key,
                    label: token.text,
                    artifactRef,
                    style: { color: resolveColor(theme, "cyan") },
                });
            }
            // Only http(s) becomes a navigable anchor. Anything else — an
            // unknown scheme, or a malformed href from a bad transform — would
            // resolve RELATIVE to the portal and navigate the SPA away on
            // click, losing all session state. Render it as inert text instead.
            if (!/^https?:\/\//i.test(String(token.href || "").trim())) {
                return React.createElement("span", {
                    key,
                    style: { color: resolveColor(theme, "cyan") },
                }, token.text);
            }
            return React.createElement("a", {
                key,
                className: "ps-md-link",
                href: token.href,
                target: "_blank",
                rel: "noreferrer",
                style: { color: resolveColor(theme, "cyan") },
            }, token.text);
        }
        return React.createElement(React.Fragment, { key }, token.text);
    });
}

function normalizeTableCellText(value = "") {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

const FIT_WIDTH_FLEX_HEADER_KEYWORDS = [
    "description",
    "mechanism",
    "details",
    "notes",
    "summary",
    "message",
    "comment",
    "reason",
    "body",
    "content",
    "explanation",
    "rationale",
    "one-liner",
];

const FIT_WIDTH_FLEX_MIN_MAX_LEN = 24;
const FIT_WIDTH_RIGID_CHAR_CAP = 32;
const FIT_WIDTH_MIN_RIGID_CHARS = 6;
const FIT_WIDTH_FLEX_MIN_CHARS = 30;
const FIT_WIDTH_FLEX_MAX_CHARS = 56;
const FIT_WIDTH_FLEX_MIN_FRACTION = 0.4;
const FIT_WIDTH_FLEX_TO_RIGID_RATIO = 1.4;
const FIT_WIDTH_MIN_EXTRA_CHARS = 2;

/**
 * Compute per-column layout for a fit-width markdown / chat table.
 *
 * Strategy:
 *   1. Measure max cell length and "wrappability" (cells with whitespace) per column.
 *   2. Identify a single "flex" column — long, prose-like, ideally with a
 *      header keyword like Description / Mechanism / Notes. This column
 *      absorbs overflow by wrapping aggressively.
 *   3. Give every other column a budget = clamp(maxLen + padding, MIN, RIGID_CAP),
 *      so rigid columns stay at their content-fit width even when one
 *      sibling column has hundreds of characters of prose.
 *   4. Give the flex column a bounded share of the rigid-column budget. A
 *      very long cell should wrap; it should not steal so much percentage
 *      width that compact columns like Count / Status collapse on phones.
 *   5. Return a minimum table width in ch so the wrapper can scroll
 *      horizontally rather than forcing all columns below readable size.
 *
 * Returns { widths: ["12.34%", ...], flexIndex: number, minWidth: "64ch" }
 * when a flex column is identified — the table renderer then forces
 * table-layout: fixed, adds an `is-flex-column` class to the chosen column,
 * and gives the table a readable minimum width. Returns null when no flex
 * column is found, in which case the renderer falls back to the browser's
 * auto-table-layout (which is already good for short / uniform tables).
 *
 * Background: the previous behavior used the browser's auto-table-layout
 * unconditionally. That works well when columns are uniform but is biased
 * toward wide columns when one column has prose hundreds of characters
 * long (e.g. a Mechanism / Description column) — auto-layout distributes
 * width proportional to (max-content − min-content), which lets the prose
 * column squeeze the rigid columns down to a few characters each.
 */
function computeFitWidthColumnLayout(rows = []) {
    const columnCount = Math.max(0, ...rows.map((row) => row.length));
    if (columnCount <= 0) return null;

    const headerRow = rows[0] || [];
    const dataRowCount = Math.max(1, rows.length - 1);

    const stats = Array.from({ length: columnCount }, () => ({
        max: 0,
        spaceCells: 0,
    }));
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
            const text = normalizeTableCellText(row[columnIndex] || "");
            if (text.length > stats[columnIndex].max) stats[columnIndex].max = text.length;
            if (rowIndex > 0 && /\s/.test(text)) stats[columnIndex].spaceCells += 1;
        }
    }

    let flexIndex = -1;
    let flexScore = 0;
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const stat = stats[columnIndex];
        if (stat.max < FIT_WIDTH_FLEX_MIN_MAX_LEN) continue;
        const spaceRatio = stat.spaceCells / dataRowCount;
        if (spaceRatio < 0.4) continue;
        const headerText = normalizeTableCellText(headerRow[columnIndex] || "").toLowerCase();
        const headerBonus = FIT_WIDTH_FLEX_HEADER_KEYWORDS.some((keyword) => headerText.includes(keyword)) ? 60 : 0;
        const score = stat.max + headerBonus;
        if (score > flexScore) {
            flexScore = score;
            flexIndex = columnIndex;
        }
    }

    if (flexIndex < 0) return null;

    const rigidBudgets = stats.map((stat, columnIndex) => {
        if (columnIndex === flexIndex) return 0;
        return Math.max(FIT_WIDTH_MIN_RIGID_CHARS, Math.min(stat.max + 2, FIT_WIDTH_RIGID_CHAR_CAP));
    });
    const sumRigid = rigidBudgets.reduce((sum, value) => sum + value, 0);
    const flexStat = stats[flexIndex];
    const flexBudget = Math.max(
        FIT_WIDTH_FLEX_MIN_CHARS,
        Math.min(
            flexStat.max * 0.45,
            FIT_WIDTH_FLEX_MAX_CHARS,
            Math.max(FIT_WIDTH_FLEX_MIN_CHARS, sumRigid * FIT_WIDTH_FLEX_TO_RIGID_RATIO),
        ),
    );
    const budgets = rigidBudgets.map((value, columnIndex) => (
        columnIndex === flexIndex ? flexBudget : value
    ));

    const totalBudget = budgets.reduce((sum, value) => sum + value, 0);
    if (totalBudget > 0 && budgets[flexIndex] / totalBudget < FIT_WIDTH_FLEX_MIN_FRACTION) {
        const sumRigid = totalBudget - budgets[flexIndex];
        budgets[flexIndex] = sumRigid * (FIT_WIDTH_FLEX_MIN_FRACTION / (1 - FIT_WIDTH_FLEX_MIN_FRACTION));
    }

    const finalTotal = budgets.reduce((sum, value) => sum + value, 0);
    if (!(finalTotal > 0)) return null;
    return {
        widths: budgets.map((value) => `${((value / finalTotal) * 100).toFixed(2)}%`),
        flexIndex,
        minWidth: `${Math.ceil(finalTotal + FIT_WIDTH_MIN_EXTRA_CHARS)}ch`,
    };
}

function buildTableColumnLabels(headerRows = [], columnCount = 0) {
    return Array.from({ length: columnCount }, (_, columnIndex) => {
        const label = (Array.isArray(headerRows) ? headerRows : [])
            .map((row) => normalizeTableCellText(row?.[columnIndex] || ""))
            .filter(Boolean)
            .join(" / ");
        return label || null;
    });
}

function isMarkdownSpecialLine(line = "", nextLine = "") {
    const value = String(line || "");
    return /^\s*#{1,6}\s+/.test(value)
        || /^\s*>/.test(value)
        || /^\s*([-*]|\d+\.)\s+/.test(value)
        || /^\s*```/.test(value)
        || (value.includes("|") && /^\s*\|?[\s:-]+(?:\|[\s:-]+)+\|?\s*$/.test(String(nextLine || "")));
}

function splitMarkdownTableRow(line = "") {
    const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
}

function parseMarkdownBlocks(source = "") {
    const text = String(source || "").replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    const blocks = [];

    for (let index = 0; index < lines.length;) {
        const line = lines[index];
        const trimmed = line.trim();

        if (!trimmed) {
            index += 1;
            continue;
        }

        const fenceMatch = /^```(\S*)\s*$/.exec(trimmed);
        if (fenceMatch) {
            const language = fenceMatch[1] || "";
            const codeLines = [];
            index += 1;
            while (index < lines.length && !/^```/.test(lines[index].trim())) {
                codeLines.push(lines[index]);
                index += 1;
            }
            if (index < lines.length) index += 1;
            blocks.push({ type: "code", language, content: codeLines.join("\n") });
            continue;
        }

        const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
        if (headingMatch) {
            blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2].trim() });
            index += 1;
            continue;
        }

        if (line.includes("|") && index + 1 < lines.length && /^\s*\|?[\s:-]+(?:\|[\s:-]+)+\|?\s*$/.test(lines[index + 1].trim())) {
            const header = splitMarkdownTableRow(line);
            index += 2;
            const rows = [];
            while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
                rows.push(splitMarkdownTableRow(lines[index]));
                index += 1;
            }
            blocks.push({ type: "table", header, rows });
            continue;
        }

        if (/^\s*>/.test(line)) {
            const quoteLines = [];
            while (index < lines.length && /^\s*>/.test(lines[index])) {
                quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
                index += 1;
            }
            blocks.push({ type: "blockquote", text: quoteLines.join("\n").trim() });
            continue;
        }

        const listMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
        if (listMatch) {
            const ordered = /\d+\./.test(listMatch[2]);
            const items = [];
            while (index < lines.length) {
                const current = lines[index];
                const itemMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(current);
                if (!itemMatch || /\d+\./.test(itemMatch[2]) !== ordered) break;
                const itemLines = [itemMatch[3].trim()];
                index += 1;
                while (
                    index < lines.length
                    && lines[index].trim()
                    && !/^(\s*)([-*]|\d+\.)\s+/.test(lines[index])
                    && !isMarkdownSpecialLine(lines[index], lines[index + 1] || "")
                ) {
                    itemLines.push(lines[index].trim());
                    index += 1;
                }
                items.push(itemLines.join(" "));
                if (!lines[index]?.trim()) break;
            }
            blocks.push({ type: "list", ordered, items });
            continue;
        }

        const paragraphLines = [line.trim()];
        index += 1;
        while (
            index < lines.length
            && lines[index].trim()
            && !isMarkdownSpecialLine(lines[index], lines[index + 1] || "")
        ) {
            paragraphLines.push(lines[index].trim());
            index += 1;
        }
        blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
    }

    return blocks;
}

function MarkdownPreviewContent({ content, theme }) {
    const blocks = React.useMemo(() => parseMarkdownBlocks(content), [content]);
    if (blocks.length === 0) {
        return React.createElement("div", { className: "ps-empty-state" }, "No preview content.");
    }
    return React.createElement("div", { className: "ps-markdown-preview" },
        blocks.map((block, index) => {
            if (block.type === "heading") {
                return React.createElement("div", {
                    key: `block:${index}`,
                    className: `ps-md-heading is-h${block.level}`,
                }, renderInlineMarkdown(block.text, theme, `heading:${index}`));
            }
            if (block.type === "code") {
                const isDiff = isDiffLanguage(block.language);
                const codeSection = React.createElement("section", {
                    key: `block:${index}`,
                    className: `ps-md-code-block${isDiff ? " is-diff" : ""}`,
                },
                    React.createElement("div", { className: "ps-md-code-header" }, block.language || "text"),
                    React.createElement("pre", { className: "ps-md-code-pre" },
                        React.createElement("code", null, isDiff
                            ? renderDiffCode(block.content, theme)
                            : renderHighlightedCode(block.content, block.language, theme))));
                if (isMermaidLanguage(block.language)) {
                    return React.createElement(MermaidDiagram, {
                        key: `block:${index}`,
                        code: block.content,
                        theme,
                        fallback: codeSection,
                    });
                }
                return codeSection;
            }
            if (block.type === "blockquote") {
                return React.createElement("blockquote", { key: `block:${index}`, className: "ps-md-quote" },
                    renderInlineMarkdown(block.text, theme, `quote:${index}`));
            }
            if (block.type === "list") {
                const ListTag = block.ordered ? "ol" : "ul";
                return React.createElement(ListTag, {
                    key: `block:${index}`,
                    className: `ps-md-list${block.ordered ? " is-ordered" : ""}`,
                }, block.items.map((item, itemIndex) => React.createElement("li", {
                    key: `item:${itemIndex}`,
                    className: "ps-md-list-item",
                }, renderInlineMarkdown(item, theme, `list:${index}:${itemIndex}`))));
            }
            if (block.type === "table") {
                const columnCount = Math.max(block.header.length || 0, ...block.rows.map((row) => row.length));
                // Wrap cells by default. Only fall back to horizontal scroll
                // when there are so many columns that wrapping would crush
                // every cell (>6 columns is the practical readability cliff
                // on phones).
                const fitToWidth = columnCount > 0 && columnCount <= 6;
                // Default: let the browser's auto-table-layout do column
                // sizing under the fit-content constraint — that handles
                // short / uniform tables well. When one column has long
                // prose (e.g. a Mechanism / Description column), auto-layout
                // squeezes the rigid columns; computeFitWidthColumnLayout
                // detects that case, picks a flex column, and assigns
                // explicit widths so the rigid columns hold their
                // content-fit width and the flex column wraps to absorb the
                // remainder.
                const layout = fitToWidth
                    ? computeFitWidthColumnLayout([block.header, ...block.rows])
                    : null;
                const hasFlexColumn = !!layout;
                const flexIndex = layout ? layout.flexIndex : -1;
                const cellClass = (cellIndex) => (cellIndex === flexIndex ? "is-flex-column" : null);
                const columnLabels = buildTableColumnLabels([block.header], columnCount);
                const tableClass = `ps-md-table${fitToWidth ? " is-fit-width" : ""}${hasFlexColumn ? " has-flex-column" : ""}`;
                const wrapClass = `ps-md-table-wrap${fitToWidth ? " is-fit-width" : ""}${hasFlexColumn ? " has-flex-column" : ""}`;
                return React.createElement("div", {
                    key: `block:${index}`,
                    className: wrapClass,
                },
                    React.createElement("table", {
                        className: tableClass,
                        style: layout?.minWidth ? { "--ps-table-min-width": layout.minWidth } : undefined,
                    },
                        layout
                            ? React.createElement("colgroup", null,
                                layout.widths.map((width, columnIndex) => React.createElement("col", {
                                    key: `col:${columnIndex}`,
                                    className: cellClass(columnIndex) || undefined,
                                    style: { width },
                                })))
                            : null,
                        React.createElement("thead", null,
                            React.createElement("tr", null,
                                block.header.map((cell, cellIndex) => React.createElement("th", {
                                    key: `head:${cellIndex}`,
                                    className: cellClass(cellIndex) || undefined,
                                },
                                    renderInlineMarkdown(cell, theme, `table:${index}:head:${cellIndex}`))))),
                        React.createElement("tbody", null,
                            block.rows.map((row, rowIndex) => React.createElement("tr", { key: `row:${rowIndex}` },
                                row.map((cell, cellIndex) => React.createElement("td", {
                                    key: `cell:${rowIndex}:${cellIndex}`,
                                    className: cellClass(cellIndex) || undefined,
                                    "data-label": columnLabels[cellIndex] || undefined,
                                },
                                    React.createElement("span", { className: "ps-table-cell-value" },
                                        renderInlineMarkdown(cell, theme, `table:${index}:${rowIndex}:${cellIndex}`)))))))));
            }
            return React.createElement("p", { key: `block:${index}`, className: "ps-md-paragraph" },
                renderInlineMarkdown(block.text, theme, `para:${index}`));
        }));
}

/**
 * Preview panel for pre-rendered content (diff, highlighted code).
 *
 * Shares MarkdownPreviewPanel's scroll wiring rather than being a plain
 * overflow:auto div: without the pane hookup the keyboard scroll commands
 * have nothing to drive, so these previews could only ever be scrolled with
 * the mouse — the global key handler swallows the arrows before the browser
 * would scroll them natively.
 */
function RenderedPreviewPanel({ controller, title, color, focused, scrollOffset = 0, paneKey, theme, className = "", focusRegion = null, children }) {
    const ref = React.useRef(null);
    const onScroll = usePanePixelScroll(ref, scrollOffset, paneKey, controller);
    // Mouse only. On touch this fired on every tap, and setFocus runs the
    // region through normalizeFocusRegion, which rewrites a region missing
    // from the current layout to order[0] — so tapping the chat on a phone
    // was silently reassigning focus to the inspector and jumping to the
    // artifact list. Keyboard scroll targeting is meaningless on touch anyway.
    const claimFocus = React.useCallback(() => {
        const region = focusRegionForPaneKey(paneKey, focusRegion);
        if (region && controller?.setFocus) controller.setFocus(region);
    }, [controller, paneKey, focusRegion]);

    return React.createElement(Panel, { title, color, focused, theme },
        React.createElement("div", {
            ref,
            className: `ps-scroll-panel is-preview ${className}`.trim(),
            onScroll,
            onMouseDown: claimFocus,
        }, children));
}

function MarkdownPreviewPanel({ controller, title, color, focused, scrollOffset = 0, paneKey, theme, content, focusRegion = null }) {
    const claimMarkdownFocus = React.useCallback(() => {
        const region = focusRegionForPaneKey(paneKey, focusRegion);
        if (region && controller?.setFocus) controller.setFocus(region);
    }, [controller, paneKey, focusRegion]);
    const ref = React.useRef(null);
    const onScroll = usePanePixelScroll(ref, scrollOffset, paneKey, controller);

    return React.createElement(Panel, { title, color, focused, theme },
        React.createElement("div", {
            ref,
            className: "ps-scroll-panel ps-markdown-scroll",
            onScroll,
            onMouseDown: claimMarkdownFocus,
        }, React.createElement(MarkdownPreviewContent, { content, theme })));
}

function formatArtifactPreviewBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) {
        const kb = bytes / 1024;
        return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function BinaryArtifactPreviewPanel({ title, color, focused, theme, filename, contentType, sizeBytes, source, uploadedAt, controller = null, sessionId = null }) {
    const meta = [];
    if (contentType) meta.push(contentType);
    if (sizeBytes != null) meta.push(formatArtifactPreviewBytes(sizeBytes));
    if (source) meta.push(source);
    const uploadedLabel = uploadedAt
        ? new Date(uploadedAt).toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        })
        : "";

    // Images render inline (authenticated fetch → object URL). Other binary
    // types keep the download-only card.
    //
    // SVG goes through the SAME object-URL <img> path rather than being
    // inlined as markup: an artifact is untrusted content, and <img> does not
    // execute script inside an SVG the way inline markup would.
    const isRasterImage = IMAGE_CONTENT_TYPE_RE.test(String(contentType || ""))
        || IMAGE_FILENAME_RE.test(String(filename || ""));
    const [imageUrl, setImageUrl] = React.useState(null);
    React.useEffect(() => {
        setImageUrl(null);
        if (!isRasterImage || !controller || !sessionId || !filename) return undefined;
        let cancelled = false;
        fetchArtifactObjectUrl(controller, sessionId, filename)
            .then((url) => { if (!cancelled) setImageUrl(url); })
            .catch(() => { if (!cancelled) setImageUrl("error"); });
        return () => { cancelled = true; };
    }, [isRasterImage, controller, sessionId, filename]);

    return React.createElement(Panel, { title, color, focused, theme },
        React.createElement("div", { className: "ps-binary-preview-card" },
            React.createElement("div", { className: "ps-binary-preview-kicker" }, isRasterImage ? "Image artifact" : "Binary artifact"),
            React.createElement("h3", { className: "ps-binary-preview-title" }, filename || "Artifact"),
            meta.length > 0
                ? React.createElement("div", { className: "ps-binary-preview-meta" }, meta.join("  •  "))
                : null,
            uploadedLabel
                ? React.createElement("div", { className: "ps-binary-preview-time" }, `Uploaded ${uploadedLabel}`)
                : null,
            isRasterImage && imageUrl && imageUrl !== "error"
                ? React.createElement("img", {
                    className: "ps-binary-preview-image",
                    src: imageUrl,
                    alt: filename || "artifact image",
                    onClick: () => { try { window.open(imageUrl, "_blank", "noopener"); } catch { /* popup blocked */ } },
                })
                : React.createElement("p", { className: "ps-binary-preview-copy" },
                    isRasterImage
                        ? (imageUrl === "error" ? "Could not load the image preview. Use Download to save the file." : "Loading image preview…")
                        : "Preview is intentionally disabled for non-text artifacts in the browser workspace. Use Download to save the file and open it in the default app.")));
}

function isBoxTopLine(text) {
    const value = String(text || "").trim();
    return value.startsWith("┌") && value.endsWith("┐");
}

function isBoxBottomLine(text) {
    const value = String(text || "").trim();
    return value.startsWith("└") && value.endsWith("┘");
}

function isBoxDividerLine(text) {
    const value = String(text || "").trim();
    return value.startsWith("├") && value.endsWith("┤");
}

function isBoxContentLine(text) {
    const value = String(text || "").trim();
    return value.startsWith("│") && value.endsWith("│");
}

function extractCodeFenceLanguage(line) {
    const value = String(lineText(line) || "").trim();
    if (!isBoxTopLine(value)) return "";
    return value
        .slice(1, -1)
        .replace(/^─+/u, "")
        .replace(/─+$/u, "")
        .trim();
}

function extractCodeFenceLine(line) {
    if (line?.kind === "runs" && Array.isArray(line.runs) && line.runs.length >= 3) {
        return String(line.runs[1]?.text || "").replace(/\s+$/u, "");
    }
    const value = lineText(line);
    if (!isBoxContentLine(value)) return String(value || "");
    return String(value)
        .slice(1, -1)
        .replace(/\s+$/u, "");
}

function trimRunsEdgeWhitespace(runs = []) {
    const nextRuns = (runs || []).map((run) => ({ ...run }));
    if (nextRuns.length === 0) return nextRuns;
    nextRuns[0].text = String(nextRuns[0].text || "").replace(/^\s+/, "");
    nextRuns[nextRuns.length - 1].text = String(nextRuns[nextRuns.length - 1].text || "").replace(/\s+$/, "");
    return nextRuns.filter((run, index) => String(run.text || "").length > 0 || nextRuns.length === 1 || index === 0);
}

function extractFramedRuns(line, { fallbackColor = null } = {}) {
    if (line?.kind === "runs" && Array.isArray(line.runs) && line.runs.length >= 3) {
        return trimRunsEdgeWhitespace(line.runs.slice(1, -1));
    }
    const text = lineText(line)
        .replace(/^\s*[┌│]\s?/, "")
        .replace(/\s?[┐│]\s*$/, "")
        .replace(/^─+/, "")
        .replace(/─+$/, "")
        .trim();
    return [{ text, color: fallbackColor }];
}

function splitBoxTableCells(text) {
    const value = String(text || "").trim();
    if (!isBoxContentLine(value)) return [];
    return value
        .slice(1, -1)
        .split("│")
        .map((cell) => cell.trim());
}

function shouldJoinBoxTableFragmentsWithoutSpace(left = "", right = "") {
    const previous = String(left || "").trimEnd();
    const next = String(right || "").trimStart();
    if (!previous || !next) return false;

    const previousChar = previous.slice(-1);
    const nextChar = next[0];

    if (/^[,.;:!?%)\]}>]/u.test(nextChar)) return true;
    if (/^[._/\\-]/u.test(nextChar)) return true;
    if (/[([{<._/\\-]$/u.test(previousChar)) return true;
    if (/\.[A-Za-z0-9]{0,4}$/u.test(previous) && /^[A-Za-z0-9]/u.test(nextChar)) return true;

    return false;
}

export function mergeBoxTableCellFragments(fragments = []) {
    const parts = (Array.isArray(fragments) ? fragments : [fragments])
        .map((fragment) => String(fragment || "").trim())
        .filter(Boolean);
    if (parts.length === 0) return "";

    return parts.slice(1).reduce((merged, fragment) => (
        shouldJoinBoxTableFragmentsWithoutSpace(merged, fragment)
            ? `${merged}${fragment}`
            : `${merged} ${fragment}`
    ), parts[0]);
}

function mergeBoxTableRowGroup(rowGroup = []) {
    const columnCount = Math.max(0, ...rowGroup.map((row) => row.length));
    return Array.from({ length: columnCount }, (_, columnIndex) => mergeBoxTableCellFragments(
        rowGroup
            .map((row) => String(row[columnIndex] || "").trim())
            .filter(Boolean),
    ));
}

function parseStructuredChatBlocks(lines = []) {
    const blocks = [];

    for (let index = 0; index < lines.length;) {
        const currentLine = lines[index];

        // Preformatted markup lines (splash art) bypass box/table/card
        // detection entirely and render as one preserve block, so no line
        // ever rewraps or gets reinterpreted as a structured element.
        if (currentLine?.preserve) {
            const variant = currentLine.splashVariant || null;
            const preserveLines = [];
            while (index < lines.length && lines[index]?.preserve && (lines[index].splashVariant || null) === variant) {
                preserveLines.push(lines[index]);
                index += 1;
            }
            blocks.push({ type: "preserve", lines: preserveLines, splashVariant: variant });
            continue;
        }

        // Sentinel card bounds emitted by buildMessageCardLines in sentinel
        // mode. The body lines between the bounds are UNWRAPPED, so parse
        // them recursively — box-drawn/markdown tables inside the card
        // become real HTML tables instead of hard-wrapped box art.
        if (currentLine?.kind === "cardStart") {
            const innerLines = [];
            index += 1;
            while (index < lines.length && lines[index]?.kind !== "cardEnd") {
                innerLines.push(lines[index]);
                index += 1;
            }
            if (index < lines.length) index += 1;
            if (index < lines.length && lineText(lines[index]).trim().length === 0) {
                index += 1;
            }
            blocks.push({
                type: "card",
                headerRuns: Array.isArray(currentLine.runs) ? currentLine.runs : [],
                borderColor: currentLine.borderColor || "gray",
                blocks: parseStructuredChatBlocks(innerLines),
            });
            continue;
        }

        // Sentinel image-attachment line — a user message's image refs. The
        // block component fetches bytes through the authenticated transport
        // (a bare <img src=download-url> cannot carry the Bearer token).
        if (currentLine?.kind === "imageAttachments") {
            blocks.push({
                type: "imageAttachments",
                sessionId: currentLine.sessionId || null,
                attachments: Array.isArray(currentLine.attachments) ? currentLine.attachments : [],
            });
            index += 1;
            continue;
        }

        // Sentinel markdown-table line emitted by parseMarkdownLines when
        // tableMode === "sentinel". Carries the raw header + rows so the
        // portal renders a real HTML table with markdown cell content (so
        // [label](url) inside cells stays clickable, instead of being flattened
        // into plain text by the box-art width-fitter).
        if (currentLine?.kind === "markdownTable") {
            blocks.push({
                type: "table",
                headerRows: Array.isArray(currentLine.header) && currentLine.header.length > 0
                    ? [currentLine.header]
                    : [],
                bodyRows: Array.isArray(currentLine.rows) ? currentLine.rows : [],
            });
            index += 1;
            continue;
        }

        const currentText = lineText(currentLine);

        if (isBoxTopLine(currentText) && currentText.includes("┬")) {
            const headerRows = [];
            const bodyRows = [];
            let currentRowGroup = [];
            let inHeader = true;
            index += 1;

            while (index < lines.length) {
                const nextLine = lines[index];
                const nextText = lineText(nextLine);
                if (isBoxBottomLine(nextText)) {
                    if (currentRowGroup.length > 0) {
                        const mergedRow = mergeBoxTableRowGroup(currentRowGroup);
                        if (mergedRow.length > 0) {
                            if (inHeader) headerRows.push(mergedRow);
                            else bodyRows.push(mergedRow);
                        }
                    }
                    index += 1;
                    break;
                }
                if (isBoxDividerLine(nextText)) {
                    if (currentRowGroup.length > 0) {
                        const mergedRow = mergeBoxTableRowGroup(currentRowGroup);
                        if (mergedRow.length > 0) {
                            if (inHeader) headerRows.push(mergedRow);
                            else bodyRows.push(mergedRow);
                        }
                    }
                    currentRowGroup = [];
                    inHeader = false;
                    index += 1;
                    continue;
                }
                if (isBoxContentLine(nextText)) {
                    const cells = splitBoxTableCells(nextText);
                    if (cells.length > 0) {
                        currentRowGroup.push(cells);
                    }
                }
                index += 1;
            }

            blocks.push({ type: "table", headerRows, bodyRows });
            continue;
        }

        if (
            currentLine?.kind === "runs"
            && Array.isArray(currentLine.runs)
            && currentLine.runs.length === 1
            && isBoxTopLine(currentText)
        ) {
            const language = extractCodeFenceLanguage(currentLine);
            const codeLines = [];
            index += 1;

            while (index < lines.length) {
                const nextLine = lines[index];
                const nextText = lineText(nextLine);
                if (isBoxBottomLine(nextText)) {
                    index += 1;
                    break;
                }
                if (isBoxContentLine(nextText)) {
                    codeLines.push(extractCodeFenceLine(nextLine));
                } else {
                    codeLines.push(lineText(nextLine));
                }
                index += 1;
            }

            if (index < lines.length && lineText(lines[index]).trim().length === 0) {
                index += 1;
            }

            blocks.push({
                type: "code",
                language: language || "text",
                content: codeLines.join("\n"),
            });
            continue;
        }

        if (
            currentLine?.kind === "runs"
            && Array.isArray(currentLine.runs)
            && currentLine.runs.length > 2
            && isBoxTopLine(currentText)
        ) {
            const headerRuns = extractFramedRuns(currentLine);
            const borderColor = currentLine.runs[0]?.color || "gray";
            const bodyLines = [];
            index += 1;

            while (index < lines.length) {
                const nextLine = lines[index];
                const nextText = lineText(nextLine);
                if (isBoxBottomLine(nextText)) {
                    index += 1;
                    break;
                }
                if (isBoxContentLine(nextText)) {
                    bodyLines.push(extractFramedRuns(nextLine));
                } else {
                    bodyLines.push(nextLine?.kind === "runs"
                        ? nextLine.runs
                        : [{ text: lineText(nextLine), color: nextLine?.color || null }]);
                }
                index += 1;
            }

            if (index < lines.length && lineText(lines[index]).trim().length === 0) {
                index += 1;
            }

            blocks.push({ type: "card", headerRuns, bodyLines, borderColor });
            continue;
        }

        blocks.push({ type: "line", line: currentLine });
        index += 1;
    }

    return blocks;
}

function StructuredChatBlocks({ lines, theme, controller = null }) {
    const blocks = React.useMemo(() => parseStructuredChatBlocks(lines), [lines]);
    return React.createElement(StructuredBlockList, { blocks, theme, controller });
}

// Rich (desktop-style) chat transcript. Consumes selectChatBlocks: plain
// user/assistant prose renders as proportional-type markdown messages;
// every other block (splash, thinking cards, system cards, epoch dividers)
// reuses the structured line renderer so the terminal-era special cases
// keep exactly one implementation.
/**
 * One rich message, memoized.
 *
 * The body runs markdown through MarkdownPreviewContent — the single most
 * expensive thing in the transcript — and a pane resize used to re-run it for
 * every loaded message. `selectChatBlocks` now returns identity-stable blocks,
 * so this bails out instead. Every prop must stay referentially stable for
 * that to hold: `theme` comes from a Map, `controller` is a singleton, and
 * `continued` is hoisted to a boolean because it depends on the PREVIOUS block
 * and would otherwise have to be recomputed inside.
 */
const RichChatMessage = React.memo(function RichChatMessage({ block, theme, controller, continued }) {
    const header = block.header || {};
    const roleClass = block.role === "user" ? " is-user" : " is-assistant";
    const pendingClass = block.pendingPhase ? ` is-${block.pendingPhase}` : "";
    const text = String(block.text || "");
    // A speaker label only earns its place when it disambiguates: another human
    // in a shared session. The viewer's own turns and the agent's are obvious
    // from side and styling.
    const showLabel = block.role === "user" && header.fromOtherPerson;
    return React.createElement("article", {
        className: `ps-rich-msg${roleClass}${pendingClass}${continued ? " is-continued" : ""}`,
    },
                    React.createElement("header", { className: "ps-rich-msg-head" },
                        showLabel
                            ? React.createElement("span", {
                                className: "ps-rich-msg-label",
                                style: { color: resolveColor(theme, header.roleColor) || undefined },
                            }, header.roleLabel)
                            : null,
                        // Delivery glyph + timestamp are on-demand detail:
                        // revealed on hover so a quiet transcript stays quiet.
                        React.createElement("span", { className: "ps-rich-msg-meta" },
                            header.glyph
                                ? React.createElement("span", {
                                    className: "ps-rich-msg-glyph",
                                    title: block.pendingPhase || undefined,
                                    style: { color: resolveColor(theme, header.glyphColor) || undefined },
                                }, header.glyph)
                                : null,
                            header.time
                                ? React.createElement("span", { className: "ps-rich-msg-time" }, header.time)
                                : null)),
                    text.trim()
                        ? React.createElement("div", { className: "ps-rich-msg-body" },
                            React.createElement(MarkdownPreviewContent, { content: text, theme }))
                        : null,
        block.attachments
            ? React.createElement(ArtifactImageStrip, {
                controller,
                sessionId: block.attachments.sessionId,
                attachments: block.attachments.attachments,
            })
            : null);
});

/** A non-message block (splash, system card, divider), memoized the same way. */
const RichChatLineBlock = React.memo(function RichChatLineBlock({ block, theme, controller }) {
    const lines = React.useMemo(() => normalizeLines(block.lines || []), [block.lines]);
    return React.createElement("div", {
        className: `ps-rich-lineblock is-${block.variant || "event"}`,
    }, React.createElement(StructuredChatBlocks, { lines, theme, controller }));
});

function RichChatBlocks({ blocks, theme, controller = null }) {
    return React.createElement("div", { className: "ps-rich-chat" },
        (blocks || []).map((block, index) => {
            if (block.kind === "message") {
                // Consecutive turns from the same speaker read as one
                // continuous passage — no repeated header, tighter spacing.
                // Computed here because it reads the previous block; passing it
                // down as a boolean is what keeps the child memoizable.
                const previous = blocks[index - 1];
                const header = block.header || {};
                const showLabel = block.role === "user" && header.fromOtherPerson;
                const continued = Boolean(previous
                    && previous.kind === "message"
                    && previous.role === block.role
                    && !(previous.header && previous.header.fromOtherPerson)
                    && !showLabel);
                return React.createElement(RichChatMessage, {
                    key: block.id != null ? `msg:${block.id}` : `msg:${index}`,
                    block,
                    theme,
                    controller,
                    continued,
                });
            }
            return React.createElement(RichChatLineBlock, {
                key: `lines:${index}`,
                block,
                theme,
                controller,
            });
        }));
}

// Authenticated artifact thumbnails: bytes are fetched through the transport
// (Bearer token) and served to <img> as object URLs. Module-level cache so
// scrolling the transcript doesn't refetch; oldest entries are revoked at cap.
const ARTIFACT_THUMB_CACHE = new Map();
const ARTIFACT_THUMB_CACHE_MAX = 60;

function fetchArtifactObjectUrl(controller, sessionId, filename) {
    const key = `${sessionId}/${filename}`;
    const cached = ARTIFACT_THUMB_CACHE.get(key);
    if (cached) {
        // Refresh LRU position.
        ARTIFACT_THUMB_CACHE.delete(key);
        ARTIFACT_THUMB_CACHE.set(key, cached);
        return cached;
    }
    const downloadResponse = controller?.transport?.api?.downloadArtifactResponse;
    if (typeof downloadResponse !== "function") {
        return Promise.reject(new Error("artifact download unavailable"));
    }
    const promise = downloadResponse.call(controller.transport.api, sessionId, filename)
        .then(async (response) => {
            if (!response?.ok) throw new Error(`download failed (${response?.status})`);
            const blob = await response.blob();
            return URL.createObjectURL(blob);
        })
        .catch((error) => {
            // Failed fetches must not be cached — a retry on next render is fine.
            if (ARTIFACT_THUMB_CACHE.get(key) === promise) ARTIFACT_THUMB_CACHE.delete(key);
            throw error;
        });
    ARTIFACT_THUMB_CACHE.set(key, promise);
    while (ARTIFACT_THUMB_CACHE.size > ARTIFACT_THUMB_CACHE_MAX) {
        const [oldestKey, oldest] = ARTIFACT_THUMB_CACHE.entries().next().value;
        ARTIFACT_THUMB_CACHE.delete(oldestKey);
        Promise.resolve(oldest).then((url) => URL.revokeObjectURL(url)).catch(() => {});
    }
    return promise;
}

function ArtifactImageStrip({ controller, sessionId, attachments }) {
    const [urls, setUrls] = React.useState({});
    React.useEffect(() => {
        if (!controller || !sessionId) return undefined;
        let cancelled = false;
        for (const attachment of attachments) {
            const filename = attachment?.filename;
            if (!filename) continue;
            fetchArtifactObjectUrl(controller, sessionId, filename)
                .then((url) => {
                    if (!cancelled) setUrls((prev) => (prev[filename] === url ? prev : { ...prev, [filename]: url }));
                })
                .catch(() => {
                    if (!cancelled) setUrls((prev) => (prev[filename] === "error" ? prev : { ...prev, [filename]: "error" }));
                });
        }
        return () => { cancelled = true; };
    }, [controller, sessionId, attachments]);

    return React.createElement("div", { className: "ps-chat-image-strip" },
        attachments.map((attachment, index) => {
            const filename = attachment?.filename || `image-${index}`;
            const url = urls[filename];
            if (url && url !== "error") {
                return React.createElement("img", {
                    key: `thumb:${index}:${filename}`,
                    className: "ps-chat-image-thumb",
                    src: url,
                    alt: filename,
                    title: `${filename} — click to view full size`,
                    onClick: () => { try { window.open(url, "_blank", "noopener"); } catch { /* popup blocked */ } },
                });
            }
            return React.createElement("div", {
                key: `thumb:${index}:${filename}`,
                className: `ps-chat-image-thumb is-pending${url === "error" ? " is-error" : ""}`,
                title: filename,
            }, url === "error" ? "⚠" : "🖼");
        }));
}

// Renders parsed chat blocks; sentinel card blocks recurse through this list
// so structured content (box/markdown tables, code fences) inside a card
// renders exactly the same as it does at top level.
function StructuredBlockList({ blocks, theme, controller = null }) {
    return React.createElement(React.Fragment, null,
        (blocks || []).map((block, index) => {
            if (block.type === "imageAttachments") {
                return React.createElement(ArtifactImageStrip, {
                    key: `imageAttachments:${index}`,
                    controller,
                    sessionId: block.sessionId,
                    attachments: block.attachments,
                });
            }
            if (block.type === "preserve") {
                const variantClass = block.splashVariant ? ` is-splash-${block.splashVariant}` : "";
                return React.createElement("div", { key: `preserve:${index}`, className: `ps-chat-preserve-block${variantClass}` },
                    block.lines.map((line, lineIndex) => React.createElement(Line, {
                        key: `preserve:${index}:${lineIndex}`,
                        line,
                        theme,
                        className: "ps-line-preserve",
                    })));
            }

            if (block.type === "code") {
                const chatIsDiff = isDiffLanguage(block.language);
                const chatCodeSection = React.createElement("section", {
                    key: `code:${index}`,
                    className: `ps-md-code-block ps-chat-code-block${chatIsDiff ? " is-diff" : ""}`,
                },
                    React.createElement("div", { className: "ps-md-code-header" }, block.language || "text"),
                    React.createElement("pre", { className: "ps-md-code-pre" },
                        React.createElement("code", null, chatIsDiff
                            ? renderDiffCode(block.content || "", theme)
                            : renderHighlightedCode(block.content || "", block.language, theme))));
                if (isMermaidLanguage(block.language)) {
                    return React.createElement(MermaidDiagram, {
                        key: `code:${index}`,
                        code: block.content || "",
                        theme,
                        fallback: chatCodeSection,
                    });
                }
                return chatCodeSection;
            }

            if (block.type === "card") {
                return React.createElement("section", {
                    key: `card:${index}`,
                    className: "ps-chat-card",
                    style: { "--ps-chat-card-accent": resolveColor(theme, block.borderColor) || "var(--ps-border)" },
                },
                React.createElement("header", { className: "ps-chat-card-header" },
                    React.createElement(Runs, { runs: block.headerRuns, theme })),
                React.createElement("div", { className: "ps-chat-card-body" },
                    Array.isArray(block.blocks)
                        ? React.createElement(StructuredBlockList, { blocks: block.blocks, theme, controller })
                        : (block.bodyLines || []).map((bodyRuns, bodyIndex) => React.createElement("div", {
                            key: `card:${index}:line:${bodyIndex}`,
                            className: "ps-chat-card-line",
                        }, React.createElement(Runs, { runs: bodyRuns, theme })) )));
            }

            if (block.type === "table") {
                const headerRows = block.headerRows || [];
                const bodyRows = block.bodyRows || [];
                const columnCount = Math.max(
                    1,
                    ...headerRows.map((row) => row.length),
                    ...bodyRows.map((row) => row.length),
                );
                const fitToWidth = columnCount <= 6;
                // Default: rely on the browser's auto-table-layout under
                // fit-content for short / uniform tables (best
                // proportional sizing). When one column has long prose
                // (Mechanism / Description / Notes), auto-layout squeezes
                // the rigid columns; computeFitWidthColumnLayout picks a
                // flex column and assigns explicit widths so the rigid
                // columns stay at content-fit and the flex column wraps to
                // absorb the remainder.
                const layout = fitToWidth
                    ? computeFitWidthColumnLayout([...headerRows, ...bodyRows])
                    : null;
                const hasFlexColumn = !!layout;
                const flexIndex = layout ? layout.flexIndex : -1;
                const cellClass = (cellIndex) => (cellIndex === flexIndex ? "is-flex-column" : null);
                const columnLabels = buildTableColumnLabels(headerRows, columnCount);
                const tableClass = `ps-chat-table${fitToWidth ? " is-fit-width" : ""}${hasFlexColumn ? " has-flex-column" : ""}`;
                const wrapClass = `ps-chat-table-wrap${fitToWidth ? " is-fit-width" : ""}${hasFlexColumn ? " has-flex-column" : ""}`;
                return React.createElement("div", {
                    key: `table:${index}`,
                    className: wrapClass,
                },
                    React.createElement("table", {
                        className: tableClass,
                        style: layout?.minWidth ? { "--ps-table-min-width": layout.minWidth } : undefined,
                    },
                        layout
                            ? React.createElement("colgroup", null,
                                layout.widths.map((width, columnIndex) => React.createElement("col", {
                                    key: `col:${columnIndex}`,
                                    className: cellClass(columnIndex) || undefined,
                                    style: { width },
                                })))
                            : null,
                        headerRows.length > 0
                            ? React.createElement("thead", null,
                                headerRows.map((row, rowIndex) => React.createElement("tr", { key: `thead:${rowIndex}` },
                                    Array.from({ length: columnCount }, (_, cellIndex) => React.createElement("th", {
                                        key: `th:${rowIndex}:${cellIndex}`,
                                        className: cellClass(cellIndex) || undefined,
                                    },
                                        renderInlineMarkdown(row[cellIndex] || "", theme, `chat-table:${index}:head:${rowIndex}:${cellIndex}`))))))
                            : null,
                        React.createElement("tbody", null,
                            bodyRows.map((row, rowIndex) => React.createElement("tr", { key: `tbody:${rowIndex}` },
                                Array.from({ length: columnCount }, (_, cellIndex) => React.createElement("td", {
                                    key: `td:${rowIndex}:${cellIndex}`,
                                    className: cellClass(cellIndex) || undefined,
                                    "data-label": columnLabels[cellIndex] || undefined,
                                },
                                    React.createElement("span", { className: "ps-table-cell-value" },
                                        renderInlineMarkdown(row[cellIndex] || "", theme, `chat-table:${index}:${rowIndex}:${cellIndex}`)))))))));
            }

            return React.createElement(Line, { key: `line:${index}`, line: block.line, theme });
        }));
}

// Pane titles carry terminal-style bracketed runs (" [+3]", " [5f086c7c]").
// The rich view keeps the information but drops the brackets — a web title
// bar shows a count and an id, it does not draw them in ASCII delimiters.
function unbracketTitleRuns(runs) {
    if (!Array.isArray(runs)) return runs;
    return runs.map((run) => {
        const text = String(run?.text ?? "");
        const match = /^(\s*)\[(.+)\](\s*)$/.exec(text);
        if (!match) return run;
        return { ...run, text: `${match[1]}${match[2]}${match[3]}` };
    });
}

function Panel({ title, titleRight = null, color = "gray", focused = false, actions = null, children, theme, className = "" }) {
    const accent = resolveColor(theme, color);
    // A panel with nothing to put in its header should not render one. Nested
    // panels (the artifact list and preview inside Files) were spending a full
    // header row restating what the enclosing pane already said.
    const hasHeader = Boolean(
        (Array.isArray(title) ? title.length > 0 : String(title ?? "").trim())
        || titleRight
        || actions,
    );
    return React.createElement("section", {
        className: `ps-panel${focused ? " is-focused" : ""}${hasHeader ? "" : " is-chromeless"}${className ? ` ${className}` : ""}`,
        style: { "--ps-panel-accent": accent || "var(--ps-border)" },
    },
    hasHeader ? React.createElement("header", { className: "ps-panel-header" },
        React.createElement("div", { className: "ps-panel-title" },
            Array.isArray(title)
                ? React.createElement(Runs, { runs: title, theme })
                : flattenTitleText(title)),
        titleRight || actions
            ? React.createElement("div", { className: "ps-panel-header-right" },
                titleRight
                    ? React.createElement("div", { className: "ps-panel-title-right" },
                        Array.isArray(titleRight)
                            ? React.createElement(Runs, { runs: titleRight, theme })
                            : flattenTitleText(titleRight))
                    : null,
                actions ? React.createElement("div", { className: "ps-panel-actions" }, actions) : null,
            )
            : null,
    ) : null,
    React.createElement("div", { className: "ps-panel-body" }, children));
}

/**
 * Node Map body: the shared lines, with node rows made clickable. A run
 * carrying `nodeSelect` marks its whole line as a node row — clicking
 * selects (or toggle-clears) that node, which also scopes the Activity pane.
 */
function PortalNodeMapLines({ lines, theme, controller }) {
    return React.createElement("div", { className: "ps-nodemap" },
        (lines || []).map((line, index) => {
            // ScrollLinesPanel normalizes every line to {kind:"runs", runs}
            // before renderBody — unwrap that shape first, then tolerate the
            // raw array/object shapes for direct (test) rendering.
            const runs = Array.isArray(line?.runs) ? line.runs : Array.isArray(line) ? line : [line];
            const nodeSelect = runs.find((run) => run?.nodeSelect)?.nodeSelect || null;
            const nodeSelected = runs.some((run) => run?.nodeSelected);
            const content = React.createElement(Runs, { runs, theme });
            if (nodeSelect) {
                return React.createElement("button", {
                    key: `line:${index}`,
                    type: "button",
                    className: `ps-nodemap__row${nodeSelected ? " is-selected" : ""}`,
                    // pointerdown, not click: the pane claims focus on
                    // mousedown, and any resulting re-render must not be able
                    // to eat the click before mouseup lands.
                    onPointerDown: (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        controller.selectNodeMapNode(nodeSelect);
                    },
                }, content);
            }
            return React.createElement("div", { key: `line:${index}`, className: "ps-nodemap__line" }, content);
        }));
}

function PortalSequenceLines({ lines, theme, completionByTurn }) {
    const [expanded, setExpanded] = React.useState(() => new Set());
    const toggle = React.useCallback((key) => {
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);
    const compactNumber = (value) => Number(value || 0).toLocaleString("en-US");
    const formatTokenK = (value) => {
        const tokens = Number(value || 0);
        if (!Number.isFinite(tokens)) return "?K";
        const scaled = tokens / 1000;
        const decimals = Math.abs(scaled) >= 10 ? 1 : 2;
        return `${scaled.toFixed(decimals)}K`;
    };
    const formatDurationSeconds = (value) => {
        const ms = Number(value || 0);
        if (!Number.isFinite(ms)) return "?s";
        return `${(ms / 1000).toFixed(1)}s`;
    };
    const shortModelOnly = (value) => {
        const model = String(value || "").trim();
        if (!model) return "unknown";
        const parts = model.split(":").filter(Boolean);
        const last = parts[parts.length - 1] || "";
        const modelIndex = parts.length > 1 && REASONING_EFFORT_LABELS.has(last.toLowerCase())
            ? parts.length - 2
            : parts.length - 1;
        const maybeModel = parts[Math.max(0, modelIndex)] || parts[0];
        return maybeModel || "unknown";
    };

    return React.createElement(React.Fragment, null,
        lines.map((line, index) => {
            // The selector tags the completed-turn run structurally; the display
            // text is width-truncated in narrow columns, so never regex it.
            const completedTurn = line?.kind === "runs" && Array.isArray(line.runs)
                ? line.runs.find((run) => run?.completedTurn != null)?.completedTurn
                : null;
            const completion = completedTurn != null ? completionByTurn.get(Number(completedTurn)) : null;
            if (!completion) {
                return React.createElement(Line, { key: `line:${index}`, line, theme });
            }
            const data = completion.data || {};
            const key = String(completion.seq ?? `${data.turnIndex ?? completedTurn}:${completion.createdAt ?? index}`);
            const isExpanded = expanded.has(key);
            const fullModelLabel = data.reasoningEffort ? `${data.model || "(unknown)"}:${data.reasoningEffort}` : (data.model || "(unknown)");
            const modelLabel = shortModelOnly(data.model);
            const duration = data.durationMs != null ? formatDurationSeconds(data.durationMs) : "duration n/a";
            const durationDetail = data.durationMs != null ? `${compactNumber(data.durationMs)} ms` : "duration n/a";
            const tokens = `${formatTokenK(data.tokensInput)} / ${formatTokenK(data.tokensOutput)}`;
            const details = [
                ["model", fullModelLabel],
                ["started", data.startedAt ? new Date(data.startedAt).toLocaleString() : null],
                ["ended", data.endedAt ? new Date(data.endedAt).toLocaleString() : null],
                ["duration", durationDetail],
                ["tokens", `${compactNumber(data.tokensInput)} in / ${compactNumber(data.tokensOutput)} out`],
                ["cache", `${compactNumber(data.tokensCacheRead)} read / ${compactNumber(data.tokensCacheWrite)} write`],
                ["tools", `${compactNumber(data.toolCalls)} calls / ${compactNumber(data.toolErrors)} errors`],
                ["names", Array.isArray(data.toolNames) && data.toolNames.length ? data.toolNames.join(", ") : null],
                ["worker", data.workerNodeId || null],
                ["result", data.resultType || null],
                ["error", data.errorMessage || null],
            ].filter(([, value]) => value != null && value !== "");
            return React.createElement(React.Fragment, { key: `seq:${index}` },
                React.createElement(Line, { line, theme }),
                React.createElement("button", {
                    type: "button",
                    className: "ps-sequence-turn-divider",
                    onClick: () => toggle(key),
                },
                    React.createElement("span", { className: "ps-sequence-turn-caret" }, isExpanded ? "v" : ">"),
                    React.createElement("span", { className: "ps-sequence-turn-rule" }, "--- "),
                    React.createElement("span", { className: "ps-sequence-turn-key" }, "Mod: "),
                    React.createElement("span", { className: "ps-sequence-turn-model" }, modelLabel),
                    React.createElement("span", { className: "ps-sequence-turn-rule" }, " ("),
                    React.createElement("span", { className: "ps-sequence-turn-key" }, "tok: "),
                    React.createElement("span", { className: "ps-sequence-turn-tokens" }, tokens),
                    React.createElement("span", { className: "ps-sequence-turn-rule" }, ", "),
                    React.createElement("span", { className: "ps-sequence-turn-key" }, "dur: "),
                    React.createElement("span", { className: "ps-sequence-turn-duration" }, duration),
                    React.createElement("span", { className: "ps-sequence-turn-rule" }, ") ---"),
                ),
                isExpanded
                    ? React.createElement("div", { className: "ps-sequence-turn-details" },
                        details.map(([label, value]) => React.createElement("div", { key: label },
                            React.createElement("span", { className: "ps-sequence-turn-detail-label" }, `${label}: `),
                            React.createElement("span", null, String(value)),
                        )))
                    : null,
            );
        }),
    );
}


/**
 * Which focus region owns a scrollable pane.
 *
 * Keyboard scrolling already routes through focusRegion
 * (controller.getScrollablePaneForFocus), but nothing set the focus when you
 * CLICKED a pane — so the scroll keys kept acting on whatever was focused
 * last. Clicking into a scrollable pane now claims the keys for it.
 */
const PANE_KEY_FOCUS_REGIONS = {
    chat: "chat",
    activity: "activity",
    inspector: "inspector",
    // The preview is reached through the inspector's Files tab, and the
    // controller maps inspector-focus + files-tab back to filePreview.
    filePreview: "inspector",
};

function focusRegionForPaneKey(paneKey, override = null) {
    // The DETACHED preview sits in the activity slot, so clicking it must claim
    // activity focus — that is what distinguishes "clicked the preview" from
    // "clicked the artifact list", which keeps inspector focus and drives the
    // selection with the same keys.
    if (override) return override;
    return PANE_KEY_FOCUS_REGIONS[String(paneKey || "")] || null;
}

function ScrollLinesPanel({ title, titleRight = null, color, focused, actions, lines, stickyLines = [], bottomStickyLines = [], scrollOffset = 0, scrollMode = "top", paneKey, controller, className = "", panelClassName = "", topContent = null, bottomContent = null, structuredBlocks = false, stickyBottom = false, renderBody = null, focusRegion = null }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const ref = React.useRef(null);
    const stickyRef = React.useRef(null);
    const syncingHorizontalRef = React.useRef(false);
    const { normalizedLines, onScroll, onWheel, onTouchStart, onTouchMove, onTouchEnd } = useScrollSync(ref, lines, scrollOffset, scrollMode, paneKey, controller, { stickyBottom });
    const normalizedSticky = React.useMemo(() => normalizeLines(stickyLines), [stickyLines]);
    const normalizedBottomSticky = React.useMemo(() => normalizeLines(bottomStickyLines), [bottomStickyLines]);
    const preserveHorizontalScroll = className.includes("is-preserve") && panelClassName.includes("has-preserved-sticky");

    // Clicking (or touching) a scrollable pane makes the keyboard scroll keys
    // act on THAT pane. Fires on mousedown rather than click so a drag-select
    // inside the pane claims focus too.
    // Mouse only. On touch this fired on every tap, and setFocus runs the
    // region through normalizeFocusRegion, which rewrites a region missing
    // from the current layout to order[0] — so tapping the chat on a phone
    // was silently reassigning focus to the inspector and jumping to the
    // artifact list. Keyboard scroll targeting is meaningless on touch anyway.
    const claimFocus = React.useCallback(() => {
        const region = focusRegionForPaneKey(paneKey, focusRegion);
        if (region && controller?.setFocus) controller.setFocus(region);
    }, [controller, paneKey, focusRegion]);

    const syncScrollLeft = React.useCallback((source, target) => {
        if (!source || !target) return;
        if (Math.abs((target.scrollLeft || 0) - (source.scrollLeft || 0)) <= 1) return;
        syncingHorizontalRef.current = true;
        target.scrollLeft = source.scrollLeft;
        window.requestAnimationFrame(() => {
            syncingHorizontalRef.current = false;
        });
    }, []);

    // Edge fades follow real overflow: fade the TOP only when content is
    // clipped above (scrolled down) and the BOTTOM only when clipped below
    // (scrolled up). With content that fits, neither fades — the first and
    // last lines stay crisp.
    const [scrollShadow, setScrollShadow] = React.useState({ up: false, down: false });
    const updateScrollShadow = React.useCallback((el) => {
        if (!el) return;
        const up = el.scrollHeight - el.scrollTop - el.clientHeight > 4;
        const down = el.scrollTop > 4;
        setScrollShadow((cur) => (cur.up === up && cur.down === down ? cur : { up, down }));
    }, []);
    const handleBodyScroll = React.useCallback((event) => {
        onScroll();
        updateScrollShadow(event.currentTarget);
        if (!preserveHorizontalScroll || syncingHorizontalRef.current) return;
        syncScrollLeft(event.currentTarget, stickyRef.current);
    }, [onScroll, preserveHorizontalScroll, syncScrollLeft, updateScrollShadow]);
    React.useEffect(() => {
        updateScrollShadow(ref.current);
    });

    const handleStickyScroll = React.useCallback((event) => {
        if (!preserveHorizontalScroll || syncingHorizontalRef.current) return;
        syncScrollLeft(event.currentTarget, ref.current);
    }, [preserveHorizontalScroll, syncScrollLeft]);

    return React.createElement(Panel, { title, titleRight, color, focused, actions, theme, className: panelClassName },
        topContent,
        normalizedSticky.length > 0
            ? React.createElement("div", {
                ref: stickyRef,
                className: `ps-panel-sticky${preserveHorizontalScroll ? " is-scroll-sync" : ""}`,
                onScroll: handleStickyScroll,
            },
                normalizedSticky.map((line, index) => React.createElement(Line, { key: `sticky:${index}`, line, theme })),
            )
            : null,
        React.createElement("div", { ref, className: `ps-scroll-panel ${className}${scrollShadow.down ? " is-scrolled-down" : ""}${scrollShadow.up ? " is-scrolled-up" : ""}`.trim(), "data-session-scroll": focusRegion === "sessions" ? "1" : undefined, onScroll: handleBodyScroll, onMouseDown: claimFocus, onTouchStart, onWheel, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd },
            typeof renderBody === "function"
                ? renderBody(normalizedLines, theme)
                : structuredBlocks
                ? React.createElement(StructuredChatBlocks, { lines: normalizedLines, theme, controller })
                : normalizedLines.map((line, index) => React.createElement(Line, { key: `line:${index}`, line, theme })),
        ),
        normalizedBottomSticky.length > 0
            ? React.createElement("div", {
                className: "ps-panel-bottom-sticky",
            },
                normalizedBottomSticky.map((line, index) => React.createElement(Line, { key: `bottom-sticky:${index}`, line, theme })),
            )
            : null,
        bottomContent);
}

// Rich (desktop-style) session row: a status dot instead of a glyph, the
// title in proportional type, and the id/age/model metadata demoted to a
// muted second line under the selected row. Depth becomes real indentation
// with a guide rail rather than an ASCII "└" prefix.
const SESSION_KIND_GLYPHS = { group: "🗂", system: "⚙", service: "⚗" };

/**
 * Selected-session details, pinned to the bottom of the Sessions panel.
 *
 * This exists so the ROWS can stay one clean line each. Everything that used
 * to unfold under the selected row (and, in the rich list, under every row)
 * lives here instead, at a fixed spot the eye can return to — so switching
 * sessions no longer reflows the list.
 *
 * Web-only by construction: the TUI renders `row.detailRuns` itself and is
 * untouched by this.
 */
const SESSION_DETAIL_NONE = "—";

function SessionDetailBox({ session, childCount = 0 }) {
    // EVERY field renders on EVERY selection, empty ones as an em dash. The box
    // is a fixed grid of rows, so moving through the list cannot change its
    // height — a box that grew and shrank would shove the list under the
    // cursor mid-scroll. That is also why each value is a single clamped line.
    const field = (label, value, extraClass = "") => {
        const text = (value == null || value === "") ? SESSION_DETAIL_NONE : String(value);
        const empty = text === SESSION_DETAIL_NONE;
        return React.createElement("div", {
            className: `ps-session-detail-field${extraClass ? ` ${extraClass}` : ""}${empty ? " is-none" : ""}`,
            key: label,
        },
            React.createElement("span", { className: "ps-session-detail-label" }, label),
            React.createElement("span", { className: "ps-session-detail-value", title: text }, text));
    };

    const usage = session?.contextUsage;
    const hasUsage = usage && Number.isFinite(usage.currentTokens) && Number.isFinite(usage.tokenLimit) && usage.tokenLimit > 0;
    const percent = hasUsage ? Math.round((usage.currentTokens / usage.tokenLimit) * 100) : null;
    const context = hasUsage
        ? `${formatCompactNumber(usage.currentTokens)} / ${formatCompactNumber(usage.tokenLimit)} · ${percent}%`
        : null;

    // "Cron vs not" is a question the list could only answer with a glyph, so
    // spell it out — an unscheduled session says "off" rather than going blank,
    // which would be indistinguishable from "unknown".
    let cron = null;
    if (session && !session.isGroup) {
        cron = "off";
        if (session.cronActive === true) {
            cron = session.cronKind === "wall-clock"
                ? `next ${formatCronTimestampForClient(session.cronNextFireAt)}`
                : typeof session.cronInterval === "number"
                    ? `every ${formatHumanDurationSeconds(session.cronInterval)}`
                    : "on";
        }
    }

    const model = session?.model
        ? (session.reasoningEffort && !String(session.model).includes(String(session.reasoningEffort))
            ? `${session.model}:${session.reasoningEffort}`
            : session.model)
        : null;

    const access = !session ? null
        : session.visibility === "shared_write" ? "shared · write"
            : session.visibility === "shared_read" ? "shared · read"
                : "private";

    // Groups have members rather than descendants; both answer "how many are
    // under this row", so they share the field.
    const children = session?.isGroup
        ? (session.memberCount == null ? null : String(session.memberCount))
        : (childCount > 0 ? String(childCount) : null);

    return React.createElement("div", { className: "ps-session-detail-box" },
        // The row above ellipsizes to one line, so this is the only place the
        // whole name is legible. Two lines are RESERVED whether or not they are
        // used, so the box height still cannot move with the selection.
        field("Title", session?.title, "is-title"),
        field("ID", session?.sessionId, "is-id"),
        field("Model", model),
        field("Context", context, percent != null && percent >= 85 ? "is-hot" : percent != null && percent >= 70 ? "is-warm" : ""),
        field("Cron", cron, session?.cronActive === true ? "is-armed" : ""),
        field("Agent", session?.agentId),
        field("Status", session?.status),
        field("Children", children),
        field("Access", access));
}

/**
 * One session row, memoized.
 *
 * The list re-renders whenever the selection moves, but `selectSessionRows`
 * hands back the SAME row object for every row whose inputs did not change, so
 * memoizing here means a keypress reconciles two rows instead of the whole
 * fleet. That only holds while every prop is referentially stable — hence the
 * hoisted click handler and ref setter rather than closures built per row.
 */
/**
 * True when the primary input is a finger. Drag-to-folder is armed on
 * pointerdown and needs `touch-action: none` to receive a move stream — which
 * on a touch screen also means the list can no longer be scrolled by dragging
 * it, so the gesture is withheld there entirely.
 */
function useCoarsePointer() {
    const query = "(pointer: coarse)";
    const read = () => (typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(query).matches
        : false);
    const [coarse, setCoarse] = React.useState(read);
    React.useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
        const media = window.matchMedia(query);
        const onChange = (event) => setCoarse(event.matches);
        media.addEventListener?.("change", onChange);
        return () => media.removeEventListener?.("change", onChange);
    }, []);
    return coarse;
}

const RAIL_ORIGIN_PX = 13;
const RAIL_STEP_PX = 11;
const RAIL_WIDTH_PX = 1.5;
// A nested row's status mark sits ON its deepest rail, so the branch reads as
// one continuous thread with a node per member rather than a stack of
// separate glyphs. Ring, not disc: the ring says "on the thread", and it keeps
// the top-level disc meaning "root" at a glance.
const RAIL_NODE_SIZE_PX = 7;

function railNodeInsetPx(depth) {
    return RAIL_ORIGIN_PX + ((depth - 1) * RAIL_STEP_PX) + (RAIL_WIDTH_PX / 2) - (RAIL_NODE_SIZE_PX / 2);
}

const SessionListRow = React.memo(function SessionListRow({
    row, theme, rich, structuredRows, mobile, onRowClick, setRef, drag,
}) {
    const depth = Math.max(0, row.depth);
    const railStyle = React.useMemo(() => {
        if (depth < 1) return undefined;
        const levels = Array.from({ length: depth }, (_, level) => level);
        return {
            backgroundImage: levels.map(() => "linear-gradient(var(--ps-rail), var(--ps-rail))").join(", "),
            backgroundSize: levels.map(() => `${RAIL_WIDTH_PX}px 100%`).join(", "),
            backgroundPosition: levels.map((level) => `${RAIL_ORIGIN_PX + (level * RAIL_STEP_PX)}px 0`).join(", "),
            backgroundRepeat: "no-repeat",
        };
    }, [depth]);
    const ref = React.useCallback((node) => setRef(row.sessionId, node), [setRef, row.sessionId]);
    const onClick = React.useCallback((event) => onRowClick(event, row), [onRowClick, row]);
    // Pointer-based dragging: HTML5 drag never fired reliably from these
    // <button> rows, and it cannot render the "N sessions" collection ghost
    // or a live destination highlight. Pointer events give both.
    // A folder's drop zone is its WHOLE expanded region — the folder row and
    // every row nested under it — so releasing over a member files alongside
    // that member rather than falling through to "remove from folder".
    //
    // Both sides of this comparison must be the BARE group id: row.sessionId
    // for a folder is the prefixed row id ("group:<uuid>") while overGroupId
    // comes off the DOM as the raw uuid, so matching on sessionId meant the
    // destination highlight never once rendered.
    const dropGroupId = row.groupId || null;
    const inDropZone = Boolean(drag?.dragging && drag.overGroupId && dropGroupId === drag.overGroupId);
    const isDropTarget = inDropZone && Boolean(row.isGroup);
    // The insertion line: a 2px rule above the row the dragged one would land
    // before. Rendered on the ROW rather than as a floating element so it
    // tracks the list as it scrolls, including during auto-scroll.
    const insertBefore = Boolean(drag?.dragging && drag.insertBeforeId === row.sessionId);
    // Dropping at the END of a list: the line goes UNDER the final sibling,
    // because there is no following row to sit above.
    const insertAfter = Boolean(drag?.dragging && drag.insertAfterId && drag.insertAfterId === row.sessionId);
    const onPointerDown = React.useCallback((event) => {
        // No drag handlers (mobile) → no gesture to claim. Capturing the
        // pointer there would swallow the touch that should scroll the list.
        if (!drag?.onPointerDown) return;
        if (event.button !== 0) return;
        // Claim the gesture: without this the browser can start a native
        // selection/element drag on the button and never deliver pointermove.
        if (event.currentTarget?.setPointerCapture && event.pointerId != null) {
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
        }
        drag.onPointerDown(event, row);
    }, [drag, row]);

    return React.createElement("button", {
        type: "button",
        ref,
        className: `ps-list-button ps-session-list-button${row.active ? " is-selected" : ""}${row.selected ? " is-multiselected" : ""}${row.pinned ? " is-pinned" : ""}${inDropZone ? " is-drop-zone" : ""}${isDropTarget ? " is-drop-target" : ""}${insertBefore ? " is-insert-before" : ""}${insertAfter ? " is-insert-after" : ""}${row.depth > 0 ? " is-nested" : ""}`,
        // Guide rails: one hairline per ancestor level, painted as background
        // images so each row covers its OWN full height and the levels join
        // into continuous lines down the branch. No wrapper element, so the
        // list stays a flat row sequence.
        style: railStyle,
        tabIndex: row.active ? 0 : -1,
        "aria-selected": row.active ? "true" : "false",
        "data-session-id": row.sessionId,
        "data-group-row": row.isGroup ? "1" : undefined,
        // The RAW group id: row ids are prefixed ("group:<uuid>") and the
        // placement API takes the bare uuid. Passing the row id silently
        // targeted a group that does not exist.
        "data-group-id": row.isGroup ? (row.groupId || "") : undefined,
        // Every row that BELONGS to a folder advertises it too, so the hit
        // test can resolve a destination from anywhere in the folder's region.
        "data-drop-group": dropGroupId || undefined,
        // Which sibling list this row sorts in. Reordering only ever compares
        // siblings, so the drop hit-test uses this to tell "put it here" from
        // "file it into that folder": a matching container means reorder, a
        // different one means the folder gesture the drag already had.
        //   ""            top-level session
        //   "folders"     a folder row (folders reorder among themselves)
        //   "g:<uuid>"    a session inside that folder
        // Sub-agents get no key — they are not movable and must not be a
        // drop target for ordering either.
        "data-order-container": row.orderContainer ?? undefined,
        "data-orderable": row.orderable ? "1" : undefined,
        onPointerDown,
        onClick,
        // macOS turns Ctrl+click into a context-menu event, so the click
        // handler never sees it. Treat it as the multi-select modifier the
        // user actually pressed.
        onContextMenu: (event) => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            onRowClick(event, row);
        },
    },
        React.createElement("div", {
            className: rich ? "ps-session-row-content is-rich" : "ps-line ps-session-row-content",
            style: {
                // Nested content starts where its node mark does, so the mark
                // lands centred on the deepest rail and the text clears it.
                paddingInlineStart: depth > 0 ? `${railNodeInsetPx(depth)}px` : "0px",
            },
        },
            rich
                ? React.createElement(RichSessionRow, { row, theme, showDetail: mobile })
                : React.createElement(SessionRowContent, {
                    row, theme, structured: structuredRows, showInlineDetail: mobile,
                })));
});

function RichSessionRow({ row, theme, showDetail = false }) {
    const chrome = row.chrome;
    if (!chrome) return React.createElement(SessionRowContent, { row, theme, structured: true, showInlineDetail: showDetail });

    const kindGlyph = SESSION_KIND_GLYPHS[chrome.kind] || null;
    const accent = resolveColor(theme, chrome.accentColor) || undefined;
    // Mobile has no room for a detail box, so it keeps the inline detail line
    // it always had. Desktop moves that content to the panel footer.
    const detailRuns = showDetail && Array.isArray(row.detailRuns) ? row.detailRuns : [];

    return React.createElement("div", { className: "ps-rich-session-row" },
        React.createElement("div", { className: "ps-rich-session-main" },
            chrome.selectMode
                ? React.createElement("span", {
                    className: `ps-rich-session-check${chrome.checked ? " is-checked" : ""}`,
                }, chrome.checked ? "✓" : "")
                : null,
            kindGlyph
                ? React.createElement("span", { className: "ps-rich-session-kind" }, kindGlyph)
                : React.createElement("span", {
                    className: `ps-rich-session-dot${row.depth > 0 ? " is-node" : ""}`,
                    style: row.depth > 0
                        ? { borderColor: resolveColor(theme, chrome.statusColor) || undefined }
                        : { background: resolveColor(theme, chrome.statusColor) || undefined },
                    title: row.status || undefined,
                }),
            chrome.owner
                ? React.createElement("span", {
                    className: `ps-rich-session-owner${chrome.owner.isMine ? " is-mine" : ""}`,
                    title: chrome.owner.initials,
                }, chrome.owner.initials)
                : null,
            React.createElement("span", {
                className: `ps-rich-session-title${chrome.untitled ? " is-untitled" : ""}`,
                style: chrome.kind === "session" ? undefined : { color: accent },
                title: chrome.title,
            }, chrome.title),
            chrome.pinned ? React.createElement("span", { className: "ps-rich-session-pin", title: "Pinned" }, React.createElement(PinGlyph)) : null,
            chrome.cron ? React.createElement("span", { className: "ps-rich-session-cron", title: "Scheduled" }, "⏱") : null,
            chrome.childBadge
                ? React.createElement("span", {
                    className: "ps-rich-session-count",
                    style: { color: resolveColor(theme, chrome.childBadge.color) || undefined },
                }, chrome.childBadge.text)
                : null,
            chrome.ctx
                ? React.createElement("span", {
                    className: "ps-rich-session-ctx",
                    style: { color: resolveColor(theme, chrome.ctx.color) || undefined },
                }, chrome.ctx.text)
                : null),
        detailRuns.length > 0
            ? React.createElement("div", { className: "ps-rich-session-detail" },
                React.createElement(Runs, { runs: detailRuns, theme }))
            : null);
}

/**
 * Portal row prefix: drop the "└ " depth glyph (the guide rail says it, and
 * better — a rail shows a branch that CONTINUES, which the glyph cannot), and
 * lift the status run out so it can be drawn as a dot instead of "~" / "*",
 * which is unreadable without a legend.
 *
 * Both runs are tagged by the selector precisely so a host can do this; the
 * TUI renders text+colour, ignores the tags, and keeps its glyphs.
 */
function portalRowRuns(runs, theme) {
    if (!Array.isArray(runs)) return { statusColor: null, rest: runs };
    let statusColor = null;
    const rest = [];
    for (const run of runs) {
        if (run?.role === "depth") continue;
        if (run?.role === "status") {
            statusColor = resolveColor(theme, run.color) || null;
            continue;
        }
        rest.push(run);
    }
    return { statusColor, rest };
}

function StatusDot({ color, node = false }) {
    return React.createElement("span", {
        className: `ps-session-status-dot${node ? " is-node" : ""}`,
        style: color ? (node ? { borderColor: color } : { background: color }) : undefined,
    });
}

/**
 * Owner avatar: a monogram disc, the shape people already read as "who"
 * in a mail client. Colour carries the identity (two-letter initials
 * collide constantly); the ring marks the viewer's own rows.
 *
 * ONE component for both lists — sessions and agent packages — so the same
 * person cannot look like two different people in two panes.
 */
function OwnerAvatar({ badge, size = "sm" }) {
    if (!badge) return null;
    return React.createElement("span", {
        className: `ps-owner-avatar is-${size}${badge.isMine ? " is-mine" : ""}`,
        "data-owner-hue": String(badge.hue ?? 0),
        title: badge.isMine ? `${badge.name} (you)` : badge.name,
        "aria-label": badge.name,
    }, badge.initials);
}

/** Drop the TUI-only text chip; the portal draws OwnerAvatar instead. */
function withoutOwnerChip(runs) {
    return Array.isArray(runs) ? runs.filter((run) => !run?.ownerChip) : runs;
}
function SessionRowContent({ row, theme, structured = false, showInlineDetail = false }) {
    const hasStructuredRuns = structured && Array.isArray(row.titleRuns);
    if (!hasStructuredRuns) {
        if (!Array.isArray(row.runs)) return row.text;
        const plain = portalRowRuns(withoutOwnerChip(row.runs), theme);
        return React.createElement(React.Fragment, null,
            plain.statusColor ? React.createElement(StatusDot, { color: plain.statusColor, node: row.depth > 0 }) : null,
            React.createElement(OwnerAvatar, { badge: row.ownerBadge }),
            React.createElement("span", { className: "ps-session-row-title__text" },
                React.createElement(Runs, { runs: plain.rest, theme })));
    }

    // Dense row: the title takes one line (clamped by CSS) and the context %
    // is pinned to the right. id · time · model · ctx now live in the panel's
    // detail box rather than unfolding under the row, so selecting a session
    // no longer reflows the list.
    const title = portalRowRuns(withoutOwnerChip(row.titleRuns), theme);
    const ctxRuns = Array.isArray(row.ctxRuns) ? row.ctxRuns : [];
    const hasCtx = ctxRuns.length > 0;
    // Mobile keeps the inline unfold under the selected row (no detail box).
    const detailRuns = Array.isArray(row.detailRuns)
        ? row.detailRuns
        : (Array.isArray(row.selectedMetaRuns) ? row.selectedMetaRuns : []);
    const hasDetail = showInlineDetail && row.active && detailRuns.length > 0;

    return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "ps-session-row-line" },
            React.createElement("div", { className: "ps-session-row-title" },
                title.statusColor ? React.createElement(StatusDot, { color: title.statusColor, node: row.depth > 0 }) : null,
                React.createElement(OwnerAvatar, { badge: row.ownerBadge }),
                // Runs wrapped in ONE element: the title is a flex row so the
                // avatar centres against the text, and the runs keep normal
                // inline flow inside the wrapper. Flexing the runs directly
                // collapses the whitespace BETWEEN them and silently narrows
                // the title (measured: 225.8px → 210.8px).
                React.createElement("span", { className: "ps-session-row-title__text" },
                    React.createElement(Runs, { runs: title.rest, theme }))),
            hasCtx
                ? React.createElement("div", { className: "ps-session-row-ctx" },
                    React.createElement(Runs, { runs: ctxRuns, theme }))
                : null),
        hasDetail
            ? React.createElement("div", { className: "ps-session-row-detail" },
                React.createElement(Runs, { runs: detailRuns, theme }))
            : null);
}

/**
 * Reuse the previous value when a freshly computed one is deep-equal.
 *
 * The session poll rebuilds sessions.byId whenever ANY session's updatedAt or
 * iteration count moves, which invalidates every downstream memo and re-renders
 * the whole list — visibly, every poll — even though the rows that are actually
 * displayed did not change. Comparing the rendered result and keeping the old
 * reference stops the churn at the render boundary, without having to chase
 * which upstream field ticked.
 *
 * Sized for lists of tens of rows: the comparison is far cheaper than the
 * reconciliation it avoids.
 */
function useStableValue(value) {
    const ref = React.useRef(value);
    const previousJson = React.useRef(null);
    const nextJson = React.useMemo(() => {
        try {
            return JSON.stringify(value);
        } catch {
            return null;   // unserializable: never claim equality
        }
    }, [value]);
    if (nextJson === null || previousJson.current !== nextJson) {
        previousJson.current = nextJson;
        ref.current = value;
    }
    return ref.current;
}

/**
 * Vertical-primary touch scrolling with an explicit horizontal opt-in.
 *
 * The session list has `width: max-content` rows, so it overflows sideways
 * whenever a title is long. Declaring `touch-action: pan-x pan-y` told the
 * browser both axes were equally on offer, and on a phone a swipe is never
 * perfectly vertical — so scrolling down kept sliding the list sideways.
 *
 * The fix is to give the browser ONE axis (`touch-action: pan-y`, set in CSS,
 * which keeps native vertical momentum) and drive horizontal ourselves, only
 * for a gesture that is unambiguously sideways. Once a gesture commits to an
 * axis it keeps it until the finger lifts: to scroll across you stop and make
 * a deliberate left/right swipe, which is exactly the intent.
 */
const PAN_COMMIT_PX = 10;      // ignore the first few px — every swipe starts noisy
const PAN_HORIZONTAL_RATIO = 1.6;   // |dx| must beat |dy| by this much to go sideways

function useHorizontalPanOptIn(ref) {
    React.useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;

        let startX = 0;
        let startY = 0;
        let lastX = 0;
        let axis = null;   // null = undecided, "x" | "y" = committed for this gesture

        const onTouchStart = (event) => {
            if (event.touches.length !== 1) { axis = "y"; return; }
            const touch = event.touches[0];
            startX = lastX = touch.clientX;
            startY = touch.clientY;
            axis = null;
        };

        const onTouchMove = (event) => {
            if (axis === "y" || event.touches.length !== 1) return;
            const touch = event.touches[0];
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;

            if (axis === null) {
                if (Math.abs(dx) < PAN_COMMIT_PX && Math.abs(dy) < PAN_COMMIT_PX) return;
                // Ties, and anything close to a tie, go to vertical. Vertical is
                // the primary axis; sideways has to be asked for.
                axis = Math.abs(dx) > Math.abs(dy) * PAN_HORIZONTAL_RATIO ? "x" : "y";
                lastX = touch.clientX;
                if (axis === "y") return;
            }

            // Committed horizontal: the browser is not panning this axis, so we
            // do it. preventDefault stops the gesture also scrolling an
            // ancestor sideways.
            el.scrollLeft -= touch.clientX - lastX;
            lastX = touch.clientX;
            if (event.cancelable) event.preventDefault();
        };

        const onTouchEnd = () => { axis = null; };

        el.addEventListener("touchstart", onTouchStart, { passive: true });
        el.addEventListener("touchmove", onTouchMove, { passive: false });
        el.addEventListener("touchend", onTouchEnd, { passive: true });
        el.addEventListener("touchcancel", onTouchEnd, { passive: true });
        return () => {
            el.removeEventListener("touchstart", onTouchStart);
            el.removeEventListener("touchmove", onTouchMove);
            el.removeEventListener("touchend", onTouchEnd);
            el.removeEventListener("touchcancel", onTouchEnd);
        };
    }, [ref]);
}

function SessionPane({ controller, actions = null, panelClassName = "", structuredRows = false }) {
    // Mobile keeps its inline detail line and gets no detail box — a reserved
    // footer would eat a meaningful slice of a phone screen.
    const isMobilePane = String(panelClassName).includes("ps-mobile-session-pane");
    // Vertical is the primary scroll axis; sideways takes a deliberate swipe.
    const sessionListRef = React.useRef(null);
    useHorizontalPanOptIn(sessionListRef);
    // Selection reverts to plain taps wherever the primary input is a finger:
    // the mobile pane, and the chat-focus overlay's list on a phone. Matches
    // the `(pointer: fine)` guard on touch-action in the stylesheet.
    const touchInput = isMobilePane || useCoarsePointer();
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const sessionButtonRefs = React.useRef(new Map());
    const viewState = useControllerSelector(controller, (state) => ({
        branding: state.branding,
        activeSessionId: state.sessions.activeSessionId,
        sessionsById: state.sessions.byId,
        sessionsFlat: state.sessions.flat,
        filterQuery: state.sessions.filterQuery || "",
        ownerFilter: state.sessions.ownerFilter,
        pinnedIds: state.sessions.pinnedIds,
        manualOrder: state.sessions.manualOrder,
        selectedIds: state.sessions.selectedIds,
        selectMode: state.sessions.selectMode,
        auth: state.auth,
        connectionMode: state.connection?.mode || "local",
        modalOpen: Boolean(state.ui.modal),
        focused: state.ui.focusRegion === "sessions",
        // The rich chat view also restyles the session list, so the portal
        // reads as one product rather than half terminal / half desktop.
        // TODO: promote this to its own `ui.richUi` setting if the two are
        // ever wanted independently.
        rich: Boolean(getTheme(state.ui.themeId)?.richChat),
        // Clicking empty space clears the list highlight; the row VM reads it,
        // so the reconstruction below must carry it or the click does nothing
        // visible (the same omission that blinded the Node Map).
        listDeselected: Boolean(state.sessions.listDeselected),
    }), shallowEqualObject);
    const computedRows = React.useMemo(() => selectSessionRows({
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: viewState.sessionsById,
            flat: viewState.sessionsFlat,
            filterQuery: viewState.filterQuery,
            ownerFilter: viewState.ownerFilter,
            pinnedIds: viewState.pinnedIds,
            manualOrder: viewState.manualOrder,
            selectedIds: viewState.selectedIds,
            selectMode: viewState.selectMode,
            listDeselected: viewState.listDeselected,
        },
        auth: viewState.auth,
        connection: {
            mode: viewState.connectionMode,
        },
        // The root system session renders as the deployment's branding title.
        // Omitting this made the list fall back to "PilotSwarm" on a branded
        // deployment, while the controller's own calls (which pass real state)
        // produced the branded name.
        branding: viewState.branding,
    }), [viewState.activeSessionId, viewState.auth, viewState.branding, viewState.connectionMode, viewState.filterQuery, viewState.listDeselected, viewState.ownerFilter, viewState.pinnedIds, viewState.manualOrder, viewState.selectedIds, viewState.selectMode, viewState.sessionsById, viewState.sessionsFlat]);
    // Hold the previous rows when a poll produced identical output.
    const rows = useStableValue(computedRows);
    const activeSession = viewState.activeSessionId
        ? viewState.sessionsById[viewState.activeSessionId] || null
        : null;
    // The row carries the computed child badge; the raw session does not.
    const activeRow = viewState.activeSessionId
        ? rows.find((r) => r.sessionId === viewState.activeSessionId) || null
        : null;
    // "Manage session" combines rename, model, and sharing in one tabbed modal
    // (opened from the toolbar so the composer chrome stays minimal, esp. on
    // mobile). Rename and sharing are owner/admin-only (session:manage /
    // session:share), so the button is disabled for anyone else — the server
    // enforces too, but a disabled button is clearer than a 403.
    const [manageOpen, setManageOpen] = React.useState(false);
    const [linkModal, setLinkModal] = React.useState(null); // { url, warn } | null
    // The model picker is a separate (controller-owned) modal that would render
    // behind the Manage modal, so we close Manage while it is open and reopen
    // it when the picker closes — cancelling returns the user to Manage.
    const reopenManageRef = React.useRef(false);
    // The switch-model flow is multi-step (model → reasoning effort → context
    // tier); watch every step so Manage doesn't reopen between them. It reopens
    // only when the whole flow ends, and only if the switch was NOT applied
    // (cancel returns to Manage; confirm closes everything).
    const MODEL_FLOW_MODALS = ["modelPicker", "reasoningEffortPicker", "contextTierPicker"];
    const modelFlowOpen = useControllerSelector(controller, (state) => MODEL_FLOW_MODALS.includes(state.ui.modal?.type));
    React.useEffect(() => {
        if (!modelFlowOpen && reopenManageRef.current) {
            reopenManageRef.current = false;
            setManageOpen(true);
        }
    }, [modelFlowOpen]);
    const requestSwitchModel = () => {
        reopenManageRef.current = true;
        setManageOpen(false);
        controller.openSwitchModelPicker(() => {
            // Applied (not cancelled): close everything, don't reopen Manage.
            reopenManageRef.current = false;
        }).then(() => {
            // If the picker never actually opened (e.g. unsupported transport),
            // don't strand the Manage modal closed with no way back.
            if (!MODEL_FLOW_MODALS.includes(controller.getState().ui.modal?.type) && reopenManageRef.current) {
                reopenManageRef.current = false;
                setManageOpen(true);
            }
        }).catch((err) => {
            reopenManageRef.current = false;
            setManageOpen(true);
            controller.dispatch({ type: "ui/status", text: err?.message || String(err) || "Failed to switch model" });
        });
    };
    const authPrincipal = viewState.auth?.principal || null;
    const viewerRole = viewState.auth?.authorization?.role;
    const isAdminViewer = viewerRole === "admin" || viewerRole === "anonymous";
    const ownsActiveSession = Boolean(
        activeSession?.owner
        && authPrincipal
        && String(activeSession.owner.provider) === String(authPrincipal.provider)
        && String(activeSession.owner.subject) === String(authPrincipal.subject),
    );
    const canModifyActiveSession = Boolean(
        activeSession && !activeSession.isSystem && !activeSession.isGroup
        && (isAdminViewer || ownsActiveSession),
    );
    const selectedCount = Array.isArray(viewState.selectedIds) ? viewState.selectedIds.length : 0;
    const isBulkSelection = selectedCount > 1;
    const canPinActiveSession = Boolean(
        activeSession
        && !activeSession.isSystem
        && (activeSession.isGroup || (!activeSession.parentSessionId && !activeSession.groupId)),
    );
    const isActivePinned = Boolean(
        activeSession
        && Array.isArray(viewState.pinnedIds)
        && viewState.pinnedIds.includes(activeSession.sessionId),
    );
    const activeGroupCanDelete = Boolean(activeSession?.isGroup && Number(activeSession.memberCount || 0) === 0);
    const canTerminate = isBulkSelection
        ? Array.isArray(viewState.selectedIds) && viewState.selectedIds.some((id) => {
            const s = viewState.sessionsById[id];
            return s && !s.isSystem && !s.isGroup;
        })
        : activeSession?.isGroup ? true : Boolean(activeSession);
    const hasExplicitSelection = selectedCount > 0;
    // Mirrors getMovableGroupSessionSelection: after an empty-space click the
    // active session still drives chat and the inspector, but it is no longer
    // a LIST selection, so the folder button must not act on it.
    const activeIsGroupable = Boolean(
        activeSession && !viewState.listDeselected
        && !activeSession.isSystem && !activeSession.isGroup && !activeSession.parentSessionId,
    );
    const groupableIds = hasExplicitSelection
        ? viewState.selectedIds.filter((id) => {
            const session = viewState.sessionsById[id];
            return session && !session.isSystem && !session.isGroup && !session.parentSessionId;
        })
        : (activeIsGroupable ? [activeSession.sessionId] : []);
    // The folder button is never disabled: with nothing to move it makes an
    // empty folder to drag into, which is the natural way to get one at all.
    const combinedPanelClassName = `ps-session-pane${viewState.rich ? " is-rich" : ""}${panelClassName ? ` ${panelClassName}` : ""}`;
    // The click handler must be referentially stable or every memoized row
    // re-renders on each keypress, defeating the point. It reads the current
    // rows/viewState from a ref that is refreshed on every render instead of
    // closing over them.
    const clickEnv = React.useRef(null);
    clickEnv.current = { rows, viewState, controller };
    // ── Drag sessions into / out of groups ────────────────────────────
    // Pointer-driven so it works from <button> rows, can render a collection
    // ghost for a multi-selection, and can highlight the destination folder.
    const [dragState, setDragState] = React.useState({ dragging: false, ids: [], titles: [], overGroupId: null, insertBeforeId: undefined, insertAfterId: null, x: 0, y: 0 });
    const dragRef = React.useRef(null);

    /**
     * Scroll the list when the pointer nears its edge, so a row can be dragged
     * somewhere that is not currently on screen. Speed ramps with how deep
     * into the edge zone the pointer is — a fixed step is either too slow to
     * cross a long list or too fast to land precisely.
     */
    const autoScrollRef = React.useRef(null);
    const stopAutoScroll = React.useCallback(() => {
        if (autoScrollRef.current == null) return;
        cancelAnimationFrame(autoScrollRef.current);
        autoScrollRef.current = null;
    }, []);
    const updateAutoScroll = React.useCallback((x, y) => {
        const EDGE_PX = 48;
        const MAX_STEP_PX = 14;
        const el = document.elementFromPoint(x, y);
        const scroller = el?.closest?.("[data-session-scroll]")
            || document.querySelector("[data-session-scroll]");
        if (!scroller) { stopAutoScroll(); return; }
        const box = scroller.getBoundingClientRect();
        let step = 0;
        if (y < box.top + EDGE_PX) {
            step = -MAX_STEP_PX * Math.min(1, (box.top + EDGE_PX - y) / EDGE_PX);
        } else if (y > box.bottom - EDGE_PX) {
            step = MAX_STEP_PX * Math.min(1, (y - (box.bottom - EDGE_PX)) / EDGE_PX);
        }
        // Record the step BEFORE the early-out: the loop reads it every frame,
        // so it has to be refreshed on each move or the scroll would keep the
        // speed (and direction) it had when the pointer first entered the edge.
        if (dragRef.current) dragRef.current.autoScrollStep = step;
        if (!dragRef.current) { stopAutoScroll(); return; }
        if (autoScrollRef.current != null) return; // loop already running
        const tick = () => {
            const pending = dragRef.current;
            if (!pending || !pending.autoScrollStep) { stopAutoScroll(); return; }
            scroller.scrollTop += pending.autoScrollStep;
            autoScrollRef.current = requestAnimationFrame(tick);
        };
        autoScrollRef.current = requestAnimationFrame(tick);
    }, [stopAutoScroll]);

    const finishDrag = React.useCallback((commit) => {
        const pending = dragRef.current;
        dragRef.current = null;
        stopAutoScroll();
        setDragState({ dragging: false, ids: [], titles: [], overGroupId: null, insertBeforeId: undefined, insertAfterId: null, x: 0, y: 0 });
        if (!commit || !pending?.started || pending.ids.length === 0) return;
        // Released inside the row's own sibling list → a placement, which is a
        // local preference: the reducer reorders and the profile write that
        // follows persists it, so it roams to the user's other surfaces.
        if (pending.intent === "reorder") {
            controller.dispatch({
                type: "sessions/reorder",
                sessionId: pending.ids[0],
                beforeSessionId: pending.beforeSessionId,
            });
            return;
        }
        // file → into that folder; unfile → out of the one it is in. Any
        // other outcome is not a move at all and must do nothing: falling
        // through here used to un-file rows on a drop that meant nothing.
        if (pending.intent !== "file" && pending.intent !== "unfile") return;
        controller.moveSessionsToGroup(pending.overGroupId, pending.ids).catch((error) => {
            controller.dispatch({ type: "ui/status", text: `Move failed: ${error?.message || error}` });
        });
    }, [controller, stopAutoScroll]);

    // Resolve a destination folder from a point. Any row inside the folder's
    // expanded region answers, not just the folder row itself: aiming at a
    // single 20px row to file something is needlessly fiddly, and releasing
    // over a member obviously means "put it in there too".
    const resolveDropGroup = React.useCallback((x, y) => {
        if (typeof x !== "number" || typeof y !== "number") return null;
        const el = document.elementFromPoint(x, y);
        const zone = el?.closest?.("[data-drop-group]") || null;
        return zone?.getAttribute("data-drop-group") || null;
    }, []);

    /**
     * Resolve a REORDER destination: which row the dragged one should land
     * before, within its own sibling list.
     *
     * Only rows sharing the dragged row's container answer — that is what
     * separates "put it here" from the folder-filing gesture, and it is why a
     * drag inside a folder reorders instead of re-filing into the folder it
     * is already in. Above a row's midpoint drops before it, below drops
     * after; past the last sibling drops at the end (null).
     */

    const resolveReorderTarget = React.useCallback((x, y, container, draggedId) => {
        if (typeof x !== "number" || typeof y !== "number" || container == null) return undefined;
        const siblings = Array.from(
            document.querySelectorAll(`[data-order-container="${CSS.escape(container)}"][data-orderable="1"]`),
        );
        if (siblings.length === 0) return undefined;
        for (const el of siblings) {
            const box = el.getBoundingClientRect();
            if (y < box.top + (box.height / 2)) {
                return { before: el.getAttribute("data-session-id") || null, after: null };
            }
        }
        // Below every sibling ⇒ land last. There is no row to draw a line
        // ABOVE, so anchor one BELOW the final sibling instead — without it
        // the one destination that has no "next row" is also the one with no
        // feedback, and the drop looks like it will do nothing.
        const last = siblings[siblings.length - 1];
        const lastId = last?.getAttribute("data-session-id") || null;
        return { before: null, after: lastId && lastId !== draggedId ? lastId : null };
    }, []);

    /**
     * Decide which gesture a point means. ONE function, called from both the
     * move handler and the release handler — deciding it twice, in two places,
     * let the release contradict the highlight the user was looking at.
     *
     *   file    pointer is inside a folder the row is not already in
     *   unfile  row lives in a folder and the pointer is outside every folder
     *   reorder anything else: same folder, or a top-level row over the list
     *
     * Filing must be tested FIRST. A reorder target can be resolved almost
     * anywhere in the list, so letting reorder win meant overGroupId was
     * always cleared and dropping into a folder never once happened.
     */
    const resolveDropIntent = React.useCallback((x, y, pending) => {
        const overGroupId = resolveDropGroup(x, y);
        const ownGroupId = pending?.ownGroupId || null;
        if (overGroupId && overGroupId !== ownGroupId) {
            return { kind: "file", overGroupId, before: undefined, after: null };
        }
        if (!overGroupId && ownGroupId) {
            return { kind: "unfile", overGroupId: null, before: undefined, after: null };
        }
        const canReorder = pending?.orderable && pending.ids.length === 1;
        const target = canReorder
            ? resolveReorderTarget(x, y, pending.container, pending.ids[0])
            : undefined;
        if (target === undefined) {
            // Nothing to reorder against (multi-select, or an empty list):
            // fall back to the folder gesture the drag always had.
            return { kind: overGroupId ? "file" : "none", overGroupId, before: undefined, after: null };
        }
        return { kind: "reorder", overGroupId: null, before: target.before, after: target.after };
    }, [resolveDropGroup, resolveReorderTarget]);


    React.useEffect(() => {
        if (!dragState.dragging) return undefined;
        const onMove = (event) => {
            const pending = dragRef.current;
            if (!pending) return;
            const intent = resolveDropIntent(event.clientX, event.clientY, pending);
            // A reorder is offered only INSIDE the row's own sibling list, and
            // only for a single row: dropping a multi-selection between two
            // rows has no obvious meaning, whereas filing several at once into
            // a folder does. Reorder wins over filing when the pointer is
            // within the row's own container, which is what lets a member be
            // rearranged inside the folder it already lives in.
            pending.intent = intent.kind;
            pending.overGroupId = intent.overGroupId;
            pending.beforeSessionId = intent.before;
            updateAutoScroll(event.clientX, event.clientY);
            // The copy cursor means "this will go INTO something" — a folder.
            // A reorder is not a copy and has its own indicator (the insertion
            // line), so lighting this for reorders showed folder affordances,
            // and folder wording, everywhere in the list.
            document.body.classList.toggle("ps-drop-ok", intent.kind === "file");
            setDragState((cur) => ({
                ...cur,
                intent: intent.kind,
                overGroupId: intent.overGroupId,
                insertBeforeId: intent.before,
                insertAfterId: intent.after,
                x: event.clientX,
                y: event.clientY,
            }));
        };
        // Resolve the target from the RELEASE coordinates. Relying on the last
        // pointermove the effect happened to process made the drop depend on
        // event timing: a fast drag committed with a stale (usually null)
        // target, which the API then read as "remove from folder" — the drag
        // appeared to do nothing at all.
        const onUp = (event) => {
            const pending = dragRef.current;
            if (pending && typeof event?.clientX === "number") {
                // Re-decide the WHOLE gesture, not just the folder: recomputing
                // one half let the release contradict the highlight the user
                // was looking at.
                const intent = resolveDropIntent(event.clientX, event.clientY, pending);
                pending.intent = intent.kind;
                pending.overGroupId = intent.overGroupId;
                pending.beforeSessionId = intent.before;
            }
            finishDrag(true);
        };
        // Named + removed: an anonymous pointercancel listener leaked one stale
        // closure PER DRAG, and the next drag's cancel event fired all of them,
        // aborting it. First drag worked, every one after it died.
        const onCancel = () => finishDrag(false);
        const onKey = (event) => { if (event.key === "Escape") finishDrag(false); };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("keydown", onKey);
        document.body.classList.add("ps-dragging-sessions");
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onCancel);
            window.removeEventListener("keydown", onKey);
            document.body.classList.remove("ps-dragging-sessions");
            document.body.classList.remove("ps-drop-ok");
        };
    }, [dragState.dragging, finishDrag, resolveDropIntent, updateAutoScroll]);

    const dragHandlers = React.useMemo(() => ({
        dragging: dragState.dragging,
        overGroupId: dragState.overGroupId,
        insertBeforeId: dragState.insertBeforeId,
        insertAfterId: dragState.insertAfterId,
        // Arm on pointerdown, but only BECOME a drag past a small threshold so
        // ordinary clicks (and Cmd/Shift multi-select) still work untouched.
        onPointerDown: (event, row) => {
            // Folders used to be undraggable because the only gesture was
            // "file into a folder" and a folder cannot go inside itself. They
            // ARE reorderable among themselves, so they may now be picked up;
            // the reorder path is the only one they can complete, because a
            // folder's container ("folders") never matches a filing target.
            if (row.isSystem) return;
            if (!row.orderable && !row.isGroup) {
                // Sub-agents: not orderable, and filing them makes no sense
                // either — their place is the shape of the run.
                if (row.depth > 0) return;
            }
            const startX = event.clientX;
            const startY = event.clientY;
            const armed = {
                row,
                startX,
                startY,
                started: false,
                ids: [],
                overGroupId: null,
                beforeSessionId: undefined,
                orderable: Boolean(row.orderable),
                container: row.orderContainer ?? null,
                // The folder the row currently lives in: filing into the
                // folder it is ALREADY in is a reorder, not a move.
                ownGroupId: row.groupId || null,
                intent: "none",
                autoScrollStep: 0,
            };
            const onMove = (moveEvent) => {
                if (armed.started) return;
                if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
                armed.started = true;
                const current = clickEnv.current.viewState;
                const selected = Array.isArray(current.selectedIds) ? current.selectedIds : [];
                const ids = selected.includes(row.sessionId) && selected.length > 1 ? selected : [row.sessionId];
                const byId = current.sessionsById || {};
                armed.ids = ids;
                dragRef.current = armed;
                setDragState({
                    dragging: true,
                    ids,
                    titles: ids.map((id) => byId[id]?.title || String(id).slice(0, 8)).slice(0, 3),
                    overGroupId: null,
                    x: moveEvent.clientX,
                    y: moveEvent.clientY,
                });
            };
            const onUp = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
        },
    }), [dragState.dragging, dragState.overGroupId, dragState.insertBeforeId, dragState.insertAfterId]);

    const handleRowClick = React.useCallback((event, row) => {
        const { rows: currentRows, viewState: current, controller: ctl } = clickEnv.current;
        // Cmd/Ctrl-click toggles multi-selection (any row).
        if (event.metaKey || event.ctrlKey) {
            event.preventDefault();
            if (!current.selectMode) {
                ctl.dispatch({ type: "sessions/selectMode", enabled: true });
            }
            ctl.dispatch({ type: "sessions/selectToggle", sessionId: row.sessionId });
            ctl.setFocus("sessions");
            return;
        }
        // Shift-click selects a contiguous range from the active row.
        if (event.shiftKey && current.activeSessionId) {
            event.preventDefault();
            const ids = currentRows.map((r) => r.sessionId);
            const startIndex = ids.indexOf(current.activeSessionId);
            const endIndex = ids.indexOf(row.sessionId);
            if (startIndex >= 0 && endIndex >= 0) {
                const [from, to] = startIndex <= endIndex
                    ? [startIndex, endIndex]
                    : [endIndex, startIndex];
                const range = ids.slice(from, to + 1);
                const merged = Array.from(new Set([...(current.selectedIds || []), ...range]));
                ctl.setSessionSelection(merged);
                ctl.setFocus("sessions");
                return;
            }
        }
        const shouldToggleChildren = row.hasChildren && row.active;
        if (shouldToggleChildren) {
            ctl.dispatch({
                type: row.collapsed ? "sessions/expand" : "sessions/collapse",
                sessionId: row.sessionId,
            });
            ctl.setFocus("sessions");
            return;
        }
        // A normal click on a different row clears any multi-selection and
        // switches the active session.
        if (current.selectMode) {
            ctl.dispatch({ type: "sessions/selectClear" });
        }
        ctl.setFocus("sessions");
        // A plain click always re-arms the highlight. On the still-active row
        // (after an empty-space deselect) loadSession would short-circuit and
        // leave the list looking permanently deselected, so re-arm directly
        // rather than re-running selection and disturbing chat scroll memory.
        if (row.sessionId === current.activeSessionId) {
            ctl.dispatch({ type: "sessions/listReselect" });
        } else if (!row.active) {
            ctl.loadSession(row.sessionId).catch(() => {});
        }
    }, []);

    const setSessionButtonRef = React.useCallback((sessionId, node) => {
        if (!sessionId) return;
        if (node) {
            sessionButtonRefs.current.set(sessionId, node);
        } else {
            sessionButtonRefs.current.delete(sessionId);
        }
    }, []);

    React.useEffect(() => {
        if (viewState.modalOpen || !viewState.focused || !viewState.activeSessionId) return;
        const activeButton = sessionButtonRefs.current.get(viewState.activeSessionId);
        if (!activeButton) return;

        if (document.activeElement !== activeButton) {
            activeButton.focus({ preventScroll: true });
        }
        // Only pull the active row into view when the active session itself
        // changes (or on focus/modal transitions). Re-running scrollIntoView
        // on every `sessions/loaded` refresh would yank the list back to the
        // active row even when the user has deliberately scrolled away to
        // browse older sessions in a long list.
        activeButton.scrollIntoView({ block: "nearest" });
    }, [viewState.activeSessionId, viewState.focused, viewState.modalOpen]);

    const panelActions = React.createElement(React.Fragment, null,
        isBulkSelection
            ? React.createElement("span", {
                className: "ps-mini-button-label",
                style: { padding: "0 6px", fontSize: "12px", opacity: 0.85 },
                title: "Multiple sessions selected. Move to group or cancel selected sessions; click Clear to exit.",
            }, `${selectedCount} selected`)
            : null,
        isBulkSelection
            ? React.createElement(IconButton, {
                className: "ps-mini-button",
                icon: "✕",
                label: "Clear multi-selection",
                onClick: () => controller.handleCommand(UI_COMMANDS.CLEAR_SESSION_SELECTION).catch(() => {}),
            })
            : React.createElement(IconButton, {
                className: "ps-mini-button ps-pin-icon",
                icon: React.createElement(PinGlyph),
                onClick: () => controller.handleCommand(UI_COMMANDS.PIN_SESSION).catch(() => {}),
                disabled: !canPinActiveSession,
                active: isActivePinned,
                label: canPinActiveSession
                    ? (isActivePinned ? "Unpin this session" : "Pin this session to the top of the list")
                    : "Only top-level non-system sessions can be pinned",
            }),
        React.createElement(IconButton, {
            className: "ps-mini-button",
            icon: groupableIds.length > 1
                ? React.createElement("span", { className: "ps-icon-badge" },
                    React.createElement(FolderGlyph),
                    React.createElement("span", { className: "ps-icon-badge__count" }, String(groupableIds.length)))
                : React.createElement(FolderGlyph),
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_MOVE_TO_GROUP).catch(() => {}),
            label: groupableIds.length > 1
                ? `Move ${groupableIds.length} selected sessions to a group`
                : groupableIds.length === 1
                    ? "Move this session to a group"
                    : "New group",
        }),
        React.createElement(IconButton, {
            className: "ps-mini-button",
            icon: React.createElement(ManageGlyph),
            onClick: () => setManageOpen(true),
            disabled: !canModifyActiveSession || isBulkSelection,
            label: isBulkSelection ? "Disabled while multiple sessions are selected" : "Manage session — rename, switch model, and sharing",
        }),
        React.createElement(IconButton, {
            className: "ps-mini-button",
            icon: React.createElement(LinkGlyph),
            onClick: () => {
                const sid = activeSession?.sessionId;
                if (!sid) return;
                const url = buildSessionLinkUrl(sid);
                if (!url) return;
                copySessionLinkText(url);
                setLinkModal({ url, warn: false });
                resolveSessionLinkWarn(controller, sid).then((warn) => {
                    setLinkModal((cur) => (cur && cur.url === url ? { ...cur, warn } : cur));
                }).catch(() => {});
            },
            disabled: !activeSession || activeSession.isGroup || isBulkSelection,
            label: "Copy link — copy a direct link to this session",
        }),
        React.createElement(IconButton, {
            className: "ps-mini-button",
            icon: React.createElement(activeSession?.isSystem ? RestartGlyph : TerminateGlyph),
            onClick: () => controller.handleCommand(activeSession?.isGroup ? UI_COMMANDS.DELETE_SESSION : UI_COMMANDS.OPEN_TERMINATE_PICKER).catch(() => {}),
            disabled: !canTerminate,
            label: isBulkSelection
                ? `Terminate ${selectedCount} selected sessions (Mark Completed, Cancel, or Delete)`
                : activeSession?.isGroup
                    ? (activeGroupCanDelete ? "Delete this empty group" : "This group cannot be deleted yet")
                    : activeSession?.isSystem
                        ? "Restart this system session (complete, terminate, or hard delete)"
                        : "Terminate — mark completed, cancel, or delete this session",
        }),
        actions);

    // The drag ghost: a single card for one session, a stacked "collection"
    // for a multi-selection, plus what it will do when released.
    const dragGhost = dragState.dragging
        ? React.createElement("div", {
            className: "ps-drag-ghost",
            style: { left: `${dragState.x}px`, top: `${dragState.y}px` },
        },
            React.createElement("div", { className: `ps-drag-ghost__stack${dragState.ids.length > 1 ? " is-collection" : ""}` },
                dragState.ids.length > 1
                    ? React.createElement("span", { className: "ps-drag-ghost__count" }, String(dragState.ids.length))
                    : null,
                React.createElement("span", { className: "ps-drag-ghost__title" },
                    dragState.ids.length > 1
                        ? `${dragState.ids.length} sessions`
                        : (dragState.titles[0] || "session"))),
            React.createElement("div", { className: "ps-drag-ghost__hint" },
                dragState.overGroupId ? "Release to file here" : "Release to remove from folder"))
        : null;

    return React.createElement(React.Fragment, null,
    dragGhost,
    React.createElement(Panel, {
        title: [{ text: "Sessions", color: "yellow", bold: true }],
        color: "yellow",
        focused: viewState.focused,
        theme,
        actions: panelActions,
        className: combinedPanelClassName,
    },
    React.createElement("div", {
        ref: sessionListRef,
        className: `ps-action-list ps-session-list${dragState.dragging ? " is-dragging" : ""}`,
        // Clicking empty space below the rows clears the list selection while
        // the other panes keep showing the session. With nothing selected the
        // folder button offers a new, empty group.
        onClick: (event) => {
            // Empty space only: a click that lands on a row bubbles here too.
            const onRow = event.target instanceof Element && event.target.closest(".ps-session-list-button");
            if (onRow) return;
            controller.dispatch({ type: "sessions/listDeselect" });
        },
    },
        rows.length === 0
            ? React.createElement("div", { className: "ps-empty-state" }, viewState.filterQuery
                ? `No sessions matched "@@${viewState.filterQuery}".`
                : "No sessions yet.")
            : rows.map((row) => React.createElement(SessionListRow, {
                key: row.sessionId,
                row,
                theme,
                rich: viewState.rich,
                structuredRows,
                mobile: isMobilePane,
                onRowClick: handleRowClick,
                setRef: setSessionButtonRef,
                // Drag-to-folder is a fine-pointer gesture: arming it on
                // touch hijacks the finger that should be scrolling the list.
                drag: touchInput ? null : dragHandlers,
            }))),
    isMobilePane
        ? null
        : React.createElement(SessionDetailBox, {
            session: activeSession,
            childCount: activeRow?.childCount || 0,
        })),
    (manageOpen && activeSession && !activeSession.isGroup)
        ? React.createElement(SessionModifyModal, {
            controller,
            sessionId: activeSession.sessionId,
            initialTitle: activeSession.title || "",
            currentModel: activeSession.model || "",
            currentReasoningEffort: activeSession.reasoningEffort || "",
            principal: viewState.auth?.principal || null,
            onClose: () => setManageOpen(false),
            onSwitchModel: requestSwitchModel,
            onChanged: () => {},
        })
        : null,
    linkModal
        ? React.createElement(SessionLinkModal, {
            url: linkModal.url,
            warn: linkModal.warn,
            onCopyAgain: () => {
                copySessionLinkText(linkModal.url);
                controller.dispatch({ type: "ui/status", text: SESSION_LINK_COPIED_STATUS });
            },
            onClose: () => setLinkModal(null),
        })
        : null);
}

// Compact confirmation dialog for the Copy link button: shows the copied URL
// (selectable), confirms the copy, and warns when the link points at a private
// session no one else can open yet.
function SessionLinkModal({ url, warn, onCopyAgain, onClose }) {
    const inputRef = React.useRef(null);
    React.useEffect(() => {
        const node = inputRef.current;
        if (node) { node.focus(); node.select(); }
    }, []);
    const stop = (e) => e.stopPropagation();
    return React.createElement("div", { className: "ps-share-overlay", onClick: onClose },
        React.createElement("div", { className: "ps-link-modal", onClick: stop },
            React.createElement("div", { className: "ps-share-modal-head" },
                React.createElement("span", null, "Link copied"),
                React.createElement("button", { className: "ps-modal-close", onClick: onClose, "aria-label": "Close", title: "Close" }, "✕")),
            React.createElement("div", { className: "ps-share-section-sub" },
                "Copied to your clipboard — anyone with access can open the session from this link."),
            React.createElement("div", { className: "ps-link-row" },
                React.createElement("input", {
                    ref: inputRef, className: "ps-link-input", readOnly: true, value: url,
                    onFocus: () => inputRef.current?.select(),
                }),
                React.createElement("button", { className: "ps-mini-button", onClick: onCopyAgain }, "Copy")),
            warn
                ? React.createElement("div", { className: "ps-link-warn" }, SESSION_LINK_PRIVATE_WARNING)
                : null));
}

const VISIBILITY_META = {
    private: { glyph: "🔒", label: "Private" },
    shared_read: { glyph: "👁", label: "Shared · read" },
    shared_write: { glyph: "✎", label: "Shared · write" },
};

// Shared wrapper for the line-art icon family. Same props PinGlyph shipped
// inline, so every glyph inherits .ps-share-glyph sizing and currentColor.
function Glyph({ children }) {
    return React.createElement("svg", {
        className: "ps-share-glyph", viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
    }, children);
}

// The "manage" glyph for the Manage session button. A wrench, not sliders:
// sliders are the second most common FILTER icon in the wild, so they collided
// with the funnel on the header toolbar. A wrench reads as "configure this one
// session" and stays distinct from the cog, which opens the admin console.
function ManageGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" }));
}

// Filter — the funnel. Plain, with no "a filter is applied" dot or active
// state: there is no cheap way to tell a narrowed list from the default one.
// The owner filter starts at `all: false` for every signed-in user (see
// defaultOwnerFilterForPrincipal), so any "is it filtered" test built on it
// reads true from the moment the app loads and the button looks stuck on.
function FunnelGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M21 4H3l7.2 8.5V19l3.6 2v-8.5L21 4z" }));
}

// Summary — a written summary. Was "≣", the same codepoint the Logs tab used.
function SummaryGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" }),
    React.createElement("path", { d: "M14 3v5h5" }),
    React.createElement("line", { x1: "8.5", y1: "13", x2: "15.5", y2: "13" }),
    React.createElement("line", { x1: "8.5", y1: "17", x2: "13", y2: "17" }));
}

// Back to the transcript. Replaces the 💬 emoji, which iOS force-renders in
// colour against an otherwise monochrome row (see the note on the tab table).
function TranscriptGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M21 14.5a2.5 2.5 0 0 1-2.5 2.5H8l-5 4V5.5A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5z" }));
}

function PlusGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("line", { x1: "12", y1: "5", x2: "12", y2: "19" }),
    React.createElement("line", { x1: "5", y1: "12", x2: "19", y2: "12" }));
}

// Theme picker. Deliberately a contrast disc rather than a sun/moon: the picker
// offers DOOM, WinAMP, win95 and friends, not a light/dark binary.
function ContrastGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("circle", { cx: "12", cy: "12", r: "9" }),
    React.createElement("path", { d: "M12 3a9 9 0 0 1 0 18z", fill: "currentColor" }));
}

function ExpandGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M8 3H5a2 2 0 0 0-2 2v3" }),
    React.createElement("path", { d: "M16 3h3a2 2 0 0 1 2 2v3" }),
    React.createElement("path", { d: "M21 16v3a2 2 0 0 1-2 2h-3" }),
    React.createElement("path", { d: "M3 16v3a2 2 0 0 0 2 2h3" }));
}

function CollapseGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M8 3v3a2 2 0 0 1-2 2H3" }),
    React.createElement("path", { d: "M21 8h-3a2 2 0 0 1-2-2V3" }),
    React.createElement("path", { d: "M16 21v-3a2 2 0 0 1 2-2h3" }),
    React.createElement("path", { d: "M3 16h3a2 2 0 0 1 2 2v3" }));
}

function CogGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("circle", { cx: "12", cy: "12", r: "3" }),
    React.createElement("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" }));
}

// Restart a system session. Was "↻" — the one text codepoint in an otherwise
// all-SVG row, so it rendered a weight lighter and sat a pixel high.
function RestartGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }),
    React.createElement("path", { d: "M21 3v5h-5" }));
}

function UploadGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M12 16V4" }),
    React.createElement("path", { d: "M7.5 8.5L12 4l4.5 4.5" }),
    React.createElement("path", { d: "M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" }));
}

function DownloadGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M12 4v12" }),
    React.createElement("path", { d: "M7.5 11.5L12 16l4.5-4.5" }),
    React.createElement("path", { d: "M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" }));
}

// ── Inspector tab glyphs ────────────────────────────────────────────────────

// Two lifelines with a call and a return — an actual sequence diagram, rather
// than the "⇶" stack of arrows, which only said "forward". The lifelines sit at
// x4.5/x19.5 (a 15-unit gap): at the original 10 the arrowheads all but touched
// them and the glyph read as one dense block at 18px.
function SequenceGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("line", { x1: "4.5", y1: "3", x2: "4.5", y2: "21" }),
    React.createElement("line", { x1: "19.5", y1: "3", x2: "19.5", y2: "21" }),
    React.createElement("path", { d: "M4.5 8.5h13" }),
    React.createElement("path", { d: "M15 6l2.5 2.5-2.5 2.5" }),
    React.createElement("path", { d: "M19.5 15.5h-13" }),
    React.createElement("path", { d: "M9 13l-2.5 2.5 2.5 2.5" }));
}

// A side panel with its list rail — fronts the mobile "Sessions" toggle, which
// opens exactly that. Paired with CollapseGlyph for "Exit focus" so the two
// rail buttons match the icon vocabulary of the main toolbar.
function SidebarGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M3 5.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }),
    React.createElement("path", { d: "M9.5 3.5v17" }));
}

// Logs are console output; a prompt chevron says that and nothing else.
function LogsGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M4 17l6-6-6-6" }),
    React.createElement("line", { x1: "12", y1: "19", x2: "20", y2: "19" }));
}

// Three connected nodes. A bare "⬡" was a shape, not a map.
function NodeMapGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("circle", { cx: "6", cy: "6", r: "2.6" }),
    React.createElement("circle", { cx: "18", cy: "6", r: "2.6" }),
    React.createElement("circle", { cx: "12", cy: "18", r: "2.6" }),
    React.createElement("line", { x1: "8.6", y1: "6", x2: "15.4", y2: "6" }),
    React.createElement("line", { x1: "7.4", y1: "8.3", x2: "10.6", y2: "15.7" }),
    React.createElement("line", { x1: "16.6", y1: "8.3", x2: "13.4", y2: "15.7" }));
}

// The Duroxide brand mark reduced to the 24 grid: hexagon ring, gear, and the
// sweep arrow breaking out at the lower right. FILLS, not strokes — a 2px
// stroked gear at r=3 is unreadable by the time the row renders it at 18px.
// Monochrome currentColor, so it inherits every theme including win95 and DOOM.
const DUROXIDE_HEX = "M12 2.3 20.4 7.15v9.7L12 21.7 3.6 16.85V7.15Z";
const DUROXIDE_GEAR = "M15.2 10.1A4.2 4.2 0 0 1 15.2 11.9L14.23 11.69A3.2 3.2 0 0 1 13.8 12.73L14.64 13.26A4.2 4.2 0 0 1 13.36 14.54L12.83 13.7A3.2 3.2 0 0 1 11.79 14.13L12 15.1A4.2 4.2 0 0 1 10.2 15.1L10.41 14.13A3.2 3.2 0 0 1 9.37 13.7L8.84 14.54A4.2 4.2 0 0 1 7.56 13.26L8.4 12.73A3.2 3.2 0 0 1 7.97 11.69L7 11.9A4.2 4.2 0 0 1 7 10.1L7.97 10.31A3.2 3.2 0 0 1 8.4 9.27L7.56 8.74A4.2 4.2 0 0 1 8.84 7.46L9.37 8.3A3.2 3.2 0 0 1 10.41 7.87L10.2 6.9A4.2 4.2 0 0 1 12 6.9L11.79 7.87A3.2 3.2 0 0 1 12.83 8.3L13.36 7.46A4.2 4.2 0 0 1 14.64 8.74L13.8 9.27A3.2 3.2 0 0 1 14.23 10.31ZM12.8 11A1.7 1.7 0 0 0 9.4 11A1.7 1.7 0 0 0 12.8 11Z";
const DUROXIDE_ARROW = "M7.23 15.01A5.7 5.7 0 0 1 17.76 14.55L19.11 15.04L15.1 16.57L14.71 13.44L16.06 13.93A3.9 3.9 0 0 0 8.87 14.25Z";
function DuroxideGlyph() {
    return React.createElement("svg", {
        className: "ps-share-glyph", viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", "aria-hidden": "true",
    },
    React.createElement("path", { d: DUROXIDE_HEX, strokeWidth: "1.9", strokeLinejoin: "round" }),
    React.createElement("path", { d: DUROXIDE_GEAR, fill: "currentColor", stroke: "none", fillRule: "evenodd" }),
    React.createElement("path", { d: DUROXIDE_ARROW, fill: "currentColor", stroke: "none" }));
}

// Two overlapping PAGES — the front one folded — so the tab reads as "several
// artifacts". The old "⧉" is the stacked-squares glyph every other app means
// "duplicate" by, which made a destination look like an action.
function FilesGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M9 2.8h4.2L17 6.6v8.6a1.8 1.8 0 0 1-1.8 1.8H15" }),
    React.createElement("path", { d: "M4.5 9.4a1.8 1.8 0 0 1 1.8-1.8h4.2l3.8 3.8v8a1.8 1.8 0 0 1-1.8 1.8H6.3a1.8 1.8 0 0 1-1.8-1.8z" }),
    React.createElement("path", { d: "M10.5 7.6v3.8h3.8" }));
}

// Solid bars on a baseline. Three things made the first attempt at this read as
// a cell-signal meter instead: monotonically ascending heights, round caps, and
// nothing anchoring the bars. So these are solid square-shouldered rects with
// the middle bar tallest, sitting on a rule.
function StatsGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("rect", { x: "4.2", y: "12", width: "3.6", height: "8", rx: "0.6", fill: "currentColor", stroke: "none" }),
    React.createElement("rect", { x: "10.2", y: "6.5", width: "3.6", height: "13.5", rx: "0.6", fill: "currentColor", stroke: "none" }),
    React.createElement("rect", { x: "16.2", y: "9.5", width: "3.6", height: "10.5", rx: "0.6", fill: "currentColor", stroke: "none" }),
    React.createElement("path", { d: "M3 21h18" }));
}

// The standard "link" glyph (two chain segments). Used for the Copy link button.
function LinkGlyph() {
    return React.createElement("svg", {
        className: "ps-share-glyph", viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
    },
    React.createElement("path", { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" }),
    React.createElement("path", { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" }));
}

// Terminate — a trash can. The terminal dispositions live behind it
// (complete / cancel / delete); regenerate moved to Manage session.
function TerminateGlyph() {
    return React.createElement("svg", {
        className: "ps-share-glyph", viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
    },
    React.createElement("path", { d: "M3 6h18" }),
    React.createElement("path", { d: "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" }),
    React.createElement("path", { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" }),
    React.createElement("line", { x1: "10", y1: "11", x2: "10", y2: "17" }),
    React.createElement("line", { x1: "14", y1: "11", x2: "14", y2: "17" }));
}

// A folder — session groups ARE folders; say so.
function FolderGlyph() {
    return React.createElement("svg", {
        className: "ps-share-glyph", viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
    },
    React.createElement("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" }));
}

// An actual push-pin (head, shaft, point) — pinned sessions sort to the top.
function PinGlyph() {
    return React.createElement("svg", {
        className: "ps-share-glyph", viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
    },
    React.createElement("path", { d: "M9 3h6" }),
    React.createElement("path", { d: "M10 3v6l-3 3v2h10v-2l-3-3V3" }),
    React.createElement("line", { x1: "12", y1: "14", x2: "12", y2: "21" }));
}

// The "lifecycle" glyph (two curved arrows forming a cycle). Fronts the session
// Lifecycle menu — Regenerate (rebirth) plus the terminal dispositions.
function LifecycleGlyph() {
    return React.createElement("svg", {
        className: "ps-share-glyph", viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
    },
    React.createElement("path", { d: "M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }),
    React.createElement("path", { d: "M3 3v5h5" }),
    React.createElement("path", { d: "M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" }),
    React.createElement("path", { d: "M21 21v-5h-5" }));
}

/**
 * Fetch the caller's effective access to the active session (security model).
 * Returns { access, loading, reload }. access is the getSessionAccess payload
 * ({ visibility, relation, canWrite, canManage, owner, isSystem, enforced }),
 * or null while loading / on error / when the transport lacks the method
 * (older deployments — treated as full access so the UI never over-restricts
 * a deployment that isn't enforcing).
 */
function useActiveSessionAccess(controller, activeSessionId, isGroup) {
    const [state, setState] = React.useState({ access: null, loading: false });
    const reload = React.useCallback(() => {
        if (!activeSessionId || isGroup || typeof controller.transport.getSessionAccess !== "function") {
            setState({ access: null, loading: false });
            return;
        }
        let cancelled = false;
        setState((s) => ({ ...s, loading: true }));
        controller.transport.getSessionAccess(activeSessionId)
            .then((access) => { if (!cancelled) setState({ access, loading: false }); })
            .catch(() => { if (!cancelled) setState({ access: null, loading: false }); });
        return () => { cancelled = true; };
    }, [controller, activeSessionId, isGroup]);
    // Deferred for the same reason the session fetch is: this fires on every
    // activeSessionId change, and scrolling the list changes that per keypress.
    // Without the settle, moving through a list of sessions issued one access
    // round trip per row. `reload` stays immediate for callers that ask for it
    // explicitly (after a sharing change).
    React.useEffect(() => {
        let cancelInFlight;
        const timer = setTimeout(() => { cancelInFlight = reload(); }, SESSION_ACCESS_SETTLE_MS);
        return () => {
            clearTimeout(timer);
            if (typeof cancelInFlight === "function") cancelInFlight();
        };
    }, [reload]);
    return { access: state.access, loading: state.loading, reload };
}

// Combined "Share & settings" modal opened from the session list toolbar:
// rename, copy link, plus (for the owner/admin) sharing — visibility +
// per-person grants. Fetches its own access snapshot so callers only pass the
// session id + current title.
function SessionModifyModal({ controller, sessionId, initialTitle, currentModel, currentReasoningEffort, principal, onClose, onSwitchModel, onChanged }) {
    const [tab, setTab] = React.useState("general");
    const [access, setAccess] = React.useState(null);
    const [title, setTitle] = React.useState(initialTitle || "");
    const [shares, setShares] = React.useState([]);          // committed baseline
    const [draftShares, setDraftShares] = React.useState([]); // staged, applied on Apply
    const [visibility, setVisibility] = React.useState("private");
    const [granteeQuery, setGranteeQuery] = React.useState("");
    const [granteeAccess, setGranteeAccess] = React.useState("write");
    const [directory, setDirectory] = React.useState([]);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);

    React.useEffect(() => {
        let cancelled = false;
        controller.transport.getSessionAccess(sessionId)
            .then((a) => { if (!cancelled && a) { setAccess(a); setVisibility(a.visibility || "private"); } })
            .catch(() => {});
        // Member directory for name autocomplete (excludes synthetic principals).
        if (typeof controller.transport.listKnownUsers === "function") {
            controller.transport.listKnownUsers({ limit: 500 })
                .then((users) => { if (!cancelled) setDirectory(Array.isArray(users) ? users : []); })
                .catch(() => {});
        }
        return () => { cancelled = true; };
    }, [controller, sessionId]);

    const loadShares = React.useCallback(() => {
        controller.transport.listSessionShares(sessionId)
            .then((rows) => { const list = Array.isArray(rows) ? rows : []; setShares(list); setDraftShares(list); })
            .catch(() => { setShares([]); setDraftShares([]); });
    }, [controller, sessionId]);
    React.useEffect(() => { loadShares(); }, [loadShares]);

    const run = async (fn) => {
        setBusy(true); setError(null);
        try { await fn(); onChanged?.(); }
        catch (err) { setError(err?.message || String(err)); }
        finally { setBusy(false); }
    };

    const saveTitle = () => run(async () => {
        await controller.transport.renameSession(sessionId, title.trim());
    });
    // Resolve the typed text to a directory member (by name, email, or id).
    // Falls back to treating the text as a raw subject for a not-yet-seen user.
    const resolveGrantee = (text) => {
        const q = text.trim().toLowerCase();
        if (!q) return null;
        const match = directory.find((u) =>
            (u.displayName && u.displayName.toLowerCase() === q)
            || (u.email && u.email.toLowerCase() === q)
            || (u.subject && u.subject.toLowerCase() === q));
        if (match) return match;
        return { provider: principal?.provider || "dev", subject: text.trim(), email: null, displayName: null };
    };
    const shareKey = (r) => `${r.provider}${r.subject}`;
    // Access edits are staged into draftShares/visibility and committed only
    // on Apply, so the button is a deliberate, satisfying confirmation.
    const stageGrant = (grantee) => {
        const key = shareKey(grantee);
        setDraftShares((cur) => [
            ...cur.filter((r) => shareKey(r) !== key),
            { provider: grantee.provider, subject: grantee.subject, email: grantee.email ?? null, displayName: grantee.displayName ?? null, access: granteeAccess },
        ]);
        setGranteeQuery("");
    };
    const addGrant = () => {
        const grantee = resolveGrantee(granteeQuery);
        if (grantee) stageGrant(grantee);
    };
    const stageRevoke = (row) => {
        const key = shareKey(row);
        setDraftShares((cur) => cur.filter((r) => shareKey(r) !== key));
    };

    // Autocomplete suggestions: directory members matching the query, minus
    // the owner and anyone already granted.
    const grantedKeys = new Set(draftShares.map(shareKey));
    const ownerKey = access?.owner ? `${access.owner.provider}${access.owner.subject}` : null;
    const q = granteeQuery.trim().toLowerCase();
    const suggestions = q
        ? directory.filter((u) => {
            const key = shareKey(u);
            if (key === ownerKey || grantedKeys.has(key)) return false;
            return (u.displayName && u.displayName.toLowerCase().includes(q))
                || (u.email && u.email.toLowerCase().includes(q))
                || (u.subject && u.subject.toLowerCase().includes(q));
        }).slice(0, 25)
        : [];
    const canManage = Boolean(access?.canManage);
    // Dirty = staged access differs from the committed baseline (the `:level`
    // suffix catches a grant whose access level changed).
    const baselineVisibility = access?.visibility || "private";
    const draftSig = new Set(draftShares.map((r) => `${shareKey(r)}:${r.access}`));
    const baseSig = new Set(shares.map((r) => `${shareKey(r)}:${r.access}`));
    const sharesChanged = draftSig.size !== baseSig.size || [...draftSig].some((k) => !baseSig.has(k));
    const accessDirty = canManage && (visibility !== baselineVisibility || sharesChanged);
    const applyAccess = () => run(async () => {
        if (visibility !== baselineVisibility) {
            await controller.transport.setSessionVisibility(sessionId, visibility);
        }
        const baseByKey = new Map(shares.map((r) => [shareKey(r), r]));
        const draftByKey = new Map(draftShares.map((r) => [shareKey(r), r]));
        for (const [key, r] of draftByKey) {
            const b = baseByKey.get(key);
            if (!b || b.access !== r.access) {
                await controller.transport.grantSessionShare(
                    sessionId,
                    { provider: r.provider, subject: r.subject, email: r.email ?? null, displayName: r.displayName ?? null },
                    r.access,
                );
            }
        }
        for (const [key, r] of baseByKey) {
            if (!draftByKey.has(key)) {
                await controller.transport.revokeSessionShare(sessionId, { provider: r.provider, subject: r.subject });
            }
        }
        const rows = await controller.transport.listSessionShares(sessionId).catch(() => null);
        if (Array.isArray(rows)) { setShares(rows); setDraftShares(rows); }
        const a = await controller.transport.getSessionAccess(sessionId).catch(() => null);
        if (a) { setAccess(a); setVisibility(a.visibility || "private"); }
        controller.dispatch({ type: "ui/status", text: "Access updated." });
    });
    const switchModel = onSwitchModel || (() => {
        onClose();
        controller.openSwitchModelPicker().catch((err) => {
            controller.dispatch({ type: "ui/status", text: err?.message || String(err) || "Failed to switch model" });
        });
    });
    const modelLabel = currentModel
        ? (currentReasoningEffort ? `${currentModel}:${currentReasoningEffort}` : currentModel)
        : "—";
    // Access is owner/admin-only; hide the tab entirely for viewers who can
    // only rename/switch model on their own session.
    const tabs = [
        { id: "general", label: "General" },
        ...(canManage ? [{ id: "access", label: "Access" }] : []),
    ];
    const activeTab = tabs.some((t) => t.id === tab) ? tab : "general";
    // Regenerate is a change-this-session action, so it belongs here rather
    // than in the terminal picker. Service sessions (⚗ machinery) never regen.
    const canRegenerate = typeof controller.transport?.regenerateSession === "function";
    const stop = (e) => e.stopPropagation();
    return React.createElement("div", { className: "ps-share-overlay", onClick: onClose },
        React.createElement("div", { className: "ps-share-modal", onClick: stop },
            React.createElement("div", { className: "ps-share-modal-head" },
                React.createElement("span", null, "Manage session"),
                React.createElement("button", { className: "ps-modal-close", onClick: onClose, "aria-label": "Close", title: "Close" }, "✕")),

            // ── Tab bar (part of the frame: it must not scroll away) ──
            React.createElement("div", { className: "ps-manage-tabs", role: "tablist" },
                tabs.map((t) => React.createElement("button", {
                    key: t.id,
                    type: "button",
                    role: "tab",
                    "aria-selected": activeTab === t.id ? "true" : "false",
                    className: `ps-manage-tab${activeTab === t.id ? " is-active" : ""}`,
                    onClick: () => setTab(t.id),
                }, t.label))),

            React.createElement("div", { className: "ps-share-modal-body" },
            // ── General: rename + model ───────────────────────────────
            activeTab === "general" ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "ps-share-section-label" }, "Name"),
                React.createElement("div", { className: "ps-share-add-row" },
                    React.createElement("input", {
                        className: "ps-share-add-input", placeholder: "Session title",
                        value: title, disabled: busy,
                        onChange: (e) => setTitle(e.target.value),
                        onKeyDown: (e) => { if (e.key === "Enter") saveTitle(); },
                    }),
                    React.createElement("button", { className: "ps-mini-button", disabled: busy || !title.trim(), onClick: saveTitle }, "Save")),
                React.createElement("div", { className: "ps-share-section-label" }, "Model"),
                React.createElement("div", { className: "ps-share-section-sub" }, "The model this session uses on its next turn."),
                React.createElement("div", { className: "ps-share-add-row" },
                    React.createElement("span", { className: "ps-manage-model-current" }, modelLabel),
                    React.createElement("button", { className: "ps-mini-button", disabled: busy, onClick: switchModel }, "Switch model…")),
                canRegenerate ? React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "ps-share-section-label" }, "Context"),
                    React.createElement("div", { className: "ps-share-section-sub" },
                        "Rebuild this session's working context from its summary. The transcript is archived and the session keeps running — it is not a terminal action."),
                    React.createElement("div", { className: "ps-share-add-row" },
                        React.createElement("button", {
                            className: "ps-mini-button ps-manage-regenerate",
                            disabled: busy,
                            onClick: () => { onClose(); controller.handleCommand(UI_COMMANDS.REGENERATE_SESSION).catch(() => {}); },
                        },
                        React.createElement(LifecycleGlyph),
                        React.createElement("span", null, "Regenerate context…")))) : null)
                : null,

            // ── Access (owner / admin only) ───────────────────────────
            (activeTab === "access" && canManage) ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "ps-share-section-label" }, "General access"),
                React.createElement("div", { className: "ps-share-section-sub" }, "The baseline level for everyone signed in to this workspace."),
                ["private", "shared_read", "shared_write"].map((value) =>
                    React.createElement("label", { key: value, className: `ps-share-radio${visibility === value ? " is-active" : ""}` },
                        React.createElement("input", {
                            type: "radio", name: "visibility", checked: visibility === value,
                            disabled: busy, onChange: () => setVisibility(value),
                        }),
                        React.createElement("span", { className: "ps-share-radio-glyph" }, VISIBILITY_META[value].glyph),
                        React.createElement("span", null, VISIBILITY_META[value].label),
                        React.createElement("span", { className: "ps-share-radio-hint" },
                            value === "private" ? "only you and admins"
                                : value === "shared_read" ? "everyone here can view"
                                    : "everyone here can view and send"))),
                React.createElement("div", { className: "ps-share-section-label" }, "Special access"),
                React.createElement("div", { className: "ps-share-section-sub" }, "Give specific people more than the general level. A person's grant wins over general access."),
                draftShares.length === 0
                    ? React.createElement("div", { className: "ps-share-empty" }, "No individual grants — everyone has the general access above.")
                    : draftShares.map((row) => React.createElement("div", { key: `${row.provider}/${row.subject}`, className: "ps-share-grant-row" },
                        React.createElement("span", { className: "ps-share-grant-name" }, row.displayName || row.subject),
                        React.createElement("span", { className: "ps-share-grant-access" }, `can ${row.access}`),
                        React.createElement("button", { className: "ps-mini-button", disabled: busy, onClick: () => stageRevoke(row) }, "Remove"))),
                React.createElement("div", { className: "ps-share-add-wrap" },
                    React.createElement("div", { className: "ps-share-add-row" },
                        React.createElement("input", {
                            className: "ps-share-add-input", placeholder: "Name, email, or id",
                            value: granteeQuery, disabled: busy, autoComplete: "off",
                            onChange: (e) => setGranteeQuery(e.target.value),
                            onKeyDown: (e) => { if (e.key === "Enter") addGrant(); },
                        }),
                        React.createElement("select", {
                            className: "ps-share-add-select", value: granteeAccess, disabled: busy,
                            onChange: (e) => setGranteeAccess(e.target.value),
                        },
                        React.createElement("option", { value: "read" }, "can read"),
                        React.createElement("option", { value: "write" }, "can write")),
                        React.createElement("button", { className: "ps-mini-button", disabled: busy || !granteeQuery.trim(), onClick: addGrant }, "Add")),
                    suggestions.length > 0
                        ? React.createElement("div", { className: "ps-share-suggestions" },
                            suggestions.map((u) => React.createElement("button", {
                                key: `${u.provider}/${u.subject}`,
                                type: "button", className: "ps-share-suggestion", disabled: busy,
                                onClick: () => stageGrant(u),
                            },
                            React.createElement("span", { className: "ps-share-suggestion-name" }, u.displayName || u.subject),
                            u.email ? React.createElement("span", { className: "ps-share-suggestion-email" }, u.email) : null)))
                        : null),
                React.createElement("div", { className: "ps-share-foot-hint" },
                    "Sharing applies to this session and its sub-agents. Suggestions are people who have "
                    + "signed in before — you can also grant by email to someone who hasn't; it takes effect "
                    + "when they first sign in."),
                )
                : null),
            // Pinned footer: the commit action never scrolls out of reach.
            (activeTab === "access" && canManage)
                ? React.createElement("div", { className: "ps-manage-apply-bar is-footer" },
                    React.createElement("span", { className: "ps-share-section-sub" },
                        accessDirty ? "Unsaved access changes." : "No changes to apply."),
                    React.createElement("button", {
                        className: "ps-mini-button ps-manage-apply",
                        disabled: busy || !accessDirty,
                        onClick: applyAccess,
                    }, "Apply"))
                : null,
            error ? React.createElement("div", { className: "ps-share-error" }, error) : null));
}

function ChatPane({ controller, mobile = false, fullWidth = false, showComposer = true }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const viewState = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const layout = computeStateLayout(state);
        const paneWidth = fullWidth || mobile
            ? layout.totalWidth
            : layout.leftWidth;
        const contentWidth = Math.max(20, paneWidth - 4);
        return {
            activeSessionId,
            activeHistory: activeSessionId ? state.history.bySessionId.get(activeSessionId) || null : null,
            activeOutbox: activeSessionId && state.outbox?.bySessionId?.[activeSessionId]
                ? state.outbox.bySessionId[activeSessionId]
                : [],
            branding: state.branding,
            connection: state.connection,
            sessionsById: state.sessions.byId,
            sessionsFlat: state.sessions.flat,
            inspectorTab: state.ui.inspectorTab,
            chatViewMode: state.ui.chatViewMode || "transcript",
            activeSessionIsGroup: Boolean(activeSessionId && state.sessions.byId[activeSessionId]?.isGroup),
            activeSessionStatus: activeSessionId ? String(state.sessions.byId[activeSessionId]?.status || "").toLowerCase() : "",
            focused: state.ui.focusRegion === "chat",
            scroll: state.ui.scroll.chat,
            // Viewer identity — so the transcript can say "You" for the viewer's
            // own messages and name others (with an "(owner)" tag).
            authPrincipal: state.auth?.principal || null,
            contentWidth,
        };
    }, shallowEqualObject);
    const selectorState = React.useMemo(() => ({
        branding: viewState.branding,
        connection: viewState.connection,
        auth: { principal: viewState.authPrincipal },
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: viewState.sessionsById,
            flat: viewState.sessionsFlat,
        },
        history: {
            bySessionId: viewState.activeSessionId && viewState.activeHistory
                ? new Map([[viewState.activeSessionId, viewState.activeHistory]])
                : new Map(),
        },
        outbox: {
            bySessionId: viewState.activeSessionId
                ? { [viewState.activeSessionId]: viewState.activeOutbox }
                : {},
        },
        ui: {
            inspectorTab: viewState.inspectorTab,
            chatViewMode: viewState.chatViewMode,
        },
    }), [
        viewState.activeHistory,
        viewState.activeSessionId,
        viewState.activeOutbox,
        viewState.authPrincipal,
        viewState.branding,
        viewState.connection,
        viewState.chatViewMode,
        viewState.inspectorTab,
        viewState.sessionsById,
        viewState.sessionsFlat,
    ]);
    const chrome = React.useMemo(
        () => selectChatPaneChrome(selectorState, { width: viewState.contentWidth }),
        [selectorState, viewState.contentWidth],
    );
    const animatedDots = useAnimatedDots(Boolean(chrome.animateTitleRight));
    const titleRight = React.useMemo(
        () => appendAnimatedDotsToRuns(chrome.titleRight, chrome.animateTitleRight ? animatedDots : ""),
        [animatedDots, chrome.animateTitleRight, chrome.titleRight],
    );
    const richMode = Boolean(theme?.richChat) && !viewState.activeSessionIsGroup;
    const [loadingOlder, setLoadingOlder] = React.useState(false);
    // Scroll-up expands the transcript automatically until the soft cap, then
    // refuses — and the portal had no control to ask for more, so a busy
    // session's history became unreachable from the browser. Surface the
    // control exactly when the automatic path has given up.
    const showLoadOlder = Boolean(
        viewState.activeHistory?.hasOlderEvents
        && Number(viewState.activeHistory?.loadedEventCount || 0) >= AUTO_HISTORY_EVENT_SOFT_CAP,
    );
    const richBlocks = React.useMemo(
        () => (richMode ? selectChatBlocks(selectorState, viewState.contentWidth, { tableMode: "sentinel" }) : null),
        [richMode, selectorState, viewState.contentWidth],
    );
    const lines = React.useMemo(() => {
        if (richBlocks) {
            // Rich mode paints from `richBlocks` via renderBody; these
            // pseudo-lines exist only as the scroll-sync change signal
            // (autoscroll-to-bottom fires when a block grows or arrives).
            return richBlocks.map((block, index) => ({
                text: block.kind === "message"
                    ? `m:${block.id ?? index}:${(block.text || "").length}:${block.pendingPhase || ""}`
                    : `l:${index}:${(block.lines || []).length}`,
            }));
        }
        return selectChatLines(selectorState, viewState.contentWidth, { tableMode: "sentinel" });
    }, [richBlocks, selectorState, viewState.contentWidth]);
    const spinnerFrame = useSpinnerFrame(viewState.activeSessionStatus === "running");
    const liveActivityLines = React.useMemo(
        () => selectLiveActivityLines(selectorState, { spinnerFrame, maxWidth: viewState.contentWidth }),
        [selectorState, spinnerFrame, viewState.contentWidth],
    );
    // The live-activity line is pinned in the bottom-sticky strip (with the
    // outbox overlay), NOT appended to the transcript — it must stay put while
    // chat content scrolls, and it drops the instant the turn ends.
    const pinnedActivityLines = liveActivityLines;
    const outboxLines = React.useMemo(
        () => selectOutboxOverlayLines(selectorState, viewState.contentWidth, { tableMode: "sentinel" }),
        [selectorState, viewState.contentWidth],
    );
    const stickyBottom = React.useMemo(
        () => (pinnedActivityLines.length > 0 ? [...outboxLines, ...pinnedActivityLines] : outboxLines),
        [outboxLines, pinnedActivityLines],
    );
    // Read-only gating: a view-only viewer (shared_read / read grant, no write)
    // gets an explanatory notice instead of the composer. The visibility chip
    // and Share affordance now live in the session list "Modify" modal and the
    // selected-session details, keeping the composer chrome minimal (mobile).
    const { access } = useActiveSessionAccess(
        controller, viewState.activeSessionId, viewState.activeSessionIsGroup,
    );
    const navigationError = useControllerSelector(controller, selectNavigationError, shallowEqualObject);
    const composerBase = showComposer && !viewState.activeSessionIsGroup && viewState.chatViewMode !== "summary";
    // Service sessions (⚗ tree-scoped machinery, e.g. the regen distiller) are
    // read-only BY KIND: their transcript is the trace of runtime machinery,
    // never a conversation surface — no prompt for anyone, owner included.
    const activeIsService = Boolean(viewState.sessionsById?.[viewState.activeSessionId]?.serviceKind);
    const readOnly = activeIsService || (Boolean(access) && access.canWrite === false);
    const composer = composerBase
        ? React.createElement("div", { className: "ps-chat-composer" },
            readOnly
                ? React.createElement("div", { className: "ps-composer-readonly" },
                    activeIsService
                        ? "⚗ Service session — runtime machinery. Its transcript is a read-only trace; it does not accept messages."
                        : `You have view access to this session. Ask ${access.owner?.displayName || access.owner?.email || "the owner"} for write access to participate.`)
                : React.createElement(PromptComposer, { controller, mobile, active: true }))
        : null;

    // A failed deep-link intent with nothing else loaded replaces the pane
    // body with the nav-error empty state (the reducer refuses fallback
    // selection while the intent exists, so there is no transcript to show).
    const hasLoadableActiveSession = Boolean(
        viewState.activeSessionId && viewState.sessionsById[viewState.activeSessionId],
    );
    if (navigationError && !hasLoadableActiveSession) {
        return React.createElement(Panel, {
            title: chrome.title,
            color: chrome.color,
            focused: viewState.focused,
            theme,
            className: "ps-chat-panel",
        },
        React.createElement("div", { className: "ps-empty-state ps-nav-error-state" },
            React.createElement("div", { className: "ps-nav-error-message" }, navigationError.message),
            navigationError.retryable
                ? React.createElement("button", {
                    type: "button",
                    className: "ps-mini-button",
                    onClick: () => controller.setNavigationIntent(navigationError.sessionId),
                }, "Retry")
                : null));
    }

    return React.createElement(ScrollLinesPanel, {
        controller,
        title: (() => {
            const baseTitle = mobile ? compactTitleRuns(chrome.title, 28) : chrome.title;
            return richMode ? unbracketTitleRuns(baseTitle) : baseTitle;
        })(),
        titleRight: mobile && titleRight ? compactTitleRuns(titleRight, 18) : titleRight,
        // Chat/Summary toggling lives on the top toolbar so the pane chrome
        // stays clean. The toolbar button is disabled for group sessions.
        actions: null,
        color: chrome.color,
        focused: viewState.focused,
        lines,
        bottomStickyLines: stickyBottom,
        scrollOffset: viewState.scroll,
        scrollMode: "bottom",
        paneKey: "chat",
        className: richMode ? "is-wrapped is-rich" : "is-wrapped",
        panelClassName: richMode ? "ps-chat-panel is-rich" : "ps-chat-panel",
        bottomContent: composer,
        topContent: showLoadOlder
            ? React.createElement("div", { className: "ps-load-older-bar" },
                React.createElement("button", {
                    type: "button",
                    className: "ps-load-older-button",
                    disabled: loadingOlder,
                    onClick: () => {
                        setLoadingOlder(true);
                        controller.handleCommand(UI_COMMANDS.EXPAND_HISTORY)
                            .catch(() => {})
                            .finally(() => setLoadingOlder(false));
                    },
                }, loadingOlder ? "Loading older messages…" : "↑ Load older messages"))
            : null,
        structuredBlocks: true,
        renderBody: richBlocks
            ? (_bodyLines, bodyTheme) => React.createElement(RichChatBlocks, {
                blocks: richBlocks,
                theme: bodyTheme,
                controller,
            })
            : null,
    });
}

/**
 * Mobile artifact viewer — a genuine full-viewport overlay, not a pane.
 *
 * Rendered OUTSIDE the workspace and fixed to the viewport, so the portal
 * header, session list and composer are all covered: opening an artifact on a
 * phone should feel like pushing a detail screen, the way a native app does,
 * not like shrinking content into one more box. Desktop never mounts this.
 */
function MobileArtifactOverlay({ controller }) {
    const view = useControllerSelector(controller, (state) => {
        const id = state.files.selectedArtifactId || "";
        const filename = id ? id.slice(id.indexOf("/") + 1) : "";
        return {
            filename,
            origin: state.files.previewOrigin || null,
            canPrev: controller.canStepArtifactPreview(-1),
            canNext: controller.canStepArtifactPreview(1),
        };
    }, shallowEqualObject);

    // Wrap toggle applies to CODE only. Markdown always wraps — prose in a
    // horizontal scroller is unreadable — and its fenced blocks keep their own
    // behavior. Images have nothing to wrap.
    const isCode = Boolean(codeLanguageForArtifact(view.filename))
        || isDiffArtifact(view.filename);
    const [contentWidth, setContentWidth] = React.useState(false);
    React.useEffect(() => { setContentWidth(false); }, [view.filename]);

    const step = React.useCallback((delta) => {
        controller.stepArtifactPreview(delta).catch(() => {});
    }, [controller]);

    return React.createElement("div", { className: "ps-artifact-overlay" },
        React.createElement("header", { className: "ps-artifact-overlay-bar" },
            React.createElement("button", {
                type: "button",
                className: "ps-artifact-overlay-btn",
                onClick: () => controller.closeArtifactPreview().catch(() => {}),
                "aria-label": view.origin === "chat" ? "Close, back to chat" : "Close, back to artifacts",
            }, "✕"),
            React.createElement("span", { className: "ps-artifact-overlay-title" }, view.filename || "Artifact"),
            isCode
                ? React.createElement("button", {
                    type: "button",
                    className: `ps-artifact-overlay-btn${contentWidth ? " is-active" : ""}`,
                    onClick: () => setContentWidth((v) => !v),
                    "aria-label": contentWidth ? "Wrap lines" : "Show full lines",
                    title: contentWidth ? "Wrap to screen width" : "Full line width (scroll horizontally)",
                }, contentWidth ? "⇥" : "↔")
                : null,
            React.createElement("button", {
                type: "button",
                className: "ps-artifact-overlay-btn",
                disabled: !view.canPrev,
                onClick: () => step(-1),
                "aria-label": "Previous artifact",
            }, "‹"),
            React.createElement("button", {
                type: "button",
                className: "ps-artifact-overlay-btn",
                disabled: !view.canNext,
                onClick: () => step(1),
                "aria-label": "Next artifact",
            }, "›")),
        // No swipe handlers: horizontal drag belongs to the content, so a wide
        // code line can be scrolled without also changing which file you are on.
        React.createElement("div", {
            className: `ps-artifact-overlay-body${contentWidth ? " is-content-width" : ""}`,
        }, React.createElement(FilesPane, {
            controller, focused: true, mobile: true, previewOnly: true, nativeScroll: true,
        })));
}

function MobileWorkspace({ controller }) {
    // The session list is always shown; use the toolbar Focus button to give
    // the chat the full screen (the old Show/Hide toggle was redundant with it).
    return React.createElement("div", { className: "ps-mobile-workspace" },
        React.createElement(SessionPane, {
            controller,
            panelClassName: "ps-mobile-session-pane",
        }),
        React.createElement("div", { className: "ps-mobile-chat-pane" },
            React.createElement(ChatPane, { controller, mobile: true, fullWidth: true })));
}

function InspectorTabs({ activeTab, controller }) {
    const visibleTabs = React.useMemo(() => getVisibleInspectorTabs(controller), [controller]);
    // Icon-only tabs: the full label (e.g. "Node Map") lives in the IconButton
    // tooltip, so there's no per-label width pressure and no mobile shortening.
    // Default IconButton className ("ps-toolbar-button") so these render
    // identically to the session toolbar icons.
    return React.createElement("div", { className: "ps-tab-row ps-tab-row-icons" },
        visibleTabs.map((tab) => React.createElement(IconButton, {
            key: tab,
            icon: INSPECTOR_TAB_ICONS[tab] ? React.createElement(INSPECTOR_TAB_ICONS[tab]) : "•",
            label: INSPECTOR_TAB_LABELS[tab] || tab,
            active: activeTab === tab,
            onClick: () => {
                controller.setFocus("inspector");
                controller.selectInspectorTab(tab).catch(() => {});
            },
        })));
}

// `previewOnly` renders JUST the artifact preview panel, so the desktop layout
// can host it in the activity slot where it gets the existing row resizer.
// Detached this way the preview is resizable; nested inside the inspector it
// could only ever have half of a pane.
function FilesPane({ controller, focused, mobile = false, previewOnly = false, nativeScroll = false }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const fileInputRef = React.useRef(null);
    const viewState = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const layout = computeStateLayout(state);
        const paneWidth = (mobile || state.files.fullscreen)
            ? (state.ui.layout?.viewportWidth ?? 120)
            : layout.rightWidth;
        return {
            activeSessionId,
            sessionsById: state.sessions.byId,
            sessionsFlat: state.sessions.flat,
            filesBySessionId: state.files.bySessionId,
            filesFilter: state.files.filter,
            selectedArtifactId: state.files.selectedArtifactId,
            markedIds: state.files.markedIds || [],
            previewOrigin: state.files.previewOrigin || null,
            focused,
            previewScroll: state.ui.scroll.filePreview,
            fullscreen: Boolean(state.files.fullscreen),
            contentWidth: Math.max(20, paneWidth - 4),
            canBrowserUpload: supportsBrowserFileUploads(controller),
            canPathUpload: supportsPathArtifactUploads(controller),
            canDeleteArtifacts: supportsArtifactDelete(controller),
            canOpenLocally: supportsLocalFileOpen(controller),
        };
    }, shallowEqualObject);
    const selectorState = React.useMemo(() => ({
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: viewState.sessionsById,
            flat: viewState.sessionsFlat,
        },
        files: {
            bySessionId: viewState.filesBySessionId,
            selectedArtifactId: viewState.selectedArtifactId,
            filter: viewState.filesFilter,
            fullscreen: viewState.fullscreen,
        },
        ui: {
            scroll: {
                filePreview: viewState.previewScroll,
            },
        },
    }), [
        viewState.activeSessionId,
        viewState.filesBySessionId,
        viewState.filesFilter,
        viewState.fullscreen,
        viewState.previewScroll,
        viewState.selectedArtifactId,
        viewState.sessionsById,
        viewState.sessionsFlat,
    ]);
    const filesView = React.useMemo(() => selectFilesView(selectorState, {
        listWidth: Math.max(18, viewState.contentWidth - 4),
        previewWidth: Math.max(18, viewState.contentWidth - 4),
        showHints: false,
    }), [selectorState, viewState.contentWidth]);
    const items = React.useMemo(() => selectFileBrowserItems(selectorState), [selectorState]);
    const hasSelection = items.length > 0;

    const uploadFiles = React.useCallback((files) => {
        const nextFiles = Array.isArray(files) ? files.filter(Boolean) : [];
        if (nextFiles.length === 0) return;
        controller.uploadArtifactFiles(nextFiles).catch(() => {});
    }, [controller]);

    const openUploadPicker = React.useCallback(() => {
        if (viewState.canBrowserUpload && fileInputRef.current) {
            fileInputRef.current.click();
            return;
        }
        if (viewState.canPathUpload) {
            controller.handleCommand(UI_COMMANDS.OPEN_ARTIFACT_UPLOAD).catch(() => {});
        }
    }, [controller, viewState.canBrowserUpload, viewState.canPathUpload]);

    // Declared BEFORE panelActions, which reads it. When this sat further down
    // the component it was a temporal dead zone violation: panelActions threw
    // "Cannot access 'markedSet' before initialization" during render, React
    // unmounted the whole tree, and the portal went blank on opening Artifacts.
    const markedSet = React.useMemo(() => new Set(viewState.markedIds || []), [viewState.markedIds]);

    const panelActions = React.createElement(React.Fragment, null,
        // Bulk actions only appear once something is marked, so the header
        // stays quiet in the common single-selection case.
        markedSet.size > 0
            ? React.createElement(React.Fragment, null,
                React.createElement("span", {
                    className: "ps-mini-button-label",
                    style: { padding: "0 6px", opacity: 0.85 },
                    title: "Cmd/Ctrl-click to mark, Shift-click for a range",
                }, `${markedSet.size} marked`),
                viewState.canDeleteArtifacts
                    ? React.createElement(IconButton, {
                        icon: React.createElement(TerminateGlyph),
                        label: `Delete ${markedSet.size} marked`,
                        onClick: () => controller.deleteMarkedArtifacts().catch(() => {}),
                    })
                    : null,
                React.createElement(IconButton, {
                    icon: "✕",
                    label: "Clear marks",
                    onClick: () => controller.clearArtifactMarks(),
                }))
            : null,
        React.createElement("input", {
            ref: fileInputRef,
            type: "file",
            className: "ps-hidden-file-input",
            multiple: true,
            tabIndex: -1,
            "aria-hidden": "true",
            onChange: (event) => {
                uploadFiles(Array.from(event.currentTarget.files || []));
                event.currentTarget.value = "";
            },
        }),
        React.createElement(IconButton, {
            icon: React.createElement(UploadGlyph),
            label: "Upload",
            onClick: openUploadPicker,
            disabled: !viewState.canBrowserUpload && !viewState.canPathUpload,
        }),
        React.createElement(IconButton, {
            icon: React.createElement(DownloadGlyph),
            label: "Download",
            onClick: () => controller.handleCommand(UI_COMMANDS.DOWNLOAD_SELECTED_FILE).catch(() => {}),
            disabled: !hasSelection,
        }),
        // Trash, not "✕" — the bulk-delete two buttons away was already a trash
        // can, and "✕" means "clear marks" in this same row.
        viewState.canDeleteArtifacts ? React.createElement(IconButton, {
            icon: React.createElement(TerminateGlyph),
            label: "Delete",
            onClick: () => controller.handleCommand(UI_COMMANDS.DELETE_SELECTED_FILE).catch(() => {}),
            disabled: !hasSelection,
        }) : null,
        viewState.canOpenLocally ? React.createElement(IconButton, {
            icon: "↗",
            label: "Open locally",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_SELECTED_FILE).catch(() => {}),
            disabled: !hasSelection,
        }) : null,
        React.createElement(IconButton, {
            icon: React.createElement(FunnelGlyph),
            label: "Filter",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_FILES_FILTER).catch(() => {}),
        }),
        // Desktop keeps the plain fullscreen toggle it has always had. The
        // back affordance belongs to the mobile overlay, which renders its own
        // top bar — putting it here too would change desktop behavior.
        React.createElement(IconButton, {
            icon: React.createElement(viewState.fullscreen ? CollapseGlyph : ExpandGlyph),
            label: viewState.fullscreen ? "Exit fullscreen" : "Fullscreen",
            onClick: () => controller.handleCommand(UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN).catch(() => {}),
        }));

    // Keyboard selection has to drag the viewport with it, exactly as the
    // session list does — otherwise j/k walks the selection straight out of
    // view and the list appears frozen.
    const selectedItemRef = React.useRef(null);
    React.useEffect(() => {
        const node = selectedItemRef.current;
        if (node && typeof node.scrollIntoView === "function") {
            node.scrollIntoView({ block: "nearest" });
        }
    }, [filesView.selectedIndex, viewState.selectedArtifactId]);

    const listContent = items.length === 0
        ? normalizeLines(filesView.listBodyLines || []).map((line, index) => React.createElement(Line, {
            key: `empty:${index}`,
            line,
            theme,
        }))
        : items.map((item, index) => React.createElement("button", {
            key: item.id,
            type: "button",
            ref: index === filesView.selectedIndex ? selectedItemRef : null,
            className: `ps-list-button${index === filesView.selectedIndex ? " is-selected" : ""}`
                + (markedSet.has(item.id) ? " is-marked" : ""),
            onClick: (event) => {
                controller.setFocus("inspector");
                // Cmd/Ctrl toggles one, Shift extends a run, plain click
                // selects and drops the marks — the usual list conventions.
                if (event.metaKey || event.ctrlKey) {
                    controller.toggleArtifactMark(item);
                    return;
                }
                if (event.shiftKey) {
                    controller.markArtifactRange(item);
                    return;
                }
                controller.clearArtifactMarks();
                controller.selectFileBrowserItem(item)
                    .then(() => { if (mobile) controller.handleCommand(UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN).catch(() => {}); })
                    .catch(() => {});
            },
        }, React.createElement(Line, {
            line: normalizeLines([filesView.listBodyLines?.[index]])[0],
            theme,
        })));

    // A .patch/.diff artifact is rendered AS a diff — gutter markers, add/remove
    // tinting — rather than as undifferentiated grey text. This is the whole
    // point of clicking through from the transcript.
    const previewReady = !filesView.previewLoading && !filesView.previewError;
    const previewIsDiff = previewReady
        && isDiffArtifact(filesView.selectedFilename, filesView.previewContentType)
        && !filesView.previewIsBinary
        && Boolean(filesView.previewContent);

    // Images are routed by content type OR extension, and go to the binary
    // panel even when the payload is text (SVG) — it owns the authenticated
    // fetch → object URL path that renders an artifact safely.
    const previewIsImage = previewReady
        && (IMAGE_CONTENT_TYPE_RE.test(String(filesView.previewContentType || ""))
            || IMAGE_FILENAME_RE.test(String(filesView.selectedFilename || "")));

    // Source files get real syntax highlighting instead of undifferentiated
    // grey text — the same highlighter the chat code blocks use.
    const previewCodeLanguage = previewReady
        && !filesView.previewIsBinary
        && !previewIsDiff
        && filesView.previewRenderMode !== "markdown"
        && Boolean(filesView.previewContent)
        ? codeLanguageForArtifact(filesView.selectedFilename)
        : null;

    // Detached (desktop) => the preview is its own pane in the activity slot and
    // claims activity focus, so arrows/j/k/PgUp scroll IT. Inline (mobile) it is
    // part of the inspector and keeps inspector focus.
    const previewFocusRegion = previewOnly ? "activity" : null;
    // In the mobile overlay the browser owns scrolling outright.
    const previewPaneKey = nativeScroll ? null : "filePreview";

    const previewIsTabular = previewReady
        && !filesView.previewIsBinary
        && isTabularArtifact(filesView.selectedFilename, filesView.previewContentType)
        && Boolean(filesView.previewContent);

    const previewPane = previewIsTabular
        ? React.createElement(RenderedPreviewPanel, {
            controller, title: null, color: "cyan", focused: false, theme,
            paneKey: previewPaneKey, scrollOffset: viewState.previewScroll,
            className: "ps-csv-preview", focusRegion: previewFocusRegion,
        }, React.createElement(TabularPreview, {
            content: filesView.previewContent,
            filename: filesView.selectedFilename,
        }))
        : previewIsImage
        ? React.createElement(BinaryArtifactPreviewPanel, {
            title: null,
            color: "cyan",
            focused: false,
            theme,
            filename: filesView.selectedFilename,
            contentType: filesView.previewContentType,
            sizeBytes: filesView.previewSizeBytes,
            source: filesView.previewSource,
            uploadedAt: filesView.previewUploadedAt,
            controller,
            sessionId: filesView.selectedSessionId,
        })
        : previewCodeLanguage
        ? React.createElement(RenderedPreviewPanel, {
            controller, title: null, color: "cyan", focused: false, theme,
            paneKey: previewPaneKey, scrollOffset: viewState.previewScroll,
            className: "ps-diff-preview", focusRegion: previewFocusRegion,
        },
            React.createElement("pre", { className: "ps-md-code-pre" },
                React.createElement("code", null,
                    renderHighlightedCode(filesView.previewContent, previewCodeLanguage, theme))))
        : previewIsDiff
        ? React.createElement(RenderedPreviewPanel, {
            controller, title: null, color: "cyan", focused: false, theme,
            paneKey: previewPaneKey, scrollOffset: viewState.previewScroll,
            className: "ps-diff-preview", focusRegion: previewFocusRegion,
        },
            React.createElement("pre", { className: "ps-md-code-pre is-diff" },
                React.createElement("code", null, renderDiffCode(filesView.previewContent, theme))))
        : filesView.previewRenderMode === "markdown"
        && !filesView.previewLoading
        && !filesView.previewError
        ? React.createElement(MarkdownPreviewPanel, {
            controller,
            title: null,
            color: "cyan",
            focused: false,
            scrollOffset: viewState.previewScroll,
            paneKey: previewPaneKey,
            theme,
            focusRegion: previewFocusRegion,
            content: stripYamlFrontmatter(filesView.previewContent || ""),
        })
        : filesView.previewIsBinary
            && !filesView.previewLoading
            && !filesView.previewError
            ? React.createElement(BinaryArtifactPreviewPanel, {
                title: null,
                color: "cyan",
                focused: false,
                theme,
                filename: filesView.selectedFilename,
                contentType: filesView.previewContentType,
                sizeBytes: filesView.previewSizeBytes,
                source: filesView.previewSource,
                uploadedAt: filesView.previewUploadedAt,
                controller,
                sessionId: filesView.selectedSessionId,
            })
        : React.createElement(ScrollLinesPanel, {
            controller,
            title: null,
            color: "cyan",
            focused: false,
            lines: filesView.previewLines,
            scrollOffset: viewState.previewScroll,
            scrollMode: "top",
            paneKey: previewPaneKey,
            focusRegion: previewFocusRegion,
            className: "is-preview is-wrapped",
        });
    const view = viewState;

    if (previewOnly) return previewPane;

    return React.createElement(Panel, {
        title: view.fullscreen
            ? filesView.fullscreenTitle
            : (mobile && filesView.panelTitleMobile)
                ? filesView.panelTitleMobile
                : filesView.panelTitle,
        color: "magenta",
        focused: view.focused,
        actions: panelActions,
        theme,
    },
    React.createElement(InspectorTabs, { activeTab: "files", controller }),
    // Fullscreen files mode shows only the preview pane; the list stays hidden.
    view.fullscreen
        ? previewPane
        : React.createElement("div", {
            // The pane is a LIST, full stop. Desktop detaches the preview into
            // the activity slot; mobile opens the full-screen overlay on tap.
            // Neither wants a cramped preview stacked under the list.
            className: "ps-files-grid is-list-only",
        },
            // No nested panel: the enclosing Files pane is already the box, and
            // a second border + header inside it only ate vertical space to
            // restate what the pane title says.
            React.createElement("div", { className: "ps-action-list ps-files-list" }, listContent),
        ));
}

function InspectorPane({ controller, mobile = false, panelClassName = "", extraActions = null }) {
    const viewState = useControllerSelector(controller, (state) => {
        const layout = computeStateLayout(state);
        const inspectorTab = state.ui.inspectorTab;
        const paneWidth = mobile
            ? (state.ui.layout?.viewportWidth ?? 120)
            : layout.rightWidth;
        return {
            inspectorTab,
            statsViewMode: state.ui.statsViewMode,
            // The Node Map renders from the worker registry: subscribe to it
            // here or the pane never re-renders when rows arrive.
            adminWorkers: state.admin?.workers,
            nodeMapSelectedNode: state.ui.nodeMapSelectedNode,
            activeSessionId: state.sessions.activeSessionId,
            sessionsById: state.sessions.byId,
            sessionsFlat: state.sessions.flat,
            historyBySessionId: state.history.bySessionId,
            sessionStats: state.sessionStats,
            fleetStats: state.fleetStats,
            connection: state.connection,
            orchestrationBySessionId: state.orchestration.bySessionId,
            executionHistoryBySessionId: state.executionHistory?.bySessionId || {},
            executionHistoryFormat: state.executionHistory?.format || "pretty",
            logs: state.logs,
            files: state.files,
            focused: state.ui.focusRegion === "inspector",
            scroll: state.ui.scroll.inspector,
            followBottom: state.ui.followBottom?.inspector !== false,
            logsTailing: state.logs.tailing,
            filesFullscreen: Boolean(state.files.fullscreen),
            contentWidth: getPortalInspectorContentWidth(paneWidth, inspectorTab),
        };
    }, shallowEqualObject);
    const selectorState = React.useMemo(() => ({
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: viewState.sessionsById,
            flat: viewState.sessionsFlat,
        },
        history: {
            bySessionId: viewState.historyBySessionId,
        },
        sessionStats: viewState.sessionStats,
        fleetStats: viewState.fleetStats,
        connection: viewState.connection,
        // selectInspector → buildNodeMapLines reads the registry from here.
        // Omitting it made the Node Map permanently blind to worker rows
        // (and to every refresh attempt) no matter what the controller did.
        admin: { workers: viewState.adminWorkers },
        ui: {
            inspectorTab: viewState.inspectorTab,
            statsViewMode: viewState.statsViewMode,
            nodeMapSelectedNode: viewState.nodeMapSelectedNode,
            scroll: {
                inspector: viewState.scroll,
            },
        },
        logs: viewState.logs,
        files: viewState.files,
        orchestration: {
            bySessionId: viewState.orchestrationBySessionId,
        },
        executionHistory: {
            bySessionId: viewState.executionHistoryBySessionId,
            format: viewState.executionHistoryFormat,
        },
    }), [
        viewState.activeSessionId,
        viewState.adminWorkers,
        viewState.connection,
        viewState.executionHistoryBySessionId,
        viewState.executionHistoryFormat,
        viewState.fleetStats,
        viewState.nodeMapSelectedNode,
        viewState.files,
        viewState.historyBySessionId,
        viewState.inspectorTab,
        viewState.sessionStats,
        viewState.statsViewMode,
        viewState.logs,
        viewState.orchestrationBySessionId,
        viewState.scroll,
        viewState.sessionsById,
        viewState.sessionsFlat,
    ]);
    const inspector = React.useMemo(() => selectInspector(selectorState, {
        width: viewState.contentWidth,
        allowWideColumns: mobile,
    }), [mobile, selectorState, viewState.contentWidth]);
    const completionByTurn = React.useMemo(() => {
        const history = viewState.activeSessionId
            ? viewState.historyBySessionId?.get(viewState.activeSessionId) || null
            : null;
        const map = new Map();
        for (const event of history?.events || []) {
            if (event?.eventType !== "session.turn_completed") continue;
            const turn = Number(event?.data?.turnIndex ?? event?.data?.iteration);
            if (Number.isFinite(turn)) map.set(turn, event);
        }
        return map;
    }, [viewState.activeSessionId, viewState.historyBySessionId]);
    const renderSequenceBody = React.useCallback((lines, theme) => (
        React.createElement(PortalSequenceLines, { lines, theme, completionByTurn })
    ), [completionByTurn]);
    const renderNodeMapBody = React.useCallback((lines, theme) => (
        React.createElement(PortalNodeMapLines, { lines, theme, controller })
    ), [controller]);
    // The nodes tab owns its freshness: registry + history load on entry and
    // every 10s while open, independent of any host sync loop. Errors keep
    // fetchedAt unset, so each tick retries until the diagnosis line clears.
    React.useEffect(() => {
        if (viewState.inspectorTab !== "nodes") return undefined;
        void controller.ensureInspectorData("nodes");
        const timer = window.setInterval(() => {
            void controller.ensureInspectorData("nodes");
        }, 10_000);
        return () => window.clearInterval(timer);
    }, [controller, viewState.inspectorTab]);

    if (viewState.inspectorTab === "files" && !inspector.disabled) {
        return React.createElement(FilesPane, { controller, focused: viewState.focused, mobile });
    }

    const actions = [];
    if (viewState.inspectorTab === "logs") {
        actions.push(React.createElement(IconButton, {
            key: "tail",
            icon: viewState.logsTailing ? "■" : "⇣",
            label: viewState.logsTailing ? "Stop tailing" : "Tail (follow)",
            active: viewState.logsTailing,
            onClick: () => controller.handleCommand(UI_COMMANDS.TOGGLE_LOG_TAIL).catch(() => {}),
        }));
        actions.push(React.createElement(IconButton, {
            key: "filter",
            // Same funnel as the session and artifact filters — filtering should
            // look identical wherever it appears.
            icon: React.createElement(FunnelGlyph),
            label: "Filter",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_LOG_FILTER).catch(() => {}),
        }));
    } else if (viewState.inspectorTab === "history") {
        actions.push(React.createElement(IconButton, {
            key: "refresh",
            icon: "↻",
            label: "Refresh",
            onClick: () => controller.handleCommand(UI_COMMANDS.REFRESH_EXECUTION_HISTORY).catch(() => {}),
        }));
        actions.push(React.createElement(IconButton, {
            key: "save",
            icon: "⇩",
            label: "Export as artifact",
            onClick: () => controller.handleCommand(UI_COMMANDS.EXPORT_EXECUTION_HISTORY).catch(() => {}),
        }));
    } else if (viewState.inspectorTab === "stats") {
        const STATS_MODE_ICONS = { session: "◉", fleet: "⬢", users: "⚇" };
        for (const mode of ["session", "fleet", "users"]) {
            actions.push(React.createElement(IconButton, {
                key: `stats-view:${mode}`,
                icon: STATS_MODE_ICONS[mode],
                label: `${mode.replace(/^./u, (char) => char.toUpperCase())} stats`,
                active: viewState.statsViewMode === mode,
                onClick: () => controller.setStatsViewMode(mode),
            }));
        }
    }

    const panelActions = extraActions
        ? actions.concat(extraActions)
        : actions;

    return React.createElement(ScrollLinesPanel, {
        controller,
        title: inspector.title,
        color: "magenta",
        focused: viewState.focused,
        actions: panelActions,
        topContent: React.createElement(InspectorTabs, { activeTab: inspector.activeTab, controller }),
        stickyLines: inspector.stickyLines || [],
        lines: inspector.lines,
        renderBody: inspector.activeTab === "sequence"
            ? renderSequenceBody
            : inspector.activeTab === "nodes" ? renderNodeMapBody : null,
        scrollOffset: viewState.scroll,
        scrollMode: inspector.activeTab === "sequence"
            ? "bottom"
            : inspector.activeTab === "logs" && viewState.followBottom
                ? "bottom"
                : "top",
        stickyBottom: inspector.activeTab === "logs",
        paneKey: "inspector",
        className: inspector.activeTab === "history" || inspector.activeTab === "logs" ? "is-wrapped" : "is-preserve",
        panelClassName: `ps-inspector-pane${inspector.activeTab === "sequence" ? " has-preserved-sticky" : ""}${panelClassName ? ` ${panelClassName}` : ""}`.trim(),
    });
}

function ActivityPane({ controller, panelClassName = "", extraActions = null }) {
    const viewState = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const layout = computeStateLayout(state);
        const maxLines = Math.max(3, layout.activityPaneHeight - 2);
        return {
            activeSessionId,
            activeSession: activeSessionId ? state.sessions.byId[activeSessionId] || null : null,
            activeHistory: activeSessionId ? state.history.bySessionId.get(activeSessionId) || null : null,
            focused: state.ui.focusRegion === "activity",
            scroll: state.ui.scroll.activity,
            followBottom: state.ui.followBottom?.activity !== false,
            maxLines,
            // Node-scoped mode (a node picked in the Node Map) turns this pane
            // into the WORKER DETAILS panel, which needs the registry, the
            // selection, and every session/history — not just the active one.
            nodeMapSelectedNode: state.ui.nodeMapSelectedNode,
            adminWorkers: state.admin?.workers,
            branding: state.branding,
            sessionsById: state.sessions.byId,
            sessionsFlat: state.sessions.flat,
            historyBySessionId: state.history.bySessionId,
            inspectorTab: state.ui.inspectorTab,
        };
    }, shallowEqualObject);
    // On the Node Map tab this pane IS the worker-details pane; Activity
    // returns the moment the inspector shows anything else.
    const nodeMode = viewState.inspectorTab === "nodes";
    const selectorState = React.useMemo(() => ({
        branding: viewState.branding,
        admin: { workers: viewState.adminWorkers },
        ui: { nodeMapSelectedNode: viewState.nodeMapSelectedNode },
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: nodeMode
                ? viewState.sessionsById
                : (viewState.activeSessionId && viewState.activeSession
                    ? { [viewState.activeSessionId]: viewState.activeSession }
                    : {}),
            flat: viewState.sessionsFlat,
        },
        history: {
            bySessionId: nodeMode
                ? viewState.historyBySessionId
                : (viewState.activeSessionId && viewState.activeHistory
                    ? new Map([[viewState.activeSessionId, viewState.activeHistory]])
                    : new Map()),
        },
    }), [
        nodeMode,
        viewState.activeHistory, viewState.activeSession, viewState.activeSessionId,
        viewState.adminWorkers, viewState.branding, viewState.historyBySessionId,
        viewState.nodeMapSelectedNode, viewState.sessionsById, viewState.sessionsFlat,
    ]);
    const activity = React.useMemo(
        () => (nodeMode
            ? selectWorkerDetailsPane(selectorState)
            : selectActivityPane(selectorState, viewState.maxLines)),
        [nodeMode, selectorState, viewState.maxLines],
    );

    return React.createElement(ScrollLinesPanel, {
        controller,
        title: activity.title,
        color: "gray",
        focused: viewState.focused,
        actions: extraActions,
        lines: activity.lines,
        scrollOffset: viewState.scroll,
        scrollMode: viewState.followBottom ? "bottom" : "top",
        stickyBottom: true,
        paneKey: "activity",
        className: "is-wrapped",
        // Stable identity class so styling can target the activity surface
        // without depending on which slot rendered it.
        panelClassName: `ps-activity-pane${panelClassName ? ` ${panelClassName}` : ""}`,
    });
}

const CHAT_FOCUS_PANES = [
    { id: "sessions", label: "Sessions", side: "left" },
    { id: "inspector", label: "Inspector", side: "right" },
    { id: "activity", label: "Activity", side: "right" },
];

function ChatFocusOverlay({ controller, pane, onClose, mobile = false }) {
    if (!pane) return null;

    let content = null;
    if (pane === "sessions") {
        // No close button: the rail's own Sessions toggle already closes this,
        // and a second ✕ crowded a header that already carries five actions.
        content = React.createElement(SessionPane, {
            controller,
            panelClassName: "ps-chat-focus-pane",
            structuredRows: mobile,
        });
    } else if (pane === "inspector") {
        content = React.createElement(InspectorPane, {
            controller,
            mobile: false,
            panelClassName: "ps-chat-focus-pane",
            extraActions: React.createElement("button", {
                type: "button",
                className: "ps-mini-button ps-overlay-close",
                onClick: onClose,
                "aria-label": "Close",
                title: "Close",
            }, "✕"),
        });
    } else if (pane === "activity") {
        content = React.createElement(ActivityPane, {
            controller,
            panelClassName: "ps-chat-focus-pane",
            extraActions: React.createElement("button", {
                type: "button",
                className: "ps-mini-button ps-overlay-close",
                onClick: onClose,
                "aria-label": "Close",
                title: "Close",
            }, "✕"),
        });
    }

    const paneMeta = CHAT_FOCUS_PANES.find((entry) => entry.id === pane);
    return React.createElement("div", {
        className: `ps-chat-focus-overlay${paneMeta?.side === "left" ? " is-left" : " is-right"}`,
    }, content);
}

function ChatFocusWorkspace({ controller, openPane, onTogglePane, onExitFocus, mobile = false }) {
    const focusRegion = useControllerSelector(controller, (state) => state.ui.focusRegion);

    // Icons, not words: two text buttons ate a whole row of phone height, and
    // IconButton carries the label as a hover tooltip / long-press on touch.
    const rail = mobile
        ? React.createElement("div", { className: "ps-chat-focus-rail" },
            React.createElement(IconButton, {
                className: "ps-mini-button ps-chat-focus-button",
                icon: React.createElement(CollapseGlyph),
                label: "Exit focus mode",
                onClick: onExitFocus,
            }),
            React.createElement(IconButton, {
                className: "ps-mini-button ps-chat-focus-button",
                icon: React.createElement(SidebarGlyph),
                label: openPane === "sessions" ? "Hide sessions" : "Show sessions",
                active: openPane === "sessions",
                onClick: () => onTogglePane("sessions"),
            }))
        : React.createElement("div", { className: "ps-chat-focus-rail" },
            CHAT_FOCUS_PANES.map((pane) => React.createElement("button", {
                key: pane.id,
                type: "button",
                className: `ps-mini-button ps-chat-focus-button${openPane === pane.id ? " is-active" : ""}`,
                "aria-pressed": openPane === pane.id ? "true" : "false",
                onClick: () => onTogglePane(pane.id),
            }, pane.label)),
            React.createElement("div", { className: "ps-chat-focus-status" },
                openPane
                    ? `Focused: ${CHAT_FOCUS_PANES.find((pane) => pane.id === openPane)?.label || openPane}`
                    : `Focused: ${focusRegion === "prompt" ? "Prompt" : "Chat"}`));

    return React.createElement("div", { className: "ps-chat-focus-shell" },
        rail,
        React.createElement("div", { className: "ps-chat-focus-body" },
            React.createElement(ChatPane, { controller, mobile, fullWidth: true }),
            React.createElement(ChatFocusOverlay, {
                controller,
                pane: openPane,
                onClose: () => onTogglePane(openPane),
                mobile,
            })));
}

const EMPTY_ARRAY = Object.freeze([]);

function formatAttachmentSize(sizeBytes) {
    const bytes = Number(sizeBytes) || 0;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

function PromptComposer({ controller, mobile, active = true, onAfterSend = null }) {
    const promptState = useControllerSelector(controller, (state) => {
        const activeSessionId = state.sessions.activeSessionId;
        const activeSession = activeSessionId ? state.sessions.byId[activeSessionId] || null : null;
        const outbox = activeSessionId && state.outbox?.bySessionId?.[activeSessionId]
            ? state.outbox.bySessionId[activeSessionId]
            : [];
        return {
            value: state.ui.prompt,
            cursor: state.ui.promptCursor,
            focused: state.ui.focusRegion === "prompt",
            modalOpen: Boolean(state.ui.modal),
            answerMode: Boolean(activeSession?.pendingQuestion?.question),
            canStopTurn: canStopSessionTurn(activeSession),
            hasOutbox: outbox.length > 0,
            hasPendingOutbox: outbox.some((item) => item?.phase === "pending"),
            pendingCount: outbox.filter((item) => item?.phase === "pending").length,
            editingPending: state.ui.promptEdit?.sessionId === activeSessionId,
            selectedOutboxPhase: state.ui.promptEdit?.sessionId === activeSessionId
                ? state.ui.promptEdit?.phase || null
                : null,
            // Raw reference (stable across renders) — image entries are
            // filtered at render time so the shallow-equal selector holds.
            promptAttachments: state.ui.promptAttachments || EMPTY_ARRAY,
        };
    }, shallowEqualObject);
    const inputRef = React.useRef(null);
    const attachInputRef = React.useRef(null);
    const [dragOver, setDragOver] = React.useState(false);

    const canAttachImages = typeof controller.transport?.supportsPromptImageAttachments === "function"
        && controller.transport.supportsPromptImageAttachments()
        && typeof controller.transport?.uploadArtifactFromFile === "function";
    const imageAttachments = canAttachImages
        ? promptState.promptAttachments.filter((a) => a?.kind === "image")
        : EMPTY_ARRAY;

    // Object URLs for chip thumbnails — created per staged File, revoked when
    // the chip leaves (send/remove) or the composer unmounts.
    const thumbUrlsRef = React.useRef(new Map());
    React.useEffect(() => {
        const urls = thumbUrlsRef.current;
        const liveFiles = new Set(imageAttachments.map((a) => a.file));
        for (const [file, url] of urls) {
            if (!liveFiles.has(file)) {
                URL.revokeObjectURL(url);
                urls.delete(file);
            }
        }
        for (const attachment of imageAttachments) {
            if (attachment.file && !urls.has(attachment.file)) {
                try {
                    urls.set(attachment.file, URL.createObjectURL(attachment.file));
                } catch { /* thumbnail is a nicety — the chip still renders */ }
            }
        }
    }, [imageAttachments]);
    React.useEffect(() => () => {
        for (const url of thumbUrlsRef.current.values()) URL.revokeObjectURL(url);
        thumbUrlsRef.current.clear();
    }, []);

    const stageImageFiles = React.useCallback((files) => {
        if (!canAttachImages) return 0;
        const list = Array.from(files || []).filter((f) => f && typeof f.type === "string" && f.type.startsWith("image/"));
        if (list.length === 0) return 0;
        const result = controller.addPendingImageFiles(list);
        return result?.accepted || 0;
    }, [controller, canAttachImages]);

    React.useEffect(() => {
        const inputNode = inputRef.current;
        if (!active || promptState.modalOpen || !promptState.focused || !inputNode) return;
        if (document.activeElement !== inputNode) {
            try {
                inputNode.focus({ preventScroll: true });
            } catch {
                inputNode.focus();
            }
        }
        inputNode.setSelectionRange(promptState.cursor, promptState.cursor);
    }, [active, promptState.cursor, promptState.focused, promptState.modalOpen]);

    const sendPrompt = React.useCallback(() => {
        controller.handleCommand(UI_COMMANDS.SEND_PROMPT)
            .catch(() => {})
            .finally(() => {
                onAfterSend?.();
            });
    }, [controller, onAfterSend]);

    const [stoppingTurn, setStoppingTurn] = React.useState(false);
    const stopTurn = React.useCallback(() => {
        setStoppingTurn(true);
        controller.handleCommand(UI_COMMANDS.STOP_TURN)
            .catch(() => {})
            .finally(() => setStoppingTurn(false));
    }, [controller]);

    const cancelPending = React.useCallback(() => {
        if (controller.getState().ui.promptEdit) {
            if (typeof controller.cancelSelectedOutboxPrompt === "function") {
                controller.cancelSelectedOutboxPrompt().catch(() => {});
            } else {
                controller.cancelSelectedPendingPrompt();
            }
            return;
        }
        if (typeof controller.cancelLatestQueuedOutbox === "function") {
            controller.cancelLatestQueuedOutbox().catch(() => {});
        }
    }, [controller]);

    const sendLabel = promptState.editingPending || (promptState.hasPendingOutbox && !promptState.value.trim())
        ? "⇪"
        : promptState.hasOutbox
            ? "+"
            : "❯";
    const selectedQueued = promptState.selectedOutboxPhase === "queued";
    const selectedCancelling = promptState.selectedOutboxPhase === "cancelling";
    const selectedReadOnly = selectedQueued || selectedCancelling;

    return React.createElement("div", {
        className: `ps-prompt-shell${mobile ? " is-mobile" : ""}${dragOver ? " is-drag-over" : ""}`,
        ...(canAttachImages ? {
            onDragOver: (event) => {
                if (event.dataTransfer?.types?.includes?.("Files")) {
                    event.preventDefault();
                    setDragOver(true);
                }
            },
            onDragLeave: (event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(false);
            },
            onDrop: (event) => {
                setDragOver(false);
                if (event.dataTransfer?.files?.length) {
                    event.preventDefault();
                    stageImageFiles(event.dataTransfer.files);
                }
            },
        } : {}),
    },
        imageAttachments.length > 0
            ? React.createElement("div", { className: "ps-prompt-attachments" },
                imageAttachments.map((attachment, index) => {
                    const thumbUrl = attachment.file ? thumbUrlsRef.current.get(attachment.file) : null;
                    // No filename in the chip: pasted images all arrive as the
                    // browser's generic "image.png", and the name is replaced
                    // by a deterministic artifact name at send anyway. The
                    // thumbnail IS the identity; the name survives as a tooltip.
                    return React.createElement("div", {
                        key: `attach:${index}:${attachment.filename}`,
                        className: "ps-attach-chip",
                        title: `${attachment.filename} · ${formatAttachmentSize(attachment.sizeBytes)}`,
                    },
                        thumbUrl
                            ? React.createElement("img", { className: "ps-attach-thumb", src: thumbUrl, alt: attachment.filename })
                            : React.createElement("div", { className: "ps-attach-thumb is-placeholder" }, "🖼"),
                        React.createElement("div", { className: "ps-attach-size" }, formatAttachmentSize(attachment.sizeBytes)),
                        React.createElement("button", {
                            type: "button",
                            className: "ps-attach-remove",
                            title: `Remove ${attachment.filename}`,
                            "aria-label": `Remove attachment ${attachment.filename}`,
                            onClick: () => controller.removePendingImageAttachment(index),
                        }, "✕"));
                }))
            : null,
        // The label carries real mode signal (answer / queued / pending /
        // cancelling); only the idle "you" is a terminal-prompt affordance,
        // so it is tagged for the rich view to hide.
        (() => {
            const promptLabelText = promptState.answerMode ? "answer"
                : selectedCancelling ? "cancelling"
                : selectedQueued ? "queued"
                : promptState.editingPending ? "pending"
                : "you";
            return React.createElement("label", {
                className: `ps-prompt-label${promptLabelText === "you" ? " is-default" : ""}`,
            }, promptLabelText);
        })(),
        React.createElement("textarea", {
            ref: inputRef,
            className: "ps-prompt-input",
            rows: mobile ? 2 : Math.max(2, getPromptInputRows(promptState.value)),
            value: promptState.value,
            readOnly: selectedReadOnly,
            placeholder: promptState.answerMode
                ? "Type an answer and press Enter"
                : promptState.editingPending
                    ? selectedCancelling
                        ? "Cancellation requested"
                        : selectedQueued
                        ? "Queued message selected"
                        : "Edit the pending message, then send or cancel it"
                    : promptState.hasOutbox
                        ? "Type a message and press Enter to queue it behind the pending batch"
                : "Type a message and press Enter",
            enterKeyHint: "send",
            onFocus: () => controller.setFocus("prompt"),
            onSelect: (event) => controller.setPromptCursor(event.currentTarget.selectionStart || 0),
            onChange: (event) => controller.setPrompt(event.currentTarget.value, event.currentTarget.selectionStart || event.currentTarget.value.length),
            // Ctrl/Cmd+V of a copied image (or iOS/Android long-press → Paste):
            // clipboardData.items carries the image file(s). preventDefault only
            // when we actually staged one, so text pastes are untouched.
            onPaste: canAttachImages
                ? (event) => {
                    const items = Array.from(event.clipboardData?.items || []);
                    const files = items
                        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                        .map((item) => item.getAsFile())
                        .filter(Boolean);
                    if (files.length > 0 && stageImageFiles(files) > 0) {
                        event.preventDefault();
                    }
                }
                : undefined,
            onKeyDown: (event) => {
                if (event.key === "Tab" && !event.shiftKey && controller.acceptPromptReferenceAutocomplete()) {
                    event.preventDefault();
                    return;
                }
                if (event.key === "ArrowUp" && !event.shiftKey && !event.metaKey && !event.altKey) {
                    event.preventDefault();
                    controller.movePromptCursorVertical(-1);
                    return;
                }
                if (event.key === "ArrowDown" && !event.shiftKey && !event.metaKey && !event.altKey) {
                    event.preventDefault();
                    controller.movePromptCursorVertical(1);
                    return;
                }
                if (event.key === "Escape" && promptState.editingPending) {
                    event.preventDefault();
                    if (selectedReadOnly) {
                        controller.exitPendingPromptEdit({ restoreDraft: true });
                        return;
                    }
                    cancelPending();
                    return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !mobile) {
                    event.preventDefault();
                    sendPrompt();
                }
            },
        }),
        React.createElement("div", { className: "ps-prompt-actions" },
            canAttachImages
                ? React.createElement(React.Fragment, null,
                    React.createElement("input", {
                        ref: attachInputRef,
                        type: "file",
                        // image/* (not the exact MIME list) so phones offer the
                        // photo library and camera; exact types are validated
                        // on staging and again at the API edge.
                        accept: "image/*",
                        multiple: true,
                        className: "ps-hidden-file-input",
                        "aria-hidden": true,
                        tabIndex: -1,
                        onChange: (event) => {
                            stageImageFiles(event.currentTarget.files);
                            event.currentTarget.value = "";
                        },
                    }),
                    React.createElement("button", {
                        type: "button",
                        className: "ps-mini-button ps-attach-button",
                        title: "Attach images (or paste / drop them into the composer)",
                        "aria-label": "Attach images",
                        onClick: () => attachInputRef.current?.click(),
                    }, "📎"))
                : null,
            promptState.editingPending && !selectedCancelling
                ? React.createElement("button", {
                    type: "button",
                    className: "ps-mini-button",
                    title: selectedQueued ? "Delete selected queued prompt" : "Cancel selected pending prompt",
                    "aria-label": selectedQueued ? "Delete selected queued prompt" : "Cancel selected pending prompt",
                    onClick: cancelPending,
                }, selectedQueued ? "Delete" : "Cancel")
                : null,
            promptState.canStopTurn || stoppingTurn
                ? React.createElement("button", {
                    type: "button",
                    className: `ps-stop-button${stoppingTurn ? " is-stopping" : ""}`,
                    title: "Stop the current turn (the session stays alive and returns to idle)",
                    "aria-label": "Stop the current turn",
                    disabled: stoppingTurn,
                    onClick: stopTurn,
                }, "■")
                : null,
            React.createElement("button", {
                type: "button",
                className: `ps-send-button${mobile ? " is-inline" : ""}`,
                title: promptState.editingPending || (promptState.hasPendingOutbox && !promptState.value.trim())
                    ? "Send all queued prompts"
                    : promptState.hasOutbox
                        ? "Queue prompt behind the pending batch"
                        : "Send prompt",
                "aria-label": promptState.editingPending || (promptState.hasPendingOutbox && !promptState.value.trim())
                    ? "Send queued prompts"
                    : promptState.hasOutbox
                        ? "Queue prompt"
                        : "Send prompt",
                onClick: sendPrompt,
            }, sendLabel),
        ),
    );
}

function StatusStrip({ controller }) {
    const status = useControllerSelector(controller, (state) => selectStatusBar(state), shallowEqualObject);
    return React.createElement("div", { className: "ps-status-strip" },
        React.createElement("div", { className: "ps-status-left" }, status.left),
        React.createElement("div", { className: "ps-status-right" }, status.right),
    );
}

// A compact icon button whose meaning is revealed on demand via a custom
// tooltip: desktop hover shows it after a fixed 1s (the native `title` delay is
// browser-controlled and too long); touch devices get a long-press tooltip
// (hold ~450ms to see the label, release to dismiss — the long-press does not
// fire onClick). aria-label carries the meaning for assistive tech.
const ICON_HOVER_TOOLTIP_MS = 1000;
function IconButton({ icon, label, onClick, disabled = false, active = false, className = "ps-toolbar-button" }) {
    // The tooltip is portaled to <body> so it escapes the toolbar/pane
    // overflow-clipping and stacking contexts (nested tooltips were hidden
    // behind, or bled through by, the panes). Coordinates are computed from
    // the button rect; it flips above when there's no room below.
    const [tip, setTip] = React.useState(null); // { x, y, placement } | null
    const btnRef = React.useRef(null);
    const tipRef = React.useRef(null);
    const timerRef = React.useRef(null);
    const longPressRef = React.useRef(false);

    // Keep the tooltip within the viewport horizontally — the leftmost/rightmost
    // buttons would otherwise clip off the edge (the tooltip is center-anchored).
    React.useLayoutEffect(() => {
        if (!tip || !tipRef.current || typeof window === "undefined") return;
        const half = tipRef.current.offsetWidth / 2;
        const margin = 6;
        const clampedX = Math.max(half + margin, Math.min(tip.x, window.innerWidth - half - margin));
        tipRef.current.style.left = `${clampedX}px`;
    }, [tip]);

    const reveal = (preferAbove = false) => {
        const el = btnRef.current;
        if (!el || typeof window === "undefined") return;
        const r = el.getBoundingClientRect();
        // Touch prefers ABOVE (the finger covers anything below the button);
        // hover prefers below. Either flips when there's no room.
        const below = preferAbove
            ? r.top - 44 < 0
            : r.bottom + 44 < window.innerHeight;
        setTip({
            x: r.left + r.width / 2,
            y: below ? r.bottom + 6 : r.top - 6,
            placement: below ? "below" : "above",
        });
    };

    // Touch and hover are handled through pointer events so each path can
    // filter on pointerType — the synthesized mouse events iOS fires after
    // touchend used to restart the hover timer and leave a ghost tooltip
    // stuck open (a finger never produces mouseleave).
    const hideTimerRef = React.useRef(null);
    const pressOriginRef = React.useRef(null);

    const startHover = (e) => {
        if (e.pointerType !== "mouse") return;
        clearTimeout(timerRef.current);
        clearTimeout(hideTimerRef.current);
        timerRef.current = setTimeout(reveal, ICON_HOVER_TOOLTIP_MS);
    };
    const endHover = (e) => {
        if (e.pointerType !== "mouse") return;
        clearTimeout(timerRef.current);
        clearTimeout(hideTimerRef.current);
        setTip(null);
    };
    const startPress = (e) => {
        if (e.pointerType === "mouse") return;
        longPressRef.current = false;
        pressOriginRef.current = { x: e.clientX, y: e.clientY };
        clearTimeout(timerRef.current);
        clearTimeout(hideTimerRef.current);
        timerRef.current = setTimeout(() => { longPressRef.current = true; reveal(true); }, 450);
    };
    const movePress = (e) => {
        // Fingers jitter during a long-press; only real movement (a scroll
        // intent) cancels. A hide-on-any-move here is what made the bubble
        // vanish mid-press.
        if (e.pointerType === "mouse" || !pressOriginRef.current) return;
        const dx = e.clientX - pressOriginRef.current.x;
        const dy = e.clientY - pressOriginRef.current.y;
        if (dx * dx + dy * dy > 100) {
            pressOriginRef.current = null;
            clearTimeout(timerRef.current);
            setTip(null);
        }
    };
    const endPress = (e) => {
        if (e.pointerType === "mouse") return;
        pressOriginRef.current = null;
        clearTimeout(timerRef.current);
        if (longPressRef.current) {
            // Long-press: keep the bubble up while pressed, then linger 3s
            // after the finger lifts.
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = setTimeout(() => setTip(null), 3000);
            // The suppressed click usually fires right after pointerup and
            // consumes the flag; clear it shortly after in case it never
            // arrives, so the NEXT tap isn't swallowed.
            setTimeout(() => { longPressRef.current = false; }, 250);
        } else {
            setTip(null);
        }
    };
    React.useEffect(() => () => {
        clearTimeout(timerRef.current);
        clearTimeout(hideTimerRef.current);
    }, []);

    const handleClick = (e) => {
        // Suppress the click that follows a long-press (tooltip reveal only).
        if (longPressRef.current) { longPressRef.current = false; e.preventDefault?.(); return; }
        if (!disabled) onClick?.(e);
    };

    // iOS fires contextmenu on long-press; without this (plus the
    // touch-callout/user-select CSS on .ps-icon-button) the system
    // loupe/copy/zoom callout opens on top of our tooltip.
    const handleContextMenu = (e) => { e.preventDefault?.(); };

    const tooltipNode = tip && typeof document !== "undefined" && document.body
        ? createPortal(
            React.createElement("span", {
                ref: tipRef,
                className: `ps-icon-tooltip is-${tip.placement}`,
                role: "tooltip",
                style: { left: `${tip.x}px`, top: `${tip.y}px` },
            }, label),
            document.body)
        : null;

    return React.createElement("button", {
        ref: btnRef,
        type: "button",
        className: `${className} ps-icon-button${active ? " is-active" : ""}`,
        onClick: handleClick,
        disabled,
        "aria-label": label,
        onPointerEnter: startHover,
        onPointerLeave: endHover,
        onPointerDown: startPress,
        onPointerMove: movePress,
        onPointerUp: endPress,
        onPointerCancel: endPress,
        onContextMenu: handleContextMenu,
    },
    React.createElement("span", { className: "ps-icon-button-glyph", "aria-hidden": "true" }, icon),
    tooltipNode);
}

function Toolbar({ controller, mobile, chatFocusMode = false, onToggleChatFocus = null, chatFocusDisabled = false }) {
    const richUi = useControllerSelector(controller, (state) => Boolean(getTheme(state.ui.themeId)?.richChat));
    const [headerSlot, setHeaderSlot] = React.useState(null);
    React.useEffect(() => {
        if (typeof document === "undefined") return;
        // Desktop centres the toolbar in the portal header regardless of chat
        // view — the terminal view was spending a whole strip on it while the
        // rich view had already handed that row back to the panes. Mobile keeps
        // the inline strip; there is no header room for it on a phone.
        setHeaderSlot(!mobile ? document.getElementById("ps-header-toolbar-slot") : null);
    }, [richUi, mobile]);
    const adminVisible = useControllerSelector(controller, (state) => Boolean(state.admin?.visible));
    const chatView = useControllerSelector(controller, (state) => ({
        mode: state.ui.chatViewMode || "transcript",
        activeSessionIsGroup: Boolean(state.sessions.activeSessionId && state.sessions.byId[state.sessions.activeSessionId]?.isGroup),
    }), shallowEqualObject);

    // Icon-first toolbar: the glyph is the affordance, the label rides a
    // tooltip (desktop hover via title; mobile long-press via IconButton).
    const buttonDefs = [
        // ONE new-session button, and it opens the chooser. The plain "＋"
        // (default model, generic agent) and "＋⚙" (choose model, then agent)
        // were two buttons for one intent, and the pair cost a slot the phone
        // toolbar could not spare.
        {
            key: "new",
            icon: React.createElement(PlusGlyph),
            label: "New session — choose model and agent",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER).catch(() => {}),
        },
        {
            key: "filter",
            icon: React.createElement(FunnelGlyph),
            label: "Filter sessions",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_SESSION_FILTER).catch(() => {}),
        },
        {
            key: "theme",
            icon: React.createElement(ContrastGlyph),
            label: "Theme",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_THEME_PICKER).catch(() => {}),
        },
        {
            key: "summary",
            icon: React.createElement(chatView.mode === "summary" ? TranscriptGlyph : SummaryGlyph),
            label: chatView.activeSessionIsGroup
                ? "Groups show group details"
                : (chatView.mode === "summary" ? "Show chat transcript" : "Show summary"),
            onClick: () => controller.setChatViewMode(chatView.mode === "summary" ? "transcript" : "summary"),
            disabled: chatView.activeSessionIsGroup,
            active: chatView.mode === "summary",
        },
        ...(onToggleChatFocus ? [{
            key: "focus",
            icon: React.createElement(chatFocusMode ? CollapseGlyph : ExpandGlyph),
            label: chatFocusMode ? "Exit focus mode" : "Focus the chat pane",
            onClick: onToggleChatFocus,
            disabled: chatFocusDisabled,
            active: chatFocusMode,
        }] : []),
        // Admin console is desktop-only: its settings tree, package detail
        // and file preview need width the phone layout cannot give them, so
        // the button is omitted rather than shipped half-working.
        ...(mobile ? [] : [{
            key: "admin",
            icon: React.createElement(CogGlyph),
            label: adminVisible ? "Close admin console" : "Admin console",
            onClick: () => controller.handleCommand(adminVisible ? UI_COMMANDS.CLOSE_ADMIN_CONSOLE : UI_COMMANDS.OPEN_ADMIN_CONSOLE).catch(() => {}),
            active: adminVisible,
        }]),
    ];

    const renderButton = (def) => React.createElement(IconButton, {
        key: def.key,
        icon: def.icon,
        label: def.label,
        onClick: def.onClick,
        disabled: Boolean(def.disabled),
        active: Boolean(def.active),
    });

    if (mobile) {
        // Single line: icon buttons are compact enough to fit one row; the
        // ps-toolbar-row-actions container scrolls horizontally (hidden
        // scrollbar) on the narrowest screens instead of wrapping.
        return React.createElement("div", { className: "ps-toolbar is-mobile" },
            React.createElement("div", { className: "ps-toolbar-row ps-toolbar-row-primary" },
                React.createElement("div", { className: "ps-toolbar-row-actions" }, buttonDefs.map(renderButton))),
        );
    }

    const toolbar = React.createElement("div", { className: "ps-toolbar" },
        React.createElement("div", { className: "ps-toolbar-actions" }, buttonDefs.map(renderButton)),
    );

    // Rich desktop UI: the toolbar lives IN the portal header (one top bar)
    // rather than as its own strip, handing that row back to the panes. The
    // slot is rendered by PortalHeader in App.jsx, outside this tree, so the
    // handoff is a portal. Falls back to inline rendering when the slot is
    // absent (mobile layouts, embeddings that use their own header).
    if (headerSlot) return createPortal(toolbar, headerSlot);
    return toolbar;
}

function ColumnResizeHandle({ controller, paneAdjust = 0 }) {
    const dragStateRef = React.useRef(null);
    const [dragging, setDragging] = React.useState(false);

    React.useEffect(() => {
        if (!dragging) return undefined;

        const stopDragging = () => {
            dragStateRef.current = null;
            setDragging(false);
            document.body.classList.remove("is-resizing-pane-x");
        };

        // Apply at most one adjustment per frame. A drag emits pointermove far
        // faster than the browser paints, and each adjust re-renders every
        // pane — so most of that work was discarded before being displayed,
        // which is what made dragging a loaded layout feel heavy.
        let movePending = 0;
        let pendingClientX = 0;
        const applyMove = () => {
            movePending = 0;
            const dragState = dragStateRef.current;
            if (!dragState) return;
            const deltaCells = Math.round((pendingClientX - dragState.startX) / GRID_CELL_WIDTH);
            const deltaIncrement = deltaCells - dragState.appliedCells;
            if (!deltaIncrement) return;
            controller.adjustPaneSplit(deltaIncrement);
            dragState.appliedCells = deltaCells;
        };
        const onPointerMove = (event) => {
            if (!dragStateRef.current) return;
            pendingClientX = event.clientX;
            if (movePending) return;
            movePending = requestAnimationFrame(applyMove);
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", stopDragging);
        window.addEventListener("pointercancel", stopDragging);

        return () => {
            if (movePending) { cancelAnimationFrame(movePending); movePending = 0; }
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", stopDragging);
            window.removeEventListener("pointercancel", stopDragging);
            document.body.classList.remove("is-resizing-pane-x");
        };
    }, [controller, dragging]);

    return React.createElement("button", {
        type: "button",
        className: `ps-column-resizer${dragging ? " is-dragging" : ""}`,
        title: "Drag to resize the inspector column. Double-click to reset.",
        "aria-label": "Resize inspector column",
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragStateRef.current = {
                startX: event.clientX,
                appliedCells: 0,
            };
            setDragging(true);
            document.body.classList.add("is-resizing-pane-x");
        },
        onDoubleClick: () => {
            if (!paneAdjust) return;
            controller.adjustPaneSplit(-paneAdjust);
        },
        onKeyDown: (event) => {
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_RIGHT_PANE).catch(() => {});
                return;
            }
            if (event.key === "ArrowRight") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_LEFT_PANE).catch(() => {});
            }
        },
    },
    React.createElement("span", { className: "ps-column-resizer-handle", "aria-hidden": "true" },
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" })));
}

function RowResizeHandle({ controller, sessionPaneAdjust = 0 }) {
    const dragStateRef = React.useRef(null);
    const [dragging, setDragging] = React.useState(false);

    React.useEffect(() => {
        if (!dragging) return undefined;

        const stopDragging = () => {
            dragStateRef.current = null;
            setDragging(false);
            document.body.classList.remove("is-resizing-pane-y");
        };

        const onPointerMove = (event) => {
            const dragState = dragStateRef.current;
            if (!dragState) return;
            const deltaCells = Math.round((event.clientY - dragState.startY) / GRID_CELL_HEIGHT);
            const deltaIncrement = deltaCells - dragState.appliedCells;
            if (!deltaIncrement) return;
            controller.adjustSessionPaneSplit(deltaIncrement);
            dragState.appliedCells = deltaCells;
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", stopDragging);
        window.addEventListener("pointercancel", stopDragging);

        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", stopDragging);
            window.removeEventListener("pointercancel", stopDragging);
            document.body.classList.remove("is-resizing-pane-y");
        };
    }, [controller, dragging]);

    return React.createElement("button", {
        type: "button",
        className: `ps-row-resizer${dragging ? " is-dragging" : ""}`,
        title: "Drag to resize the sessions and chat panes. Double-click to reset.",
        "aria-label": "Resize sessions and chat panes",
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragStateRef.current = {
                startY: event.clientY,
                appliedCells: 0,
            };
            setDragging(true);
            document.body.classList.add("is-resizing-pane-y");
        },
        onDoubleClick: () => {
            if (!sessionPaneAdjust) return;
            controller.adjustSessionPaneSplit(-sessionPaneAdjust);
        },
        onKeyDown: (event) => {
            if (event.key === "ArrowUp") {
                event.preventDefault();
                controller.adjustSessionPaneSplit(-1);
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                controller.adjustSessionPaneSplit(1);
            }
        },
    },
    React.createElement("span", { className: "ps-row-resizer-handle", "aria-hidden": "true" },
        React.createElement("span", { className: "ps-row-resizer-dot" }),
        React.createElement("span", { className: "ps-row-resizer-dot" }),
        React.createElement("span", { className: "ps-row-resizer-dot" })));
}

function SessionColumnResizeHandle({ controller, portalSessionColumnAdjust = 0 }) {
    const dragStateRef = React.useRef(null);
    const [dragging, setDragging] = React.useState(false);

    React.useEffect(() => {
        if (!dragging) return undefined;

        const stopDragging = () => {
            dragStateRef.current = null;
            setDragging(false);
            document.body.classList.remove("is-resizing-pane-x");
        };

        const onPointerMove = (event) => {
            const dragState = dragStateRef.current;
            if (!dragState) return;
            const nextAdjust = clampNumber(
                dragState.startAdjust + (event.clientX - dragState.startX),
                dragState.minAdjust,
                dragState.maxAdjust,
            );
            controller.dispatch({
                type: "ui/portalSessionColumnAdjust",
                portalSessionColumnAdjust: nextAdjust,
            });
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", stopDragging);
        window.addEventListener("pointercancel", stopDragging);

        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", stopDragging);
            window.removeEventListener("pointercancel", stopDragging);
            document.body.classList.remove("is-resizing-pane-x");
        };
    }, [controller, dragging]);

    return React.createElement("button", {
        type: "button",
        className: `ps-column-resizer${dragging ? " is-dragging" : ""}`,
        title: "Drag to resize the sessions and chat columns. Double-click to reset.",
        "aria-label": "Resize sessions and chat columns",
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const gridNode = event.currentTarget.closest(".ps-workspace-main-grid");
            const bounds = portalSessionColumnBounds(gridNode?.getBoundingClientRect?.().width);
            dragStateRef.current = {
                startX: event.clientX,
                startAdjust: Number(portalSessionColumnAdjust) || 0,
                minAdjust: bounds.minAdjust,
                maxAdjust: bounds.maxAdjust,
            };
            setDragging(true);
            document.body.classList.add("is-resizing-pane-x");
        },
        onDoubleClick: () => {
            controller.dispatch({ type: "ui/portalSessionColumnAdjust", portalSessionColumnAdjust: 0 });
        },
        onKeyDown: (event) => {
            const gridNode = event.currentTarget.closest(".ps-workspace-main-grid");
            const bounds = portalSessionColumnBounds(gridNode?.getBoundingClientRect?.().width);
            const adjustBy = (delta) => {
                const nextAdjust = clampNumber(
                    (Number(portalSessionColumnAdjust) || 0) + delta,
                    bounds.minAdjust,
                    bounds.maxAdjust,
                );
                controller.dispatch({
                    type: "ui/portalSessionColumnAdjust",
                    portalSessionColumnAdjust: nextAdjust,
                });
            };
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                adjustBy(-24);
                return;
            }
            if (event.key === "ArrowRight") {
                event.preventDefault();
                adjustBy(24);
            }
        },
    },
    React.createElement("span", { className: "ps-column-resizer-handle", "aria-hidden": "true" },
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" })));
}

function ActivityRowResizeHandle({ controller, activityPaneAdjust = 0 }) {
    const dragStateRef = React.useRef(null);
    const [dragging, setDragging] = React.useState(false);

    React.useEffect(() => {
        if (!dragging) return undefined;

        const stopDragging = () => {
            dragStateRef.current = null;
            setDragging(false);
            document.body.classList.remove("is-resizing-pane-y");
        };

        const onPointerMove = (event) => {
            const dragState = dragStateRef.current;
            if (!dragState) return;
            const deltaCells = Math.round((event.clientY - dragState.startY) / GRID_CELL_HEIGHT);
            const deltaIncrement = deltaCells - dragState.appliedCells;
            if (!deltaIncrement) return;
            controller.adjustActivityPaneSplit(-deltaIncrement);
            dragState.appliedCells = deltaCells;
        };

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", stopDragging);
        window.addEventListener("pointercancel", stopDragging);

        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", stopDragging);
            window.removeEventListener("pointercancel", stopDragging);
            document.body.classList.remove("is-resizing-pane-y");
        };
    }, [controller, dragging]);

    return React.createElement("button", {
        type: "button",
        className: `ps-row-resizer${dragging ? " is-dragging" : ""}`,
        title: "Drag to resize the activity pane. Double-click to reset.",
        "aria-label": "Resize activity pane",
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragStateRef.current = {
                startY: event.clientY,
                appliedCells: 0,
            };
            setDragging(true);
            document.body.classList.add("is-resizing-pane-y");
        },
        onDoubleClick: () => {
            if (!activityPaneAdjust) return;
            controller.adjustActivityPaneSplit(-activityPaneAdjust);
        },
        onKeyDown: (event) => {
            if (event.key === "ArrowUp") {
                event.preventDefault();
                controller.adjustActivityPaneSplit(1);
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                controller.adjustActivityPaneSplit(-1);
            }
        },
    },
    React.createElement("span", { className: "ps-row-resizer-handle", "aria-hidden": "true" },
        React.createElement("span", { className: "ps-row-resizer-dot" }),
        React.createElement("span", { className: "ps-row-resizer-dot" }),
        React.createElement("span", { className: "ps-row-resizer-dot" })));
}

function MobileNav({ activePane, setActivePane, controller }) {
    const tabs = [
        { id: "workspace", label: "Main", focus: "chat" },
        { id: "inspector", label: "Inspector", focus: "inspector" },
        { id: "activity", label: "Activity", focus: "activity" },
    ];
    return React.createElement("div", { className: "ps-mobile-nav" },
        tabs.map((tab) => React.createElement("button", {
            key: tab.id,
            type: "button",
            className: `ps-mobile-nav-button${activePane === tab.id ? " is-active" : ""}`,
            onClick: () => {
                setActivePane(tab.id);
                controller.setFocus(tab.focus);
            },
        }, tab.label)));
}

function ModalLayer({ controller }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const modalState = useControllerSelector(controller, (state) => ({
        rawModal: state.ui.modal,
        themePicker: selectThemePickerModal(state),
        modelPicker: selectModelPickerModal(state),
        reasoningEffortPicker: selectReasoningEffortPickerModal(state),
        contextTierPicker: selectContextTierPickerModal(state),
        sessionAgentPicker: selectSessionAgentPickerModal(state),
        sessionGroupPicker: selectSessionGroupPickerModal(state),
        sessionGroupName: selectSessionGroupNameModal(state),
        artifactPicker: selectArtifactPickerModal(state),
        logFilter: selectLogFilterModal(state),
        filesFilter: selectFilesFilterModal(state),
        historyFormat: selectHistoryFormatModal(state),
        renameSession: selectRenameSessionModal(state),
        sessionOwnerFilter: selectSessionOwnerFilterModal(state),
        artifactUpload: selectArtifactUploadModal(state),
        confirm: selectConfirmModal(state),
        logsFilter: state.logs.filter,
        filesFilterState: state.files.filter,
        historyFormatState: state.executionHistory?.format || "pretty",
    }), shallowEqualObject);
    const modal = modalState.rawModal;
    const renameInputRef = React.useRef(null);
    const groupNameInputRef = React.useRef(null);
    const listModalRef = React.useRef(null);
    // Full-text search for the people list in the session filter.
    const [ownerFilterQuery, setOwnerFilterQuery] = React.useState("");
    const ownerFilterOpen = modal?.type === "sessionOwnerFilter";
    React.useEffect(() => { if (!ownerFilterOpen) setOwnerFilterQuery(""); }, [ownerFilterOpen]);

    React.useEffect(() => {
        if (modal?.type !== "renameSession" || !modalState.renameSession) return;
        const inputNode = renameInputRef.current;
        if (!inputNode) return;
        if (document.activeElement !== inputNode) {
            try {
                inputNode.focus({ preventScroll: true });
            } catch {
                inputNode.focus();
            }
        }
        inputNode.setSelectionRange(modalState.renameSession.cursorIndex, modalState.renameSession.cursorIndex);
    }, [modal?.type, modalState.renameSession?.cursorIndex, modalState.renameSession?.value]);

    React.useEffect(() => {
        if (modal?.type !== "sessionGroupName" || !modalState.sessionGroupName) return;
        const inputNode = groupNameInputRef.current;
        if (!inputNode) return;
        if (document.activeElement !== inputNode) {
            try {
                inputNode.focus({ preventScroll: true });
            } catch {
                inputNode.focus();
            }
        }
        inputNode.setSelectionRange(modalState.sessionGroupName.cursorIndex, modalState.sessionGroupName.cursorIndex);
    }, [modal?.type, modalState.sessionGroupName?.cursorIndex, modalState.sessionGroupName?.value]);

    React.useEffect(() => {
        if (!modal) return;
        if (![
            "themePicker",
            "modelPicker",
            "reasoningEffortPicker",
            "contextTierPicker",
            "sessionAgentPicker",
            "sessionGroupPicker",
            "artifactPicker",
            "sessionOwnerFilter",
            "logFilter",
            "filesFilter",
            "historyFormat",
        ].includes(modal.type)) {
            return;
        }

        const listNode = listModalRef.current;
        if (!listNode) return;
        const selected = listNode.querySelector(".ps-list-button.is-selected");
        if (selected && typeof selected.scrollIntoView === "function") {
            selected.scrollIntoView({ block: "nearest" });
        }
    }, [
        modal?.type,
        modal?.selectedIndex,
        modalState.themePicker?.selectedRowIndex,
        modalState.modelPicker?.selectedRowIndex,
        modalState.reasoningEffortPicker?.selectedRowIndex,
        modalState.contextTierPicker?.selectedRowIndex,
        modalState.sessionAgentPicker?.selectedRowIndex,
        modalState.sessionGroupPicker?.selectedRowIndex,
        modalState.artifactPicker?.selectedRowIndex,
        modalState.sessionOwnerFilter?.selectedRowIndex,
        modalState.logFilter?.selectedRowIndex,
        modalState.filesFilter?.selectedRowIndex,
        modalState.historyFormat?.selectedRowIndex,
    ]);

    if (!modal) return null;

    const close = () => controller.handleCommand(UI_COMMANDS.CLOSE_MODAL).catch(() => {});

    const renderListModal = (presentation, confirmLabel = "Apply") => {
        const rows = Array.isArray(presentation.rows) ? presentation.rows : [];
        const rowItemIndexes = Array.isArray(presentation.rowItemIndexes) ? presentation.rowItemIndexes : null;
        const usesHangingIndent = modal.type === "modelPicker" || modal.type === "reasoningEffortPicker" || modal.type === "contextTierPicker" || modal.type === "sessionAgentPicker";
        const renderedList = rowItemIndexes && rowItemIndexes.length === rows.length
            ? rows.map((row, rowIndex) => {
                const itemIndex = rowItemIndexes[rowIndex];
                const runs = Array.isArray(row)
                    ? row
                    : normalizeLines([row])[0]?.runs || [{ text: row?.text || "", color: row?.color }];
                if (itemIndex == null || itemIndex < 0) {
                    return React.createElement("div", {
                        key: `row:${rowIndex}`,
                        className: "ps-line ps-modal-list-heading-line",
                    }, React.createElement(Runs, { runs, theme }));
                }
                const item = modal.items?.[itemIndex];
                return React.createElement("button", {
                    key: item?.id || `row:${rowIndex}`,
                    type: "button",
                    className: `ps-list-button ps-modal-list-button${itemIndex === modal.selectedIndex ? " is-selected" : ""}${usesHangingIndent ? " is-hanging" : ""}${item?.disabled ? " is-disabled" : ""}`,
                    onClick: () => controller.dispatch({ type: "ui/modalSelection", index: itemIndex }),
                },
                React.createElement("div", { className: "ps-line ps-modal-list-line" },
                    React.createElement(Runs, { runs, theme })));
            })
            : (modal.items || []).map((item, index) => React.createElement("button", {
                key: item.id || index,
                type: "button",
                className: `ps-list-button ps-modal-list-button${index === modal.selectedIndex ? " is-selected" : ""}${usesHangingIndent ? " is-hanging" : ""}${item?.disabled ? " is-disabled" : ""}`,
                onClick: () => controller.dispatch({ type: "ui/modalSelection", index }),
            },
            React.createElement("div", { className: "ps-line ps-modal-list-line" },
                React.createElement(Runs, {
                    runs: Array.isArray(rows?.[index])
                        ? rows[index]
                        : normalizeLines([rows?.[index]])[0]?.runs || [{ text: rows?.[index]?.text || "", color: rows?.[index]?.color }],
                    theme,
                }))));

        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
        React.createElement("div", { className: `ps-modal is-list${modal.type === "themePicker" ? " is-theme-picker" : ""}`, onClick: (event) => event.stopPropagation() },
            React.createElement("div", { className: "ps-modal-header" },
                React.createElement("div", { className: "ps-modal-title" }, presentation.title),
                React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close, "aria-label": "Close", title: "Close" }, "✕"),
            ),
            React.createElement("div", { className: "ps-modal-grid" },
                React.createElement("div", { ref: listModalRef, className: "ps-modal-list" },
                    renderedList,
                ),
                React.createElement("div", { className: "ps-modal-details" },
                    React.createElement("div", { className: "ps-modal-details-title" }, presentation.detailsTitle || "Details"),
                    normalizeLines(presentation.detailsLines || []).map((line, index) => React.createElement(Line, { key: `detail:${index}`, line, theme, className: "ps-modal-detail-line" })),
                ),
            ),
            React.createElement("div", { className: "ps-modal-footer" },
                React.createElement("button", { type: "button", className: "ps-modal-button", onClick: close }, "Cancel"),
                React.createElement("button", {
                    type: "button",
                    className: "ps-modal-button is-primary",
                    onClick: () => controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {}),
                }, confirmLabel)),
        ));
    };

    if (modal.type === "confirm" && modalState.confirm) {
        const isAlert = Boolean(modal.alert);
        const isDestructive = !isAlert && modal.action === "deleteSession";
        // The regenerate confirm carries distillation inputs: a mode select and
        // an optional distilling-instructions textarea, bound to modal.extras.
        const isRegen = modal.action === "regenerateSession";
        const extras = modal.extras || {};
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-narrow", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, modalState.confirm.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close, "aria-label": "Close", title: "Close" }, "✕"),
                ),
                React.createElement("div", { className: "ps-modal-body", style: { padding: "16px 20px" } },
                    React.createElement("p", { style: { color: "#94a3b8", margin: 0 } }, modalState.confirm.message),
                ),
                isRegen
                    ? React.createElement("div", { className: "ps-modal-body", style: { padding: "0 20px 12px", display: "flex", flexDirection: "column", gap: 10 } },
                        React.createElement("label", { style: { color: "#94a3b8", fontSize: "12px", display: "flex", alignItems: "center", gap: 8 } },
                            "Distillation",
                            React.createElement("select", {
                                className: "ps-modal-input",
                                style: { flex: "1", padding: "4px 8px" },
                                value: extras.distillMode || "llm",
                                onChange: (event) => controller.updateConfirmExtras({ distillMode: event.currentTarget.value }),
                            },
                                React.createElement("option", { value: "llm" }, "Intelligent (LLM reads the whole transcript)"),
                                React.createElement("option", { value: "deterministic" }, "Fast (no LLM — tail + pointers)"),
                            ),
                        ),
                        (extras.distillMode || "llm") === "llm"
                            ? React.createElement(DistillerModelPickers, { controller, extras })
                            : null,
                        (extras.distillMode || "llm") === "llm"
                            ? React.createElement("textarea", {
                                className: "ps-modal-input",
                                style: { width: "100%", minHeight: "64px", resize: "vertical", fontFamily: "inherit", fontSize: "13px" },
                                placeholder: "Distilling instructions (optional) — e.g. \"preserve every SQL snippet verbatim\"",
                                value: extras.instructions || "",
                                maxLength: 4000,
                                onChange: (event) => controller.updateConfirmExtras({ instructions: event.currentTarget.value }),
                            })
                            : null,
                    )
                    : null,
                React.createElement("div", { className: "ps-modal-footer" },
                    isAlert ? null : React.createElement("button", { type: "button", className: "ps-modal-button", onClick: close }, "Cancel"),
                    React.createElement("button", {
                        type: "button",
                        className: `ps-modal-button ${isDestructive ? "is-danger" : "is-primary"}`,
                        onClick: () => controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {}),
                    }, modalState.confirm.confirmLabel)),
            ));
    }
    if (modal.type === "themePicker" && modalState.themePicker) {
        return renderListModal(modalState.themePicker, "Apply Theme");
    }
    // In switch-model mode the model/reasoning pickers retarget an existing
    // session, so the confirm action is "Switch Model", not "Create Session".
    const pickerConfirmLabel = modal.sessionOptions?.mode === "switchModel" ? "Switch Model" : "Create Session";
    if (modal.type === "modelPicker" && modalState.modelPicker) {
        return renderListModal(modalState.modelPicker, pickerConfirmLabel);
    }
    if (modal.type === "reasoningEffortPicker" && modalState.reasoningEffortPicker) {
        return renderListModal(modalState.reasoningEffortPicker, pickerConfirmLabel);
    }
    if (modal.type === "contextTierPicker" && modalState.contextTierPicker) {
        return renderListModal(modalState.contextTierPicker, pickerConfirmLabel);
    }
    if (modal.type === "sessionAgentPicker" && modalState.sessionAgentPicker) {
        return renderListModal(modalState.sessionAgentPicker, "Create Session");
    }
    if (modal.type === "sessionGroupPicker" && modalState.sessionGroupPicker) {
        return renderListModal(modalState.sessionGroupPicker, "Move");
    }
    if (modal.type === "artifactPicker" && modalState.artifactPicker) {
        return renderListModal(modalState.artifactPicker, modalState.artifactPicker.confirmLabel || "Open / Download");
    }
    if (modal.type === "sessionOwnerFilter" && modalState.sessionOwnerFilter) {
        const presentation = modalState.sessionOwnerFilter;
        const rows = Array.isArray(presentation.rows) ? presentation.rows : [];
        // Full-text match over the row's rendered text, so typing "sean" or
        // part of an email narrows the list. Indexes stay ORIGINAL so toggling
        // still targets the right filter entry.
        const needle = ownerFilterQuery.trim().toLowerCase();
        const rowText = (index) => {
            const row = rows?.[index];
            const runs = Array.isArray(row) ? row : normalizeLines([row])[0]?.runs || [];
            return runs.map((run) => run?.text || "").join("") || String(row?.text || "");
        };
        const visibleIndexes = (modal.items || [])
            .map((item, index) => index)
            .filter((index) => {
                if (!needle) return true;
                const item = (modal.items || [])[index] || {};
                return `${rowText(index)} ${item.label || ""} ${item.description || ""}`.toLowerCase().includes(needle);
            });
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-list", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, presentation.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close, "aria-label": "Close", title: "Close" }, "✕"),
                ),
                React.createElement("input", {
                    className: "ps-modal-input ps-modal-search",
                    value: ownerFilterQuery,
                    placeholder: "Search people…",
                    autoFocus: true,
                    onChange: (event) => setOwnerFilterQuery(event.currentTarget.value),
                    onKeyDown: (event) => { if (event.key === "Escape" && ownerFilterQuery) { event.stopPropagation(); setOwnerFilterQuery(""); } },
                }),
                React.createElement("div", { className: "ps-modal-grid" },
                    React.createElement("div", { ref: listModalRef, className: "ps-modal-list" },
                        visibleIndexes.length === 0
                            ? React.createElement("div", { className: "ps-empty-state" }, `No one matches "${ownerFilterQuery}".`)
                            : null,
                        visibleIndexes.map((index) => ((item) => React.createElement("button", {
                            key: item.id || index,
                            type: "button",
                            className: `ps-list-button ps-modal-list-button${index === modal.selectedIndex ? " is-selected" : ""}`,
                            onClick: () => controller.toggleSessionOwnerFilter(index),
                        },
                        React.createElement("div", { className: "ps-line ps-modal-list-line" },
                            React.createElement(Runs, {
                                runs: Array.isArray(rows?.[index])
                                    ? rows[index]
                                    : normalizeLines([rows?.[index]])[0]?.runs || [{ text: rows?.[index]?.text || "", color: rows?.[index]?.color }],
                                theme,
                            }))))((modal.items || [])[index] || {})),
                    ),
                    React.createElement("div", { className: "ps-modal-details" },
                        React.createElement("div", { className: "ps-modal-details-title" }, presentation.detailsTitle || "Details"),
                        normalizeLines(presentation.detailsLines || []).map((line, index) => React.createElement(Line, { key: `detail:${index}`, line, theme, className: "ps-modal-detail-line" })),
                    ),
                ),
                React.createElement("div", { className: "ps-modal-footer" },
                    React.createElement("button", { type: "button", className: "ps-modal-button is-primary", onClick: close }, "Done")),
            ));
    }
    if (modal.type === "renameSession" && modalState.renameSession) {
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-narrow", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, modalState.renameSession.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close, "aria-label": "Close", title: "Close" }, "✕"),
                ),
                React.createElement("input", {
                    ref: renameInputRef,
                    className: "ps-modal-input",
                    value: modalState.renameSession.value,
                    placeholder: modalState.renameSession.placeholder,
                    onChange: (event) => controller.setRenameSessionValue(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length),
                    onKeyDown: (event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {});
                        }
                    },
                    autoFocus: true,
                }),
                React.createElement("div", { className: "ps-modal-details" },
                    normalizeLines(modalState.renameSession.helpLines || []).map((line, index) => React.createElement(Line, { key: `help:${index}`, line, theme, className: "ps-modal-detail-line" })),
                ),
                React.createElement("div", { className: "ps-modal-footer" },
                    React.createElement("button", { type: "button", className: "ps-modal-button", onClick: close }, "Cancel"),
                    React.createElement("button", {
                        type: "button",
                        className: "ps-modal-button is-primary",
                        onClick: () => controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {}),
                    }, "Save")),
            ));
    }
    if (modal.type === "sessionGroupName" && modalState.sessionGroupName) {
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-narrow", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, modalState.sessionGroupName.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close, "aria-label": "Close", title: "Close" }, "✕"),
                ),
                React.createElement("input", {
                    ref: groupNameInputRef,
                    className: "ps-modal-input",
                    value: modalState.sessionGroupName.value,
                    placeholder: modalState.sessionGroupName.placeholder,
                    onChange: (event) => controller.setSessionGroupNameValue(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length),
                    onKeyDown: (event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {});
                        }
                    },
                    autoFocus: true,
                }),
                React.createElement("div", { className: "ps-modal-details" },
                    normalizeLines(modalState.sessionGroupName.helpLines || []).map((line, index) => React.createElement(Line, { key: `help:${index}`, line, theme, className: "ps-modal-detail-line" })),
                ),
                React.createElement("div", { className: "ps-modal-footer" },
                    React.createElement("button", { type: "button", className: "ps-modal-button", onClick: close }, "Cancel"),
                    React.createElement("button", {
                        type: "button",
                        className: "ps-modal-button is-primary",
                        onClick: () => controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {}),
                    }, "Create and Move")),
            ));
    }
    if (modal.type === "terminatePicker") {
        const isBulk = Number(modal.bulkCount) > 1;
        const isSystemRestart = Boolean(modal.systemRestart);
        const sessionLabel = String(modal.sessionTitle || "").trim() || "this session";
        const bulkCount = Number(modal.bulkCount) || 0;
        const bodyText = isBulk
            ? `What should happen to the ${bulkCount} selected sessions? Choose an action; you'll be asked to confirm.`
            : isSystemRestart
                ? `How should "${sessionLabel}" be restarted? Choose a disposition; you'll be asked to confirm.`
            : `What should happen to "${sessionLabel}"? Choose an action; you'll be asked to confirm.`;
        const pick = (action) => () => {
            controller.pickTerminateAction(action).catch(() => {});
        };
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-narrow", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, modal.title || "Session Lifecycle"),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close, "aria-label": "Close", title: "Close" }, "✕"),
                ),
                React.createElement("div", { className: "ps-modal-body", style: { padding: "12px 16px 4px" } },
                    React.createElement("p", { style: { color: "#94a3b8", margin: 0 } }, bodyText)),
                React.createElement("div", {
                    className: "ps-modal-body",
                    style: { padding: "10px 16px 16px", display: "flex", flexDirection: "column", gap: 8 },
                },
                    modal.canRegenerate
                        ? React.createElement("button", {
                            type: "button",
                            className: "ps-modal-button",
                            style: { width: "100%", justifyContent: "flex-start" },
                            title: "Archive and distill the transcript, then rebuild context fresh at the next turn boundary. Facts, artifacts, sub-agents, sharing, schedule, and chat history are preserved.",
                            onClick: pick("regenerate"),
                        }, "Regenerate Context")
                        : null,
                    React.createElement("button", {
                        type: "button",
                        className: "ps-modal-button is-primary",
                        style: { width: "100%", justifyContent: "flex-start" },
                        onClick: pick("complete"),
                    }, isBulk ? `Mark ${bulkCount} Completed` : isSystemRestart ? "Complete & Restart" : "Mark Completed"),
                    React.createElement("button", {
                        type: "button",
                        className: "ps-modal-button",
                        style: { width: "100%", justifyContent: "flex-start" },
                        onClick: pick("cancel"),
                    }, isBulk ? `Cancel ${bulkCount} Sessions` : isSystemRestart ? "Terminate & Restart" : "Cancel Session"),
                    React.createElement("button", {
                        type: "button",
                        className: "ps-modal-button is-danger",
                        style: { width: "100%", justifyContent: "flex-start" },
                        onClick: pick("delete"),
                    }, isBulk ? `Hard Delete ${bulkCount} Sessions` : isSystemRestart ? "Hard Delete & Restart" : "Delete Session"),
                ),
                React.createElement("div", { className: "ps-modal-footer" },
                    React.createElement("button", { type: "button", className: "ps-modal-button", onClick: close }, "Close")),
            ));
    }
    if (modal.type === "artifactUpload" && modalState.artifactUpload) {
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-narrow", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, modalState.artifactUpload.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close, "aria-label": "Close", title: "Close" }, "✕"),
                ),
                React.createElement("input", {
                    className: "ps-modal-input",
                    value: modalState.artifactUpload.value,
                    placeholder: modalState.artifactUpload.placeholder,
                    onChange: (event) => controller.setArtifactUploadValue(event.currentTarget.value, event.currentTarget.selectionStart || event.currentTarget.value.length),
                    autoFocus: true,
                }),
                React.createElement("div", { className: "ps-modal-details" },
                    normalizeLines(modalState.artifactUpload.helpLines || []).map((line, index) => React.createElement(Line, { key: `help:${index}`, line, theme, className: "ps-modal-detail-line" })),
                ),
                React.createElement("div", { className: "ps-modal-footer" },
                    React.createElement("button", { type: "button", className: "ps-modal-button", onClick: close }, "Cancel"),
                    React.createElement("button", {
                        type: "button",
                        className: "ps-modal-button is-primary",
                        onClick: () => controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {}),
                    }, "Attach")),
            ));
    }

    const filterPresentation = modal.type === "logFilter"
        ? modalState.logFilter
        : modal.type === "filesFilter"
            ? modalState.filesFilter
            : modal.type === "historyFormat"
                ? modalState.historyFormat
                : null;
    if (filterPresentation) {
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-wide", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, filterPresentation.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close, "aria-label": "Close", title: "Close" }, "✕"),
                ),
                React.createElement("div", { className: "ps-filter-grid" },
                    (modal.items || []).map((item, itemIndex) => {
                        const currentValue = modal.type === "filesFilter"
                            ? modalState.filesFilterState?.[item.id] || item.options?.[0]?.id
                            : modal.type === "historyFormat"
                                ? modalState.historyFormatState
                                : modalState.logsFilter?.[item.id] || item.options?.[0]?.id;
                        return React.createElement("div", { key: item.id || itemIndex, className: "ps-filter-column" },
                            React.createElement("div", { className: "ps-filter-title" }, item.label),
                            (item.options || []).map((option) => React.createElement("button", {
                                key: option.id,
                                type: "button",
                                className: `ps-filter-option${option.id === currentValue ? " is-selected" : ""}`,
                                onClick: () => {
                                    controller.dispatch({ type: "ui/modalSelection", index: itemIndex });
                                    if (modal.type === "historyFormat") {
                                        controller.dispatch({ type: "executionHistory/format", format: option.id });
                                    } else if (modal.type === "filesFilter") {
                                        controller.dispatch({ type: "files/filter", filter: { [item.id]: option.id } });
                                        controller.ensureFilesForScope(option.id).catch(() => {});
                                    } else {
                                        controller.dispatch({ type: "logs/filter", filter: { [item.id]: option.id } });
                                    }
                                },
                            }, option.label)),
                        );
                    }),
                ),
                React.createElement("div", { className: "ps-modal-footer" },
                    React.createElement("button", { type: "button", className: "ps-modal-button is-primary", onClick: close }, "Done")),
            ));
    }

    return null;
}

// Distiller model / effort / context-tier pickers for the regenerate confirm.
// The distiller runs on deployment machinery config rather than the served
// session's model, so these are explicit choices; empty means "deployment
// default". Effort and tier lists follow the SELECTED model, so an
// unsupported combination cannot be submitted.
function DistillerModelPickers({ controller, extras }) {
    const options = Array.isArray(extras.distillerModelOptions) ? extras.distillerModelOptions : [];
    const selected = options.find((m) => m.qualifiedName === extras.distillerModel) || null;
    const efforts = selected?.supportedReasoningEfforts || [];
    const tiers = selected?.supportedContextTiers || [];
    const labelStyle = { color: "#94a3b8", fontSize: "12px", display: "flex", alignItems: "center", gap: 8 };
    const selectStyle = { flex: "1", padding: "4px 8px" };

    const pick = (patch) => controller.updateConfirmExtras(patch);

    return React.createElement(React.Fragment, null,
        React.createElement("label", { style: labelStyle },
            "Distiller model",
            React.createElement("select", {
                className: "ps-modal-input",
                style: selectStyle,
                value: extras.distillerModel || "",
                // Switching model clears effort/tier: the previous values may
                // not exist on the new model.
                onChange: (event) => pick({
                    distillerModel: event.currentTarget.value,
                    distillerEffort: "",
                    distillerContextTier: "",
                }),
            },
                React.createElement("option", { value: "" }, "Deployment default"),
                options.map((m) => React.createElement("option", {
                    key: m.qualifiedName,
                    value: m.qualifiedName,
                }, m.qualifiedName)),
            ),
        ),
        efforts.length > 0
            ? React.createElement("label", { style: labelStyle },
                "Reasoning",
                React.createElement("select", {
                    className: "ps-modal-input",
                    style: selectStyle,
                    value: extras.distillerEffort || "",
                    onChange: (event) => pick({ distillerEffort: event.currentTarget.value }),
                },
                    React.createElement("option", { value: "" }, "Model default"),
                    efforts.map((e) => React.createElement("option", { key: e, value: e }, e)),
                ),
            )
            : null,
        tiers.length > 0
            ? React.createElement("label", { style: labelStyle },
                "Context",
                React.createElement("select", {
                    className: "ps-modal-input",
                    style: selectStyle,
                    value: extras.distillerContextTier || "",
                    onChange: (event) => pick({ distillerContextTier: event.currentTarget.value }),
                },
                    React.createElement("option", { value: "" }, "Model default"),
                    tiers.map((t) => React.createElement("option", { key: t, value: t },
                        t === "long_context" ? "long context (fits a larger transcript)" : t)),
                ),
            )
            : null,
    );
}

function useKeyboardShortcuts(controller, mobile) {
    React.useEffect(() => {
        const handler = (event) => {
            const target = event.target;
            const editable = target instanceof HTMLElement
                && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable);
            const modal = controller.getState().ui.modal;
            const visibleInspectorTabs = getVisibleInspectorTabs(controller);
            const currentInspectorTab = controller.getState().ui.inspectorTab;
            const focusRegion = controller.getState().ui.focusRegion;
            const isPlainShortcut = !event.metaKey && !event.ctrlKey && !event.altKey;
            const isShiftTheme = !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "T" && event.shiftKey;
            const isShiftModel = !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "N" && event.shiftKey;
            const selectVisibleInspectorTab = (delta) => {
                const nextTab = cycleTabs(visibleInspectorTabs, currentInspectorTab, delta);
                controller.selectInspectorTab(nextTab).catch(() => {});
            };

            if (!editable && isShiftTheme) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_THEME_PICKER).catch(() => {});
                return;
            }
            if (!editable && isShiftModel) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER).catch(() => {});
                return;
            }

            if (modal && !editable) {
                if (event.key === "Escape" || (modal.type === "confirm" && event.key === "n")) {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.CLOSE_MODAL).catch(() => {});
                    return;
                }
                if (event.key === "Enter" || (modal.type === "confirm" && event.key === "y")) {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM).catch(() => {});
                    return;
                }
                if (event.key === "Tab" && event.shiftKey) {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.MODAL_PANE_PREV).catch(() => {});
                    return;
                }
                if (event.key === "Tab") {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.MODAL_PANE_NEXT).catch(() => {});
                    return;
                }
                if (event.key === "ArrowUp" || event.key === "k") {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.MODAL_PREV).catch(() => {});
                    return;
                }
                if (event.key === "ArrowDown" || event.key === "j") {
                    event.preventDefault();
                    controller.handleCommand(UI_COMMANDS.MODAL_NEXT).catch(() => {});
                }
                return;
            }

            if (editable) {
                return;
            }

            if (event.key === "r" && isPlainShortcut && focusRegion !== "prompt") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.REFRESH).catch(() => {});
                return;
            }
            if (focusRegion === "chat" && event.key === "s" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.TOGGLE_CHAT_VIEW).catch(() => {});
                return;
            }
            if (event.key === "n" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.NEW_SESSION).catch(() => {});
                return;
            }
            if (
                focusRegion === "inspector"
                && currentInspectorTab === "files"
                && (
                    (event.key === "u" && isPlainShortcut)
                    || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")
                )
            ) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_ARTIFACT_UPLOAD).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "files" && event.key === "a" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.DOWNLOAD_SELECTED_FILE).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "files" && event.key === "x" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.DELETE_SELECTED_FILE).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "files" && event.key === "o" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_SELECTED_FILE).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "files" && event.key === "f" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_FILES_FILTER).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "stats" && event.key === "f" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.TOGGLE_STATS_VIEW).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "files" && event.key === "v" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "logs" && event.key === "t" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.TOGGLE_LOG_TAIL).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "logs" && event.key === "f" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_LOG_FILTER).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "history" && event.key === "f" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_HISTORY_FORMAT).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "history" && event.key === "r" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.REFRESH_EXECUTION_HISTORY).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && currentInspectorTab === "history" && event.key === "a" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.EXPORT_EXECUTION_HISTORY).catch(() => {});
                return;
            }
            if (event.key === "a" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_ARTIFACT_PICKER).catch(() => {});
                return;
            }
            if (event.key === "p" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.FOCUS_PROMPT).catch(() => {});
                return;
            }
            if (event.key === "c" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.CANCEL_SESSION).catch(() => {});
                return;
            }
            if (event.key === "d" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.DONE_SESSION).catch(() => {});
                return;
            }
            if (event.key === "D" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.DELETE_SESSION).catch(() => {});
                return;
            }
            if (event.key === "m" && isPlainShortcut && focusRegion === "inspector") {
                event.preventDefault();
                selectVisibleInspectorTab(1);
                return;
            }
            if (event.key === "[" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_LEFT_PANE).catch(() => {});
                return;
            }
            if (event.key === "]" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_RIGHT_PANE).catch(() => {});
                return;
            }
            if (event.key === "{" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.SHRINK_SESSION_PANE).catch(() => {});
                return;
            }
            if (event.key === "}" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.GROW_SESSION_PANE).catch(() => {});
                return;
            }
            if (focusRegion === "inspector" && event.key === "ArrowLeft") {
                event.preventDefault();
                selectVisibleInspectorTab(-1);
                return;
            }
            if (focusRegion === "inspector" && event.key === "ArrowRight") {
                event.preventDefault();
                selectVisibleInspectorTab(1);
                return;
            }
            if (focusRegion === "sessions" && (event.key === "ArrowUp" || event.key === "k")) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.MOVE_SESSION_UP).catch(() => {});
                return;
            }
            if (focusRegion === "sessions" && (event.key === "ArrowDown" || event.key === "j")) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN).catch(() => {});
                return;
            }
            if (focusRegion === "sessions" && event.ctrlKey && event.key.toLowerCase() === "g" && !event.metaKey && !event.altKey) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_MOVE_TO_GROUP).catch(() => {});
                return;
            }
            if (focusRegion === "sessions" && (event.key === "PageUp" || (event.ctrlKey && event.key.toLowerCase() === "u"))) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.PAGE_UP).catch(() => {});
                return;
            }
            if (focusRegion === "sessions" && (event.key === "PageDown" || (event.ctrlKey && event.key.toLowerCase() === "d"))) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.PAGE_DOWN).catch(() => {});
                return;
            }
            if (focusRegion === "sessions" && event.key === "t" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.OPEN_RENAME_SESSION).catch(() => {});
                return;
            }
            if (!mobile && (event.key === "PageUp" || (event.ctrlKey && event.key.toLowerCase() === "u"))) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.PAGE_UP).catch(() => {});
                return;
            }
            if (!mobile && (event.key === "PageDown" || (event.ctrlKey && event.key.toLowerCase() === "d"))) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.PAGE_DOWN).catch(() => {});
                return;
            }
            if (!mobile && event.key === "g" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.SCROLL_TOP).catch(() => {});
                return;
            }
            if (!mobile && event.key === "G" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.SCROLL_BOTTOM).catch(() => {});
                return;
            }
            if (focusRegion !== "prompt" && event.key === "h" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.FOCUS_LEFT).catch(() => {});
                return;
            }
            if (focusRegion !== "prompt" && event.key === "l" && isPlainShortcut) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.FOCUS_RIGHT).catch(() => {});
                return;
            }
            // The Files tab is a LIST, so arrows/j/k must move the selection
            // there the same way they do in the session list — otherwise they
            // fall through to the generic scroll below and the artifact list
            // cannot be driven from the keyboard at all. Must precede the
            // scroll fallback.
            if (!mobile && focusRegion === "inspector" && currentInspectorTab === "files"
                && (event.key === "ArrowUp" || event.key === "k")) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.MOVE_FILE_UP).catch(() => {});
                return;
            }
            if (!mobile && focusRegion === "inspector" && currentInspectorTab === "files"
                && (event.key === "ArrowDown" || event.key === "j")) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.MOVE_FILE_DOWN).catch(() => {});
                return;
            }
            if (!mobile && (event.key === "ArrowUp" || event.key === "k")) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.SCROLL_UP).catch(() => {});
                return;
            }
            if (!mobile && (event.key === "ArrowDown" || event.key === "j")) {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.SCROLL_DOWN).catch(() => {});
                return;
            }
            if (!mobile && event.key === "Escape") {
                event.preventDefault();
                controller.handleCommand(UI_COMMANDS.FOCUS_SESSIONS).catch(() => {});
            }
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [controller, mobile]);
}

function formatAdminPrincipalLabel(principal) {
    if (!principal) return "Unknown user";
    const name = String(principal.displayName || "").trim();
    const email = String(principal.email || "").trim();
    if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} <${email}>`;
    if (name) return name;
    if (email) return email;
    const provider = String(principal.provider || "").trim();
    const subject = String(principal.subject || "").trim();
    return [provider, subject].filter(Boolean).join(":") || "user";
}

function AdminConsolePanel({ controller, mobile = false }) {
    const view = useControllerSelector(controller, selectAdminConsole, shallowEqualObject);
    const draftRef = React.useRef(null);
    const packages = view.packages || {};
    const showPackages = view.section === "packages";
    const showWorkers = view.section === "workers";
    // Workspace pane geometry: user-resizable (drag the pane's left edge for
    // width, the Preview header for the tree/preview split), persisted.
    const [wsLayout, setWsLayout] = React.useState(() => {
        const defaults = { wsWidth: 440, treePct: 44, navWidth: 240 };
        try {
            return { ...defaults, ...JSON.parse(window.localStorage.getItem("ps-admin-ws-layout") || "{}") };
        } catch {
            return defaults;
        }
    });
    const updateWsLayout = React.useCallback((patch) => {
        setWsLayout((prev) => {
            const next = { ...prev, ...patch };
            next.wsWidth = Math.min(900, Math.max(300, Math.round(next.wsWidth)));
            next.treePct = Math.min(85, Math.max(15, next.treePct));
            next.navWidth = Math.min(420, Math.max(170, Math.round(next.navWidth ?? 240)));
            try { window.localStorage.setItem("ps-admin-ws-layout", JSON.stringify(next)); } catch { /* private mode */ }
            return next;
        });
    }, []);
    // Settings-tree column resize: drag the tree's right edge (persisted with
    // the other pane geometry under the sanctioned ps-admin-ws-layout key).
    const startNavDrag = React.useCallback((event) => {
        event.preventDefault();
        document.body.style.cursor = "col-resize";
        const startX = event.clientX;
        const startWidth = wsLayout.navWidth ?? 240;
        const onMove = (move) => updateWsLayout({ navWidth: startWidth + (move.clientX - startX) });
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            document.body.style.cursor = "";
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    }, [wsLayout.navWidth, updateWsLayout]);

    React.useEffect(() => {
        if (view.ghcpKey.editing) {
            // Defer focus to next tick so the input has mounted.
            const handle = window.requestAnimationFrame(() => {
                if (draftRef.current) draftRef.current.focus();
            });
            return () => window.cancelAnimationFrame(handle);
        }
        return undefined;
    }, [view.ghcpKey.editing]);

    const onClose = React.useCallback(() => {
        controller.closeAdminConsole();
    }, [controller]);
    const onRefresh = React.useCallback(() => {
        controller.refreshAdminProfile().catch(() => {});
    }, [controller]);
    const onBeginEdit = React.useCallback(() => {
        controller.beginAdminEditGhcpKey();
    }, [controller]);
    const onCancelEdit = React.useCallback(() => {
        controller.cancelAdminEditGhcpKey();
    }, [controller]);
    const onClear = React.useCallback(() => {
        controller.clearAdminGhcpKey().catch(() => {});
    }, [controller]);
    const onSubmit = React.useCallback((event) => {
        event.preventDefault();
        controller.saveAdminGhcpKey().catch(() => {});
    }, [controller]);
    const onDraftChange = React.useCallback((event) => {
        controller.setAdminGhcpKeyDraft(event.target.value);
    }, [controller]);

    const principalLabel = formatAdminPrincipalLabel(view.principal);

    const header = React.createElement("header", { className: "ps-admin-console__header" },
        React.createElement("h2", null, "Admin Console"),
        React.createElement("span", { className: "ps-admin-console__who" }, principalLabel),
        React.createElement("button", { type: "button", className: "ps-mini-button", onClick: onClose }, "Close"));

    const ghcpSection = React.createElement(AdminGhcpSection, {
        view, draftRef, onBeginEdit, onCancelEdit, onClear, onSubmit, onDraftChange, onRefresh, controller,
    });

    const tree = React.createElement(AdminSettingsTree, { controller, view });
    const detail = React.createElement(AdminPackageDetailPane, { controller, view });
    const workspacePane = showPackages && packages.selectedName
        ? React.createElement(AdminPackageWorkspacePane, { controller, view, layout: wsLayout, onLayout: updateWsLayout })
        : null;
    const dialog = packages.addDialog?.open
        ? React.createElement(AdminAddPackageDialog, { controller, dialog: packages.addDialog })
        : null;

    if (mobile) {
        // Drill-in stack: settings list → section content; a selected package
        // stacks detail + files + preview in one scroll with a back action.
        let body;
        if (showPackages && packages.selectedName) {
            body = React.createElement("div", { className: "ps-admin-mobile-stack" },
                React.createElement("button", {
                    type: "button", className: "ps-mini-button ps-admin-back",
                    onClick: () => controller.selectAdminPackage(null),
                }, "← All packages"),
                detail,
                workspacePane);
        } else if (showPackages) {
            body = tree;
        } else if (showWorkers) {
            body = React.createElement("div", { className: "ps-admin-mobile-stack" }, tree,
                React.createElement(AdminWorkersPane, { controller, view }));
        } else {
            body = React.createElement("div", { className: "ps-admin-mobile-stack" }, tree, ghcpSection);
        }
        return React.createElement("div", { className: "ps-admin-console is-mobile" },
            header,
            view.loadError ? React.createElement("div", { className: "ps-admin-console__error", role: "alert" }, view.loadError) : null,
            body,
            dialog);
    }

    return React.createElement("div", { className: "ps-admin-console is-workspace" },
        header,
        view.loadError ? React.createElement("div", { className: "ps-admin-console__error", role: "alert" }, view.loadError) : null,
        React.createElement("div", {
            className: "ps-admin-workspace",
            style: workspacePane
                ? { gridTemplateColumns: `${wsLayout.navWidth}px minmax(0, 1fr) minmax(0, ${wsLayout.wsWidth}px)` }
                : { gridTemplateColumns: `${wsLayout.navWidth}px minmax(0, 1fr)` },
        },
            React.createElement("div", { className: "ps-admin-nav" },
                tree,
                React.createElement("div", {
                    className: "ps-admin-nav__resize",
                    onPointerDown: startNavDrag,
                    role: "separator",
                    "aria-orientation": "vertical",
                    "aria-label": "Resize settings column",
                })),
            React.createElement("div", { className: "ps-admin-main" },
                showPackages ? detail : showWorkers ? React.createElement(AdminWorkersPane, { controller, view }) : ghcpSection),
            workspacePane),
        dialog);
}

function AdminWorkersPane({ controller, view }) {
    const workers = view.workers || {};
    const rows = workers.rows || [];
    const counts = workers.counts || {};
    // Liveness is heartbeat recency (~20s beats, 90s window): a static
    // snapshot rots into "0 live" while the pane sits open. Poll while
    // mounted; the TUI refreshes on `r`.
    React.useEffect(() => {
        const timer = window.setInterval(() => {
            void controller.refreshAdminWorkers();
        }, 25_000);
        return () => window.clearInterval(timer);
    }, [controller]);
    return React.createElement("div", { className: "ps-admin-detail ps-admin-workers" },
        React.createElement("div", { className: "ps-admin-workers__head" },
            React.createElement("h3", null, "Workers"),
            workers.summaryText
                ? React.createElement("span", { className: "ps-admin-workers__summary" },
                    `${workers.summaryText}${counts.pools > 1 ? ` · ${counts.pools} pools` : ""}${counts.draining ? ` · ${counts.draining} draining` : ""}`)
                : null,
            React.createElement("button", {
                type: "button", className: "ps-mini-button",
                disabled: Boolean(workers.loading),
                onClick: () => controller.refreshAdminWorkers(),
            }, workers.loading ? "Refreshing…" : "Refresh")),
        workers.error
            ? React.createElement("div", { className: "ps-admin-console__error", role: "alert" }, workers.error)
            : null,
        workers.empty
            ? React.createElement("p", { className: "ps-admin-console__hint" },
                "No workers registered. Workers appear here on their first heartbeat and self-prune after an hour of silence.")
            : React.createElement("div", { className: "ps-admin-workers__scroll" },
                React.createElement("table", { className: "ps-admin-workers__table" },
                    React.createElement("thead", null, React.createElement("tr", null,
                        ["Worker", "Pool", "Phase", "Heartbeat", "Uptime", "RSS", "Sessions", "Loop p99", "Packages", "SDK"]
                            .map((label) => React.createElement("th", { key: label }, label)))),
                    React.createElement("tbody", null, rows.map((row) => React.createElement("tr", {
                        key: row.id,
                        className: row.live ? "is-live" : "is-stale",
                    },
                        React.createElement("td", { className: "ps-admin-workers__id", title: row.owner ? `owner: ${row.owner}` : undefined },
                            React.createElement("span", { className: `ps-worker-dot${row.live ? " is-live" : ""}` }),
                            row.id,
                            row.substrate && row.substrate !== "kubernetes"
                                ? React.createElement("span", { className: "ps-admin-workers__substrate" }, row.substrate)
                                : null),
                        React.createElement("td", null, row.pool),
                        React.createElement("td", null,
                            React.createElement("span", { className: `ps-worker-phase is-${row.phase}` }, row.phase)),
                        React.createElement("td", null, row.agoText),
                        React.createElement("td", null, row.uptimeText ?? "—"),
                        React.createElement("td", null, row.rssText ?? "—"),
                        React.createElement("td", null, row.sessions ?? "—"),
                        React.createElement("td", null, row.eventLoopText ?? "—"),
                        React.createElement("td", { title: row.pkgEpoch != null ? `epoch ${row.pkgEpoch}` : undefined }, row.pkgText ?? "—"),
                        React.createElement("td", null, row.sdkVersion ?? "—")))))));
}

function AdminSettingsTree({ controller, view }) {
    const packages = view.packages || {};
    return React.createElement("nav", { className: "ps-admin-tree" },
        React.createElement("div", { className: "ps-admin-tree__label" }, "Settings"),
        (view.settingsTree || []).map((row) => {
            if (row.kind === "group") {
                return React.createElement("div", { key: row.id, className: "ps-admin-tree__group" },
                    `${row.label}`, React.createElement("span", { className: "ps-admin-tree__count" }, String(row.count ?? 0)));
            }
            const onClick = row.kind === "package"
                ? () => controller.selectAdminPackage(row.name)
                : () => controller.setAdminSection(row.id === "agents" ? "packages" : row.id === "workers" ? "workers" : "ghcp");
            return React.createElement("button", {
                key: row.id,
                type: "button",
                className: `ps-admin-tree__row depth-${row.depth}${row.selected ? " is-selected" : ""}${row.kind === "package" && !row.enabled ? " is-disabled" : ""}`,
                onClick,
            },
                // A user-scope package shows WHOSE it is, using the same
                // owner-initials chip the session rows use, so "[ad]" means
                // the same thing on both sides of the app. Shared packages
                // belong to the deployment, so they keep the scope badge.
                row.kind === "package"
                    ? (row.ownerBadge
                        ? React.createElement(OwnerAvatar, { badge: row.ownerBadge })
                        : React.createElement("span", {
                            className: "ps-scope-badge is-shared",
                            title: "shared with the whole deployment",
                        }, "S"))
                    : null,
                React.createElement("span", { className: "ps-admin-tree__name" }, row.label),
                row.kind === "package" && row.semver
                    ? React.createElement("span", { className: "ps-admin-tree__ver" }, row.semver)
                    : null);
        }),
        packages.loading ? React.createElement("div", { className: "ps-admin-tree__hint" }, "Loading packages…") : null,
        packages.error ? React.createElement("div", { className: "ps-admin-tree__hint is-error" }, packages.error) : null,
        React.createElement("button", {
            type: "button",
            className: "ps-admin-tree__add",
            onClick: () => controller.openAdminAddPackage(),
        }, "+ Add package"));
}

function AdminPackageDetailPane({ controller, view }) {
    const packages = view.packages || {};
    const detail = packages.detail;
    if (!packages.selectedName) {
        return React.createElement("div", { className: "ps-admin-detail is-empty" },
            React.createElement("h3", null, "Agents"),
            React.createElement("p", { className: "ps-admin-console__hint" },
                packages.empty
                    ? "No agent packages yet. Add one from a GitHub/ADO repo, a tarball URL, or upload a folder — or push from a terminal with `pilotswarm agents push ./my-agents`."
                    : "Select a package from the tree to see its detail, versions, and files."));
    }
    const confirmDelete = () => {
        const ok = window.confirm(
            `Delete ${detail.name}? Every version and its artifacts are removed. Live sessions using its agents will fail on their next turn.`,
        );
        if (ok) controller.runAdminPackageAction("delete");
    };
    const act = (kind, arg) => () => controller.runAdminPackageAction(kind, arg);
    const pending = detail.actionPending;
    return React.createElement("div", { className: "ps-admin-detail" },
        detail.error
            ? React.createElement("div", { className: "ps-admin-console__error", role: "alert" },
                `Package load failed: ${detail.error}`)
            : null,
        detail.loading
            ? React.createElement("p", { className: "ps-admin-console__hint" }, "Loading package…")
            : null,
        React.createElement("div", { className: "ps-admin-detail__head" },
            React.createElement("h3", null, detail.name),
            React.createElement("span", { className: `ps-scope-badge is-${detail.scope}` }, detail.scope),
            !detail.enabled ? React.createElement("span", { className: "ps-scope-badge is-off" }, "disabled") : null),
        detail.description ? React.createElement("p", { className: "ps-admin-detail__desc" }, detail.description) : null,
        React.createElement("dl", { className: "ps-admin-detail__meta" },
            React.createElement("dt", null, "Version"),
            React.createElement("dd", null, detail.activeSemver
                ? `${detail.activeSemver} · sha ${detail.activeSha12 || "?"} · ${detail.sizeText}`
                : "no active version"),
            detail.fleet
                ? [React.createElement("dt", { key: "fk" }, "Fleet"), React.createElement("dd", { key: "fv", className: "is-ok" }, detail.fleet.text)]
                : null,
            React.createElement("dt", null, "Created"),
            React.createElement("dd", null, `${detail.createdBy || "unknown"} · ${detail.createdAtText}`)),
        detail.agents.length
            ? React.createElement("div", null,
                React.createElement("div", { className: "ps-admin-detail__label" }, "Agents in this package"),
                React.createElement("div", { className: "ps-admin-detail__chips" },
                    detail.agents.map((agent) => React.createElement("span", { key: agent.name, className: "ps-agent-chip", title: agent.description },
                        agent.name,
                        agent.toolCount ? React.createElement("i", null, ` · ${agent.toolCount} tools`) : null))))
            : null,
        detail.versions.length
            ? React.createElement("div", null,
                React.createElement("div", { className: "ps-admin-detail__label" }, "Versions"),
                React.createElement("div", { className: "ps-admin-versions" },
                    detail.versions.map((version) => React.createElement("div", {
                        key: version.semver,
                        className: `ps-admin-version${version.active ? " is-active" : ""}`,
                    },
                        React.createElement("b", null, version.semver),
                        React.createElement("span", null, version.sha12),
                        React.createElement("span", null, version.dateText),
                        version.active
                            ? React.createElement("span", { className: "is-ok" }, "● active")
                            : (detail.canManage
                                ? React.createElement("button", { type: "button", className: "ps-mini-button", onClick: act("pin", version.semver), disabled: Boolean(pending) }, "Pin")
                                : null)))))
            : null,
        detail.canManage
            ? React.createElement("div", { className: "ps-admin-detail__actions" },
                detail.source
                    ? React.createElement("button", { type: "button", className: "ps-primary-button", onClick: act("sync"), disabled: Boolean(pending) },
                        pending === "sync" ? "Syncing…" : "Sync now")
                    : null,
                // Publishing a new version is the same job as adding one, so it
                // is the same dialog with the destination already chosen.
                React.createElement("button", {
                    type: "button",
                    className: "ps-primary-button",
                    onClick: () => controller.openAdminUpdatePackage(detail.name, detail.scope),
                    disabled: Boolean(pending),
                    title: `Publish a new version of ${detail.name} from a repo folder`,
                }, "Update"),
                React.createElement("button", { type: "button", className: "ps-mini-button", onClick: act(detail.scope === "shared" ? "demote" : "promote"), disabled: Boolean(pending) },
                    detail.scope === "shared" ? "Demote to user" : "Promote to shared"),
                React.createElement("button", { type: "button", className: "ps-mini-button", onClick: act(detail.enabled ? "disable" : "enable"), disabled: Boolean(pending) },
                    detail.enabled ? "Disable" : "Enable"),
                React.createElement("button", { type: "button", className: "ps-mini-button is-danger", onClick: confirmDelete, disabled: Boolean(pending) }, "Delete"))
            : React.createElement("p", { className: "ps-admin-console__hint" },
                "Read-only: only the package creator or an admin can modify it."),
        detail.actionError
            ? React.createElement("div", { className: "ps-admin-console__error", role: "alert" }, detail.actionError)
            : null);
}

function AdminPackageWorkspacePane({ controller, view, layout = null, onLayout = null }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const workspace = view.packages?.workspace;
    const paneRef = React.useRef(null);
    // Shared pointer-drag: track from pointerdown, apply via onLayout, end on up.
    const startDrag = React.useCallback((event, apply) => {
        if (!onLayout) return;
        event.preventDefault();
        const startX = event.clientX;
        const startY = event.clientY;
        const startLayout = { ...layout };
        const onMove = (move) => apply(startLayout, move.clientX - startX, move.clientY - startY);
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            document.body.style.cursor = "";
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    }, [layout, onLayout]);
    const onWidthDrag = React.useCallback((event) => {
        document.body.style.cursor = "col-resize";
        startDrag(event, (start, dx) => onLayout({ wsWidth: start.wsWidth - dx }));
    }, [startDrag, onLayout]);
    const onSplitDrag = React.useCallback((event) => {
        document.body.style.cursor = "row-resize";
        const height = paneRef.current?.getBoundingClientRect().height || 600;
        startDrag(event, (start, _dx, dy) => onLayout({ treePct: start.treePct + (dy / height) * 100 }));
    }, [startDrag, onLayout]);
    if (!workspace) return null;
    return React.createElement("div", {
        className: "ps-admin-ws",
        ref: paneRef,
        style: layout ? { gridTemplateRows: `auto minmax(80px, ${layout.treePct}%) auto minmax(0, 1fr)` } : undefined,
    },
        onLayout
            ? React.createElement("div", {
                className: "ps-admin-ws__vdivider",
                title: "Drag to resize the workspace",
                onPointerDown: onWidthDrag,
            })
            : null,
        React.createElement("div", { className: "ps-admin-ws__head" },
            `Package workspace${workspace.semver ? ` · ${view.packages.selectedName}@${workspace.semver}` : ""}`),
        React.createElement("div", { className: "ps-admin-ws__tree" },
            workspace.loading ? React.createElement("div", { className: "ps-admin-tree__hint" }, "Loading files…") : null,
            workspace.error ? React.createElement("div", { className: "ps-admin-tree__hint is-error" }, workspace.error) : null,
            workspace.treeRows.map((row) => React.createElement("button", {
                key: `${row.type}:${row.path}`,
                type: "button",
                style: { paddingLeft: `${8 + (row.depth || 0) * 16}px` },
                className: `ps-admin-ws__row is-${row.type}${row.selected ? " is-selected" : ""}`,
                onClick: row.type === "dir"
                    ? () => controller.toggleAdminPackageDir(row.path)
                    : () => controller.selectAdminPackageFile(row.path),
            },
                React.createElement("span", { className: "ps-admin-ws__caret" },
                    row.type === "dir" ? (row.expanded ? "▾" : "▸") : ""),
                React.createElement("span", { className: "ps-admin-ws__name" }, row.label),
                row.sizeText ? React.createElement("span", { className: "ps-admin-ws__size" }, row.sizeText) : null))),
        React.createElement("div", {
            className: `ps-admin-ws__preview-head${onLayout ? " is-resizable" : ""}`,
            title: onLayout ? "Drag to resize file list vs preview" : undefined,
            onPointerDown: onLayout ? onSplitDrag : undefined,
        },
            workspace.selectedPath ? `Preview · ${workspace.selectedPath}` : "Preview"),
        React.createElement("div", { className: "ps-admin-ws__preview" },
            workspace.fileLoading ? React.createElement("div", { className: "ps-admin-tree__hint" }, "Loading…") : null,
            workspace.fileError ? React.createElement("div", { className: "ps-admin-tree__hint is-error" }, workspace.fileError) : null,
            workspace.file
                ? (workspace.file.isBinary
                    ? React.createElement("div", { className: "ps-admin-tree__hint" }, `Binary file · ${workspace.file.sizeText}`)
                    : React.createElement(AdminWorkspacePreviewBody, { file: workspace.file, theme }))
                : null));
}

/** Split leading `--- … ---` frontmatter off a markdown document. */
function splitFrontmatter(text) {
    const match = /^---\n([\s\S]*?)\n---\n?/.exec(text || "");
    if (!match) return { meta: null, body: text || "" };
    const rows = match[1].split("\n")
        .map((line) => /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line))
        .filter(Boolean)
        .map(([, key, value]) => ({ key, value }));
    // Only claim it as frontmatter when it parses as simple key: value
    // metadata; anything else stays part of the document verbatim.
    if (rows.length === 0) return { meta: null, body: text || "" };
    return { meta: rows, body: (text || "").slice(match[0].length) };
}

/**
 * Content-aware package-file preview: markdown renders as a document
 * (frontmatter as a meta strip), JSON pretty-prints, code highlights.
 * The TUI keeps its plain-text preview — this is portal presentation only.
 */
function AdminWorkspacePreviewBody({ file, theme }) {
    const language = file.language || "text";
    const truncatedNote = file.truncated
        ? React.createElement("div", { className: "ps-admin-tree__hint" }, "… truncated preview")
        : null;
    if (language === "markdown") {
        const { meta, body } = splitFrontmatter(file.text || "");
        return React.createElement("div", { className: "ps-admin-ws__doc" },
            meta
                ? React.createElement("div", { className: "ps-admin-ws__frontmatter" },
                    meta.map((row) => React.createElement("div", { key: row.key, className: "ps-admin-ws__fm-row" },
                        React.createElement("span", { className: "ps-admin-ws__fm-key" }, row.key),
                        React.createElement("span", { className: "ps-admin-ws__fm-val" }, row.value))))
                : null,
            React.createElement(MarkdownPreviewContent, { content: body, theme }),
            truncatedNote);
    }
    if (language === "json") {
        let pretty = file.text || "";
        if (!file.truncated) {
            // Re-indent only complete documents; a truncated tail would
            // just throw and fall back to the raw text anyway.
            try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch { /* show as-is */ }
        }
        return React.createElement("div", { className: "ps-admin-ws__doc" },
            React.createElement("pre", { className: "ps-admin-ws__code lang-json" },
                React.createElement("code", null, renderHighlightedCode(pretty, "json", theme))),
            truncatedNote);
    }
    return React.createElement("div", { className: "ps-admin-ws__doc" },
        React.createElement("pre", { className: `ps-admin-ws__code lang-${language}` },
            React.createElement("code", null, renderHighlightedCode(file.text || "", language, theme))),
        truncatedNote);
}

function AdminAddPackageDialog({ controller, dialog }) {
    // The authoring guide is DEPLOYMENT config: a layered app ships its own,
    // carrying the base instructions plus the skills, tools and MCP servers
    // that only exist on that fleet.
    const guideUrl = useControllerSelector(controller, (state) => state.docs?.agentPackageGuideUrl || null);
    const setField = (field) => (event) => controller.setAdminAddPackageField(field, event.target.value);
    const kinds = [["repo", "GitHub / Azure DevOps"], ["upload", "Upload folder"]];
    const isRepo = dialog.kind === "repo" || dialog.kind === "github" || dialog.kind === "ado";
    const folderRef = React.useRef(null);
    const [reading, setReading] = React.useState(false);
    const UPLOAD_LIMIT = 2 * 1024 * 1024;
    const onSubmit = (event) => {
        event.preventDefault();
        if (reading || dialog.submitting) return;
        if (dialog.kind === "upload") {
            const input = folderRef.current;
            if (!input?.files?.length) {
                controller.failAdminAddPackage("Choose a package folder first.");
                return;
            }
            // Filter and size-check BEFORE reading a single byte: a folder
            // with node_modules must not freeze the tab base64-reading
            // megabytes the server would reject anyway.
            const picked = [...input.files]
                .map((file) => ({
                    file,
                    path: file.webkitRelativePath.split("/").slice(1).join("/") || file.name,
                }))
                .filter(({ path: rel }) => rel
                    && !rel.split("/").includes("node_modules")
                    && !rel.split("/").includes(".git"));
            const totalBytes = picked.reduce((sum, { file }) => sum + file.size, 0);
            if (picked.length === 0) {
                controller.failAdminAddPackage("The chosen folder has no uploadable files.");
                return;
            }
            if (totalBytes > UPLOAD_LIMIT) {
                controller.failAdminAddPackage(
                    `Folder is ${(totalBytes / (1024 * 1024)).toFixed(1)} MB after filtering — the upload envelope is 2 MB. Use a repo/URL source or 'pilotswarm agents push' for larger packages.`,
                );
                return;
            }
            setReading(true);
            Promise.all(picked.map(({ file, path: rel }) => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(new Error(`could not read ${rel}`));
                reader.onload = () => resolve({
                    path: rel,
                    contentBase64: String(reader.result).split(",", 2)[1] || "",
                });
                reader.readAsDataURL(file);
            })))
                .then((payload) => controller.submitAdminUploadPackage(payload, dialog.scope))
                .catch((error) => controller.failAdminAddPackage(error?.message || "Could not read the chosen folder."))
                .finally(() => setReading(false));
            return;
        }
        controller.submitAdminAddPackage().catch(() => {});
    };
    return React.createElement("div", { className: "ps-modal-backdrop", onClick: () => controller.closeAdminAddPackage() },
        React.createElement("form", {
            className: "ps-modal ps-admin-add",
            onClick: (event) => event.stopPropagation(),
            // A form containing a type=password input is treated as a SIGN-IN
            // form by Safari/Chrome, which then offer saved credentials on the
            // nearest text input — the link box. These opt the whole form (and
            // the password managers) out of that heuristic.
            autoComplete: "off",
            onSubmit,
        },
            React.createElement("div", { className: "ps-modal-header" },
                React.createElement("span", null, dialog.updateName ? `Update ${dialog.updateName}` : "Add agent package"),
                React.createElement("button", { type: "button", className: "ps-mini-button", onClick: () => controller.closeAdminAddPackage() }, "✕")),
            React.createElement("div", { className: "ps-admin-add__body" },
                React.createElement("div", { className: "ps-admin-add__tabs" },
                    kinds.map(([kind, label]) => React.createElement("button", {
                        key: kind,
                        type: "button",
                        className: `ps-admin-add__tab${dialog.kind === kind ? " is-on" : ""}`,
                        onClick: () => controller.setAdminAddPackageField("kind", kind),
                    }, label))),
                isRepo
                    ? [
                        React.createElement("label", { key: "u", className: "ps-admin-add__field" }, "Link to plugin.json (or the folder containing it)",
                            React.createElement("input", {
                                value: dialog.repoUrl,
                                onChange: setField("repoUrl"),
                                placeholder: "https://github.com/org/repo/blob/main/my-agents/plugin.json",
                                autoFocus: true,
                                type: "url",
                                name: "agent-package-link",
                                autoComplete: "off",
                                spellCheck: false,
                                "data-1p-ignore": "true",
                                "data-lpignore": "true",
                                "data-bwignore": "true",
                            })),
                        React.createElement("div", { key: "h", className: "ps-admin-add__hint" },
                            "Paste the browser URL — branch and path are read from the link. The files are read "
                            + "by THIS BROWSER with your access (public GitHub needs nothing; Azure DevOps uses your "
                            + "signed-in account) and uploaded as a package artifact."),
                        React.createElement("label", { key: "t", className: "ps-admin-add__field" }, "PAT (only for private GitHub repos, or to override — used here, never stored)",
                            React.createElement("input", {
                                type: "password",
                                value: dialog.authToken,
                                onChange: setField("authToken"),
                                name: "agent-package-pat",
                                // "new-password" is what actually suppresses the
                                // saved-credential prompt; "off" is ignored for
                                // password inputs in Safari.
                                autoComplete: "new-password",
                                "data-1p-ignore": "true",
                                "data-lpignore": "true",
                                "data-bwignore": "true",
                            })),
                    ]
                    : React.createElement("label", { className: "ps-admin-add__field" }, "Package folder with plugin.json — the manifest (≤ 2 MB; node_modules skipped)",
                            React.createElement("input", { ref: folderRef, type: "file", webkitdirectory: "", directory: "", multiple: true })),
                React.createElement("div", { className: "ps-admin-add__scope" },
                    React.createElement("label", null,
                        React.createElement("input", { type: "radio", name: "pkg-scope", checked: dialog.scope === "shared", disabled: Boolean(dialog.updateName), onChange: () => controller.setAdminAddPackageField("scope", "shared") }),
                        " Shared — everyone can use it"),
                    React.createElement("label", null,
                        React.createElement("input", { type: "radio", name: "pkg-scope", checked: dialog.scope === "user", disabled: Boolean(dialog.updateName), onChange: () => controller.setAdminAddPackageField("scope", "user") }),
                        " User — only you see it")),
                dialog.updateName
                    ? React.createElement("p", { className: "ps-admin-console__hint" },
                        `Publishes a new version of ${dialog.updateName}. Its scope is unchanged — `
                        + "use Demote/Promote on the package to move it.")
                    : null,
                // The authoring guide, linked where someone actually needs it.
                // It is written to be handed to a coding assistant as-is, so
                // the URL is worth being able to copy out of the dialog.
                guideUrl
                    ? React.createElement("p", { className: "ps-admin-console__hint" },
                        "New to this? ",
                        React.createElement("a", {
                            href: guideUrl,
                            target: "_blank",
                            rel: "noreferrer noopener",
                        }, "How to build an agent package"),
                        " — a complete guide you can also hand straight to Claude or Copilot.")
                    : null,
                React.createElement("p", { className: "ps-admin-console__hint" },
                    "Same thing from a terminal: pilotswarm agents push ./my-agents --shared"),
                dialog.progress && !dialog.error
                    ? React.createElement("p", { className: "ps-admin-add__progress" }, dialog.progress)
                    : null,
                dialog.error
                    ? React.createElement("pre", { className: "ps-admin-add__error", role: "alert" }, dialog.error)
                    : null),
            React.createElement("div", { className: "ps-modal-footer" },
                React.createElement("button", { type: "button", className: "ps-mini-button", onClick: () => controller.closeAdminAddPackage(), disabled: dialog.submitting }, "Cancel"),
                React.createElement("button", { type: "submit", className: "ps-primary-button", disabled: dialog.submitting || reading },
                    reading
                        ? "Reading folder…"
                        : dialog.submitting
                            ? "Importing…"
                            : dialog.updateName ? "Import & update" : "Import & publish"))));
}

function AdminGhcpSection({ view, draftRef, onBeginEdit, onCancelEdit, onClear, onSubmit, onDraftChange, onRefresh, controller }) {
        return React.createElement("section", { className: "ps-admin-console__section" },
            React.createElement("h3", null, "GitHub Copilot key"),
            view.ghcpKey.storeAsSystem
                ? React.createElement("p", { className: "ps-admin-console__hint" },
                    "System-wide key for platform-managed (ownerless) system ",
                    "sessions — agent tuners, repo cache managers, and other ",
                    "sessions with no owner resolve this key for GitHub Copilot ",
                    "models. Clearing it reverts them to the worker default.")
                : React.createElement("p", { className: "ps-admin-console__hint" },
                    "Per-user override for the GitHub Copilot model provider token. ",
                    "When set, this key is used instead of the worker's env-supplied ",
                    "GITHUB_TOKEN for sessions you own. Clearing the key reverts to ",
                    "the worker default."),
            view.isAdmin && view.systemGhcpKey.supported
                ? React.createElement("label", { className: "ps-admin-console__system-toggle" },
                    React.createElement("input", {
                        type: "checkbox",
                        checked: view.ghcpKey.storeAsSystem,
                        disabled: view.ghcpKey.saving,
                        onChange: (event) => controller.setAdminGhcpKeyStoreAsSystem(event.target.checked),
                    }),
                    "Store as System key")
                : null,
            React.createElement("p", { className: `ps-admin-console__status${view.ghcpKey.error ? " is-error" : ""}` },
                view.ghcpKey.error || view.ghcpKey.statusText),
            view.ghcpKey.editing
                ? React.createElement("form", { className: "ps-admin-console__form", onSubmit },
                    React.createElement("input", {
                        ref: draftRef,
                        type: "password",
                        autoComplete: "off",
                        spellCheck: false,
                        value: view.ghcpKey.draft,
                        disabled: view.ghcpKey.saving,
                        placeholder: "Paste GitHub Copilot key",
                        onChange: onDraftChange,
                    }),
                    React.createElement("div", { className: "ps-admin-console__actions" },
                        React.createElement("button", {
                            type: "submit",
                            className: "ps-primary-button",
                            disabled: view.ghcpKey.saving,
                        }, view.ghcpKey.saving ? "Saving..." : "Save"),
                        React.createElement("button", {
                            type: "button",
                            className: "ps-mini-button",
                            onClick: onCancelEdit,
                            disabled: view.ghcpKey.saving,
                        }, "Cancel")))
                : React.createElement("div", { className: "ps-admin-console__actions" },
                    React.createElement("button", {
                        type: "button",
                        className: "ps-primary-button",
                        onClick: onBeginEdit,
                    }, view.ghcpKey.targetConfigured
                        ? (view.ghcpKey.storeAsSystem ? "Replace System key" : "Replace key")
                        : (view.ghcpKey.storeAsSystem ? "Set System key" : "Set key")),
                    view.ghcpKey.targetConfigured
                        ? React.createElement("button", {
                            type: "button",
                            className: "ps-mini-button",
                            onClick: onClear,
                        }, view.ghcpKey.storeAsSystem ? "Clear System key" : "Clear key")
                        : null,
                    React.createElement("button", {
                        type: "button",
                        className: "ps-mini-button",
                        onClick: onRefresh,
                    }, view.loading ? "Refreshing..." : "Refresh")));
}

export function createWebPilotSwarmController({ transport, mode = "remote", branding = null, docs = null } = {}) {
    clearBrowserPreferenceCache();
    // Rich prose is the right default on a desktop transcript; on a phone the
    // terminal view fits far more per screen and does not reflow wide content.
    // This is only the DEFAULT — a stored profile preference still wins once
    // settings load, so an explicit choice is never overridden.
    const isNarrowViewport = typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia("(max-width: 920px)").matches;
    const store = createStore(appReducer, createInitialState({
        mode,
        branding,
        docs,
        chatViewMode: isNarrowViewport ? "transcript" : "rich",
    }));
    return new PilotSwarmUiController({ store, transport });
}

export function PilotSwarmWebApp({ controller }) {
    // The rich UI restyles chrome that lives OUTSIDE this tree (the portal
    // header in App.jsx), so the flag rides on <body> and every surface
    // keys off `body.ps-rich-ui` in CSS rather than threading a prop.
    const richUi = useControllerSelector(controller, (state) => Boolean(getTheme(state.ui.themeId)?.richChat));
    React.useEffect(() => {
        if (typeof document === "undefined") return undefined;
        document.body.classList.toggle("ps-rich-ui", richUi);
        return () => document.body.classList.remove("ps-rich-ui");
    }, [richUi]);

    const viewportRef = React.useRef(null);
    const mainGridRef = React.useRef(null);
    const viewport = useMeasuredViewport(viewportRef);
    const mainGridViewport = useMeasuredViewport(mainGridRef);
    const gridViewport = computeGridViewport(viewport);

    // Publish the real viewport in character cells. Without this the ui-core
    // layout model runs on its 120×40 fallback everywhere in the browser, so
    // width-derived behavior (markdown wrap width, render metrics, the
    // splashMobile width swap) assumed a ~120-column terminal regardless of
    // device — phones kept getting desktop splash art narrower than ~76 cols.
    React.useEffect(() => {
        const publish = () => {
            const probe = document.createElement("span");
            probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;";
            // Measure with the font real lines render in — an off-context
            // probe can inherit a different size and skew the column count.
            const sample = document.querySelector(".ps-scroll-panel .ps-line") || document.querySelector(".ps-line");
            if (sample) probe.style.font = window.getComputedStyle(sample).font;
            probe.textContent = "0".repeat(100);
            (sample?.parentElement || document.body).appendChild(probe);
            const charWidth = (probe.getBoundingClientRect().width / 100) || 8;
            probe.remove();
            controller.dispatch({
                type: "ui/viewport",
                width: Math.floor(window.innerWidth / charWidth),
                height: Math.floor(window.innerHeight / SCROLL_ROW_HEIGHT),
            });
        };
        publish();
        let timer;
        const onResize = () => { clearTimeout(timer); timer = setTimeout(publish, 150); };
        window.addEventListener("resize", onResize);
        window.addEventListener("orientationchange", onResize);
        return () => {
            clearTimeout(timer);
            window.removeEventListener("resize", onResize);
            window.removeEventListener("orientationchange", onResize);
        };
    }, [controller]);
    const [chatFocusMode, setChatFocusMode] = React.useState(false);
    const [chatFocusPane, setChatFocusPane] = React.useState(null);
    const state = useControllerSelector(controller, (rootState) => ({
        themeId: rootState.ui.themeId,
        ownerFilter: rootState.sessions.ownerFilter,
        pinnedIds: rootState.sessions.pinnedIds,
        // Without this the profile-save effect reads undefined and a reorder
        // never persists — the reducer would reorder the list correctly and
        // the placement would vanish on reload.
        manualOrder: rootState.sessions.manualOrder,
        // Pass the live Set reference here so shallow-equal sees the same
        // identity across renders (a fresh array would break memoization).
        // Conversion to a sorted array happens inside `normalizeProfileSettings`.
        collapsedSessionIds: rootState.sessions.collapsedIds,
        activeSessionId: rootState.sessions.activeSessionId || null,
        promptRows: getStatePromptRows(rootState),
        chatViewMode: rootState.ui.chatViewMode || "transcript",
        activeSessionIsGroup: Boolean(rootState.sessions.activeSessionId && rootState.sessions.byId[rootState.sessions.activeSessionId]?.isGroup),
        paneAdjust: rootState.ui.layout?.paneAdjust ?? 0,
        sessionPaneAdjust: rootState.ui.layout?.sessionPaneAdjust ?? 0,
        portalSessionColumnAdjust: rootState.ui.layout?.portalSessionColumnAdjust ?? 0,
        activityPaneAdjust: rootState.ui.layout?.activityPaneAdjust ?? 0,
        focusRegion: rootState.ui.focusRegion,
        inspectorTab: rootState.ui.inspectorTab,
        filesFullscreen: Boolean(rootState.files.fullscreen),
        selectedArtifactId: rootState.files.selectedArtifactId || null,
        adminVisible: Boolean(rootState.admin?.visible),
    }), shallowEqualObject);
    const profileSettingsHydratedRef = React.useRef(false);
    const lastProfileSettingsJsonRef = React.useRef(null);
    // Last-known value of the OTHER device class's chat-view slot. The save
    // endpoint replaces the whole settings object, so this is what keeps a
    // desktop save from erasing the phone's preference.
    const otherChatViewModeRef = React.useRef(null);
    const profileSettingsSaveTimerRef = React.useRef(null);
    const profileSettingsPollTimerRef = React.useRef(null);
    const profileSettingsPollInFlightRef = React.useRef(false);
    const profileSettingsSaveInFlightRef = React.useRef(false);
    const appliedProfileSettingsJsonRef = React.useRef(null);
    const defaultProfileSettingsRef = React.useRef(null);
    const [mobilePane, setMobilePane] = React.useState("workspace");
    const mobile = (viewport.width || window.innerWidth || 0) < MOBILE_BREAKPOINT;
    const readOnlyChatPane = state.activeSessionIsGroup || state.chatViewMode === "summary";
    const effectivePromptRows = readOnlyChatPane ? 0 : state.promptRows;

    useKeyboardShortcuts(controller, mobile);

    React.useEffect(() => {
        controller.setViewport(gridViewport);
    }, [controller, gridViewport.height, gridViewport.width]);

    React.useEffect(() => {
        let active = true;
        profileSettingsHydratedRef.current = false;
        lastProfileSettingsJsonRef.current = null;
        appliedProfileSettingsJsonRef.current = null;
        defaultProfileSettingsRef.current = buildDefaultProfileSettingsFromState(controller.getState());
        if (profileSettingsSaveTimerRef.current) {
            clearTimeout(profileSettingsSaveTimerRef.current);
            profileSettingsSaveTimerRef.current = null;
        }
        if (profileSettingsPollTimerRef.current) {
            clearInterval(profileSettingsPollTimerRef.current);
            profileSettingsPollTimerRef.current = null;
        }
        profileSettingsPollInFlightRef.current = false;
        profileSettingsSaveInFlightRef.current = false;

        const transport = controller.transport;
        if (typeof transport?.getCurrentUserProfile !== "function"
            || typeof transport?.setCurrentUserProfileSettings !== "function") {
            profileSettingsHydratedRef.current = true;
            return () => {
                active = false;
            };
        }

        const pollProfileSettings = async () => {
            if (!active || profileSettingsPollInFlightRef.current) return;
            profileSettingsPollInFlightRef.current = true;
            try {
                const profile = await transport.getCurrentUserProfile();
                if (!active) return;
                // Recompute the fallback defaults from CURRENT state each poll:
                // the principal is resolved by now (it was likely null at mount),
                // so the "no persisted filter" fallback becomes the correct
                // principal-scoped default (Me+System) instead of {all:true}.
                const remoteNormalized = normalizeProfileSettings(profile?.profileSettings);
                if (isChatViewMode(remoteNormalized[otherChatViewModeKey()])) {
                    otherChatViewModeRef.current = remoteNormalized[otherChatViewModeKey()];
                }
                defaultProfileSettingsRef.current = buildDefaultProfileSettingsFromState(
                    controller.getState(), otherChatViewModeRef.current,
                );
                const settings = materializeProfileSettings(
                    profile?.profileSettings,
                    defaultProfileSettingsRef.current,
                );
                const settingsJson = JSON.stringify(settings);
                const currentSettingsBeforeApply = profileSettingsFromViewState(
                    controller.getState(), otherChatViewModeRef.current,
                );
                const currentSettingsBeforeApplyJson = JSON.stringify(currentSettingsBeforeApply);
                const hasUnpersistedLocalChange = profileSettingsHydratedRef.current
                    && lastProfileSettingsJsonRef.current != null
                    && currentSettingsBeforeApplyJson !== lastProfileSettingsJsonRef.current;
                const hasPendingLocalWrite = Boolean(profileSettingsSaveTimerRef.current)
                    || profileSettingsSaveInFlightRef.current
                    || hasUnpersistedLocalChange;
                if (!hasPendingLocalWrite && appliedProfileSettingsJsonRef.current !== settingsJson) {
                    controller.dispatch({ type: "profileSettings/apply", settings });
                    appliedProfileSettingsJsonRef.current = settingsJson;
                }

                // lastProfileSettingsJson is what the SAVE effect diffs against
                // to decide whether anything needs writing. Refreshing it on
                // every poll made the poll adopt UNSAVED local state as if it
                // had been persisted: the save effect then saw no difference,
                // wrote nothing, and the next reload restored the older stored
                // value. That is how a fresh selection could take effect on
                // screen and still be lost on reload.
                //
                // So only re-baseline when this poll actually applied remote
                // settings, or on first hydration (where local state IS the
                // remote state by definition and there is nothing to lose).
                if (!profileSettingsHydratedRef.current || !hasPendingLocalWrite) {
                    const currentSettings = profileSettingsFromViewState(
                        controller.getState(), otherChatViewModeRef.current,
                    );
                    lastProfileSettingsJsonRef.current = JSON.stringify(currentSettings);
                }
                profileSettingsHydratedRef.current = true;
            } catch {
                if (!active) return;
                profileSettingsHydratedRef.current = true;
            } finally {
                profileSettingsPollInFlightRef.current = false;
            }
        };

        pollProfileSettings().catch(() => {});
        profileSettingsPollTimerRef.current = setInterval(() => {
            pollProfileSettings().catch(() => {});
        }, PROFILE_SETTINGS_POLL_MS);

        return () => {
            active = false;
            if (profileSettingsSaveTimerRef.current) {
                clearTimeout(profileSettingsSaveTimerRef.current);
                profileSettingsSaveTimerRef.current = null;
            }
            if (profileSettingsPollTimerRef.current) {
                clearInterval(profileSettingsPollTimerRef.current);
                profileSettingsPollTimerRef.current = null;
            }
            profileSettingsPollInFlightRef.current = false;
        };
    }, [controller]);

    React.useEffect(() => {
        if (!profileSettingsHydratedRef.current) return undefined;
        const settings = profileSettingsFromViewState(state, otherChatViewModeRef.current);
        const settingsJson = JSON.stringify(settings);
        if (lastProfileSettingsJsonRef.current === settingsJson) return undefined;
        lastProfileSettingsJsonRef.current = settingsJson;
        if (profileSettingsSaveTimerRef.current) {
            clearTimeout(profileSettingsSaveTimerRef.current);
        }
        profileSettingsSaveTimerRef.current = setTimeout(() => {
            profileSettingsSaveTimerRef.current = null;
            profileSettingsSaveInFlightRef.current = true;
            saveProfileSettings(controller, settings)
                .catch(() => {})
                .finally(() => {
                    profileSettingsSaveInFlightRef.current = false;
                });
        }, 400);
        return undefined;
    }, [controller, state.activeSessionId, state.activityPaneAdjust, state.chatViewMode, state.collapsedSessionIds, state.ownerFilter, state.paneAdjust, state.manualOrder, state.pinnedIds, state.portalSessionColumnAdjust, state.sessionPaneAdjust, state.themeId]);

    React.useEffect(() => {
        applyDocumentTheme(state.themeId);
    }, [state.themeId]);

    // Follow focus only on an actual TRANSITION, never on the first run.
    //
    // The default focus is "sessions", but the mobile layout has no sessions
    // region, so normalizeFocusRegion rewrites it to order[0] — the inspector.
    // Syncing that initial value made a plain page load open the inspector on
    // its default (sequence) tab instead of the chat. A real focus change, e.g.
    // tapping the mobile nav, still switches panes.
    const lastFocusRef = React.useRef(null);
    React.useEffect(() => {
        const previous = lastFocusRef.current;
        lastFocusRef.current = state.focusRegion;
        if (previous === null) return;
        if (previous === state.focusRegion) return;
        if (mobile && state.focusRegion !== "prompt") {
            setMobilePane(state.focusRegion === "activity"
                ? "activity"
                : state.focusRegion === "inspector"
                    ? "inspector"
                    : "workspace");
        }
    }, [mobile, state.focusRegion]);

    React.useEffect(() => {
        const visibleTabs = getVisibleInspectorTabs(controller);
        if (!visibleTabs.includes(state.inspectorTab) && visibleTabs.length > 0) {
            controller.selectInspectorTab(visibleTabs[0]).catch(() => {});
        }
    }, [controller, state.inspectorTab]);

    const layout = React.useMemo(
        () => computeLegacyLayout(gridViewport, state.paneAdjust, effectivePromptRows, state.sessionPaneAdjust, state.activityPaneAdjust),
        [gridViewport, state.activityPaneAdjust, state.paneAdjust, effectivePromptRows, state.sessionPaneAdjust],
    );
    const filesFullscreenActive = state.filesFullscreen && state.inspectorTab === "files";
    // Preview detaches into the activity slot only while the Files tab is open
    // AND something is selected — otherwise Activity keeps the slot. Fullscreen
    // is excluded because it already shows the preview alone.
    const artifactPreviewDetached = state.inspectorTab === "files"
        && Boolean(state.selectedArtifactId)
        && !filesFullscreenActive;

    React.useEffect(() => {
        if (!filesFullscreenActive || !chatFocusMode) return;
        setChatFocusMode(false);
        setChatFocusPane(null);
    }, [chatFocusMode, filesFullscreenActive]);

    const toggleChatFocusMode = React.useCallback(() => {
        setChatFocusMode((current) => {
            const next = !current;
            if (!next) {
                setChatFocusPane(null);
            } else {
                controller.setFocus("chat");
            }
            return next;
        });
    }, [controller]);

    const toggleChatFocusPane = React.useCallback((paneId) => {
        setChatFocusPane((current) => {
            const next = current === paneId ? null : paneId;
            controller.setFocus(next || "chat");
            return next;
        });
    }, [controller]);

    const estimatedMainGridWidth = Math.max(0, (viewport.width || 0) * 0.68);
    const measuredMainGridWidth = mainGridViewport.width || estimatedMainGridWidth;
    const sessionColumnWidth = portalSessionColumnWidth(measuredMainGridWidth, state.portalSessionColumnAdjust);
    const sessionColumnMode = portalSessionColumnMode(sessionColumnWidth);
    const sessionColumnTrack = sessionColumnMode === "hidden"
        ? "0px"
        : `clamp(0px, calc(${PORTAL_SESSION_COLUMN_RATIO * 100}% + ${Number(state.portalSessionColumnAdjust) || 0}px), max(0px, calc(100% - 14rem - 32px)))`;

    const desktopWorkspace = React.createElement("div", {
        className: "ps-workspace-grid",
        style: {
            gridTemplateColumns: `minmax(0, ${layout.leftWidth}fr) var(--ps-resizer-track, 16px) minmax(0, ${layout.rightWidth}fr)`,
        },
    },
    React.createElement("div", {
        ref: mainGridRef,
        className: `ps-workspace-main-grid is-session-${sessionColumnMode}`,
        style: {
            gridTemplateColumns: `${sessionColumnTrack} var(--ps-resizer-track, 16px) minmax(14rem, 1fr)`,
        },
    },
    sessionColumnMode !== "hidden" ? React.createElement("div", {
        className: "ps-workspace-pane-slot",
        style: { gridColumn: "1" },
    },
        React.createElement(SessionPane, { controller, structuredRows: true })) : null,
    React.createElement("div", {
        style: {
            gridColumn: "2",
            minWidth: 0,
            display: "flex",
        },
    },
        React.createElement(SessionColumnResizeHandle, { controller, portalSessionColumnAdjust: state.portalSessionColumnAdjust })),
    React.createElement("div", {
        className: "ps-workspace-pane-slot",
        style: { gridColumn: "3" },
    },
        React.createElement(ChatPane, { controller }))),
    React.createElement(ColumnResizeHandle, { controller, paneAdjust: state.paneAdjust }),
    React.createElement("div", {
        className: "ps-workspace-column",
        style: { gridTemplateRows: `${layout.inspectorPaneHeight}fr var(--ps-resizer-track, 16px) ${layout.activityPaneHeight}fr` },
    },
    React.createElement("div", {
        className: "ps-workspace-pane-slot",
        style: { gridRow: "1" },
    },
        !layout.inspectorHidden ? React.createElement(InspectorPane, { controller, mobile: false }) : null),
    React.createElement("div", {
        style: {
            gridRow: "2",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
        },
    },
        React.createElement(ActivityRowResizeHandle, { controller, activityPaneAdjust: state.activityPaneAdjust })),
    React.createElement("div", {
        className: "ps-workspace-pane-slot",
        style: { gridRow: "3" },
    },
        // The artifact preview takes over the activity slot while an artifact
        // is selected, so it inherits the row resizer and can be sized freely.
        // It yields back to Activity the moment the selection clears.
        artifactPreviewDetached
            ? React.createElement(FilesPane, { controller, focused: false, previewOnly: true })
            : (!layout.activityHidden ? React.createElement(ActivityPane, { controller }) : null))));
    const chatFocusWorkspace = React.createElement(ChatFocusWorkspace, {
        controller,
        openPane: chatFocusPane,
        onTogglePane: toggleChatFocusPane,
        onExitFocus: toggleChatFocusMode,
        mobile,
    });
    const fullscreenWorkspace = React.createElement("div", { className: "ps-workspace-full" },
        React.createElement(InspectorPane, { controller, mobile: false }));

    let mobileContent = null;
    // Mobile gets the overlay below instead of an in-pane fullscreen view; the
    // workspace keeps rendering underneath so backing out restores it intact.
    if (filesFullscreenActive && !mobile) mobileContent = React.createElement("div", { className: "ps-mobile-pane-fill" },
        React.createElement(InspectorPane, { controller, mobile: true }));
    // Node Map is the one inspector tab whose detail lives in ANOTHER pane: the
    // Activity pane doubles as worker details, and on desktop it sits directly
    // below the inspector, which is what the "details fill the pane below" hint
    // means. On a phone Activity is a separate bottom tab, so tapping a node
    // filled a pane you could not see. Stack them here instead — the node list
    // scrolls, the details sit under it.
    else if (mobilePane === "inspector") mobileContent = (state.inspectorTab === "nodes")
        ? React.createElement("div", { className: "ps-mobile-pane-fill ps-mobile-node-split" },
            React.createElement(InspectorPane, { controller, mobile: true }),
            React.createElement(ActivityPane, { controller, panelClassName: "ps-mobile-node-detail" }))
        : React.createElement("div", { className: "ps-mobile-pane-fill" },
            React.createElement(InspectorPane, { controller, mobile: true }));
    else if (mobilePane === "activity") mobileContent = React.createElement("div", { className: "ps-mobile-pane-fill" },
        React.createElement(ActivityPane, { controller }));
    else mobileContent = React.createElement(MobileWorkspace, { controller });

    return React.createElement(ControllerContext.Provider, { value: controller },
        React.createElement("div", { ref: viewportRef, className: "ps-web-shell" },
        // Hide the top toolbar on mobile inspector/activity panes (and in
        // chat-focus mode). Those panes are pure read-only surfaces;
        // session/model/theme actions stay reachable from the Main pane,
        // and dropping the toolbar buys ~3 lines of vertical real estate
        // on a phone, which matters for the fleet-skills card and the
        // logs/sequence inspectors.
        (mobile && (chatFocusMode || mobilePane === "inspector" || mobilePane === "activity"))
            ? null
            : React.createElement(Toolbar, {
            controller,
            mobile,
            chatFocusMode,
            onToggleChatFocus: toggleChatFocusMode,
            chatFocusDisabled: filesFullscreenActive,
        }),
        React.createElement("div", { className: "ps-workspace" },
            state.adminVisible
                ? React.createElement(AdminConsolePanel, { controller, mobile })
                : (filesFullscreenActive
                    ? fullscreenWorkspace
                    : (chatFocusMode
                        ? chatFocusWorkspace
                        : (mobile ? mobileContent : desktopWorkspace)))),
        mobile && !chatFocusMode ? React.createElement(MobileNav, { activePane: mobilePane, setActivePane: setMobilePane, controller }) : null,
        mobile && filesFullscreenActive
            ? React.createElement(MobileArtifactOverlay, { controller })
            : null,
        React.createElement(ModalLayer, { controller })));
}
