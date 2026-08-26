import React from "react";
// createPortal is only invoked when an IconButton tooltip renders (portal only,
// never in the TUI); the import itself is side-effect-free and react-dom is a
// dependency wherever this file loads, so it is safe in the shared module.
import { createPortal } from "react-dom";
import { appendAnimatedDotsToRuns, useAnimatedDots, useSpinnerFrame } from "./chat-status.js";
import {
    UI_COMMANDS,
    INSPECTOR_TABS,
    ARTIFACT_DOWNLOAD_HINT,
    appReducer,
    canStopSessionTurn,
    computeLegacyLayout,
    createInitialState,
    buildPortalLinks,
    formatPortalLinksForCopy,
    createStore,
    AUTO_HISTORY_EVENT_SOFT_CAP,
    formatCompactNumber,
    formatCronTimestampForClient,
    formatHumanDurationSeconds,
    getDiagnosticsSplitAdjustBounds,
    getPromptInputRows,
    getTheme,
    isThemeLight,
    normalizeStoredCanvasPrefs,
    parseTerminalMarkupRuns,
    PilotSwarmUiController,
    tokenizeInlineMarkdown,
    selectActivityPane,
    selectWorkerDetailsPane,
    selectAdminConsole,
    selectArtifactPickerModal,
    selectArtifactUploadModal,
    selectLiveActivityLines,
    selectChatLines,
    selectChatPaneChrome,
    selectOutboxOverlayLines,
    selectCanvasView,
    selectFileBrowserItems,
    selectFilesFilterModal,
    selectFilesScope,
    selectFilesView,
    selectHistoryFormatModal,
    selectInspector,
    selectLogFilterModal,
    selectModelPickerModal,
    selectNavigationError,
    selectProviderTable,
    selectReasoningEffortPickerModal,
    selectContextTierPickerModal,
    selectRenameSessionModal,
    selectSessionAgentPickerModal,
    selectSessionGroupNameModal,
    selectSessionGroupPickerModal,
    selectSessionOwnerFilterModal,
    selectSessionRows,
    selectSessionStatusSummary,
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
const ARTIFACT_LINK_COPIED_STATUS = "Artifact link copied to clipboard";
// Mirrors SESSION_NAV_SETTLE_MS in the controller: the access probe rides the
// same "wait for the selection to stop moving" rule as the session fetch.
const SESSION_ACCESS_SETTLE_MS = 140;
const SESSION_LINK_PRIVATE_WARNING = "Only people with access can open this link.";

function buildSessionLinkUrl(sessionId) {
    if (!sessionId || typeof window === "undefined" || !window.location) return null;
    return `${window.location.origin}${window.location.pathname}?session=${encodeURIComponent(sessionId)}`;
}

/**
 * Deep link straight to one artifact's preview: `?session=…&artifact=…&view=full`.
 *
 * This is also what "open in a new tab" navigates to. It deliberately does NOT
 * open the artifact's blob URL directly — a blob: document opened at top level
 * runs at the PORTAL's origin, which would hand untrusted artifact markup the
 * signed-in user's bearer token. Routing through the app keeps every byte of
 * artifact HTML inside the sandboxed iframe.
 */
function buildArtifactLinkUrl(sessionId, filename, { fullscreen = true } = {}) {
    const base = buildSessionLinkUrl(sessionId);
    if (!base || !filename) return base;
    return `${base}&artifact=${encodeURIComponent(filename)}${fullscreen ? "&view=full" : ""}`;
}

// Multi-origin link generation (PORTAL_LINK_ORIGINS): set once by the host
// app when the portal config lands. Empty = single-origin behavior. A module
// singleton, deliberately — links are produced from deep inside component
// trees and the origin list is global, immutable config.
let portalLinkOrigins = [];
export function setPortalLinkOrigins(list) {
    portalLinkOrigins = Array.isArray(list) ? list : [];
}
export function getPortalLinkOrigins() {
    return portalLinkOrigins;
}

function copySessionLinkText(url) {
    const text = formatPortalLinksForCopy(buildPortalLinks(url, portalLinkOrigins));
    if (navigator?.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
}

/**
 * One box per entry point, each independently copyable, plus a "Copy all"
 * that takes every labeled line at once.
 *
 * The single shared textarea this replaced forced the sender to hand over
 * both URLs even when they knew which network the recipient was on, and a
 * partial selection out of a monospace blob is fiddly. A sender who knows
 * copies one; a sender who doesn't copies all.
 *
 * Single-origin deployments render exactly one unlabeled row — no labels, no
 * Copy all, nothing to explain.
 */
function MultiOriginLinkRows({ url, keyPrefix, copied, onCopy }) {
    const links = buildPortalLinks(url, portalLinkOrigins);
    const selectOnFocus = (event) => event.currentTarget.select();
    if (links.length <= 1) {
        return React.createElement("div", { className: "ps-link-row" },
            React.createElement("input", {
                className: "ps-link-input", readOnly: true, value: url, onFocus: selectOnFocus,
            }),
            React.createElement("button", {
                type: "button", className: "ps-mini-button", onClick: () => onCopy(keyPrefix, url),
            }, copied === keyPrefix ? "Copied" : "Copy"));
    }
    const allKey = `${keyPrefix}:all`;
    return React.createElement("div", { className: "ps-link-origins" },
        links.map((link, index) => {
            const key = `${keyPrefix}:${index}`;
            return React.createElement("div", { className: "ps-link-origin", key },
                React.createElement("div", { className: "ps-link-origin-label" }, link.label),
                React.createElement("div", { className: "ps-link-row" },
                    React.createElement("input", {
                        className: "ps-link-input", readOnly: true, value: link.url,
                        "aria-label": `${link.label} link`, onFocus: selectOnFocus,
                    }),
                    React.createElement("button", {
                        type: "button", className: "ps-mini-button",
                        onClick: () => onCopy(key, link.url),
                    }, copied === key ? "Copied" : "Copy")));
        }),
        React.createElement("div", { className: "ps-link-copy-all" },
            React.createElement("button", {
                type: "button", className: "ps-mini-button",
                onClick: () => onCopy(allKey, formatPortalLinksForCopy(links)),
            }, copied === allKey ? "Copied all" : "Copy all")));
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
    if (typeof candidate.sessionDetailCollapsed === "boolean") {
        normalized.sessionDetailCollapsed = candidate.sessionDetailCollapsed;
    }
    if (typeof candidate.touchScale === "boolean") {
        normalized.touchScale = candidate.touchScale;
    }
    if (typeof candidate.touchScaleMobile === "boolean") {
        normalized.touchScaleMobile = candidate.touchScaleMobile;
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
    if (candidate.rightPaneMode === "canvas" || candidate.rightPaneMode === "panes") {
        normalized.rightPaneMode = candidate.rightPaneMode;
    }
    // The two independent desktop columns. This normalizer WHITELISTS keys, so
    // an unlisted one is dropped on the way to the server without a word —
    // which is exactly how a toggle looks like it never persisted.
    if (hasOwn(candidate, "desktopPanes") && candidate.desktopPanes && typeof candidate.desktopPanes === "object") {
        normalized.desktopPanes = {
            canvasOpen: candidate.desktopPanes.canvasOpen === true,
            diagnosticsOpen: candidate.desktopPanes.diagnosticsOpen === true,
            zen: candidate.desktopPanes.zen === true,
        };
    }
    if (hasOwn(candidate, "canvasPrefs")) {
        normalized.canvasPrefs = normalizeStoredCanvasPrefs(candidate.canvasPrefs);
    }
    // Phones and desktops keep SEPARATE view preferences: rich prose reads well
    // on a wide transcript and poorly in a 390px column, so a single shared
    // value would have each device overwriting the other's choice.
    return normalized;
}


/** True on phone-sized viewports — the device class that owns the mobile slot. */
function isNarrowViewport() {
    return typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia("(max-width: 920px)").matches;
}

/** Profile key this device reads and writes. */

/** The key belonging to the OTHER device class. */

/**
 * The "Mobile" (touch-scale) preference is per DEVICE CLASS:
 * it describes how big the type and hit targets should be on the screen you are
 * actually looking at, so turning it on from a phone must not scale up the
 * desktop. It is otherwise orthogonal to the theme — it lives in the theme
 * picker's footer only because that is the "how this looks" surface.
 *
 * Note the desktop slot keeps the legacy name `touchScale`, so profiles written
 * before the split keep working on desktop with no migration.
 */
function touchScaleKey() {
    return isNarrowViewport() ? "touchScaleMobile" : "touchScale";
}

/** The touch-scale key belonging to the OTHER device class. */
function otherTouchScaleKey() {
    return isNarrowViewport() ? "touchScale" : "touchScaleMobile";
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

function profileSettingsFromViewState(state, preservedOtherTouchScale = null, preservedRightPaneMode = null, preservedDesktopPanes = null) {
    return normalizeProfileSettings({
        themeId: state.themeId,
        [touchScaleKey()]: state.touchScale,
        sessionDetailCollapsed: state.sessionDetailCollapsed,
        sessionOwnerFilter: state.ownerFilter,
        layoutAdjustments: {
            paneAdjust: state.paneAdjust,
            sessionPaneAdjust: state.sessionPaneAdjust,
            portalSessionColumnAdjust: state.portalSessionColumnAdjust,
            activityPaneAdjust: state.activityPaneAdjust,
            canvasPaneAdjust: state.canvasPaneAdjust,
            diagnosticsPaneAdjust: state.diagnosticsPaneAdjust,
            diagnosticsSplitAdjust: state.diagnosticsSplitAdjust,
        },
        pinnedSessionIds: state.pinnedIds,
        sessionOrder: state.manualOrder,
        collapsedSessionIds: state.collapsedSessionIds,
        activeSessionId: state.activeSessionId,
        // rightPaneMode describes the DESKTOP right column; a phone has no
        // such column (its canvas surface is a nav tab), so a phone must not
        // write its own value — it preserves the last-known stored one, or a
        // desktop that flipped to canvas would be flipped back by the phone's
        // next save.
        //
        // desktopPanes replaces it and is preserved the same way, for the same
        // reason. rightPaneMode is still written so a rolled-back build reads
        // something sane.
        ...(isNarrowViewport()
            ? {
                ...(preservedRightPaneMode === "canvas" || preservedRightPaneMode === "panes"
                    ? { rightPaneMode: preservedRightPaneMode }
                    : {}),
                ...(preservedDesktopPanes && typeof preservedDesktopPanes === "object"
                    ? { desktopPanes: preservedDesktopPanes }
                    : {}),
            }
            : {
                rightPaneMode: state.canvasOpen ? "canvas" : "panes",
                desktopPanes: { canvasOpen: state.canvasOpen === true, diagnosticsOpen: state.diagnosticsOpen === true, zen: state.canvasZen === true },
            }),
        canvasPrefs: state.canvasPrefs,
        // setCurrentUserProfileSettings REPLACES the settings object, so the
        // other device class's slot has to be written back verbatim or saving
        // from a desktop would wipe the phone's preference (and vice versa).
        ...(typeof preservedOtherTouchScale === "boolean"
            ? { [otherTouchScaleKey()]: preservedOtherTouchScale }
            : {}),
    });
}

function buildDefaultProfileSettingsFromState(state, preservedOtherTouchScale = null, preservedRightPaneMode = null) {
    return normalizeProfileSettings({
        themeId: state?.ui?.themeId,
        [touchScaleKey()]: state?.ui?.touchScale,
        sessionDetailCollapsed: state?.ui?.sessionDetailCollapsed,
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
        ...(isNarrowViewport()
            ? (preservedRightPaneMode === "canvas" || preservedRightPaneMode === "panes"
                ? { rightPaneMode: preservedRightPaneMode }
                : {})
            : {
                rightPaneMode: state?.ui?.rightPaneMode,
                desktopPanes: {
                    canvasOpen: state?.ui?.canvasOpen === true,
                    diagnosticsOpen: state?.ui?.diagnosticsOpen === true,
                    zen: state?.ui?.canvasZen === true,
                },
            }),
        canvasPrefs: state?.canvas?.prefs,
        ...(typeof preservedOtherTouchScale === "boolean"
            ? { [otherTouchScaleKey()]: preservedOtherTouchScale }
            : {}),
    });
}

function materializeProfileSettings(remoteSettings, defaults) {
    const normalizedRemote = normalizeProfileSettings(remoteSettings);
    const normalizedDefaults = normalizeProfileSettings(defaults);
    // No-defaults rule for per-device and toggle-like fields: when the remote
    // profile lacks a key, do NOT synthesize a default — the poll runs every
    // few seconds, and a synthesized value would clobber a fresh local change
    // the server has not persisted yet. An omitted key leaves the
    // profileSettings/apply guards preserving the current value.
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
        // Canvas keys follow the same no-defaults rule: the poll must not
        // clobber a local flip/badge advance the server has not persisted yet.
        // An omitted key leaves the profileSettings/apply guards preserving
        // the current value.
        ...(hasOwn(normalizedRemote, "desktopPanes")
            ? { desktopPanes: normalizedRemote.desktopPanes }
            : {}),
        ...(hasOwn(normalizedRemote, "rightPaneMode")
            ? { rightPaneMode: normalizedRemote.rightPaneMode }
            : {}),
        ...(hasOwn(normalizedRemote, "canvasPrefs")
            ? { canvasPrefs: normalizedRemote.canvasPrefs }
            : {}),
        // touchScale was missing from this merge entirely, which is why the
        // "Mobile" checkbox never survived a reload: the save path wrote it,
        // but nothing ever read it back, and the reducer's hasTouchScale guard
        // then preserved the default. Same no-defaults rule —
        // synthesizing one here would let a poll clobber a fresh local toggle.
        ...(hasOwn(normalizedRemote, touchScaleKey())
            ? { touchScale: normalizedRemote[touchScaleKey()] }
            // Profiles written before the per-device split carry a single
            // `touchScale`, which IS the desktop key — so only a phone needs to
            // inherit it, and only until it saves a slot of its own.
            : (isNarrowViewport() && hasOwn(normalizedRemote, "touchScale")
                ? { touchScale: normalizedRemote.touchScale }
                : {})),
        // Read back for the same reason as touchScale above: written but never
        // merged means the fold state resets on every reload. No default here
        // either — absent must stay absent so a poll cannot overwrite a toggle
        // the person just made.
        ...(hasOwn(normalizedRemote, "sessionDetailCollapsed")
            ? { sessionDetailCollapsed: normalizedRemote.sessionDetailCollapsed }
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

/**
 * Below this, releasing a drag CLOSES the column rather than leaving a sliver.
 *
 * "Resized to 0 toggles it off" is the rule, but a pointer rarely lands on
 * exactly 0 — without a threshold you get a 3px column you cannot read, cannot
 * grab, and did not ask for. 120px is about the narrowest either column is
 * still useful at.
 */
const PORTAL_COLUMN_SNAP_CLOSED_PX = 120;

/** Width of the draggable track between the canvas and diagnostics columns. */
const PORTAL_COLUMN_RESIZER_PX = 16;

/**
 * The narrowest the canvas should OPEN at. Not a clamp — drag it smaller if
 * you like, or drag it away entirely.
 *
 * A canvas is a rendered page being looked at, so it needs enough width for a
 * normal document column. The inherited fr split left it near 200px.
 */
const PORTAL_CANVAS_MIN_PX = 480;

/**
 * Wide enough to OPEN the canvas by default on a first visit.
 *
 * Sessions and chat need roughly 224px + 500px to stay comfortable, and the
 * canvas wants PORTAL_CANVAS_MIN_PX beside them. 1440 clears that with room to
 * spare and is a real device width (a 14" MacBook, a 900p desktop), so the
 * common laptop gets a canvas and a small window does not get three cramped
 * columns.
 */
const PORTAL_CANVAS_DEFAULT_MIN_VIEWPORT_PX = 1440;

/**
 * Whether this profile has ever expressed a preference about the two columns.
 *
 * The width-based default must fire only in its absence: someone who CLOSED
 * the canvas has stored `{canvasOpen: false}`, which is a choice and reads
 * nothing like "unset". A legacy rightPaneMode counts too — it is the same
 * preference in the older shape.
 */
function hasStoredDesktopPanes(settings) {
    if (!settings || typeof settings !== "object") return false;
    if (settings.desktopPanes && typeof settings.desktopPanes === "object") return true;
    return settings.rightPaneMode === "canvas" || settings.rightPaneMode === "panes";
}

/**
 * The widths the two optional columns OPEN at, in pixels. 2:1 — the canvas is
 * the thing being looked at; diagnostics is a readout beside it.
 *
 * Pixels, not shares of the window, because of the rule the fr model broke:
 * when a column closes, the freed space goes to chat + sessions — never to
 * the surviving column. A pane owns its width; chat flexes.
 */
const PORTAL_CANVAS_COL_DEFAULT_PX = 640;
const PORTAL_DIAG_COL_DEFAULT_PX = 320;


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

function getPortalInspectorContentWidth(paneWidth, inspectorTab, mobile = false) {
    // The sequence view once reserved 3 extra columns here so that "content
    // that fits visually does not trip a cosmetic x-scrollbar". That was a
    // fudge for a real bug: every sequence line was padded to the full width,
    // including the final column whose trailing spaces align nothing, so with
    // white-space:pre the content box always measured exactly the pane width
    // and any rounding tipped it into a permanent scrollbar. The padding is now
    // trimmed at the source (see trimTrailingRunPad in ui-core selectors), so
    // the guard would only throw away 3 usable columns.
    //
    // A PHONE still needs a margin, for a different reason: the column count
    // is derived from an assumed character cell, and iOS Safari's monospace
    // fallback renders wider than the desktop's. A grid sized to the exact
    // pane there overflows by a chunk, and the reader meets a view scrolled
    // sideways with its timestamps and STATS header sliced off. Two columns of
    // slack absorb the metric difference.
    return Math.max(20, paneWidth - (mobile ? 6 : 4));
}

/**
 * The pane's own truth for content width, in character columns.
 *
 * Character-cell panes (chat code fences and tables, the sequence grid, the
 * stats boxes) were sized from the legacy TUI layout model's split of a
 * window-level probe — a model that knows nothing about the portal's
 * draggable grid columns, so its imagined pane widths drift arbitrarily far
 * from the real ones. Content rendered for the imagined width then spills
 * out of the real pane (sequence), arrives pre-sliced behind a sideways
 * scroll (stats), or wraps absurdly narrow (a JSON fence at ~19 columns).
 *
 * This hook measures the actual panel node: its content box, and a probe in
 * its own rendered line font (the same technique as the mobile inspector
 * clamp below, which proved the window-level probe "able to lie"). Returns
 * null until the first measurement lands — callers fall back to the legacy
 * width for that first paint. Re-measures on real size changes, trailing
 * debounced so a splitter drag re-wraps once at the end, not per tick.
 */
function useMeasuredPaneColumns({ slack = 1, debounceMs = 120 } = {}) {
    const [cols, setCols] = React.useState(null);
    const stateRef = React.useRef({ node: null, observer: null, timer: null, frame: null });
    const attachRef = React.useCallback((node) => {
        const st = stateRef.current;
        if (st.observer) { st.observer.disconnect(); st.observer = null; }
        if (st.timer) { window.clearTimeout(st.timer); st.timer = null; }
        if (st.frame) { cancelAnimationFrame(st.frame); st.frame = null; }
        st.node = node;
        if (!node || typeof window === "undefined" || typeof ResizeObserver === "undefined") return;
        const measure = () => {
            st.timer = null;
            if (st.node !== node || !node.isConnected) return;
            const target = node.querySelector(".ps-line") || node;
            const cs = window.getComputedStyle(target);
            const probe = document.createElement("span");
            probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;";
            probe.style.fontFamily = cs.fontFamily;
            probe.style.fontSize = cs.fontSize;
            probe.style.fontWeight = cs.fontWeight;
            probe.style.letterSpacing = cs.letterSpacing;
            probe.textContent = "0".repeat(100);
            node.appendChild(probe);
            const charWidth = (probe.getBoundingClientRect().width / 100) || 0;
            probe.remove();
            if (!(charWidth > 0)) return;
            const panelStyle = window.getComputedStyle(node);
            const contentPx = node.clientWidth
                - (parseFloat(panelStyle.paddingLeft) || 0)
                - (parseFloat(panelStyle.paddingRight) || 0);
            // A collapsed/hidden pane measures ~0; keep the last good value.
            if (!(contentPx > 50)) return;
            const next = Math.max(20, Math.floor(contentPx / charWidth) - slack);
            setCols((current) => (current === next ? current : next));
        };
        const schedule = () => {
            if (st.timer) window.clearTimeout(st.timer);
            st.timer = window.setTimeout(measure, debounceMs);
        };
        st.frame = requestAnimationFrame(measure);
        st.observer = new ResizeObserver(schedule);
        // content-box: a classic (non-overlay) vertical scrollbar appearing
        // shrinks the content box without touching the border box — observe
        // the box that actually bounds the text.
        try {
            st.observer.observe(node, { box: "content-box" });
        } catch {
            st.observer.observe(node);
        }
    }, [slack, debounceMs]);
    return [cols, attachRef];
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

function applyTouchScale(enabled) {
    if (typeof document === "undefined") return;
    // One attribute, one CSS block. Everything the scale touches — type ramp,
    // control padding, hit targets — is already expressed as a custom property
    // or a class the stylesheet owns, so this needs no per-component wiring.
    if (enabled) document.documentElement.dataset.psTouch = "1";
    else delete document.documentElement.dataset.psTouch;
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
        (runs || []).map((run, index, all) => {
            // The download hint trails the artifact link as its own run.
            const followsArtifactLink = index > 0 && Boolean(parseArtifactHref(all[index - 1]?.href));
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
            // for a patch you want to READ. They now render as a card that
            // opens the artifact reader.
            const artifactRef = parseArtifactHref(href);

            if (artifactRef) {
                return React.createElement(ArtifactLink, {
                    key: `${index}:${run.text || ""}`,
                    artifactRef,
                    style,
                });
            }

            const text = followsArtifactLink
                ? stripArtifactDownloadHint(run.text || "")
                : (run.text || "");
            if (followsArtifactLink && !text) return null;

            return isExternalHref
                ? React.createElement("a", {
                    key: `${index}:${run.text || ""}`,
                    className: "ps-md-link",
                    href,
                    target: "_blank",
                    rel: "noreferrer",
                    style,
                }, text)
                : React.createElement("span", {
                    key: `${index}:${run.text || ""}`,
                    style,
                }, text);
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
 * A canvas action is a button press inside the drawn page, not something the
 * viewer typed. Printing the raw `[canvas-action] {…}` JSON as a chat message
 * buries the conversation in plumbing, so it renders as one collapsed row —
 * the same affordance as a system notice — that opens to show the exact
 * payload the page sent.
 */
function CanvasActionLine({ line, theme }) {
    const payload = String(line?.canvasActionPayload || "").trim();
    const name = line?.canvasActionName || "action";
    const detail = String(line?.canvasActionDetail || "").trim();
    const time = String(line?.canvasActionTime || "").trim();
    return React.createElement("details", { className: "ps-system-notice ps-canvas-action" },
        React.createElement("summary", {
            className: "ps-system-notice-summary ps-canvas-action-summary",
            style: { color: resolveColor(theme, "gray") || "var(--ps-muted)" },
        },
        React.createElement("span", { className: "ps-canvas-action-tag" }, "canvas"),
        React.createElement("span", { className: "ps-system-notice-summary-text" },
            `${name}${detail ? ` — ${detail}` : ""}`),
        time ? React.createElement("span", { className: "ps-canvas-action-time" }, time) : null),
        payload
            ? React.createElement("div", { className: "ps-system-notice-body" },
                React.createElement("pre", { className: "ps-canvas-action-payload" }, payload))
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
    // Checked before `kind`: the canvas-action line carries runs for the TUI
    // but the portal renders it as its own collapsed row, not as those runs.
    if (line.canvasAction) {
        return React.createElement(CanvasActionLine, { line, theme });
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
// Artifacts are stored with whatever content type the uploader declared, and
// agents routinely write .svg as text/plain. A blob: URL carries its type
// straight to <img>, which renders nothing for a non-image type — so the
// extension is the fallback source of truth when the stored type is not one.
const IMAGE_MIME_BY_EXTENSION = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
};

function imageMimeFromFilename(filename) {
    const match = /\.([a-z0-9]+)$/i.exec(String(filename || ""));
    return match ? (IMAGE_MIME_BY_EXTENSION[match[1].toLowerCase()] || null) : null;
}

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

const HTML_ARTIFACT_RE = /\.(html?|xhtml)$/i;

/**
 * HTML-shaped artifacts, recognized by extension OR content type — the same
 * belt-and-braces rule the diff and tabular predicates use, because an agent
 * may write `text/html` bytes under a name we would not guess.
 */
function isHtmlArtifact(filename, contentType) {
    if (HTML_ARTIFACT_RE.test(String(filename || ""))) return true;
    return /^(text\/html|application\/xhtml\+xml)$/i.test(String(contentType || "").trim().split(";")[0]);
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

/**
 * Drop the TUI's "(press a to download)" tail that the shared link decorator
 * appends after an artifact link.
 *
 * It arrives as ordinary text immediately following the link, so it survives
 * into the portal where the key does not exist and download is the wrong verb
 * anyway — the card next to it opens a reader. Matched against the exported
 * constant rather than a second copy of the literal.
 */
function stripArtifactDownloadHint(text) {
    const value = String(text ?? "");
    if (value.startsWith(ARTIFACT_DOWNLOAD_HINT)) return value.slice(ARTIFACT_DOWNLOAD_HINT.length);
    // Leading whitespace already consumed by a preceding run/token.
    const trimmedHint = ARTIFACT_DOWNLOAD_HINT.trimStart();
    if (value.startsWith(trimmedHint)) return value.slice(trimmedHint.length);
    return value;
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

/**
 * Classify an artifact for display: what kind of thing it is, said in words a
 * reader recognizes rather than a file extension.
 *
 * HTML is called out as its own kind because it behaves differently from every
 * other artifact — it opens as a live rendered page rather than as text — and
 * the card should promise that before the click, not after.
 */
function describeArtifact(filename) {
    const name = String(filename || "");
    const ext = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] || "").toLowerCase();
    if (isHtmlArtifact(name)) return { kind: "page", type: "HTML", noun: "Page" };
    if (isDiffArtifact(name)) return { kind: "diff", type: ext.toUpperCase() || "DIFF", noun: "Diff" };
    if (IMAGE_FILENAME_RE.test(name)) return { kind: "image", type: ext.toUpperCase(), noun: "Image" };
    if (isTabularArtifact(name)) return { kind: "table", type: ext.toUpperCase(), noun: "Table" };
    if (/\.md$/i.test(name)) return { kind: "doc", type: "MD", noun: "Document" };
    if (codeLanguageForArtifact(name)) return { kind: "code", type: ext.toUpperCase(), noun: "Code" };
    return { kind: "file", type: ext.toUpperCase() || "FILE", noun: "File" };
}

/**
 * A filename read as a title: drop the extension, drop a trailing date stamp,
 * and turn separators into spaces. `icm-pg-outage-chain-20260805.html` reads as
 * "Icm pg outage chain" — the same move a document viewer makes, because the
 * card is a thing you recognize at a glance, not a path you retype.
 */
function artifactCardTitle(filename) {
    const base = String(filename || "").replace(/\.[A-Za-z0-9]+$/, "");
    const undated = base.replace(/[-_ ]?\d{6,8}$/, "");
    const words = (undated || base).replace(/[-_]+/g, " ").trim();
    if (!words) return String(filename || "Artifact");
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Per-kind mark for the card's thumbnail. Inline SVG so it inherits color. */
function ArtifactCardGlyph({ kind }) {
    const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" };
    const inner = kind === "page"
        // A browser window: what you get is a rendered page, not a file.
        ? [
            React.createElement("rect", { key: "w", x: 2.5, y: 3.5, width: 15, height: 13, rx: 2, ...stroke }),
            React.createElement("path", { key: "b", d: "M2.5 7.5h15", ...stroke }),
            React.createElement("circle", { key: "d", cx: 5.2, cy: 5.5, r: 0.7, fill: "currentColor", stroke: "none" }),
        ]
        : kind === "image"
            ? [
                React.createElement("rect", { key: "f", x: 2.5, y: 3.5, width: 15, height: 13, rx: 2, ...stroke }),
                React.createElement("path", { key: "m", d: "M2.5 13l4-4 4 3.5 3-2.5 3.5 3", ...stroke }),
            ]
            : kind === "table"
                ? [
                    React.createElement("rect", { key: "f", x: 2.5, y: 3.5, width: 15, height: 13, rx: 2, ...stroke }),
                    React.createElement("path", { key: "g", d: "M2.5 8h15M8 8v8.5M2.5 12.5h15", ...stroke }),
                ]
                : [
                    // Document: a page with a folded corner and text lines.
                    React.createElement("path", { key: "p", d: "M5 2.5h6.5L16 7v10.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z", ...stroke }),
                    React.createElement("path", { key: "c", d: "M11.5 2.5V7H16", ...stroke }),
                    kind === "diff"
                        ? React.createElement("path", { key: "t", d: "M7 11h6M10 8.5v5", ...stroke })
                        : React.createElement("path", { key: "t", d: "M7 10.5h6M7 13.5h4", ...stroke }),
                ];
    return React.createElement("svg", {
        className: "ps-artifact-card-glyph",
        viewBox: "0 0 20 20",
        "aria-hidden": "true",
    }, inner);
}

/**
 * An artifact in the transcript, as a card rather than a link.
 *
 * The old inline link was a coloured filename followed by "(press a to
 * download)" — a keystroke that does not exist in a browser, describing the
 * wrong verb for something you want to read. A card names the thing, says what
 * kind it is, and opens the reader on click.
 */
function ArtifactLink({ artifactRef }) {
    const controller = React.useContext(ControllerContext);
    const descriptor = describeArtifact(artifactRef.filename);
    const onOpen = React.useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        openArtifactFromChat(controller, artifactRef.sessionId, artifactRef.filename);
    }, [controller, artifactRef.sessionId, artifactRef.filename]);

    // Deliberately NOT given the surrounding run's inline style. That style
    // carries the link colour and underline the transcript uses for inline
    // links, and inheriting it painted the card's title as underlined accent
    // text — a card is a surface, not a phrase.
    return React.createElement("button", {
        type: "button",
        className: `ps-artifact-card is-${descriptor.kind}`,
        onClick: onOpen,
        title: `Open ${artifactRef.filename}`,
    },
    React.createElement("span", { className: "ps-artifact-card-thumb", "aria-hidden": "true" },
        React.createElement(ArtifactCardGlyph, { kind: descriptor.kind })),
    React.createElement("span", { className: "ps-artifact-card-text" },
        React.createElement("span", { className: "ps-artifact-card-title" }, artifactCardTitle(artifactRef.filename)),
        React.createElement("span", { className: "ps-artifact-card-meta" }, `${descriptor.noun} · ${descriptor.type}`)),
    React.createElement("span", { className: "ps-artifact-card-open" }, "Open"));
}

/**
 * Open an artifact from the transcript.
 *
 * Desktop gets the takeover pane — the chat stays visible beside it, which is
 * the whole point of following a link from a conversation. A phone has no room
 * for two things at once and keeps the full-viewport overlay.
 */
function openArtifactFromChat(controller, sessionId, filename) {
    if (!controller?.revealArtifact) return;
    const isPhone = typeof window !== "undefined"
        && typeof window.matchMedia === "function"
        && window.matchMedia("(max-width: 920px)").matches;
    // Whether ✕ hands the column back or collapses it again is decided inside
    // revealArtifact, from the layout it can already see.
    Promise.resolve(isPhone
        ? controller.revealArtifact(sessionId, filename, { fullscreen: true })
        : controller.revealArtifact(sessionId, filename, { pane: true })).catch(() => {});
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
    const tokens = tokenizeInlineMarkdown(source);
    return tokens.map((token, index) => {
        const key = `${keyPrefix}:${index}`;
        // The shared decorator appends the TUI's download hint as plain text
        // right after the artifact link; the portal drops it.
        if (index > 0 && tokens[index - 1]?.type === "link" && parseArtifactHref(tokens[index - 1]?.href)) {
            const stripped = stripArtifactDownloadHint(token.text || "");
            if (!stripped) return null;
            if (stripped !== token.text) token = { ...token, text: stripped };
        }
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
                return React.createElement(ArtifactLink, { key, artifactRef });
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
                    // Click-through goes to the artifact deep link, NOT to the
                    // blob URL. A blob: document opened at top level runs at
                    // the portal's own origin, and IMAGE_FILENAME_RE admits
                    // .svg — an SVG is a scriptable document, so opening one
                    // that way would execute artifact-authored script with
                    // access to the signed-in user's token. Rendering it in
                    // <img> (below) is safe; navigating to it is not.
                    onClick: () => {
                        const target = buildArtifactLinkUrl(sessionId, filename);
                        if (!target) return;
                        try { window.open(target, "_blank", "noopener"); } catch { /* popup blocked */ }
                    },
                })
                : React.createElement("p", { className: "ps-binary-preview-copy" },
                    isRasterImage
                        ? (imageUrl === "error" ? "Could not load the image preview. Use Download to save the file." : "Loading image preview…")
                        : "Preview is intentionally disabled for non-text artifacts in the browser workspace. Use Download to save the file and open it in the default app.")));
}

/**
 * Full-fidelity HTML artifact preview.
 *
 * Two things make this different from every other preview branch:
 *
 * 1. It renders from the DOWNLOAD stream, not `previewContent`. The text
 *    preview pipeline truncates at FILE_PREVIEW_CHAR_LIMIT (200k chars), so a
 *    real agent-built dashboard is routinely cut off mid-document. "Full
 *    fidelity" has to mean all of the bytes.
 *
 * 2. The document runs its own scripts, inside a sandbox with NO
 *    `allow-same-origin`. That combination is the whole security model here:
 *    blob: URLs inherit the origin of whoever created them, so withholding
 *    allow-same-origin is what forces the frame into an opaque origin. The
 *    artifact's tooltips, SVG interactions and layout scripts all work; its
 *    script cannot read the portal's localStorage, cookies, bearer token, or
 *    reach across into the parent DOM. Popups are allowed so external links
 *    still work; forms and top-level navigation are not.
 */
/**
 * Re-run a rendered artifact's layout when the frame's width changes.
 *
 * Agent-authored HTML routinely computes geometry ONCE at load — this
 * dashboard measures the container and writes absolute SVG coordinates, with
 * no resize listener anywhere in it. Widening the pane reflowed its CSS grid
 * (media queries need no script) but left the graph drawn for the old width,
 * with three columns stacked on top of each other.
 *
 * Nothing can be fixed from out here: the frame is deliberately opaque-origin,
 * so we cannot call into it, read its scroll position, or re-run its init. The
 * one lever that works from outside is making the document load again at the
 * new size — a remount, which re-executes the same blob with no refetch.
 *
 * So: debounce until the drag settles, ignore trivial jitter, and never fire
 * on the initial measurement. That costs one reload per resize gesture, and it
 * does lose scroll position — unavoidable across an opaque origin, and the
 * alternative is a picture that is simply wrong at the size the user chose.
 */
const HTML_PREVIEW_RESIZE_SETTLE_MS = 260;
// Comfortably wider than a scrollbar. A reload changes the document's height,
// which can add or remove the frame's vertical scrollbar, which changes the
// host's width by ~15px — enough to clear a smaller threshold and schedule
// another reload, which toggles the scrollbar back. That loop is what made the
// panel appear to redraw continuously; measuring against the last COMMITTED
// width (below) closes it, and the wider band keeps it shut.
const HTML_PREVIEW_RESIZE_MIN_DELTA_PX = 28;

/**
 * Reload the rendered frame when the pane's width settles, double-buffered.
 *
 * Two rules keep this from being visible:
 *
 *  - Compare against the width the CURRENT document was rendered at, not the
 *    last width observed. Otherwise every intermediate measurement becomes a
 *    new baseline and the scrollbar feedback loop above never terminates.
 *  - Load the replacement behind the one on screen and swap on its `load`
 *    event. A remounted iframe is blank while it loads, and a blank frame
 *    paints its background — white, so a light-assuming document is readable —
 *    which is exactly the flash. Nothing is ever swapped in unpainted.
 *
 * Returns the two nonces the caller renders: `live` is on screen, `pending` is
 * loading behind it. Both use the same element key across promotion so React
 * reuses the element instead of remounting it (which would reload it again).
 */
function useHtmlPreviewReload(elementRef, enabled, resetKey, relayoutKey) {
    const [live, setLive] = React.useState(null);
    const [pending, setPending] = React.useState(0);
    const committedWidthRef = React.useRef(null);
    const nonceRef = React.useRef(0);

    // A different artifact is a different document: drop what is on screen and
    // stage the new one, so the old page is never shown under a new title.
    React.useEffect(() => {
        committedWidthRef.current = null;
        nonceRef.current += 1;
        setLive(null);
        setPending(nonceRef.current);
    }, [resetKey]);

    // Zoom changes the frame's LAYOUT width (see the width/transform pair in
    // the stylesheet), so a document that computed its geometry once is just
    // as stale after zooming as after a drag. Stage a replacement — but keep
    // the current one on screen, unlike resetKey above, because this is the
    // same document at a new size rather than a different one.
    const firstRelayout = React.useRef(true);
    React.useEffect(() => {
        if (firstRelayout.current) { firstRelayout.current = false; return; }
        if (!enabled) return;
        committedWidthRef.current = null;
        nonceRef.current += 1;
        setPending(nonceRef.current);
    }, [relayoutKey, enabled]);

    React.useEffect(() => {
        const node = elementRef.current;
        if (!enabled || !node || typeof ResizeObserver === "undefined") return undefined;
        let timer = null;
        const observer = new ResizeObserver((entries) => {
            const width = Math.round(entries[0]?.contentRect?.width || 0);
            if (!width) return;
            if (committedWidthRef.current === null) {
                committedWidthRef.current = width;
                return;
            }
            if (Math.abs(width - committedWidthRef.current) < HTML_PREVIEW_RESIZE_MIN_DELTA_PX) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                // Commit the width as of the moment we decide to reload, so the
                // next comparison is against what the new document will render
                // at rather than against a mid-drag sample.
                committedWidthRef.current = Math.round(node.getBoundingClientRect().width) || width;
                nonceRef.current += 1;
                setPending(nonceRef.current);
            }, HTML_PREVIEW_RESIZE_SETTLE_MS);
        });
        observer.observe(node);
        return () => {
            if (timer) clearTimeout(timer);
            observer.disconnect();
        };
    }, [elementRef, enabled]);

    // `load` means the document finished loading, NOT that it finished
    // painting. Promoting on the load event alone swapped in a frame the
    // compositor had not drawn yet, so the white background showed through for
    // a beat. Two frames of slack is enough for the paint to land, and it is
    // invisible next to the reload it follows.
    const promote = React.useCallback((nonce) => {
        const swap = () => {
            setPending((current) => (current === nonce ? null : current));
            setLive((current) => (current === nonce ? current : nonce));
        };
        if (typeof requestAnimationFrame !== "function") { swap(); return; }
        requestAnimationFrame(() => requestAnimationFrame(swap));
    }, []);

    return { live, pending, promote };
}

/**
 * Width the frame LAYS OUT at while fitting, before being scaled down.
 *
 * It has to be a constant: the frame is sandboxed without `allow-same-origin`,
 * so the document's real content width is unreadable from here — there is no
 * contentDocument to measure. 1024 is the width a fixed-layout page is most
 * likely to have been written for, and a responsive one reflows to it happily.
 */
const HTML_PREVIEW_FIT_LAYOUT_WIDTH_PX = 1024;

/** Fit-to-width switch. Rendered by whichever surface owns the artifact bar. */
function HtmlFitWidthToggle({ fitWidth, setFitWidth }) {
    return React.createElement(IconButton, {
        icon: fitWidth ? "1:1" : "⤢",
        label: fitWidth ? "Actual size" : "Fit page to width",
        active: fitWidth,
        onClick: () => setFitWidth(!fitWidth),
    });
}

const HTML_ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/**
 * Zoom for the rendered artifact ONLY.
 *
 * Browser zoom scales the entire workspace — the session list and the
 * transcript along with it — when the thing you actually wanted to read
 * larger is one dense chart. This moves the artifact and leaves the interface
 * around it alone.
 */
function HtmlZoomControl({ zoom, setZoom }) {
    const step = (direction) => {
        const index = HTML_ZOOM_STEPS.findIndex((value) => Math.abs(value - zoom) < 0.005);
        const from = index === -1 ? HTML_ZOOM_STEPS.indexOf(1) : index;
        const next = HTML_ZOOM_STEPS[Math.min(HTML_ZOOM_STEPS.length - 1, Math.max(0, from + direction))];
        setZoom(next);
    };
    return React.createElement("span", { className: "ps-html-zoom", role: "group", "aria-label": "Artifact zoom" },
        React.createElement("button", {
            type: "button",
            className: "ps-html-zoom-btn",
            onClick: () => step(-1),
            disabled: zoom <= HTML_ZOOM_STEPS[0] + 0.001,
            title: "Zoom out (artifact only)",
            "aria-label": "Zoom out",
        }, "−"),
        // Doubles as reset — the fastest way back from an exploratory zoom.
        React.createElement("button", {
            type: "button",
            className: "ps-html-zoom-level",
            onClick: () => setZoom(1),
            title: "Reset zoom to 100%",
            "aria-label": `Zoom ${Math.round(zoom * 100)} percent, click to reset`,
        }, `${Math.round(zoom * 100)}%`),
        React.createElement("button", {
            type: "button",
            className: "ps-html-zoom-btn",
            onClick: () => step(1),
            disabled: zoom >= HTML_ZOOM_STEPS[HTML_ZOOM_STEPS.length - 1] - 0.001,
            title: "Zoom in (artifact only)",
            "aria-label": "Zoom in",
        }, "+"));
}

/** Rendered-page vs. HTML-source switch. Shared by the Files tab and the reader. */
function HtmlViewModeToggle({ mode, setMode }) {
    return React.createElement("span", {
        className: "ps-html-preview-modes",
        role: "group",
        "aria-label": "Preview mode",
    }, ["rendered", "source"].map((value) => React.createElement("button", {
        key: value,
        type: "button",
        className: `ps-html-preview-mode${mode === value ? " is-active" : ""}`,
        "aria-pressed": mode === value,
        onClick: () => setMode(value),
    }, value === "rendered" ? "Rendered" : "Source")));
}

function useElementBox(ref) {
    const [box, setBox] = React.useState({ width: 0, height: 0 });
    React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node || typeof ResizeObserver === "undefined") return undefined;
        const update = () => {
            const rect = node.getBoundingClientRect();
            setBox((current) => {
                const width = Math.round(rect.width) || 0;
                const height = Math.round(rect.height) || 0;
                return current.width === width && current.height === height
                    ? current
                    : { width, height };
            });
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(node);
        return () => observer.disconnect();
    }, [ref]);
    return box;
}

function fetchArtifactHtmlObjectUrl(controller, sessionId, filename) {
    const downloadResponse = controller?.transport?.api?.downloadArtifactResponse;
    if (typeof downloadResponse !== "function") {
        return Promise.reject(new Error("artifact download unavailable"));
    }
    return downloadResponse.call(controller.transport.api, sessionId, filename)
        .then(async (response) => {
            if (!response?.ok) throw new Error(`download failed (${response?.status})`);
            // Re-type the blob explicitly rather than trusting the response's
            // content-type. An artifact stored as application/octet-stream
            // would otherwise make the iframe offer a download instead of
            // rendering, and a missing charset would mojibake UTF-8 content.
            const bytes = await response.arrayBuffer();
            return URL.createObjectURL(new Blob([bytes], { type: "text/html;charset=utf-8" }));
        });
}

function HtmlArtifactPreviewPanel({
    controller, sessionId, filename, contentType, sizeBytes, theme,
    color = "cyan", focused = false, title = null, chromeless = false,
}) {
    // Mode lives in controller state so the reader pane's header can own the
    // toggle. Inside the Files tab this panel still draws its own.
    const mode = useControllerSelector(controller, (state) => state.files.htmlViewMode || "rendered");
    const setMode = React.useCallback((next) => {
        controller.dispatch({ type: "files/htmlViewMode", mode: next });
    }, [controller]);
    const [frameUrl, setFrameUrl] = React.useState(null);
    const [error, setError] = React.useState(null);
    // Measured on the wrapper, not the iframe: an iframe being remounted is
    // briefly absent, and observing an element that disappears would drop the
    // baseline and re-fire on the way back.
    const frameHostRef = React.useRef(null);
    const fitWidth = useControllerSelector(controller, (state) => Boolean(state.files.htmlFitWidth));
    const setFitWidth = React.useCallback((next) => {
        controller.dispatch({ type: "files/htmlFitWidth", enabled: next });
    }, [controller]);
    const hostBox = useElementBox(frameHostRef);
    // Only ever scale DOWN. When the pane is already wider than the layout
    // width there is nothing to fit, and blowing the page up to fill it would
    // just make a responsive document coarse.
    const fitScale = fitWidth && hostBox.width > 0 && hostBox.width < HTML_PREVIEW_FIT_LAYOUT_WIDTH_PX
        ? hostBox.width / HTML_PREVIEW_FIT_LAYOUT_WIDTH_PX
        : 1;
    const fitActive = fitScale < 1;
    // Zoom composes with fit rather than competing with it: fit chooses the
    // base scale that shows the whole width, zoom moves from there. At
    // zoom 1 with fit off, neither touches the frame at all.
    const zoom = useControllerSelector(controller, (state) => Number(state.files.htmlZoom) || 1);
    const setZoom = React.useCallback((next) => {
        controller.dispatch({ type: "files/htmlZoom", zoom: next });
    }, [controller]);
    const renderScale = fitActive ? fitScale * zoom : zoom;
    // While fitting, the frame's own width is pinned to the layout constant, so
    // a pane resize changes only the SCALE — the document does not need to be
    // reloaded, and reloading would cost the reader their scroll position on
    // something as ordinary as rotating the phone.
    const frames = useHtmlPreviewReload(frameHostRef, mode === "rendered" && !fitActive, `${sessionId}/${filename}`, zoom);

    // The object URL is owned by this component — created on mount, revoked on
    // unmount or artifact change. It deliberately does not share the thumbnail
    // LRU: that cache revokes at its cap, which would blank a frame the user
    // is still reading.
    React.useEffect(() => {
        setFrameUrl(null);
        setError(null);
        if (mode !== "rendered" || !controller || !sessionId || !filename) return undefined;
        let cancelled = false;
        let created = null;
        fetchArtifactHtmlObjectUrl(controller, sessionId, filename)
            .then((url) => {
                created = url;
                if (cancelled) {
                    URL.revokeObjectURL(url);
                    return;
                }
                setFrameUrl(url);
            })
            .catch((err) => { if (!cancelled) setError(err?.message || String(err)); });
        return () => {
            cancelled = true;
            if (created) URL.revokeObjectURL(created);
        };
    }, [controller, sessionId, filename, mode]);

    const deepLink = buildArtifactLinkUrl(sessionId, filename);
    const actions = chromeless ? null : React.createElement(React.Fragment, null,
        React.createElement(HtmlViewModeToggle, { mode, setMode }),
        mode === "rendered"
            ? React.createElement(HtmlFitWidthToggle, { fitWidth, setFitWidth })
            : null,
        mode === "rendered"
            ? React.createElement(HtmlZoomControl, { zoom, setZoom })
            : null,
        deepLink
            ? React.createElement(IconButton, {
                icon: "↗",
                label: "Open in a new tab",
                onClick: () => { try { window.open(deepLink, "_blank", "noopener"); } catch { /* popup blocked */ } },
            })
            : null);

    const body = mode === "source"
        ? React.createElement(HtmlArtifactSourcePanel, { controller, sessionId, filename, theme })
        : error
            ? React.createElement("div", { className: "ps-html-preview-status" },
                React.createElement("p", null, `Could not load ${filename}: ${error}`),
                React.createElement("p", null, "Use Download to save the file and open it locally."))
            : frameUrl
                // Live and pending are rendered together while a reload is in
                // flight; the pending one is offscreen-transparent until its
                // load fires. Keys are `frame:<nonce>` in BOTH roles so
                // promotion is a class change, not a remount — remounting
                // would reload the document we just finished loading.
                ? [frames.live, frames.pending]
                    .filter((nonce, index, all) => nonce !== null && all.indexOf(nonce) === index)
                    .map((nonce) => React.createElement("iframe", {
                        key: `frame:${nonce}`,
                        className: `ps-html-preview-frame${nonce === frames.live ? "" : " is-staging"}`,
                        // A transform does not change the layout box, so the
                        // frame is laid out at the full layout width and a
                        // proportionally TALLER height, then scaled back into
                        // the host. Height in layout px, not %, because a
                        // percentage would resolve against a flex parent whose
                        // definite height is not guaranteed.
                        style: fitActive
                            ? {
                                flex: "none",
                                width: `${HTML_PREVIEW_FIT_LAYOUT_WIDTH_PX}px`,
                                height: `${Math.max(1, Math.round(hostBox.height / renderScale))}px`,
                                transform: `scale(${renderScale})`,
                                transformOrigin: "top left",
                            }
                            // Zoom without fit takes the other route: shrink the
                            // frame's LAYOUT box by the zoom factor and scale it
                            // back up, so the document reflows at the zoomed size
                            // instead of being magnified as a flat picture.
                            : zoom !== 1 && hostBox.width > 0
                                ? {
                                    flex: "none",
                                    width: `${Math.max(1, Math.round(hostBox.width / zoom))}px`,
                                    height: `${Math.max(1, Math.round(hostBox.height / zoom))}px`,
                                    transform: `scale(${zoom})`,
                                    transformOrigin: "top left",
                                }
                                : undefined,
                        src: frameUrl,
                        title: filename || "HTML artifact",
                        // No allow-same-origin — see the block comment above.
                        sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox",
                        // Opaque origin ≠ "self", so the autoplay policy would
                        // silently mute an interactive artifact (same fix the
                        // canvas frame carries).
                        allow: "autoplay *",
                        referrerPolicy: "no-referrer",
                        onLoad: () => frames.promote(nonce),
                    }))
                : React.createElement("div", { className: "ps-html-preview-status" },
                    React.createElement("p", null, `Rendering ${filename}…`),
                    sizeBytes != null
                        ? React.createElement("p", { className: "ps-html-preview-meta" },
                            [contentType, formatArtifactPreviewBytes(sizeBytes)].filter(Boolean).join("  •  "))
                        : null);

    // The measured host wraps the rendered branch only — in Source mode there
    // is no document whose layout could go stale, so nothing observes width.
    const hosted = mode === "rendered"
        ? React.createElement("div", {
            ref: frameHostRef,
            // The frame's layout box stays HTML_PREVIEW_FIT_LAYOUT_WIDTH_PX wide
            // while fitting; without clipping, that overflow would hand the host
            // a horizontal scrollbar for content that is already fully visible.
            className: `ps-html-preview-host${fitActive || zoom !== 1 ? " is-fitting" : ""}`,
        }, body)
        : body;

    return React.createElement(Panel, { title, color, focused, theme, actions, className: "ps-html-preview" }, hosted);
}

/**
 * Source view for an HTML artifact — highlighted, and fetched in full rather
 * than reusing the 200k-truncated preview text, so toggling Rendered→Source
 * does not silently lose two thirds of a large document.
 */
function HtmlArtifactSourcePanel({ controller, sessionId, filename, theme }) {
    const [text, setText] = React.useState(null);
    const [error, setError] = React.useState(null);
    React.useEffect(() => {
        setText(null);
        setError(null);
        const downloadResponse = controller?.transport?.api?.downloadArtifactResponse;
        if (typeof downloadResponse !== "function" || !sessionId || !filename) {
            setError("artifact download unavailable");
            return undefined;
        }
        let cancelled = false;
        downloadResponse.call(controller.transport.api, sessionId, filename)
            .then(async (response) => {
                if (!response?.ok) throw new Error(`download failed (${response?.status})`);
                return response.text();
            })
            .then((value) => { if (!cancelled) setText(value); })
            .catch((err) => { if (!cancelled) setError(err?.message || String(err)); });
        return () => { cancelled = true; };
    }, [controller, sessionId, filename]);

    if (error) {
        return React.createElement("div", { className: "ps-html-preview-status" },
            React.createElement("p", null, `Could not load source: ${error}`));
    }
    if (text == null) {
        return React.createElement("div", { className: "ps-html-preview-status" },
            React.createElement("p", null, "Loading source…"));
    }
    return React.createElement("div", { className: "ps-scroll-panel is-preview ps-diff-preview" },
        React.createElement("pre", { className: "ps-md-code-pre" },
            React.createElement("code", null, renderHighlightedCode(text, "html", theme))));
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
    // canvasUpdate-flagged lines are the TUI's affordance (an artifact link
    // for a host that cannot render the canvas). In the browser the canvas
    // pane updating IS the signal, so the chat skips them outright — desktop
    // and mobile share this renderer, so one filter covers both.
    //
    // canvasAction lines are NOT skipped: pressing a button in the drawn page
    // is a real thing the viewer did, and dropping it leaves an unexplained
    // gap before the agent's reply. Line renders it as one collapsed row.
    const blocks = React.useMemo(
        () => parseStructuredChatBlocks((lines || []).filter((line) => !line?.canvasUpdate)),
        [lines],
    );
    return React.createElement(StructuredBlockList, { blocks, theme, controller });
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
            // Re-type from the extension when the stored content type is not an
            // image one. This is what made an agent-written bar_chart.svg
            // (uploaded as text/plain) render as a broken-image glyph: the blob
            // inherited text/plain and <img> will not paint that. Re-typing does
            // NOT widen the SVG-script exposure the block below guards against —
            // <img> never runs script in an SVG regardless of how it is typed,
            // and the click-through still goes to the artifact deep link.
            const imageMime = imageMimeFromFilename(filename);
            const typedBlob = imageMime && !IMAGE_CONTENT_TYPE_RE.test(blob.type)
                ? new Blob([blob], { type: imageMime })
                : blob;
            return URL.createObjectURL(typedBlob);
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

function ScrollLinesPanel({ title, titleRight = null, color, focused, actions, lines, stickyLines = [], bottomStickyLines = [], scrollOffset = 0, scrollMode = "top", paneKey, controller, className = "", panelClassName = "", topContent = null, bottomContent = null, structuredBlocks = false, stickyBottom = false, renderBody = null, focusRegion = null, panelRef = null }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const ref = React.useRef(null);
    // Mirror the scroll-panel node into the caller's ref too (panes measure
    // their own content width from it — see useMeasuredPaneColumns).
    const setPanelNode = React.useCallback((node) => {
        ref.current = node;
        if (typeof panelRef === "function") panelRef(node);
        else if (panelRef) panelRef.current = node;
    }, [panelRef]);
    const stickyRef = React.useRef(null);
    const syncingHorizontalRef = React.useRef(false);
    const { normalizedLines, onScroll, onWheel, onTouchStart, onTouchMove, onTouchEnd } = useScrollSync(ref, lines, scrollOffset, scrollMode, paneKey, controller, { stickyBottom });
    const normalizedSticky = React.useMemo(() => normalizeLines(stickyLines), [stickyLines]);
    const normalizedBottomSticky = React.useMemo(() => normalizeLines(bottomStickyLines), [bottomStickyLines]);
    const preserveHorizontalScroll = className.includes("is-preserve") && panelClassName.includes("has-preserved-sticky");

    // A stale sideways offset is how a fitted grid greets the reader with its
    // timestamps and header sliced off: pan once, switch tabs or sessions, and
    // the new content inherits the old scrollLeft. Reset it whenever the pane's
    // identity changes — the user's own pan within a view still stands.
    const horizontalResetKey = `${paneKey}:${title}`;
    React.useEffect(() => {
        // Two passes, deliberately: the first runs before the new view's lines
        // have laid out, and the sticky-header scroll sync can copy a stale
        // offset back onto the body afterwards. The rAF pass lands after both
        // and is what actually sticks (observed on Stats, whose header row
        // syncs horizontally with the body).
        const reset = () => {
            if (ref.current) ref.current.scrollLeft = 0;
            if (stickyRef.current) stickyRef.current.scrollLeft = 0;
        };
        reset();
        const frame = typeof requestAnimationFrame === "function"
            ? requestAnimationFrame(() => { reset(); })
            : null;
        return () => { if (frame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame); };
    }, [horizontalResetKey]);

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
        React.createElement("div", { ref: setPanelNode, className: `ps-scroll-panel ${className}${scrollShadow.down ? " is-scrolled-down" : ""}${scrollShadow.up ? " is-scrolled-up" : ""}`.trim(), "data-session-scroll": focusRegion === "sessions" ? "1" : undefined, onScroll: handleBodyScroll, onMouseDown: claimFocus, onTouchStart, onWheel, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd },
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

/**
 * The wait sentence the detail box should show, given the status it is ALREADY
 * showing. Pure, and exported so the agreement can be tested directly.
 *
 * `waitReason` is applied raw, but the status beside it is debounced — a change
 * is held for 5s by mergeSessionRowVisualStatus because the 4s catalog poll
 * (the CMS row) and the post-event detail sync (live orchestration) disagree
 * mid-turn. Reading one through the hold and the other around it made the
 * WAITING block blink in and out on every poll, and let the box read
 * "(running)" with a WAITING row underneath it at the same time.
 *
 * So the sentence is shown only while the status on screen agrees there is
 * something to wait for. A budget pause is not routed through here: it is
 * authoritative on its own and always shows.
 */
export function visibleWaitReason(session, statusLabel) {
    const reason = typeof session?.waitReason === "string" && session.waitReason.trim()
        ? session.waitReason.trim()
        : null;
    if (!reason) return null;
    const status = String(statusLabel || "");
    // "waiting", and "waiting on 7" / "waiting on children" for a parent whose
    // descendants are still going.
    const waiting = status === "waiting"
        || status.startsWith("waiting on")
        || status === "input_required";
    return waiting ? reason : null;
}

function SessionDetailBox({ session, childCount = 0, pause = null, controller = null, collapsed = false, onToggle = null }) {
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

    const statusSummary = selectSessionStatusSummary(session);

    // Why this session is stopped, where the person is standing.
    //
    // "(waiting)" is a state, not a reason, and the four reasons have four
    // different remedies — so the sentence is the server's own, the same one
    // the "Paused now" band shows, with a way through to the provider that
    // caused it. `waitReason` covers every OTHER kind of wait (a scheduled
    // one, an agent asking to sleep), which is a different fact and says so.
    //
    // The block is gated on the DEBOUNCED status, not on waitReason alone.
    // Without that gate the two halves of this box run on different clocks:
    // the Updated row holds a status change for 5s (mergeSessionRowVisualStatus)
    // while waitReason is applied raw, and mid-turn the two writers disagree —
    // the CMS row still carries the sentence after the live orchestration has
    // moved on, or the reverse. The result was a WAITING block blinking in and
    // out on every 4s poll, and a box that could read "(running)" with a
    // WAITING row under it at the same time.
    //
    // A budget pause is separate: it is authoritative on its own and is not
    // derived from the session's status, so it always shows.
    const waitReason = visibleWaitReason(session, statusSummary?.status);
    const pauseBlock = (!pause && !waitReason) ? null : React.createElement("div", {
        className: `ps-session-detail-pause${pause ? " is-paused" : ""}`,
    },
    React.createElement("span", { className: "ps-session-detail-label" }, pause ? "Paused" : "Waiting"),
    React.createElement("span", { className: "ps-session-detail-why" },
        // The sentence already says when it clears wherever it can; `clears`
        // only fills the gap where it cannot.
        pause ? pause.reason : waitReason,
        pause && pause.clears
            ? React.createElement("span", { className: "ps-session-detail-clears" }, pause.clears)
            : null,
        pause && controller ? React.createElement("button", {
            type: "button", className: "ps-budget-link",
            title: pause.provider
                ? `Open ${pause.provider} in Providers & Budgets`
                : "Open providers and budgets",
            onClick: () => controller.openBudget(
                pause.provider ? { provider: pause.provider } : {},
            ).catch(() => {}),
        }, pause.provider ? `Open ${pause.provider}` : "Open providers and budgets") : null));

    // Collapsed, the box is one line: the state you check constantly (how full
    // the context is, when it last moved, whether it is stuck) without the ten
    // rows you look up once. Expanding is a click, and the choice is a
    // preference so it survives switching sessions and reloading.
    if (collapsed) {
        const marks = [];
        if (context) {
            marks.push(React.createElement("span", {
                key: "context",
                className: `ps-session-detail-mark${percent != null && percent >= 85 ? " is-hot" : percent != null && percent >= 70 ? " is-warm" : ""}`,
            }, percent != null ? `${percent}%` : context));
        }
        if (statusSummary) {
            marks.push(React.createElement("span", { key: "updated", className: "ps-session-detail-mark" },
                `${statusSummary.relative} (${statusSummary.status})`));
        }
        // A stopped session is the one thing you must not have to expand to
        // find out, so it keeps a marker in the collapsed line.
        if (pause || waitReason) {
            marks.push(React.createElement("span", {
                key: "halt",
                className: `ps-session-detail-mark${pause ? " is-paused" : ""}`,
                title: pause ? pause.reason : waitReason,
            }, pause ? "paused" : "waiting"));
        }
        return React.createElement("div", { className: "ps-session-detail-box is-collapsed" },
            React.createElement("button", {
                type: "button",
                className: "ps-session-detail-summary",
                "aria-expanded": false,
                title: "Show session details",
                onClick: onToggle,
            },
                React.createElement("span", { className: "ps-session-detail-twisty", "aria-hidden": "true" }, "▸"),
                React.createElement("span", { className: "ps-session-detail-summary-title" },
                    session?.title || SESSION_DETAIL_NONE),
                React.createElement("span", { className: "ps-session-detail-marks" }, marks)));
    }

    return React.createElement("div", { className: "ps-session-detail-box" },
        React.createElement("button", {
            type: "button",
            className: "ps-session-detail-collapse",
            "aria-expanded": true,
            title: "Hide session details",
            onClick: onToggle,
        }, React.createElement("span", { "aria-hidden": "true" }, "▾"), " Less"),
        // The row above ellipsizes to one line, so this is the only place the
        // whole name is legible. Two lines are RESERVED whether or not they are
        // used, so the box height still cannot move with the selection.
        field("Title", session?.title, "is-title"),
        field("ID", session?.sessionId, "is-id"),
        field("Owner", session?.owner ? formatAdminPrincipalLabel(session.owner) : null),
        field("Model", model),
        field("Context", context, percent != null && percent >= 85 ? "is-hot" : percent != null && percent >= 70 ? "is-warm" : ""),
        field("Cron", cron, session?.cronActive === true ? "is-armed" : ""),
        field("Agent", session?.agentId),
        // "when, and what it is doing" in one row. The status comes from the
        // shared derivation rather than the raw field — see
        // selectSessionStatusSummary for why raw made this flip idle/waiting.
        field("Updated", statusSummary ? `${statusSummary.relative} (${statusSummary.status})` : null),
        field("Children", children),
        field("Access", access),
        // Outside the fixed grid above: this one is a sentence, and the grid's
        // whole point is that every row is one clamped line.
        pauseBlock);
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
    row, theme, structuredRows, mobile, onRowClick, setRef, drag,
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
            className: "ps-line ps-session-row-content",
            style: {
                // Nested content starts where its node mark does, so the mark
                // lands centred on the deepest rail and the text clears it.
                paddingInlineStart: depth > 0 ? `${railNodeInsetPx(depth)}px` : "0px",
            },
        },
            React.createElement(SessionRowContent, {
                row, theme, structured: structuredRows, showInlineDetail: mobile,
            })));
});

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
        // The row's own styling already marks selection; drawing the bar too
        // would cost a column and truncate the row early.
        if (run?.role === "selection") continue;
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
            React.createElement(SessionCanvasMark, { mark: row.canvasMark }),
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
                React.createElement(SessionCanvasMark, { mark: row.canvasMark }),
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
 * One axis per gesture: a touch drag scrolls the session list up/down OR
 * left/right, never both.
 *
 * The session list has `width: max-content` rows, so it overflows sideways
 * whenever a title is long. With both axes on offer a swipe is never perfectly
 * vertical, so scrolling down kept sliding the list sideways too.
 *
 * This used to hand the vertical case back to the browser (`touch-action:
 * pan-y`) and only drive horizontal itself. That relied on the browser to
 * refuse the sideways component, and it has two problems:
 *
 *   - What counts as "vertical enough" for `pan-y` is the browser's call, not
 *     ours, and engines disagree. The guarantee was only as good as whichever
 *     one the reader happened to be using.
 *   - A drag near 45° fell in the gap: we committed it to vertical and stepped
 *     aside, and the browser then declined to pan it at all. The list simply
 *     did not move, which reads as broken rather than as a locked axis.
 *
 * So both axes are driven here. Every gesture past the slop threshold commits
 * to exactly one axis and always moves it — no dead zone, and no engine gets a
 * vote on the diagonal. Vertical stays the default: sideways has to be asked
 * for, by a drag that beats vertical by PAN_HORIZONTAL_RATIO.
 *
 * Driving the scroll ourselves means we also own the part the browser was
 * doing for free, so a flick decays under `releaseFling` instead of stopping
 * dead under the finger. CSS keeps `touch-action: pan-y` as a floor: if these
 * listeners ever fail to attach, the list still scrolls vertically the native
 * way rather than becoming inert.
 */
const PAN_COMMIT_PX = 10;      // ignore the first few px — every swipe starts noisy
const PAN_HORIZONTAL_RATIO = 1.6;   // |dx| must beat |dy| by this much to go sideways
const FLING_MIN_VELOCITY = 0.05;    // px/ms below which a lift is a stop, not a flick
const FLING_FRICTION = 0.95;        // per frame; ~0.35s of glide from a brisk flick
const FLING_MAX_VELOCITY = 4;       // px/ms ceiling, so a fast flick stays catchable

/**
 * Which axis does this gesture own? Pure, and exported so the rule can be
 * tested without a browser — the bug it replaces was a gesture that matched
 * NEITHER branch and therefore scrolled nothing.
 *
 * Returns null while the drag is still inside the slop radius, then "x" or
 * "y" — never null again, and never both. Every gesture that gets past the
 * threshold moves something.
 */
export function commitPanAxis(dx, dy) {
    if (Math.abs(dx) < PAN_COMMIT_PX && Math.abs(dy) < PAN_COMMIT_PX) return null;
    // Ties, and anything close to a tie, go to vertical. Vertical is the
    // primary axis; sideways has to be asked for.
    return Math.abs(dx) > Math.abs(dy) * PAN_HORIZONTAL_RATIO ? "x" : "y";
}

function useAxisLockedPan(ref) {
    React.useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;

        let startX = 0;
        let startY = 0;
        let lastX = 0;
        let lastY = 0;
        let lastT = 0;
        let velocity = 0;   // px/ms along the committed axis, sign follows the finger
        let axis = null;    // null = undecided, "x" | "y" = committed for this gesture
        let flingFrame = null;

        const stopFling = () => {
            if (flingFrame !== null) {
                cancelAnimationFrame(flingFrame);
                flingFrame = null;
            }
        };

        const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

        const onTouchStart = (event) => {
            stopFling();
            // Two fingers is a pinch or a system gesture — leave it alone.
            if (event.touches.length !== 1) { axis = "done"; return; }
            const touch = event.touches[0];
            startX = lastX = touch.clientX;
            startY = lastY = touch.clientY;
            lastT = now();
            velocity = 0;
            axis = null;
        };

        const onTouchMove = (event) => {
            if (axis === "done" || event.touches.length !== 1) return;
            const touch = event.touches[0];
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;

            if (axis === null) {
                axis = commitPanAxis(dx, dy);
                if (axis === null) return;
                // Measure from here, so the slop we ignored is not also applied.
                lastX = touch.clientX;
                lastY = touch.clientY;
                lastT = now();
            }

            const stepX = touch.clientX - lastX;
            const stepY = touch.clientY - lastY;
            const t = now();
            const elapsed = Math.max(1, t - lastT);
            const step = axis === "x" ? stepX : stepY;

            if (axis === "x") el.scrollLeft -= stepX;
            else el.scrollTop -= stepY;

            // Exponential smoothing: one jittery sample should not decide the
            // whole flick, and a finger that stops before lifting should decay
            // to zero rather than fling on a stale reading.
            const sample = Math.max(-FLING_MAX_VELOCITY, Math.min(FLING_MAX_VELOCITY, step / elapsed));
            velocity = velocity * 0.7 + sample * 0.3;

            lastX = touch.clientX;
            lastY = touch.clientY;
            lastT = t;
            // We are the scroller now; stop the browser doing it as well.
            if (event.cancelable) event.preventDefault();
        };

        const releaseFling = (committed) => {
            if (Math.abs(velocity) < FLING_MIN_VELOCITY) return;
            let v = velocity;
            const tick = () => {
                v *= FLING_FRICTION;
                if (Math.abs(v) < FLING_MIN_VELOCITY) { flingFrame = null; return; }
                const before = committed === "x" ? el.scrollLeft : el.scrollTop;
                if (committed === "x") el.scrollLeft -= v * 16;
                else el.scrollTop -= v * 16;
                const after = committed === "x" ? el.scrollLeft : el.scrollTop;
                // Hit an end stop — no point animating against it.
                if (after === before) { flingFrame = null; return; }
                flingFrame = requestAnimationFrame(tick);
            };
            flingFrame = requestAnimationFrame(tick);
        };

        const onTouchEnd = () => {
            const committed = axis;
            axis = null;
            if (committed === "x" || committed === "y") releaseFling(committed);
            velocity = 0;
        };

        const onTouchCancel = () => { axis = null; velocity = 0; stopFling(); };

        el.addEventListener("touchstart", onTouchStart, { passive: true });
        el.addEventListener("touchmove", onTouchMove, { passive: false });
        el.addEventListener("touchend", onTouchEnd, { passive: true });
        el.addEventListener("touchcancel", onTouchCancel, { passive: true });
        return () => {
            stopFling();
            el.removeEventListener("touchstart", onTouchStart);
            el.removeEventListener("touchmove", onTouchMove);
            el.removeEventListener("touchend", onTouchEnd);
            el.removeEventListener("touchcancel", onTouchCancel);
        };
    }, [ref]);
}

function SessionPane({ controller, actions = null, panelClassName = "", structuredRows = false, showDetailBox = null }) {
    // Mobile keeps its inline detail line and normally gets no detail box — a
    // reserved footer would eat a meaningful slice of a phone screen. The
    // sessions-ONLY layout is the exception: it has the whole screen and the
    // detail box is the point of asking for it.
    const isMobilePane = String(panelClassName).includes("ps-mobile-session-pane");
    // Vertical is the primary scroll axis; sideways takes a deliberate swipe.
    const sessionListRef = React.useRef(null);
    useAxisLockedPan(sessionListRef);
    // Selection reverts to plain taps wherever the primary input is a finger:
    // the mobile pane, and the chat-focus overlay's list on a phone. Matches
    // the `(pointer: fine)` guard on touch-action in the stylesheet.
    const touchInput = isMobilePane || useCoarsePointer();
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const detailCollapsed = useControllerSelector(
        controller,
        (state) => Boolean(state.ui.sessionDetailCollapsed),
    );
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
        // Clicking empty space clears the list highlight; the row VM reads it,
        // so the reconstruction below must carry it or the click does nothing
        // visible (the same omission that blinded the Node Map).
        listDeselected: Boolean(state.sessions.listDeselected),
        // The canvas markers read these. This synthetic state is exactly the
        // trap the branding comment below describes: omit a slice here and
        // every row computes as if it were empty — the markers were null on
        // every row until these two lines existed.
        canvasBySessionId: state.canvas?.bySessionId,
        canvasPrefs: state.canvas?.prefs,
        // Why a waiting session is waiting. Same trap as the canvas slices
        // above: omit it and every row computes as if nothing were paused, and
        // three sessions stopped for three different reasons all read
        // "waiting".
        budgetPaused: state.budget?.paused,
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
        canvas: {
            bySessionId: viewState.canvasBySessionId,
            prefs: viewState.canvasPrefs,
        },
        budget: { paused: viewState.budgetPaused },
    }), [viewState.activeSessionId, viewState.auth, viewState.branding, viewState.budgetPaused, viewState.canvasBySessionId, viewState.canvasPrefs, viewState.connectionMode, viewState.filterQuery, viewState.listDeselected, viewState.ownerFilter, viewState.pinnedIds, viewState.manualOrder, viewState.selectedIds, viewState.selectMode, viewState.sessionsById, viewState.sessionsFlat]);
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
    // System sessions are ADMIN-modifiable and read-only for everyone else —
    // which is exactly what the server already enforces in
    // evaluateSessionAccess: an admin passes every class, and for a non-admin
    // a system session allows read and refuses every write with "System
    // sessions are managed by administrators."
    //
    // This gate used to be STRICTER than the server, excluding isSystem for
    // everybody, so an admin who was entitled to rename or re-model the
    // sweeper had the button disabled with no way to reach the capability.
    // Client and server now agree; the server remains the enforcement point.
    const canModifyActiveSession = Boolean(
        activeSession && !activeSession.isGroup
        && (activeSession.isSystem
            ? isAdminViewer
            : (isAdminViewer || ownsActiveSession)),
    );
    const selectedCount = Array.isArray(viewState.selectedIds) ? viewState.selectedIds.length : 0;
    const isBulkSelection = selectedCount > 1;
    // A folder has none of the session-manage surface — no model, no sharing,
    // no visibility — which is why canModifyActiveSession excludes groups. But
    // it does have a TITLE, and the rename modal already routes groups to
    // updateSessionGroup. Renaming is the one manage action a folder supports.
    // Session groups are private per-user organisation, so a folder you can
    // see is a folder you own; there is no separate ownership check to make.
    const canRenameActiveGroup = Boolean(activeSession?.isGroup && !isBulkSelection);
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
    const combinedPanelClassName = `ps-session-pane${panelClassName ? ` ${panelClassName}` : ""}`;
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
    /**
     * The element that actually scrolls the session list.
     *
     * Walked up from the list itself rather than resolved from the pointer:
     * `[data-session-scroll]` is only stamped on the pane while it holds
     * focus, and the pane and the list inside it BOTH declare overflow — which
     * of the two really scrolls depends on how the flex layout resolved. The
     * old lookup could land on the one whose scrollHeight equals its
     * clientHeight, where `scrollTop +=` is silently a no-op and the list just
     * sat there while you dragged past its edge.
     */
    const findSessionScroller = React.useCallback(() => {
        let node = sessionListRef.current;
        while (node && node !== document.body) {
            const overflowY = window.getComputedStyle(node).overflowY;
            if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight - node.clientHeight > 1) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }, []);

    const updateAutoScroll = React.useCallback((x, y) => {
        const EDGE_PX = 48;
        const MAX_STEP_PX = 14;
        const scroller = findSessionScroller();
        if (!scroller) { stopAutoScroll(); return; }
        const box = scroller.getBoundingClientRect();
        let step = 0;
        // Each branch's own guard already makes its numerator positive, and
        // Math.min caps the ramp at full speed — so dragging PAST the edge, the
        // case this exists for, keeps scrolling at MAX_STEP rather than
        // accelerating without bound.
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
    }, [findSessionScroller, stopAutoScroll]);

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
        // A FOLDER has a groupId of its own — its own id. Feeding that through
        // the filing branches below meant every position in the list resolved
        // to "file into that other folder" or "take it out of itself", and a
        // folder could never once be reordered. Folders nest in nothing, so
        // reorder is the only gesture they have.
        if (pending?.isGroup) {
            const target = pending.ids.length === 1
                ? resolveReorderTarget(x, y, pending.container, pending.ids[0])
                : undefined;
            if (target === undefined) return { kind: "none", overGroupId: null, before: undefined, after: null };
            return { kind: "reorder", overGroupId: null, before: target.before, after: target.after };
        }
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
                isGroup: Boolean(row.isGroup),
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

    // Which (session, focus, modal) combination has already been pulled into
    // view. Anything else re-arms the reveal; a bare list refresh does not.
    const revealedRowKeyRef = React.useRef(null);
    const activeRowRevealKey = `${viewState.activeSessionId || ""}${viewState.focused ? 1 : 0}${viewState.modalOpen ? 1 : 0}`;

    React.useEffect(() => {
        if (viewState.modalOpen || !viewState.focused || !viewState.activeSessionId) {
            // Disarm, so returning from a modal (or refocusing the pane) counts
            // as a fresh arming. Without this the ref still holds the key from
            // before the modal opened, the comparison below matches, and the
            // row is never brought back into view on the way out.
            revealedRowKeyRef.current = null;
            return;
        }
        const activeButton = sessionButtonRefs.current.get(viewState.activeSessionId);
        // The row is not rendered yet. On a page reload the active session id
        // is restored from the profile BEFORE the listing arrives, so the first
        // run lands here — leaving the key un-consumed is what lets the reveal
        // retry once `sessionsFlat` brings the row in.
        if (!activeButton) return;

        // Everything below runs ONCE per arming. This effect is woken by every
        // list refresh (~4×/sec while a session streams), and moving DOM focus
        // on each of those was actively dangerous: the Manage and Copy-link
        // dialogs are local React state rather than `ui.modal`, so
        // `viewState.modalOpen` is false while they are open — focus was ripped
        // out of their text inputs mid-keystroke, and because the global
        // shortcut handler decides "am I editable?" from the event target, the
        // rest of what the user typed ran as commands (d = complete,
        // D = delete). Scrolling on every refresh has a milder failure but the
        // same shape: the list yanks back to the active row while the user is
        // deliberately scrolled away browsing older sessions.
        if (revealedRowKeyRef.current === activeRowRevealKey) return;
        revealedRowKeyRef.current = activeRowRevealKey;

        // Never take focus off something the user is typing into. Belt and
        // braces on top of the arming guard, for any future caller of this
        // effect that fires while a local dialog is up.
        const focused = document.activeElement;
        const isTypingTarget = Boolean(focused && (
            focused.tagName === "INPUT"
            || focused.tagName === "TEXTAREA"
            || focused.tagName === "SELECT"
            || focused.isContentEditable
        ));
        if (focused !== activeButton && !isTypingTarget) {
            activeButton.focus({ preventScroll: true });
        }
        activeButton.scrollIntoView({ block: "nearest" });
    }, [activeRowRevealKey, viewState.activeSessionId, viewState.focused, viewState.modalOpen, viewState.sessionsFlat]);

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
            onClick: () => {
                // Folders reuse this control rather than dead-ending on it:
                // it is where people look for "change this thing's name", and
                // it is where this one was reported from.
                if (activeSession?.isGroup) {
                    controller.handleCommand(UI_COMMANDS.OPEN_RENAME_SESSION).catch(() => {});
                    return;
                }
                setManageOpen(true);
            },
            disabled: (!canModifyActiveSession && !canRenameActiveGroup) || isBulkSelection,
            // A disabled control has to say WHY. This label used to describe
            // the ENABLED behaviour in every disabled case except bulk
            // selection, so on a system session the tooltip promised "rename,
            // switch model, and sharing" while the click did nothing — which
            // reads as a broken dialog rather than an unavailable action.
            label: isBulkSelection
                ? "Disabled while multiple sessions are selected"
                : activeSession?.isSystem
                    ? "System sessions are managed by administrators"
                    : activeSession?.isGroup
                        ? "Rename folder"
                        : !canModifyActiveSession
                            ? "Only this session's owner or an admin can manage it"
                            : "Manage session — rename, switch model, and sharing",
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
                // Read the resolved INTENT, not just the folder under the
                // pointer. Folders always resolve to reorder with a null
                // overGroupId, so the old test labelled every folder drag
                // "Release to remove from folder" — a folder is in no folder.
                dragState.intent === "file" ? "Release to file here"
                    : dragState.intent === "unfile" ? "Release to remove from folder"
                    : dragState.intent === "reorder" ? "Release to move here"
                    : "Release to cancel"))
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
                structuredRows,
                mobile: isMobilePane,
                onRowClick: handleRowClick,
                setRef: setSessionButtonRef,
                // Drag-to-folder is a fine-pointer gesture: arming it on
                // touch hijacks the finger that should be scrolling the list.
                drag: touchInput ? null : dragHandlers,
            }))),
    (showDetailBox === null ? !isMobilePane : showDetailBox)
        ? React.createElement(SessionDetailBox, {
            session: activeSession,
            childCount: activeRow?.childCount || 0,
            // Why it is stopped, and a way through to the surface that can
            // change it. The row already carries the joined pause record.
            pause: activeRow?.pause || null,
            controller,
            collapsed: detailCollapsed,
            onToggle: () => controller.dispatch({
                type: "ui/sessionDetailCollapsed",
                collapsed: !detailCollapsed,
            }),
        })
        : null),
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
    const [copied, setCopied] = React.useState("");
    const multi = buildPortalLinks(url, portalLinkOrigins).length > 1;
    const copy = React.useCallback((key, text) => {
        // onCopyAgain owns the single-origin clipboard write (and its status
        // line); the per-origin buttons write their own one URL.
        if (key === "session" && !multi) { onCopyAgain?.(); }
        else if (navigator?.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
        setCopied(key);
        window.setTimeout(() => setCopied(""), 1500);
    }, [multi, onCopyAgain]);
    const stop = (e) => e.stopPropagation();
    return React.createElement("div", { className: "ps-share-overlay", onClick: onClose },
        React.createElement("div", { className: "ps-link-modal", onClick: stop },
            React.createElement("div", { className: "ps-share-modal-head" },
                React.createElement("span", null, multi ? "Session links copied" : "Link copied"),
                React.createElement("button", { className: "ps-modal-close", onClick: onClose, "aria-label": "Close", title: "Close" }, "✕")),
            React.createElement("div", { className: "ps-share-section-sub" },
                multi
                    ? "All entry-point links were copied. Copy just the one your recipient's network can reach, or take both."
                    : "Copied to your clipboard — anyone with access can open the session from this link."),
            React.createElement(MultiOriginLinkRows, { url, keyPrefix: "session", copied, onCopy: copy }),
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

// Back to the transcript. Replaces the 💬 emoji, which iOS force-renders in
// colour against an otherwise monochrome row (see the note on the tab table).

function PlusGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("line", { x1: "12", y1: "5", x2: "12", y2: "19" }),
    React.createElement("line", { x1: "5", y1: "12", x2: "19", y2: "12" }));
}

function TrashGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M3 6h18" }),
    React.createElement("path", { d: "M8 6V4h8v2" }),
    React.createElement("path", { d: "M19 6l-1 15H6L5 6" }),
    React.createElement("path", { d: "M10 11v5" }),
    React.createElement("path", { d: "M14 11v5" }));
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

// Providers & Budgets. A coin, not a chart or a gauge: the surface is about
// what a turn COSTS and who is paying, and a chart glyph would collide with
// the inspector's stats mark.
function CoinGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("circle", { cx: "12", cy: "12", r: "9" }),
    React.createElement("path", { d: "M14.5 9.2a2.6 2.6 0 0 0-2.5-1.6c-1.5 0-2.6.8-2.6 2s1 1.7 2.6 2 2.6.8 2.6 2-1.1 2-2.6 2a2.6 2.6 0 0 1-2.5-1.6" }),
    React.createElement("path", { d: "M12 6v1.6" }),
    React.createElement("path", { d: "M12 16.4V18" }));
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

// The phone's view modes live in the top bar, not a bottom nav; each reads at
// icon size without a label.
// The Main pane, whatever layout it is in: a frame with a list rail and a
// conversation beside it. Constant across the three-way cycle.
function MainLayoutGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }),
    React.createElement("line", { x1: "9.5", y1: "4", x2: "9.5", y2: "20" }),
    React.createElement("line", { x1: "12.5", y1: "9", x2: "18", y2: "9" }),
    React.createElement("line", { x1: "12.5", y1: "13", x2: "18", y2: "13" }));
}

// Inspector takes the pulse — the trace/sequence view is its default face.
function InspectorPaneGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M3 12h4l2.5-6 4 12 2.5-6H21" }));
}

// Activity reads a log: a page with lines on it.
function ActivityPaneGlyph() {
    return React.createElement(Glyph, null,
    React.createElement("path", { d: "M6 3h8l4 4v14H6z" }),
    React.createElement("path", { d: "M14 3v4h4" }),
    React.createElement("line", { x1: "9", y1: "12", x2: "15", y2: "12" }),
    React.createElement("line", { x1: "9", y1: "16", x2: "15", y2: "16" }));
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
        },
    }), [
        viewState.activeHistory,
        viewState.activeSessionId,
        viewState.activeOutbox,
        viewState.authPrincipal,
        viewState.branding,
        viewState.connection,
        viewState.inspectorTab,
        viewState.sessionsById,
        viewState.sessionsFlat,
    ]);
    // Character-cell content (code fences, tables, box art) wraps at the
    // pane's MEASURED width; the legacy-model width only covers the first
    // paint, before the panel node exists to measure.
    const [measuredCols, panelRef] = useMeasuredPaneColumns();
    const contentWidth = measuredCols ?? viewState.contentWidth;
    const chrome = React.useMemo(
        () => selectChatPaneChrome(selectorState, { width: contentWidth }),
        [selectorState, contentWidth],
    );
    const animatedDots = useAnimatedDots(Boolean(chrome.animateTitleRight));
    const titleRight = React.useMemo(
        () => appendAnimatedDotsToRuns(chrome.titleRight, chrome.animateTitleRight ? animatedDots : ""),
        [animatedDots, chrome.animateTitleRight, chrome.titleRight],
    );
    const [loadingOlder, setLoadingOlder] = React.useState(false);
    // Scroll-up expands the transcript automatically until the soft cap, then
    // refuses — and the portal had no control to ask for more, so a busy
    // session's history became unreachable from the browser. Surface the
    // control exactly when the automatic path has given up.
    const showLoadOlder = Boolean(
        viewState.activeHistory?.hasOlderEvents
        && Number(viewState.activeHistory?.loadedEventCount || 0) >= AUTO_HISTORY_EVENT_SOFT_CAP,
    );
    const lines = React.useMemo(
        () => selectChatLines(selectorState, contentWidth, { tableMode: "sentinel" }),
        [selectorState, contentWidth],
    );
    const spinnerFrame = useSpinnerFrame(viewState.activeSessionStatus === "running");
    const liveActivityLines = React.useMemo(
        () => selectLiveActivityLines(selectorState, { spinnerFrame, maxWidth: contentWidth }),
        [selectorState, spinnerFrame, contentWidth],
    );
    // The live-activity line is pinned in the bottom-sticky strip (with the
    // outbox overlay), NOT appended to the transcript — it must stay put while
    // chat content scrolls, and it drops the instant the turn ends.
    const pinnedActivityLines = liveActivityLines;
    const outboxLines = React.useMemo(
        () => selectOutboxOverlayLines(selectorState, contentWidth, { tableMode: "sentinel" }),
        [selectorState, contentWidth],
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
    const composerBase = showComposer && !viewState.activeSessionIsGroup;
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
        title: mobile ? compactTitleRuns(chrome.title, 28) : chrome.title,
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
        className: "is-wrapped",
        panelClassName: "ps-chat-panel",
        panelRef,
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
        renderBody: null,
    });
}

/**
 * The desktop artifact reader: a full-height pane that takes over the right
 * column, replacing the inspector AND activity panes for as long as it is open.
 *
 * Why a takeover rather than one more box: an artifact worth opening from the
 * transcript is the thing you want to READ, and the previous arrangement gave
 * it the bottom third of a column it shared with a file list. The chat stays
 * beside it — that is the half of the split that matters — while everything
 * that was only ever context for the chat steps aside.
 *
 * ✕ hands the column back to the inspector/activity split, or re-collapses it
 * if it was already collapsed when the pane opened (see closeArtifactPane).
 */
function ArtifactTakeoverPane({ controller, onClose }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const view = useControllerSelector(controller, (state) => {
        const id = state.files.selectedArtifactId || "";
        const slash = id.indexOf("/");
        return {
            sessionId: slash > 0 ? id.slice(0, slash) : null,
            filename: slash > 0 ? id.slice(slash + 1) : "",
            canPrev: controller.canStepArtifactPreview(-1),
            canNext: controller.canStepArtifactPreview(1),
        };
    }, shallowEqualObject);

    const descriptor = describeArtifact(view.filename);
    const htmlViewMode = useControllerSelector(controller, (state) => state.files.htmlViewMode || "rendered");
    const htmlFitWidth = useControllerSelector(controller, (state) => Boolean(state.files.htmlFitWidth));
    const setHtmlFitWidth = React.useCallback((next) => {
        controller.dispatch({ type: "files/htmlFitWidth", enabled: next });
    }, [controller]);
    const setHtmlViewMode = React.useCallback((next) => {
        controller.dispatch({ type: "files/htmlViewMode", mode: next });
    }, [controller]);
    const htmlZoom = useControllerSelector(controller, (state) => Number(state.files.htmlZoom) || 1);
    const setHtmlZoom = React.useCallback((next) => {
        controller.dispatch({ type: "files/htmlZoom", zoom: next });
    }, [controller]);
    const step = React.useCallback((delta) => {
        controller.stepArtifactPreview(delta).catch(() => {});
    }, [controller]);

    // ‹ › as keys, not just buttons — the same navigation the phone overlay
    // has. Bound on the pane itself rather than the window so it cannot
    // hijack the arrow keys while the user is typing in the composer.
    const onKeyDown = React.useCallback((event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "ArrowLeft" || event.key === "[") { event.preventDefault(); step(-1); return; }
        if (event.key === "ArrowRight" || event.key === "]") { event.preventDefault(); step(1); return; }
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
    }, [onClose, step]);

    const deepLink = buildArtifactLinkUrl(view.sessionId, view.filename);

    return React.createElement("section", {
        className: "ps-artifact-pane",
        onKeyDown,
        tabIndex: -1,
        role: "region",
        "aria-label": `Artifact: ${view.filename || "none"}`,
    },
    React.createElement("header", { className: "ps-artifact-pane-bar" },
        // Rendered/Source lives HERE for HTML rather than in a second header
        // row below — one bar owns the artifact, the way the reference does.
        descriptor.kind === "page"
            ? React.createElement(HtmlViewModeToggle, { mode: htmlViewMode, setMode: setHtmlViewMode })
            : null,
        // The panel is chromeless in here, so this bar owns the fit control —
        // and this is the surface that needs it most: a fixed-width page in a
        // phone-width frame is exactly the case fitting exists for.
        descriptor.kind === "page" && htmlViewMode === "rendered"
            ? React.createElement(HtmlFitWidthToggle, { fitWidth: htmlFitWidth, setFitWidth: setHtmlFitWidth })
            : null,
        // Zoom belongs here for the same reason: it scales the ARTIFACT, not
        // the workspace, which is the whole distinction from browser zoom.
        descriptor.kind === "page" && htmlViewMode === "rendered"
            ? React.createElement(HtmlZoomControl, { zoom: htmlZoom, setZoom: setHtmlZoom })
            : null,
        React.createElement("span", { className: "ps-artifact-pane-heading" },
            React.createElement("span", {
                className: "ps-artifact-pane-name",
                title: view.filename,
            }, artifactCardTitle(view.filename) || "Artifact"),
            React.createElement("span", { className: "ps-artifact-pane-type" }, descriptor.type)),
        React.createElement("span", { className: "ps-artifact-pane-actions" },
            React.createElement("button", {
                type: "button",
                className: "ps-artifact-pane-btn",
                disabled: !view.canPrev,
                onClick: () => step(-1),
                title: "Previous artifact (←)",
                "aria-label": "Previous artifact",
            }, "‹"),
            React.createElement("button", {
                type: "button",
                className: "ps-artifact-pane-btn",
                disabled: !view.canNext,
                onClick: () => step(1),
                title: "Next artifact (→)",
                "aria-label": "Next artifact",
            }, "›"),
            React.createElement("button", {
                type: "button",
                className: "ps-artifact-pane-btn",
                onClick: () => {
                    if (!deepLink) return;
                    copySessionLinkText(deepLink);
                    controller.dispatch({ type: "ui/status", text: ARTIFACT_LINK_COPIED_STATUS });
                },
                disabled: !deepLink,
                title: "Copy a link that reopens this artifact",
                "aria-label": "Copy link",
            }, "🔗"),
            React.createElement("button", {
                type: "button",
                className: "ps-artifact-pane-btn",
                onClick: () => controller.handleCommand(UI_COMMANDS.DOWNLOAD_SELECTED_FILE).catch(() => {}),
                title: "Download",
                "aria-label": "Download",
            }, React.createElement(DownloadGlyph)),
            React.createElement("button", {
                type: "button",
                className: "ps-artifact-pane-btn is-close",
                onClick: onClose,
                title: "Close (Esc)",
                "aria-label": "Close artifact",
            }, "✕"))),
    React.createElement("div", { className: "ps-artifact-pane-body" },
        React.createElement(FilesPane, {
            controller, focused: false, previewOnly: true, chromeless: true, theme,
        })));
}

/**
 * The phone's canvas: a LAYER over the content region, not a full screen.
 *
 * It used to be a fixed, full-viewport overlay — the portal header and the
 * toolbar disappeared behind it too, so looking at a drawing meant leaving the
 * app and finding your way back. It now fills exactly the region the Main,
 * Activity and Inspector panes share: top edge under the toolbar, bottom edge
 * at the viewport, edge to edge, no inset. The header and the toolbar (with
 * its Canvas button, the only way in or out — there is no ✕ here) stay put.
 *
 * It is rendered as a SIBLING of that region's content, not inside any pane,
 * because the frame has to outlive every pane: the canvas runs interactive
 * pages, and switching to Inspector and back must not reset a running game.
 *
 * Maximized, it goes truly full-screen: the same element flips from absolute
 * inside the region to fixed over the whole viewport, covering the portal
 * header and the toolbar too. That is a CLASS change on one div and nothing
 * else — the frame is never moved in the DOM, so a game survives the toggle.
 * The thin strip persists in both states; only the right-hand button flips.
 */
function MobileCanvasLayer({ controller, visible = true }) {
    const [maximized, setMaximized] = React.useState(false);
    const toggleMaximized = React.useCallback(() => setMaximized((current) => !current), []);
    // Leaving the canvas drops full-screen, so coming back lands in the inset
    // presentation rather than a takeover the user has to undo before they can
    // reach the toolbar again.
    React.useEffect(() => {
        if (!visible) setMaximized(false);
    }, [visible]);
    // Kept MOUNTED while hidden: unmounting destroys the sandboxed document,
    // and with it everything the user typed and scrolled. The hidden state is
    // an off-screen transform (see .ps-mobile-canvas-layer.is-hidden), so the
    // frame keeps a real, unchanged box and no settle-reload fires on re-show.
    return React.createElement("div", {
        className: `ps-mobile-canvas-layer${maximized ? " is-maximized" : ""}${visible ? "" : " is-hidden"}`,
        ...(visible ? {} : { inert: true, "aria-hidden": "true" }),
    },
        React.createElement(CanvasPane, {
            controller, mobile: true, visible, focusOnPromote: true,
            maximized, onToggleMaximized: toggleMaximized,
        }));
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

// How much visual-viewport height must vanish before we call it a keyboard.
// Smaller drops (URL-bar churn, iOS toolbars settling) stay under this.
const KEYBOARD_TAKEOVER_MIN_SHRINK_PX = 140;

/**
 * Pure decision for the keyboard takeover, split out for tests. Returns the
 * next {baseline, takeover}. The keyboard signal is a visual-viewport height
 * drop from the tallest height seen at the current width; a width change is
 * a rotation and resets the baseline. window.innerHeight is NOT a usable
 * baseline: Android's interactive-widget=resizes-content shrinks it together
 * with the keyboard, which would read as "no shrink".
 */
export function evaluateKeyboardTakeover(baseline, viewportWidth, viewportHeight, composerFocused) {
    let nextBaseline = baseline;
    if (!baseline || Math.abs(viewportWidth - baseline.width) > 2) {
        nextBaseline = { width: viewportWidth, height: viewportHeight };
    } else if (viewportHeight > baseline.height) {
        nextBaseline = { width: baseline.width, height: viewportHeight };
    }
    const shrunk = viewportHeight <= nextBaseline.height - KEYBOARD_TAKEOVER_MIN_SHRINK_PX;
    return { baseline: nextBaseline, takeover: shrunk && composerFocused };
}

/**
 * True while the on-screen keyboard is up AND the chat composer summoned it.
 * Both conditions matter: height alone would fire for a modal's text field
 * and collapse the workspace behind the modal; focus alone would fire for
 * hardware keyboards that shrink nothing. State-driven on the keyboard
 * itself, so it reverts the moment the keyboard goes away — including the
 * iOS swipe-dismiss that closes the keyboard without blurring the input.
 */
function useKeyboardTakeover(enabled) {
    const [takeover, setTakeover] = React.useState(false);
    React.useEffect(() => {
        if (!enabled || typeof window === "undefined" || !window.visualViewport) {
            setTakeover(false);
            return undefined;
        }
        const viewport = window.visualViewport;
        let baseline = { width: viewport.width, height: viewport.height };
        let frame = 0;
        const evaluate = () => {
            frame = 0;
            const composerFocused = Boolean(document.activeElement?.classList?.contains("ps-prompt-input"));
            const next = evaluateKeyboardTakeover(baseline, viewport.width, viewport.height, composerFocused);
            baseline = next.baseline;
            setTakeover(next.takeover);
        };
        // rAF-deferred: focusout fires while activeElement is mid-transition,
        // and visualViewport resize storms during the keyboard animation.
        const schedule = () => { if (!frame) frame = requestAnimationFrame(evaluate); };
        evaluate();
        viewport.addEventListener("resize", schedule);
        window.addEventListener("focusin", schedule);
        window.addEventListener("focusout", schedule);
        return () => {
            if (frame) cancelAnimationFrame(frame);
            viewport.removeEventListener("resize", schedule);
            window.removeEventListener("focusin", schedule);
            window.removeEventListener("focusout", schedule);
        };
    }, [enabled]);
    return enabled ? takeover : false;
}

/**
 * The phone's Main pane, in one of three layouts cycled by the Main toolbar
 * button: split (sessions + chat), chat only, sessions only (list + the
 * detail sub-panel). This replaced chat-focus mode, which was a second way to
 * say "chat only" with its own chrome and its own exit.
 */
function MobileWorkspace({ controller, layout = "split" }) {
    const sessionPane = React.createElement(SessionPane, {
        controller,
        panelClassName: "ps-mobile-session-pane",
    });
    if (layout === "chat") {
        return React.createElement("div", { className: "ps-mobile-workspace is-chat-only" },
            React.createElement("div", { className: "ps-mobile-chat-pane" },
                React.createElement(ChatPane, { controller, mobile: true, fullWidth: true })));
    }
    if (layout === "sessions") {
        return React.createElement("div", { className: "ps-mobile-workspace is-sessions-only" },
            React.createElement(SessionPane, {
                controller,
                panelClassName: "ps-mobile-session-pane",
                showDetailBox: true,
            }));
    }
    return React.createElement("div", { className: "ps-mobile-workspace" },
        sessionPane,
        React.createElement("div", { className: "ps-mobile-chat-pane" },
            React.createElement(ChatPane, { controller, mobile: true, fullWidth: true })));
}

/** Frame-and-easel glyph for the Canvas toggle. */
function CanvasGlyph() {
    const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };
    return React.createElement("svg", { viewBox: "0 0 20 20", width: 16, height: 16, "aria-hidden": "true" },
        React.createElement("rect", { x: 2.5, y: 3.5, width: 15, height: 11, rx: 1.5, ...stroke }),
        React.createElement("path", { d: "M5.5 11.5l3-3.5 2.5 2.5 3.5-4", ...stroke }),
        React.createElement("path", { d: "M7 17.5h6M10 14.5v3", ...stroke }));
}

/**
 * Diagnostics: a bug, for "debug".
 *
 * Not a cog — the admin console owns that — and not sliders, which the filter
 * funnel is already close enough to.
 */
function DiagnosticsGlyph() {
    // Bigger than its neighbours on purpose, and drawn heavier. A bug is a
    // busier shape than a funnel or a cog: at 16px with hairline legs it
    // collapsed into a smudge, so it takes 20px and a thicker stroke to read
    // as the same visual weight.
    const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
    return React.createElement("svg", { viewBox: "0 0 20 20", width: 20, height: 20, "aria-hidden": "true" },
        // Shell, with the seam that says beetle rather than pill.
        React.createElement("path", { d: "M6.2 8.6a3.8 3.8 0 0 1 7.6 0v2.9a3.8 3.8 0 0 1-7.6 0z", ...stroke }),
        React.createElement("path", { d: "M6.2 10.3h7.6", ...stroke }),
        // Head and antennae.
        React.createElement("path", { d: "M7.6 6.5a2.4 2.4 0 0 1 4.8 0", ...stroke }),
        React.createElement("path", { d: "M8 4.4 6.9 2.9M12 4.4l1.1-1.5", ...stroke }),
        // Legs: three a side, the outer two angled so the silhouette reads.
        React.createElement("path", { d: "M6.3 8.6 3.8 7.4M6.2 10.6H3.6M6.3 12.6 3.8 13.9", ...stroke }),
        React.createElement("path", { d: "M13.7 8.6 16.2 7.4M13.8 10.6h2.6M13.7 12.6l2.5 1.3", ...stroke }));
}

/**
 * The canvas marker on a session row.
 *
 * Two states, and they must be tellable apart at a glance in a dense list:
 *   "canvas"  outline only — a canvas exists here
 *   "unseen"  outline plus a filled dot — it changed since you last looked
 *
 * Shape carries the meaning, not colour alone: the dot is visible in either
 * theme and to a reader who cannot separate the two hues.
 */
function SessionCanvasMark({ mark }) {
    if (mark !== "canvas" && mark !== "unseen") return null;
    const unseen = mark === "unseen";
    const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" };
    return React.createElement("span", {
        className: `ps-session-canvas-mark${unseen ? " is-unseen" : ""}`,
        title: unseen ? "Canvas updated since you last viewed it" : "This session has a canvas",
        "aria-label": unseen ? "Canvas updated" : "Has a canvas",
        role: "img",
    },
    React.createElement("svg", { viewBox: "0 0 16 16", width: 12, height: 12, "aria-hidden": "true" },
        React.createElement("rect", { x: 1.6, y: 2.6, width: 12.8, height: 9.2, rx: 1.4, ...stroke }),
        React.createElement("path", { d: "M6 14.4h4", ...stroke }),
        unseen
            ? React.createElement("circle", { cx: 12.4, cy: 4.6, r: 2.4, fill: "currentColor", stroke: "none" })
            : null));
}

/** Chain-link glyph for the canvas share button. */
function CanvasLinkGlyph() {
    const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
    return React.createElement("svg", { viewBox: "0 0 20 20", width: 14, height: 14, "aria-hidden": "true" },
        React.createElement("path", { d: "M8.5 11.5l3-3", ...stroke }),
        React.createElement("path", { d: "M7 13l-1.8 1.8a2.8 2.8 0 01-4-4l3-3a2.8 2.8 0 014 0", ...stroke }),
        React.createElement("path", { d: "M13 7l1.8-1.8a2.8 2.8 0 014 4l-3 3a2.8 2.8 0 01-4 0", ...stroke }));
}

/**
 * The canvas share dialog: two audiences, one live public token.
 *
 * - Session access: a plain deep link; portal sign-in + the existing
 *   visibility check do the authz. Always available.
 * - Anyone with link: the ONE public view token for this canvas. Created
 *   on demand, RESET rotates it (the old link dies instantly), Remove
 *   returns to unlinked. The raw token appears exactly once, right after
 *   mint — the server stores only its hash.
 *
 * Link management is a session:manage operation server-side; anyone else
 * sees the server's refusal inline.
 */
// Tab labels name the AUDIENCE, not the mechanism — the sharer is choosing
// who should be able to open this, not which token scheme to use.
const CANVAS_SHARE_TABS = [
    { id: "session", label: "Session access" },
    { id: "public", label: "Anyone with link" },
];

function CanvasShareDialog({ controller, sessionId, slot, onClose }) {
    const [info, setInfo] = React.useState(null);        // { exists, createdAt } | null while loading
    const [freshLink, setFreshLink] = React.useState(null); // the just-minted URL, shown once
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [copied, setCopied] = React.useState("");

    // Which kind of link the dialog is showing. Two tabs rather than two
    // stacked sections: the choice between "people who already have session
    // access" and "anyone holding this token" is the decision the sharer is
    // making, and stacking them put a destructive Reset next to an innocuous
    // deep link. Mirrors the Manage-session dialog's General/Access tabs.
    const [tab, setTab] = React.useState("session");
    // The canvas KV write policy (interactive-canvas-apps Part D): who may
    // write the app's shared state. null = not loaded / not supported.
    const [kvPolicy, setKvPolicy] = React.useState(null);
    // Who the VIEWER is on this canvas. Only an owner or an admin may change
    // the policy, so the control is disabled for everyone else rather than
    // letting them pick a value and then showing a refusal.
    const [kvMe, setKvMe] = React.useState(null);
    const transport = controller.transport;
    const sessionLink = `${window.location.origin}/?session=${encodeURIComponent(sessionId)}&view=canvas&slot=${slot}&max=1`;
    // The token variants all resolve the same hashed row: one token, N doors,
    // single-switch revocation whichever door the bearer uses.
    const linkRows = (url, keyPrefix) => React.createElement(MultiOriginLinkRows, {
        url, keyPrefix, copied, onCopy: copy,
    });

    const refresh = React.useCallback(() => {
        transport.getCanvasShareLink?.(sessionId, slot)
            .then((state) => setInfo(state || { exists: false }))
            .catch((err) => { setInfo({ exists: false }); setError(err?.message || String(err)); });
        if (typeof transport.readCanvasKv === "function") {
            transport.readCanvasKv(sessionId, slot, { limit: 1 })
                .then((read) => { setKvPolicy(read?.policy || "owner"); setKvMe(read?.me || null); })
                .catch(() => { setKvPolicy(null); setKvMe(null); });
        }
    }, [transport, sessionId, slot]);
    React.useEffect(() => { refresh(); }, [refresh]);

    const canSetKvPolicy = kvMe?.relation === "owner" || kvMe?.relation === "admin";

    const setPolicy = (value) => {
        setBusy(true); setError("");
        transport.setCanvasKvAccess(sessionId, slot, value)
            .then(() => setKvPolicy(value))
            .catch((err) => setError(err?.message || String(err)))
            .finally(() => setBusy(false));
    };

    const copy = (label, text) => {
        navigator.clipboard?.writeText(text)
            .then(() => { setCopied(label); window.setTimeout(() => setCopied(""), 1500); })
            .catch(() => setError("Could not reach the clipboard — copy the link manually."));
    };

    const mint = (isReset) => {
        setBusy(true); setError("");
        transport.resetCanvasShareLink(sessionId, slot)
            .then(({ token }) => {
                setFreshLink(`${window.location.origin}/?canvasShare=${encodeURIComponent(token)}`);
                setInfo({ exists: true });
            })
            .catch((err) => setError(err?.message || String(err)))
            .finally(() => setBusy(false));
        void isReset;
    };

    const remove = () => {
        setBusy(true); setError("");
        transport.removeCanvasShareLink(sessionId, slot)
            .then(() => { setFreshLink(null); setInfo({ exists: false }); })
            .catch((err) => setError(err?.message || String(err)))
            .finally(() => setBusy(false));
    };

    return React.createElement("div", { className: "ps-canvas-share-overlay", onClick: onClose },
        React.createElement("div", { className: "ps-canvas-share-dialog", onClick: (e) => e.stopPropagation(), role: "dialog", "aria-label": "Share canvas" },
            React.createElement("div", { className: "ps-canvas-share-title" },
                "Share this canvas",
                React.createElement("button", { type: "button", className: "ps-mini-button", onClick: onClose, "aria-label": "Close" }, "✕")),

            React.createElement("div", { className: "ps-manage-tabs", role: "tablist" },
                CANVAS_SHARE_TABS.map((t) => React.createElement("button", {
                    key: t.id,
                    type: "button",
                    role: "tab",
                    "aria-selected": tab === t.id ? "true" : "false",
                    className: `ps-manage-tab${tab === t.id ? " is-active" : ""}`,
                    onClick: () => setTab(t.id),
                }, t.label))),

            // Both panels are always rendered, stacked in one grid cell, with
            // the inactive one held at visibility:hidden. It still occupies
            // its space, so the dialog is always as tall as the TALLER tab and
            // switching tabs never resizes the box. Sizing this way (rather
            // than a min-height guess) also stays correct when the panels grow:
            // one link box on a single-origin deployment, two plus Copy all on
            // a multi-origin one. visibility:hidden also takes the hidden
            // panel's inputs and buttons out of the tab order and the
            // accessibility tree, so nothing offscreen is reachable.
            React.createElement("div", { className: "ps-canvas-share-panels" },
                React.createElement("div", {
                    className: `ps-canvas-share-panel${tab === "session" ? " is-active" : ""}`,
                    role: "tabpanel", "aria-hidden": tab === "session" ? undefined : "true",
                },
                    React.createElement("div", { className: "ps-canvas-share-sub" }, "Opens the portal signed in, canvas full screen. Session visibility rules apply."),
                    linkRows(sessionLink, "session"),
                    // Who may WRITE the app's shared state. Stated in words:
                    // "readers" reaches everyone the session is read-shared
                    // with, which a dialog that only says "link" hides.
                    kvPolicy !== null
                        ? React.createElement("div", { className: "ps-canvas-share-policy" },
                            React.createElement("label", { className: "ps-canvas-share-sub", htmlFor: "ps-canvas-kv-policy" }, "Who can edit inside this app"),
                            React.createElement("select", {
                                id: "ps-canvas-kv-policy",
                                className: "ps-canvas-slot-select",
                                value: kvPolicy,
                                disabled: busy || !canSetKvPolicy,
                                onChange: (event) => setPolicy(event.target.value),
                            },
                                React.createElement("option", { value: "owner" }, "Only people who can edit the session"),
                                React.createElement("option", { value: "readers" }, "Anyone who can open the session"),
                                React.createElement("option", { value: "link" }, "Anyone who can open the session, plus link viewers")),
                            React.createElement("div", { className: "ps-canvas-share-sub" },
                                kvPolicy === "owner"
                                    ? "You, admins, and anyone you shared the session with as “write”. People with view-only access can watch the app but not change anything in it."
                                    : kvPolicy === "link"
                                        ? "Your view-only people can edit inside the app. Anyone holding the share link can watch it — link holders can never edit."
                                        : "Adds your view-only people: they can edit inside the app. It does not let them message the agent."),
                            canSetKvPolicy
                                ? null
                                : React.createElement("div", { className: "ps-canvas-share-sub" },
                                    "Only the session owner or an admin can change this."))
                        : null),
                React.createElement("div", {
                    className: `ps-canvas-share-panel${tab === "public" ? " is-active" : ""}`,
                    role: "tabpanel", "aria-hidden": tab === "public" ? undefined : "true",
                },
                    React.createElement("div", { className: "ps-canvas-share-sub" },
                        "View only, live, no sign-in. One link at a time — resetting makes the previous link stop working immediately."),
                    info === null
                        ? React.createElement("div", { className: "ps-canvas-share-sub" }, "Checking…")
                        : freshLink
                            ? React.createElement(React.Fragment, null,
                                linkRows(freshLink, "public"),
                                React.createElement("div", { className: "ps-canvas-share-sub is-warn" },
                                    "Copy it now — the link is shown only this once."))
                            : info.exists
                                ? React.createElement("div", { className: "ps-canvas-share-sub" },
                                    `A link exists${info.createdAt ? ` (created ${new Date(info.createdAt).toLocaleString()})` : ""}. For safety it cannot be re-shown — Reset to get a new one.`)
                                : React.createElement("div", { className: "ps-canvas-share-sub" }, "No public link yet."),
                    React.createElement("div", { className: "ps-canvas-share-actions" },
                        React.createElement("button", { type: "button", className: "ps-mini-button", disabled: busy, onClick: () => mint(info?.exists) },
                            info?.exists ? "Reset link" : "Create link"),
                        info?.exists
                            ? React.createElement("button", { type: "button", className: "ps-mini-button", disabled: busy, onClick: remove }, "Remove link")
                            : null))),
            error ? React.createElement("div", { className: "ps-canvas-share-error" }, error) : null));
}

/**
 * The canvas slot controls: a dropdown when the session has more than one
 * drawn canvas, plus prev/next arrows. Hidden entirely with one canvas —
 * the common case stays exactly as it always looked. Slot state is
 * ui.canvasSlot (in-memory; the selector clamps to a drawn slot).
 */
function CanvasSlotControls({ controller, view, compact = false }) {
    const slots = Array.isArray(view.slots) ? view.slots : [];
    if (slots.length <= 1) return null;
    const order = slots.map((s2) => s2.slot);
    const at = Math.max(0, order.indexOf(view.slot));
    const go = (delta) => {
        const next = order[(at + delta + order.length) % order.length];
        controller.dispatch({ type: "ui/canvasSlot", slot: next });
    };
    const labelFor = (s2) => (s2.name ? s2.name : `canvas ${s2.slot}`) + (s2.unseen ? " •" : "");
    return React.createElement("span", { className: `ps-canvas-slot-controls${compact ? " is-compact" : ""}` },
        React.createElement("button", {
            type: "button", className: "ps-artifact-pane-btn",
            onClick: () => go(-1), title: "Previous canvas", "aria-label": "Previous canvas",
        }, "\u2039"),
        React.createElement("select", {
            className: "ps-canvas-slot-select",
            value: view.slot,
            onChange: (e) => controller.dispatch({ type: "ui/canvasSlot", slot: Number(e.target.value) }),
            "aria-label": "Choose canvas",
            title: "Choose canvas",
        }, slots.map((s2) => React.createElement("option", { key: s2.slot, value: s2.slot }, labelFor(s2)))),
        React.createElement("button", {
            type: "button", className: "ps-artifact-pane-btn",
            onClick: () => go(1), title: "Next canvas", "aria-label": "Next canvas",
        }, "\u203a"));
}

/** Zen: a narrow chat rail beside a wide canvas. */
function ZenGlyph() {
    const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };
    return React.createElement("svg", { viewBox: "0 0 20 20", width: 15, height: 15, "aria-hidden": "true" },
        React.createElement("rect", { x: 2.2, y: 3.4, width: 3.6, height: 13.2, rx: 1, ...stroke }),
        React.createElement("rect", { x: 8.2, y: 3.4, width: 9.6, height: 13.2, rx: 1, ...stroke }));
}

/** Corners pushing OUT — take the whole screen. */
function MaximizeGlyph() {
    const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" };
    return React.createElement("svg", { viewBox: "0 0 20 20", width: 13, height: 13, "aria-hidden": "true" },
        React.createElement("path", { d: "M8 3H3v5M12 3h5v5M12 17h5v-5M8 17H3v-5", ...stroke }));
}

/** Corners pulling IN — back to the canvas inset in the content region. */
function RestoreGlyph() {
    const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" };
    return React.createElement("svg", { viewBox: "0 0 20 20", width: 13, height: 13, "aria-hidden": "true" },
        React.createElement("path", { d: "M3 8h5V3M17 8h-5V3M17 12h-5v5M3 12h5v5", ...stroke }));
}

/**
 * Double-buffered canvas frame with PER-REVISION blob URLs.
 *
 * Deliberately not the artifact preview panel: that component nulls its frame
 * URL when its fetch key changes (right for a DIFFERENT document, a blank
 * flash for a redraw of the same one) and shares one URL between live and
 * staging frames. Here each fetched revision owns its URL; the replacement
 * loads hidden-but-painted behind the live frame and is promoted on load, so
 * a live redraw is a composite swap of something already drawn.
 */
function CanvasFrame({ controller, sessionId, slot = 1, latestRev, zoom, visible = true, focusOnPromote = false, dataRev = 0, dataPayload = null, dataPatch = null }) {
    const [live, setLive] = React.useState(null);       // { url, rev }
    const [staging, setStaging] = React.useState(null); // { url, rev }
    const [loadError, setLoadError] = React.useState(null); // { rev }
    const [retryTick, setRetryTick] = React.useState(0);
    // Blob URLs tracked in a ref so cleanup can revoke directly — setState
    // updaters are neither a reliable post-unmount hook nor a pure place for
    // side effects (StrictMode double-invokes them).
    const urlsRef = React.useRef({ live: null, staging: null });
    const autoRetryRef = React.useRef({ rev: 0, used: false });
    const hostRef = React.useRef(null);
    const liveIframeElRef = React.useRef(null);
    // The staging frame's element, so the KV bridge can answer a page's
    // `ready` posted at script time (before promote). See the bridge below.
    const stagingIframeElRef = React.useRef(null);
    const hostBox = useElementBox(hostRef);
    // The frame geometry each revision LOADED at. A sandboxed page cannot be
    // poked after the fact (no reaching into an opaque origin), and pages
    // routinely measure the viewport exactly once — so when the pane settles
    // at a materially different size than the page loaded at (boot-time
    // hydration, a column resize, zoom), the only honest fix is the reader's:
    // reload through the double buffer at the new size. Verified live: a page
    // loading during boot measured the iframe's INTRINSIC 150px default and
    // baked it in, which is how a full-height game renders as a bottom sliver
    // under a black void.
    const loadedBoxRef = React.useRef(null);
    const zoomRef = React.useRef(zoom);
    zoomRef.current = zoom;
    const visibleRef = React.useRef(visible);
    visibleRef.current = visible;

    // The interactive-canvas bridge. Provenance is THIS check: a message is
    // accepted only when its source window is the LIVE canvas iframe — the
    // staging frame, the artifact reader, file previews, and every other
    // window on the page fail the identity test. Contract validation and
    // rate limiting happen in controller.submitCanvasAction; with no
    // contract on the current revision, nothing is accepted at all.
    React.useEffect(() => {
        if (!controller || !sessionId) return undefined;
        const onMessage = (event) => {
            const frameEl = liveIframeElRef.current;
            const payload = event.data;
            if (!payload || typeof payload !== "object" || !event.source) return;
            const fromLive = Boolean(frameEl && event.source === frameEl.contentWindow);
            // A document runs its scripts in the STAGING frame first and is
            // promoted on load — so a page that calls CanvasKV() at script
            // time posts `ready` before this frame is live. KV READS are
            // safe to answer from the staging frame of THIS canvas (it holds
            // the revision about to go live; the reply goes back to the
            // window that asked). Writes and actions stay live-frame only.
            const fromStaging = Boolean(stagingIframeElRef.current && event.source === stagingIframeElRef.current.contentWindow);
            if (!fromLive && !fromStaging) return;
            if (payload.type === "canvas-action") {
                if (!fromLive) return;
                controller.submitCanvasAction(sessionId, payload).then((result) => {
                    if (result && result.ok === false && typeof console !== "undefined") {
                        console.warn(`canvas action rejected: ${result.reason}`);
                    }
                }).catch(() => {});
                return;
            }
            // The KV bridge (door 1). The page never names the session or the
            // slot — both come from THIS frame — and never sends `by`: the
            // server stamps it from the signed-in principal.
            if (payload.type === "canvas-kv") {
                const id = payload.id;
                const transport = controller.transport;
                // Reply to the window that ASKED (live or staging), never to
                // whichever frame is live by the time the request lands.
                const source = event.source;
                const post = (message) => {
                    try { source.postMessage(message, "*"); } catch { /* frame mid-teardown */ }
                };
                const fail = (error, code = "ERROR") => post({ type: "canvas-kv-result", id, ok: false, error: String(error?.message || error || "failed"), code: error?.code || code });
                if (typeof transport?.readCanvasKv !== "function") { fail("the canvas KV store is not available on this deployment", "UNAVAILABLE"); return; }
                const op = String(payload.op || "");
                if (!fromLive && (op === "put" || op === "delete")) {
                    fail("the canvas is still loading; retry the write in a moment", "NOT_READY");
                    return;
                }
                if (op === "ready" || op === "list") {
                    transport.readCanvasKv(sessionId, slot, { prefix: payload.prefix ?? null, limit: payload.limit ?? null, after: payload.after ?? null })
                        .then((read) => post({
                            type: op === "ready" ? "canvas-kv-ready" : "canvas-kv-result",
                            id, ok: true,
                            entries: read?.entries ?? [], nextAfter: read?.nextAfter ?? null,
                            me: read?.me ?? null, canWrite: Boolean(read?.me?.canWrite), policy: read?.policy ?? "owner",
                        }))
                        .catch(fail);
                    return;
                }
                if (op === "get") {
                    transport.readCanvasKv(sessionId, slot, { key: payload.key })
                        .then((read) => post({ type: "canvas-kv-result", id, ok: true, entry: read?.entries?.[0] ?? null }))
                        .catch(fail);
                    return;
                }
                if (op === "put" || op === "delete") {
                    const one = op === "put"
                        ? { op: "put", key: payload.key, value: payload.value, ...(payload.ifMatch != null ? { ifMatch: payload.ifMatch } : {}) }
                        : { op: "delete", key: payload.key, ...(payload.ifMatch != null ? { ifMatch: payload.ifMatch } : {}) };
                    transport.writeCanvasKv(sessionId, slot, [one])
                        .then((written) => {
                            const r = written?.results?.[0] ?? { ok: false, error: "no result" };
                            post({ type: "canvas-kv-result", id, ok: Boolean(r.ok), key: r.key, rev: r.rev, capped: r.capped, error: r.error, code: r.code });
                        })
                        .catch(fail);
                    return;
                }
                fail(`unknown canvas-kv op ${op}`, "INVALID_REQUEST");
            }
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [controller, sessionId, slot]);

    // Live KV changes for this slot → the page, as `canvas-kv-change`. A
    // pointer-only ping (value too big for the notify) fetches that one key.
    React.useEffect(() => {
        if (!controller || !sessionId || typeof controller.subscribeCanvasKv !== "function") return undefined;
        return controller.subscribeCanvasKv(sessionId, (change) => {
            if (!change || Number(change.slot) !== Number(slot)) return;
            const frameWindow = liveIframeElRef.current?.contentWindow;
            if (!frameWindow) return;
            const deliver = (entry) => {
                try { frameWindow.postMessage({ type: "canvas-kv-change", key: change.key, rev: change.rev, op: change.op, ...(entry ? { v: entry.v, by: entry.by, at: entry.at } : {}) }, "*"); } catch { /* frame mid-teardown */ }
            };
            if (change.op === "delete") { deliver(null); return; }
            if (change.value && typeof change.value === "object") { deliver({ v: change.value.v, by: change.value.by, at: change.value.at }); return; }
            controller.transport?.readCanvasKv?.(sessionId, slot, { key: change.key })
                .then((read) => deliver(read?.entries?.[0] ?? null))
                .catch(() => { /* the page's next list catches up */ });
        });
    }, [controller, sessionId, slot]);

    React.useEffect(() => {
        if (!controller || !sessionId || !latestRev) return undefined;
        let cancelled = false;
        let retryTimer = null;
        fetchArtifactHtmlObjectUrl(controller, sessionId, slot <= 1 ? "canvas.html" : `canvas${slot}.html`)
            .then((url) => {
                if (cancelled) { URL.revokeObjectURL(url); return; }
                // A staging revision that never loaded is superseded here —
                // revoke it, or every rapid redraw leaks a document-sized blob.
                if (urlsRef.current.staging && urlsRef.current.staging !== urlsRef.current.live) {
                    URL.revokeObjectURL(urlsRef.current.staging);
                }
                urlsRef.current.staging = url;
                setLoadError(null);
                setStaging({ url, rev: latestRev });
            })
            .catch(() => {
                if (cancelled) return;
                // One quiet retry for transient blips; after that, surface it.
                // The next draw event or a pane re-open also refetches.
                if (autoRetryRef.current.rev !== latestRev) autoRetryRef.current = { rev: latestRev, used: false };
                if (!autoRetryRef.current.used) {
                    autoRetryRef.current.used = true;
                    retryTimer = setTimeout(() => { if (!cancelled) setRetryTick((t) => t + 1); }, 1500);
                    return;
                }
                setLoadError({ rev: latestRev });
            });
        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
        };
    }, [controller, sessionId, slot, latestRev, retryTick]);

    // Session switch / unmount: drop both frames — a different session is a
    // different document, and showing the old canvas under a new session is a
    // lie. Revocation goes through the ref, not state updaters.
    React.useEffect(() => () => {
        if (urlsRef.current.staging && urlsRef.current.staging !== urlsRef.current.live) {
            URL.revokeObjectURL(urlsRef.current.staging);
        }
        if (urlsRef.current.live) URL.revokeObjectURL(urlsRef.current.live);
        urlsRef.current = { live: null, staging: null };
        setLive(null);
        setStaging(null);
        setLoadError(null);
    }, [sessionId]);

    const promote = React.useCallback((frame) => {
        // Only the CURRENT staging revision promotes — a load event from a
        // frame the fetch effect already superseded must not go live again.
        if (!frame || urlsRef.current.staging !== frame.url) return;
        const oldLive = urlsRef.current.live;
        urlsRef.current.live = frame.url;
        urlsRef.current.staging = null;
        if (oldLive && oldLive !== frame.url) URL.revokeObjectURL(oldLive);
        setLive(frame);
        setStaging((current) => (current && current.url === frame.url ? null : current));
        // Record the geometry this revision loaded at (in page-viewport
        // units, i.e. divided by zoom) — the settle effect below compares
        // against it to decide when a reload is owed.
        const hostEl = hostRef.current;
        if (hostEl) {
            const rect = hostEl.getBoundingClientRect();
            const z = zoomRef.current || 1;
            loadedBoxRef.current = { w: Math.round(rect.width / z), h: Math.round(rect.height / z) };
        }
        // The surface's receipt: THIS is the one place a revision is known to
        // be truly on screen, so this is where viewed-marking lives. Mode
        // transitions marking revs viewed claimed phones saw drawings their
        // layout never showed. A frame kept MOUNTED but hidden (the sticky
        // toggle) still promotes new revisions in the background — those are
        // NOT viewed; the badge must light until the user actually looks.
        if (controller && sessionId && visibleRef.current) {
            controller.dispatch({ type: "canvas/viewed", sessionId, slot, rev: frame.rev });
        }
        // iOS: a programmatic focus into the freshly promoted frame is the
        // synchronous interaction that registers its scroller — the code
        // equivalent of the tap users discovered by accident. preventScroll
        // so the viewport never jumps. Phone-only (the desktop must not have
        // its composer focus stolen by a background draw).
        if (focusOnPromote && visibleRef.current) {
            try { liveIframeElRef.current?.focus({ preventScroll: true }); } catch { /* best effort */ }
        }
    }, [controller, sessionId, focusOnPromote]);

    // The LLM→page half of the duplex: post the latest data tick INTO the
    // live frame. Keyed on BOTH the tick and the live frame identity, so a
    // freshly promoted document (redraw, reload, cold open) replays the
    // current state without the agent doing anything — the page just needs
    // one idempotent applyData(). Posting into a cross-origin frame is
    // allowed; a page with no listener ignores it.
    React.useEffect(() => {
        if (!live || !dataRev || dataPayload === null) return;
        try {
            liveIframeElRef.current?.contentWindow?.postMessage(
                { type: "canvas-data", data: dataPayload, dataRev }, "*",
            );
            // The delta that produced this state, for pages that registered a
            // canvas-patch listener (targeted DOM updates, transitions). The
            // whole-state message above ALWAYS accompanies it — applyData
            // stays the mandatory floor; the patch is the opt-in fast path.
            if (dataPatch) {
                liveIframeElRef.current?.contentWindow?.postMessage(
                    { type: "canvas-patch", patch: dataPatch, dataRev }, "*",
                );
            }
        } catch { /* frame mid-teardown */ }
        // On-screen injection = seen; hidden injection leaves the badge lit
        // until the user actually looks (the catch-up below files it then).
        if (controller && sessionId && visibleRef.current) {
            controller.dispatch({ type: "canvas/viewed", sessionId, slot, dataRev });
        }
    }, [live, dataRev, dataPayload, dataPatch, controller, sessionId]);

    // Catch-up receipt: becoming visible with a live revision on screen IS
    // viewing it — this is what clears a badge earned while hidden.
    React.useEffect(() => {
        if (visible && live && controller && sessionId) {
            controller.dispatch({ type: "canvas/viewed", sessionId, slot, rev: live.rev, ...(dataRev ? { dataRev } : {}) });
            if (focusOnPromote) {
                try { liveIframeElRef.current?.focus({ preventScroll: true }); } catch { /* best effort */ }
            }
        }
    }, [visible, live, controller, sessionId, focusOnPromote, dataRev]);

    // Settle-reload: once the pane's size (or zoom) stops moving somewhere
    // materially different from where the live page loaded, refetch the same
    // revision through the staging buffer so the page re-runs its layout at
    // the true viewport. Debounced past the resize gesture; a couple of px
    // of tolerance so subpixel wobble never churns it.
    React.useEffect(() => {
        if (!live || !visible) return undefined;
        const z = zoom || 1;
        const w = Math.round((hostBox.width || 0) / z);
        const h = Math.round((hostBox.height || 0) / z);
        if (!w || !h) return undefined;
        const loadedAt = loadedBoxRef.current;
        if (loadedAt) {
            // A page that loaded against a REAL box owns its layout from then
            // on and is NEVER auto-reloaded: the inner window receives genuine
            // resize events when this element changes size (sandboxing blocks
            // DOM poking, not resize), and a reload would cost a stateful app
            // — a game, a half-filled form — everything it holds, for a
            // purely cosmetic guarantee. Observed live: dragging the desktop
            // window reset a farm game to day 1. Settle-reload exists ONLY to
            // rescue documents that loaded against a degenerate box — the
            // iframe's 300×150 intrinsic default before layout, or a hidden
            // host — and baked that measurement in.
            const loadedDegenerate = loadedAt.w < 220 || loadedAt.h < 170;
            if (!loadedDegenerate) return undefined;
            const dw = Math.abs(loadedAt.w - w);
            const dh = Math.abs(loadedAt.h - h);
            if (dw <= 2 && dh <= 2) return undefined;
            // Height-only jitter is iOS toolbar churn (the URL bar collapses
            // and expands, ±6% or so) — a reload for that costs the user
            // their scroll position and page state for nothing.
            if (dw <= 2 && dh / Math.max(1, loadedAt.h) < 0.15) return undefined;
        }
        const timer = setTimeout(() => {
            loadedBoxRef.current = { w, h };
            setRetryTick((t) => t + 1);
        }, 350);
        return () => clearTimeout(timer);
    }, [hostBox.width, hostBox.height, zoom, live, visible]);

    const zoomStyle = zoom !== 1 && hostBox.width > 0
        ? {
            flex: "none",
            width: `${Math.max(1, Math.round(hostBox.width / zoom))}px`,
            height: `${Math.max(1, Math.round(hostBox.height / zoom))}px`,
            transform: `scale(${zoom})`,
            transformOrigin: "top left",
        }
        : undefined;

    return React.createElement("div", { ref: hostRef, className: "ps-html-preview-host is-fitting" },
        [live, staging].filter(Boolean).map((frame) => React.createElement("iframe", {
            key: `canvas:${frame.rev}:${frame.url}`,
            ref: frame === live
                ? ((el) => { liveIframeElRef.current = el; })
                : ((el) => { stagingIframeElRef.current = el; }),
            className: `ps-html-preview-frame${frame === live ? "" : " is-staging"}`,
            style: zoomStyle,
            src: frame.url,
            title: "Session canvas",
            // Same sandbox contract as artifact previews — no allow-same-origin.
            sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox",
            // The autoplay Permissions Policy defaults to `self`, and a
            // sandboxed frame has an OPAQUE origin — so a canvas page could
            // build an AudioContext, get no error, and emit nothing. Granting
            // autoplay is what lets a game's sound effects actually play.
            allow: "autoplay *",
            referrerPolicy: "no-referrer",
            onLoad: frame === staging ? () => promote(frame) : undefined,
        })),
        loadError
            ? React.createElement("div", { className: "ps-canvas-load-error" },
                React.createElement("span", null,
                    live
                        ? `Couldn't load rev ${loadError.rev} — showing rev ${live.rev}.`
                        : `Couldn't load rev ${loadError.rev}.`),
                React.createElement("button", {
                    type: "button",
                    className: "ps-artifact-pane-btn",
                    onClick: () => { autoRetryRef.current = { rev: 0, used: false }; setLoadError(null); setRetryTick((t) => t + 1); },
                }, "Retry"))
            : null);
}

/**
 * The session's standing display: rendered from the reserved canvas.html
 * artifact and converging live on canvas_updated events.
 *
 * Desktop mounts it in the right column, where it replaces the
 * inspector/activity split while active (the artifact reader still takes
 * precedence while open and returns here). The phone mounts it as a layer over
 * the content region — see MobileCanvasLayer — and gets a stripped header: the
 * revision on one thin line with a maximize toggle, no zoom control and no ✕,
 * because there the toolbar's Canvas button is the only way in or out.
 *
 * maximized / onToggleMaximized are the phone's full-screen state, owned by
 * MobileCanvasLayer. Passing no handler simply omits the button.
 */
function CanvasPane({ controller, mobile = false, visible = true, focusOnPromote = false, maximized = false, onToggleMaximized = null }) {
    const view = useControllerSelector(controller, selectCanvasView, shallowEqualObject);
    const zoom = useControllerSelector(controller, (state) => Number(state.files.htmlZoom) || 1);
    const setZoom = React.useCallback((next) => {
        controller.dispatch({ type: "files/htmlZoom", zoom: next });
    }, [controller]);

    // Belt to the selection-burst braces: a pane mounted before the burst's
    // snapshot resolves (deep link straight into canvas mode) fetches it here;
    // the memo makes the duplicate call free.
    React.useEffect(() => {
        if (view.sessionId) controller.ensureCanvasSnapshot(view.sessionId).catch(() => {});
    }, [controller, view.sessionId]);

    const zenOn = useControllerSelector(controller, (s) => s?.ui?.canvasZen === true);
    const [shareOpen, setShareOpen] = React.useState(false);
    const [toolbarSlot, setToolbarSlot] = React.useState(null);
    React.useEffect(() => {
        if (!maximized) { setToolbarSlot(null); return undefined; }
        // The slot is rendered by the Toolbar in the SAME commit that flips
        // maximized, so poll one frame rather than racing it.
        let raf = 0;
        const find = () => {
            const el = document.getElementById("ps-toolbar-canvas-slot");
            if (el) setToolbarSlot(el);
            else raf = requestAnimationFrame(find);
        };
        find();
        return () => cancelAnimationFrame(raf);
    }, [maximized]);
    const closeCanvas = React.useCallback(() => {
        controller.dispatch({ type: "ui/canvasOpen", open: false, sessionId: view.sessionId, manual: true });
    }, [controller, view.sessionId]);

    // The phone's header is ONE thin line: `rev 4` on the left, the
    // maximize/restore toggle hard right. Nothing else — no ✕ (the toolbar's
    // Canvas button is the way out) and no zoom control, because every pixel
    // of height here is canvas the user can no longer see.
    //
    // The strip renders whenever there is a revision to name OR the canvas is
    // maximized. That second half is not cosmetic: maximized covers the whole
    // viewport including the toolbar, so if a cleared canvas (sizeBytes 0)
    // dropped the strip it would take the only way back with it.
    const showRevStrip = mobile && (view.exists || maximized);
    const header = mobile
        ? (showRevStrip
            ? React.createElement("header", { className: "ps-artifact-pane-bar is-rev-strip" },
                React.createElement("span", { className: "ps-artifact-pane-type", title: view.note || undefined },
                    view.exists ? `${view.name ? `${view.name} \u00b7 ` : ""}rev ${view.latestRev}` : ""),
                React.createElement(CanvasSlotControls, { controller, view, compact: true }),
                view.exists
                    ? React.createElement("button", {
                        type: "button",
                        className: "ps-canvas-max-btn",
                        onClick: () => setShareOpen(true),
                        title: "Share this canvas — copy a view link",
                        "aria-label": "Share canvas",
                    }, React.createElement(CanvasLinkGlyph))
                    : null,
                onToggleMaximized
                    ? React.createElement("button", {
                        type: "button",
                        className: "ps-canvas-max-btn",
                        onClick: onToggleMaximized,
                        title: maximized ? "Back to the inset canvas" : "Maximize — cover the whole screen",
                        "aria-label": maximized ? "Restore canvas" : "Maximize canvas",
                    }, React.createElement(maximized ? RestoreGlyph : MaximizeGlyph))
                    : null)
            : null)
        : (maximized ? (toolbarSlot ? createPortal(React.createElement(React.Fragment, null,
            view.exists
                ? React.createElement("span", { className: "ps-toolbar-canvas-rev" }, `${view.name ? `${view.name} \u00b7 ` : ""}rev ${view.latestRev}`)
                : null,
            React.createElement(CanvasSlotControls, { controller, view, compact: true }),
            view.exists ? React.createElement(HtmlZoomControl, { zoom, setZoom }) : null,
            React.createElement("button", {
                type: "button",
                className: `ps-artifact-pane-btn${zenOn ? " is-active" : ""}`,
                // Full screen covers the workspace, so a bare zen toggle
                // changes state UNDER the layer and looks dead. From here zen
                // means "step down into zen": drop full screen in the same
                // click so the change is visible.
                onClick: () => {
                    controller.dispatch({ type: "ui/canvasMaximized", on: false });
                    controller.dispatch({ type: "ui/canvasZen", on: !zenOn });
                },
                title: zenOn ? "Leave zen — bring back sessions and panels" : "Zen — chat rail + canvas only",
                "aria-label": zenOn ? "Leave zen mode" : "Zen mode",
            }, React.createElement(ZenGlyph)),
            React.createElement("button", {
                type: "button",
                className: "ps-artifact-pane-btn ps-toolbar-canvas-restore",
                onClick: () => controller.dispatch({ type: "ui/canvasMaximized", on: false }),
                title: "Back to the workspace",
                "aria-label": "Restore canvas",
            }, React.createElement(RestoreGlyph))), toolbarSlot) : null)
        : React.createElement("header", { className: "ps-artifact-pane-bar" },
            React.createElement("span", { className: "ps-artifact-pane-heading" },
                React.createElement("span", { className: "ps-artifact-pane-name ps-canvas-pane-glyph", title: view.note || "Canvas" },
                    React.createElement(CanvasGlyph)),
                view.exists
                    ? React.createElement("span", { className: "ps-artifact-pane-type", title: view.note || undefined },
                        `${view.name ? `${view.name} \u00b7 ` : ""}rev ${view.latestRev}`)
                    : null,
                React.createElement(CanvasSlotControls, { controller, view })),
            React.createElement("span", { className: "ps-artifact-pane-actions" },
                view.exists ? React.createElement(HtmlZoomControl, { zoom, setZoom }) : null,
                view.exists
                    ? React.createElement("button", {
                        type: "button",
                        className: "ps-artifact-pane-btn",
                        onClick: () => setShareOpen(true),
                        title: "Share this canvas — copy a view link",
                        "aria-label": "Share canvas",
                    }, React.createElement(CanvasLinkGlyph))
                    : null,
                // Zen: sessions step away, chat becomes a rail, the canvas is
                // the workbench. The mode for "the work happens on the canvas,
                // chat is for steering".
                React.createElement("button", {
                    type: "button",
                    className: `ps-artifact-pane-btn${zenOn ? " is-active" : ""}`,
                    onClick: () => controller.dispatch({ type: "ui/canvasZen" }),
                    title: zenOn ? "Leave zen — bring back sessions and panels" : "Zen — chat rail + canvas only",
                    "aria-label": zenOn ? "Leave zen mode" : "Zen mode",
                }, React.createElement(ZenGlyph)),
                // Full screen. No ✕ beside it: the toolbar's Canvas button is
                // the way out, and a second close control in a pane that also
                // has a toggle is one affordance too many.
                //
                // While full screen this whole bar is hidden and the rev and
                // the way back are promoted into the portal header, so the
                // control never disappears with the pane that drew it.
                React.createElement("button", {
                    type: "button",
                    className: "ps-artifact-pane-btn",
                    onClick: () => controller.dispatch({ type: "ui/canvasMaximized", on: true }),
                    title: "Full screen — hide chat and sessions",
                    "aria-label": "Full screen canvas",
                }, React.createElement(MaximizeGlyph)))));

    return React.createElement("section", {
        className: "ps-artifact-pane ps-canvas-pane",
        role: "region",
        "aria-label": "Session canvas",
    },
    header,
    React.createElement("div", { className: "ps-artifact-pane-body" },
        view.exists
            ? React.createElement(CanvasFrame, {
                key: `slot:${view.slot}`,
                controller,
                sessionId: view.sessionId,
                slot: view.slot,
                latestRev: view.latestRev,
                zoom,
                visible,
                focusOnPromote,
                dataRev: view.latestDataRev,
                dataPayload: view.dataPayload,
                dataPatch: view.dataPatch,
            })
            : React.createElement("div", { className: "ps-canvas-blank" },
                React.createElement("p", { className: "ps-canvas-blank-title" }, "Nothing on the canvas yet."),
                React.createElement("p", null,
                    "Ask the agent to draw — a dashboard, a chart, a diagram — or it will draw when it has something worth showing."))),
        shareOpen && view.exists
            ? React.createElement(CanvasShareDialog, {
                controller,
                sessionId: view.sessionId,
                slot: view.slot,
                onClose: () => setShareOpen(false),
            })
            : null);
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
function FilesPane({ controller, focused, mobile = false, previewOnly = false, nativeScroll = false, chromeless = false }) {
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
        // Deep link to THIS artifact, opened full screen. Same URL shape the
        // agent's show_artifact tool hands back, so a link pasted in chat and a
        // link copied here land in exactly the same place.
        React.createElement(IconButton, {
            icon: "🔗",
            label: "Copy link to this artifact",
            onClick: () => {
                const url = buildArtifactLinkUrl(filesView.selectedSessionId, filesView.selectedFilename);
                if (!url) return;
                copySessionLinkText(url);
                controller.dispatch({ type: "ui/status", text: ARTIFACT_LINK_COPIED_STATUS });
            },
            disabled: !hasSelection || !filesView.selectedFilename,
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

    // HTML renders as HTML. Note this branch does NOT require previewContent:
    // the frame streams the artifact's own bytes, so it works even when the
    // text preview was truncated or never loaded.
    const previewIsHtml = previewReady
        && !filesView.previewIsBinary
        && isHtmlArtifact(filesView.selectedFilename, filesView.previewContentType);

    const previewPane = previewIsHtml
        ? React.createElement(HtmlArtifactPreviewPanel, {
            controller,
            sessionId: filesView.selectedSessionId,
            filename: filesView.selectedFilename,
            contentType: filesView.previewContentType,
            sizeBytes: filesView.previewSizeBytes,
            theme,
            color: "cyan",
            focused: false,
            title: null,
            chromeless,
        })
        : previewIsTabular
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
            contentWidth: getPortalInspectorContentWidth(paneWidth, inspectorTab, mobile),
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
    // allowWideColumns let the sequence grid exceed the viewport so a phone
    // could pan it — in practice it rendered clipped on BOTH edges (the
    // timestamps and the STATS header sliced off) and read as broken. Fitting
    // to width collapses surplus lanes into "…" instead, which is legible.
    //
    // The width itself is the pane's MEASURED column count wherever a
    // measurement exists — the legacy-model rightWidth imagines a split the
    // portal's draggable grid does not honor, which is how the sequence grid
    // used to spill past the pane edge and the stats boxes arrived pre-sliced.
    const [measuredCols, panelRef] = useMeasuredPaneColumns();
    const contentWidth = measuredCols ?? viewState.contentWidth;
    const inspector = React.useMemo(() => selectInspector(selectorState, {
        width: contentWidth,
    }), [selectorState, contentWidth]);
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

    // Ground-truth clamp, phones only. The global column count comes from a
    // window-level probe that phones have repeatedly proven able to lie to
    // (pinch state, desktop-site layout viewports, probe-context fonts). The
    // pane itself cannot lie: it measures its own content box and its own
    // rendered line font, and when the published count disagrees materially it
    // republishes from those measurements. Runs after paint on mount and tab
    // switches; the ±2 tolerance keeps it from ping-ponging with publish().
    const clampFrameRef = React.useRef(null);
    React.useEffect(() => {
        if (!mobile) return undefined;
        clampFrameRef.current = requestAnimationFrame(() => {
            try {
                const panel = document.querySelector(".ps-mobile-pane-fill .ps-inspector-pane .ps-scroll-panel");
                const line = panel ? panel.querySelector(".ps-line") : null;
                if (!panel || !line) return;
                const cs = window.getComputedStyle(line);
                const probe = document.createElement("span");
                probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;";
                probe.style.fontFamily = cs.fontFamily;
                probe.style.fontSize = cs.fontSize;
                probe.style.fontWeight = cs.fontWeight;
                probe.style.letterSpacing = cs.letterSpacing;
                probe.textContent = "0".repeat(100);
                line.parentElement.appendChild(probe);
                const charWidth = (probe.getBoundingClientRect().width / 100) || 8;
                probe.remove();
                const panelStyle = window.getComputedStyle(panel);
                const contentPx = panel.clientWidth
                    - (parseFloat(panelStyle.paddingLeft) || 0)
                    - (parseFloat(panelStyle.paddingRight) || 0);
                if (!(contentPx > 50)) return;
                const contentCols = Math.floor(contentPx / charWidth);
                // getPortalInspectorContentWidth hands the selector paneWidth-6
                // on mobile, so publishing contentCols+6 makes the selector see
                // exactly what the pane measured.
                const paneCols = contentCols + 6;
                const currentCols = controller.getState().ui.layout?.viewportWidth ?? 120;
                if (Math.abs(paneCols - currentCols) <= 2) return;
                controller.dispatch({ type: "ui/viewport", width: paneCols, height: null });
            } catch {
                // Measurement is best-effort; the publish path still stands.
            }
        });
        return () => {
            if (clampFrameRef.current) cancelAnimationFrame(clampFrameRef.current);
        };
    }, [controller, mobile, viewState.inspectorTab, viewState.activeSessionId]);

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
        panelRef,
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

    // Auto-grow: one line idle, sized to the RENDERED content (scrollHeight
    // sees soft wrap; counting "\n" does not). CSS max-height provides the
    // cap, after which the textarea scrolls internally. The measurement
    // zeroes the height first — NOT "auto": iOS Safari keeps a textarea's
    // scrollHeight at its high-water mark under "auto", so a box that grew
    // never shrank back after the text was sent or deleted.
    const growInput = React.useCallback(() => {
        const node = inputRef.current;
        if (!node) return;
        node.style.height = "0px";
        node.style.height = `${node.scrollHeight + 2}px`;
    }, []);
    React.useLayoutEffect(() => {
        growInput();
    }, [growInput, promptState.value]);
    React.useEffect(() => {
        // Width changes re-wrap the content; re-measure on viewport resizes
        // (covers rotation and the on-screen keyboard shrinking the pane).
        window.addEventListener("resize", growInput);
        return () => window.removeEventListener("resize", growInput);
    }, [growInput]);

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
            // Programmatic focus pops the on-screen keyboard on touch devices;
            // there, focus only ever comes from the user's own tap.
            if (mobile) return;
            try {
                inputNode.focus({ preventScroll: true });
            } catch {
                inputNode.focus();
            }
        }
        // Apply the model's caret ONLY when it disagrees with the DOM — that
        // is a programmatic intervention (pending-message recall, reference
        // autocomplete insert, draft restore). While the user edits, the DOM
        // is the source of truth and onSelect/onChange mirror it into state;
        // unconditionally echoing state back used to collapse in-progress
        // backward selections (mouse drag right-to-left, Shift+Left, and the
        // start handle of a touch selection).
        if (inputNode.value === promptState.value && inputNode.selectionStart !== promptState.cursor) {
            inputNode.setSelectionRange(promptState.cursor, promptState.cursor);
        }
    }, [active, mobile, promptState.cursor, promptState.value, promptState.focused, promptState.modalOpen]);

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
            // One line at rest; a layout effect grows it to the rendered
            // content and CSS max-height caps it. Never a manual resize grip.
            rows: 1,
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
            // On touch, Enter inserts a newline (the chevron sends) — the
            // keyboard must not advertise a send that will not happen.
            enterKeyHint: mobile ? "enter" : "send",
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
                // Arrow keys are NOT intercepted: the textarea's native cursor
                // movement understands soft-wrapped lines and goal columns;
                // onSelect mirrors every move into the shared model. (The old
                // hijack routed through the TUI's logical-line cursor and made
                // Down jump whole paragraphs inside wrapped text.)
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
            // pointerdown preventDefault on every action keeps focus in the
            // textarea — on a phone, tapping Send must not collapse the
            // keyboard between messages.
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
                        onPointerDown: (event) => event.preventDefault(),
                        onClick: () => attachInputRef.current?.click(),
                    }, "📎"))
                : null,
            promptState.editingPending && !selectedCancelling
                ? React.createElement("button", {
                    type: "button",
                    className: "ps-mini-button",
                    title: selectedQueued ? "Delete selected queued prompt" : "Cancel selected pending prompt",
                    "aria-label": selectedQueued ? "Delete selected queued prompt" : "Cancel selected pending prompt",
                    onPointerDown: (event) => event.preventDefault(),
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
                    onPointerDown: (event) => event.preventDefault(),
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
                onPointerDown: (event) => event.preventDefault(),
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

function Toolbar({ controller, mobile, canvasPaneOpen = false, onToggleCanvasPane = null, mobilePane = "workspace", onSelectMobilePane = null, mobileMainLayout = "split" }) {
    const [headerSlot, setHeaderSlot] = React.useState(null);
    React.useEffect(() => {
        if (typeof document === "undefined") return;
        // Desktop centres the toolbar in the portal header regardless of chat
        // view — the terminal view was spending a whole strip on it while the
        // rich view had already handed that row back to the panes. Mobile keeps
        // the inline strip; there is no header room for it on a phone.
        setHeaderSlot(!mobile ? document.getElementById("ps-header-toolbar-slot") : null);
    }, [mobile]);
    const adminVisible = useControllerSelector(controller, (state) => Boolean(state.admin?.visible));
    const budgetOpen = useControllerSelector(controller, (state) => Boolean(state.ui?.budgetOpen));
    const canvasView = useControllerSelector(controller, selectCanvasView, shallowEqualObject);
    const diagnosticsOpen = useControllerSelector(controller, (s) => s?.ui?.diagnosticsOpen === true);
    const canvasMaximized = useControllerSelector(controller, (s) => s?.ui?.canvasMaximized === true);
    // The artifact reader takes over the right side; while it is up, the
    // surface on screen is NOT the canvas, so the canvas toggle must not
    // read as active (its next press still shows the canvas).
    const artifactReaderOpen = useControllerSelector(controller, (s) => Boolean(s?.files?.paneOpen && s?.files?.selectedArtifactId));

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
        // Canvas toggle, both device classes: the desktop flips the right
        // column, the phone lays the canvas over the chat transcript — one
        // affordance, one badge, and on the phone the ONLY way in or out (the
        // canvas itself carries no ✕ there). While the canvas is hidden, an
        // undisplayed revision lights the badge.
        {
            key: "canvas",
            icon: React.createElement(CanvasGlyph),
            label: (mobile ? canvasPaneOpen : (canvasView.mode === "canvas" && !artifactReaderOpen))
                ? "Hide the canvas"
                : "Show canvas",
            onClick: () => {
                if (mobile) {
                    if (onToggleCanvasPane) onToggleCanvasPane();
                    return;
                }
                // Desktop: the canvas is a column of its own now. Closing it
                // shows nothing in its place — Diagnostics has its own toggle.
                controller.dispatch({
                    type: "ui/canvasOpen",
                    open: canvasView.mode !== "canvas",
                    sessionId: canvasView.sessionId,
                    manual: true,
                });
            },
            active: mobile ? canvasPaneOpen : (canvasView.mode === "canvas" && !artifactReaderOpen),
            badge: mobile
                ? (canvasView.exists
                    && (canvasView.latestRev > (canvasView.lastViewedRev || 0)
                        || (canvasView.latestDataRev || 0) > (canvasView.lastViewedDataRev || 0))
                    && !canvasPaneOpen)
                : canvasView.unseen,
            // Three states: plain outline (empty), green dot bottom-left
            // (loaded), green + yellow (loaded with unseen changes).
            loadedDot: canvasView.exists,
        },
        // Providers & Budgets. Both device classes: what a turn costs, and
        // what stopped a session, are answers a person needs wherever they
        // are — and unlike the admin console the surface reflows to a phone.
        {
            key: "budget",
            icon: React.createElement(CoinGlyph),
            label: budgetOpen ? "Close budget" : "Budget — providers, limits and usage",
            onClick: () => {
                if (budgetOpen) controller.closeBudget();
                else controller.openBudget().catch(() => {});
            },
            active: budgetOpen,
        },
        // Diagnostics — Inspector + Activity as one column, desktop only.
        //
        // They used to be tabs inside the chat pane and were always present.
        // Off by default now, and behind this toggle: they are instrumentation,
        // not part of reading a conversation. The phone keeps them as nav tabs,
        // where there is no column to put them in.
        ...(mobile ? [] : [{
            key: "diagnostics",
            icon: React.createElement(DiagnosticsGlyph),
            label: diagnosticsOpen ? "Hide diagnostics" : "Show diagnostics (inspector and activity)",
            onClick: () => controller.dispatch({ type: "ui/diagnosticsOpen" }),
            active: diagnosticsOpen,
        }]),
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

    const renderButton = (def) => {
        const button = React.createElement(IconButton, {
            key: def.badge ? undefined : def.key,
            icon: def.icon,
            label: def.label,
            onClick: def.onClick,
            disabled: Boolean(def.disabled),
            active: Boolean(def.active),
        });
        // Defs with corner markers wrap in the positioning span: yellow
        // top-right = unseen changes, green bottom-left = canvas has content.
        return (def.badge || def.loadedDot)
            ? React.createElement("span", { key: def.key, className: "ps-canvas-toggle" },
                button,
                def.loadedDot ? React.createElement("span", { className: "ps-canvas-loaded-dot", "aria-hidden": "true" }) : null,
                def.badge ? React.createElement("span", { className: "ps-canvas-badge", "aria-hidden": "true" }) : null)
            : button;
    };

    if (mobile) {
        // One row, two groups: actions left, the three VIEW MODES right —
        // they used to be word tabs pinned to the bottom of the screen, and
        // folding them up here hands that whole strip back to the chat pane.
        // The Main button is a CYCLE once you are already on Main: split →
        // chat only → sessions only. ONE glyph for all three states (a
        // layout/panes mark) — a shape-shifting icon reads as three different
        // buttons; only the tooltip names what the next tap gives you.
        const mainLabels = {
            split: "Main — sessions and chat (tap for chat only)",
            chat: "Main — chat only (tap for sessions only)",
            sessions: "Main — sessions only (tap for both)",
        };
        // Two tabs, not three: the row was out of space, and Inspector +
        // Activity are one idea on the desktop already (Diagnostics, the
        // bug). The bug button opens the inspector; tapping it again while
        // inside diagnostics flips inspector <-> activity; the main button is
        // always the way back.
        const onDiagnostics = mobilePane === "inspector" || mobilePane === "activity";
        const nextDiagnosticsPane = mobilePane === "inspector" ? "activity" : "inspector";
        const paneDefs = [
            { id: "workspace", icon: MainLayoutGlyph, label: mainLabels[mobileMainLayout] || mainLabels.split, focus: "chat" },
            {
                id: nextDiagnosticsPane,
                icon: DiagnosticsGlyph,
                active: onDiagnostics,
                label: onDiagnostics
                    ? (mobilePane === "inspector" ? "Diagnostics — inspector (tap for activity)" : "Diagnostics — activity (tap for inspector)")
                    : "Diagnostics — inspector and activity",
                focus: nextDiagnosticsPane,
            },
        ];
        return React.createElement("div", { className: "ps-toolbar is-mobile" },
            React.createElement("div", { className: "ps-toolbar-row ps-toolbar-row-primary" },
                React.createElement("div", { className: "ps-toolbar-row-actions" }, buttonDefs.map(renderButton)),
                React.createElement("div", { className: "ps-toolbar-row-actions is-panes" },
                    paneDefs.map((def) => React.createElement(IconButton, {
                        key: def.id === "workspace" ? "workspace" : "diagnostics",
                        icon: React.createElement(def.icon),
                        label: def.label,
                        active: def.active ?? (mobilePane === def.id),
                        onClick: () => {
                            if (onSelectMobilePane) onSelectMobilePane(def.id, def.focus);
                        },
                    })))),
        );
    }

    // Two groups. Budget, Diagnostics and the admin console are TOOLS — they
    // act on the app rather than on the conversation — so they sit apart from
    // the session controls, hard right. Everything else keeps its order.
    const RIGHT_GROUP = new Set(["budget", "diagnostics", "admin"]);

    // While the canvas is full screen, ANY other button first drops full
    // screen and then does its own job. Pressing Filter and watching nothing
    // happen behind a canvas — or watching a panel open where you cannot see
    // it — is the confusing half of every full-screen mode. The Canvas toggle
    // is exempt: it already means "put the canvas away", and closing drops the
    // flag in the reducer.
    const withRestore = (def) => (!canvasMaximized || def.key === "canvas" ? def : {
        ...def,
        onClick: (...args) => {
            controller.dispatch({ type: "ui/canvasMaximized", on: false });
            return def.onClick?.(...args);
        },
    });

    const leftButtons = buttonDefs.filter((d) => !RIGHT_GROUP.has(d.key)).map(withRestore);
    const rightButtons = buttonDefs.filter((d) => RIGHT_GROUP.has(d.key)).map(withRestore);
    const toolbar = React.createElement("div", { className: "ps-toolbar" },
        // Three columns: left rail | main controls | right rail. Full-screen
        // canvas uses the otherwise-empty left rail for the normal actions so
        // they do not crowd the canvas metadata and controls across the top.
        React.createElement("div", { className: "ps-toolbar-side is-left" },
            canvasMaximized ? leftButtons.map(renderButton) : null),
        React.createElement("div", { className: "ps-toolbar-actions" },
            canvasMaximized ? null : leftButtons.map(renderButton)),
        React.createElement("div", { className: "ps-toolbar-side is-right" },
            // The portal header parks its version/status meta here, LEFT of
            // the tool buttons, and its sign-out glyph in the slot after
            // them — one right-aligned cluster: meta · bug · settings · out.
            React.createElement("span", { className: "ps-toolbar-meta-slot", id: "ps-toolbar-meta-slot" }),
            // While the canvas is full screen its header controls (rev, zoom,
            // zen, restore) portal INTO this slot from CanvasPane — zoom state
            // lives there, so the controls come to the toolbar rather than
            // their state moving out.
            canvasMaximized
                ? React.createElement("span", { className: "ps-toolbar-canvas-slot", id: "ps-toolbar-canvas-slot" })
                : null,
            canvasMaximized
                ? React.createElement("span", { className: "ps-toolbar-divider", "aria-hidden": "true" })
                : null,
            rightButtons.length
                ? React.createElement("div", { className: "ps-toolbar-actions is-tools" }, rightButtons.map(renderButton))
                : null,
            React.createElement("span", { className: "ps-toolbar-signout-slot", id: "ps-toolbar-signout-slot" })),
    );

    // Rich desktop UI: the toolbar lives IN the portal header (one top bar)
    // rather than as its own strip, handing that row back to the panes. The
    // slot is rendered by PortalHeader in App.jsx, outside this tree, so the
    // handoff is a portal. Falls back to inline rendering when the slot is
    // absent (mobile layouts, embeddings that use their own header).
    if (headerSlot) return createPortal(toolbar, headerSlot);
    return toolbar;
}

/**
 * Pin a drag to the element that started it.
 *
 * Without capture, a resizer listens for pointerup on `window` — and never
 * hears it if the button is released over a CROSS-ORIGIN iframe. The artifact
 * reader is exactly that, and it sits directly beside the column resizer, so
 * releasing over a rendered artifact left the drag armed: the seam kept
 * following the pointer with no button held and the cursor stayed stuck in
 * col-resize.
 *
 * Pointer capture routes every subsequent event for this pointerId to the
 * capturing element regardless of what is underneath, iframes included. The
 * events still bubble to the window listeners the handles already use, so
 * this is additive.
 */
function capturePointerForDrag(event) {
    try {
        event.currentTarget?.setPointerCapture?.(event.pointerId);
    } catch {
        // Capture is best-effort; the body class below is the second line of
        // defence and the window listeners still work for same-origin drags.
    }
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
            capturePointerForDrag(event);
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
            capturePointerForDrag(event);
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
            capturePointerForDrag(event);
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


/**
 * The seam between the canvas and diagnostics columns.
 *
 * Only rendered when both are open — with one column the outer chat/right
 * handle is already the only split there is.
 *
 * Drag either column below PORTAL_COLUMN_SNAP_CLOSED_PX and releasing CLOSES
 * it: the user asked for "resized to 0 means toggled off, and it has to be
 * toggled back on". The adjust is reset at the same time, so re-opening from
 * the toolbar comes back at the even split rather than at the sliver that
 * closed it.
 */
function CanvasDiagnosticsResizeHandle({ controller, canvasPaneAdjust = 0, diagnosticsPaneAdjust = 0 }) {
    const dragStateRef = React.useRef(null);
    const [dragging, setDragging] = React.useState(false);

    const widths = (ca, da) => ({
        canvas: PORTAL_CANVAS_COL_DEFAULT_PX + (Number(ca) || 0),
        diag: PORTAL_DIAG_COL_DEFAULT_PX + (Number(da) || 0),
    });

    // Moving the seam trades pixels between the two columns; the total — and
    // therefore chat — does not move. Below the snap on release, the starved
    // column CLOSES and both widths reset, so reopening is always usable.
    const commit = (ca, da) => {
        const w = widths(ca, da);
        if (w.canvas < PORTAL_COLUMN_SNAP_CLOSED_PX || w.diag < PORTAL_COLUMN_SNAP_CLOSED_PX) {
            controller.dispatch({ type: "ui/canvasPaneAdjust", canvasPaneAdjust: 0 });
            controller.dispatch({ type: "ui/diagnosticsPaneAdjust", diagnosticsPaneAdjust: 0 });
            controller.dispatch(w.canvas < PORTAL_COLUMN_SNAP_CLOSED_PX
                ? { type: "ui/canvasOpen", open: false, manual: true }
                : { type: "ui/diagnosticsOpen", open: false });
            return;
        }
        controller.dispatch({ type: "ui/canvasPaneAdjust", canvasPaneAdjust: ca });
        controller.dispatch({ type: "ui/diagnosticsPaneAdjust", diagnosticsPaneAdjust: da });
    };

    React.useEffect(() => {
        if (!dragging) return undefined;
        const onMove = (event) => {
            const st = dragStateRef.current;
            if (!st) return;
            const dx = event.clientX - st.startX;
            controller.dispatch({ type: "ui/canvasPaneAdjust", canvasPaneAdjust: st.startCanvas + dx });
            controller.dispatch({ type: "ui/diagnosticsPaneAdjust", diagnosticsPaneAdjust: st.startDiag - dx });
        };
        const onUp = () => {
            const st = dragStateRef.current;
            dragStateRef.current = null;
            setDragging(false);
            document.body.classList.remove("is-resizing-pane-x");
            if (st) {
                const ui = controller.getState()?.ui?.layout || {};
                commit(ui.canvasPaneAdjust ?? 0, ui.diagnosticsPaneAdjust ?? 0);
            }
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
    }, [controller, dragging]);

    return React.createElement("button", {
        type: "button",
        className: `ps-column-resizer${dragging ? " is-dragging" : ""}`,
        title: "Drag to trade width between the canvas and diagnostics. Drag one away to close it. Double-click to reset.",
        "aria-label": "Resize canvas and diagnostics columns",
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            capturePointerForDrag(event);
            dragStateRef.current = {
                startX: event.clientX,
                startCanvas: Number(canvasPaneAdjust) || 0,
                startDiag: Number(diagnosticsPaneAdjust) || 0,
            };
            setDragging(true);
            document.body.classList.add("is-resizing-pane-x");
        },
        onDoubleClick: () => {
            controller.dispatch({ type: "ui/canvasPaneAdjust", canvasPaneAdjust: 0 });
            controller.dispatch({ type: "ui/diagnosticsPaneAdjust", diagnosticsPaneAdjust: 0 });
        },
        onKeyDown: (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const dx = event.key === "ArrowRight" ? 24 : -24;
            commit((Number(canvasPaneAdjust) || 0) + dx, (Number(diagnosticsPaneAdjust) || 0) - dx);
        },
    },
    React.createElement("span", { className: "ps-column-resizer-handle", "aria-hidden": "true" },
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" })));
}

/** The zen seam: drags the chat rail, remembered per session. */
function ZenRailResizeHandle({ controller, sessionId, railPx = 380 }) {
    const dragStateRef = React.useRef(null);
    const [dragging, setDragging] = React.useState(false);
    React.useEffect(() => {
        if (!dragging) return undefined;
        const onMove = (event) => {
            const st = dragStateRef.current;
            if (!st) return;
            controller.dispatch({ type: "canvas/zenRail", sessionId, px: st.start + (event.clientX - st.startX) });
        };
        const onUp = () => {
            dragStateRef.current = null;
            setDragging(false);
            document.body.classList.remove("is-resizing-pane-x");
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
    }, [controller, dragging, sessionId]);
    return React.createElement("button", {
        type: "button",
        className: `ps-column-resizer${dragging ? " is-dragging" : ""}`,
        title: "Drag to resize chat against the canvas (remembered for this session)",
        "aria-label": "Resize the zen chat rail",
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            capturePointerForDrag(event);
            dragStateRef.current = { startX: event.clientX, start: railPx };
            setDragging(true);
            document.body.classList.add("is-resizing-pane-x");
        },
        onKeyDown: (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            controller.dispatch({ type: "canvas/zenRail", sessionId, px: railPx + (event.key === "ArrowRight" ? 24 : -24) });
        },
    },
    React.createElement("span", { className: "ps-column-resizer-handle", "aria-hidden": "true" },
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" })));
}

/**
 * The seam between chat and the right block. Chat flexes, so this drags the
 * width of the column beside it — canvas when open, else diagnostics. The
 * other column never moves: growing chat shrinks only its neighbour.
 */
function ChatRightResizeHandle({ controller, target, adjust = 0 }) {
    const dragStateRef = React.useRef(null);
    const [dragging, setDragging] = React.useState(false);
    const actionType = target === "canvas" ? "ui/canvasPaneAdjust" : "ui/diagnosticsPaneAdjust";
    const key = target === "canvas" ? "canvasPaneAdjust" : "diagnosticsPaneAdjust";
    const base = target === "canvas" ? PORTAL_CANVAS_COL_DEFAULT_PX : PORTAL_DIAG_COL_DEFAULT_PX;

    const commit = (next) => {
        if (base + next < PORTAL_COLUMN_SNAP_CLOSED_PX) {
            controller.dispatch({ type: actionType, [key]: 0 });
            controller.dispatch(target === "canvas"
                ? { type: "ui/canvasOpen", open: false, manual: true }
                : { type: "ui/diagnosticsOpen", open: false });
            return;
        }
        controller.dispatch({ type: actionType, [key]: next });
    };

    React.useEffect(() => {
        if (!dragging) return undefined;
        const onMove = (event) => {
            const st = dragStateRef.current;
            if (!st) return;
            // Pointer right = chat grows = the neighbour gives up the pixels.
            controller.dispatch({ type: actionType, [key]: st.startAdjust - (event.clientX - st.startX) });
        };
        const onUp = () => {
            const st = dragStateRef.current;
            dragStateRef.current = null;
            setDragging(false);
            document.body.classList.remove("is-resizing-pane-x");
            if (st) commit((controller.getState()?.ui?.layout || {})[key] ?? 0);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
    }, [controller, dragging, actionType, key]);

    return React.createElement("button", {
        type: "button",
        className: `ps-column-resizer${dragging ? " is-dragging" : ""}`,
        title: "Drag to resize. Drag the column away to close it. Double-click to reset.",
        "aria-label": "Resize the right column",
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            capturePointerForDrag(event);
            dragStateRef.current = { startX: event.clientX, startAdjust: Number(adjust) || 0 };
            setDragging(true);
            document.body.classList.add("is-resizing-pane-x");
        },
        onDoubleClick: () => controller.dispatch({ type: actionType, [key]: 0 }),
        onKeyDown: (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            commit((Number(adjust) || 0) - (event.key === "ArrowRight" ? 24 : -24));
        },
    },
    React.createElement("span", { className: "ps-column-resizer-handle", "aria-hidden": "true" },
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" })));
}

/**
 * The inspector/activity seam, in continuous pixels — it follows the pointer
 * 1:1. Replaces the row-quantized ActivityRowResizeHandle for the portal:
 * that one converted drags to whole terminal rows (~20px notches) against
 * geometry computed from the whole viewport rather than this column, and the
 * legacy layout could snap-collapse a pane mid-drag. The grid's minmax does
 * all the clamping now.
 */
function DiagnosticsSplitResizeHandle({ controller, splitAdjust = 0 }) {
    const dragStateRef = React.useRef(null);
    const [dragging, setDragging] = React.useState(false);
    React.useEffect(() => {
        if (!dragging) return undefined;
        const onMove = (event) => {
            const st = dragStateRef.current;
            if (!st) return;
            // The first grid track is `50% + adjust`, while the divider takes
            // real space between the two panes. Its bounds are asymmetric:
            // -column/2 makes Inspector 0px; column/2-divider makes Activity
            // 0px. Using one symmetric half-range left an 8-9px pane remnant.
            const next = clamp(st.start + (event.clientY - st.startY), st.minAdjust, st.maxAdjust);
            controller.dispatch({ type: "ui/diagnosticsSplitAdjust", diagnosticsSplitAdjust: next });
        };
        const onUp = () => {
            dragStateRef.current = null;
            setDragging(false);
            document.body.classList.remove("is-resizing-pane-y");
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
            document.body.classList.remove("is-resizing-pane-y");
        };
    }, [controller, dragging]);
    return React.createElement("button", {
        type: "button",
        className: `ps-row-resizer${dragging ? " is-dragging" : ""}`,
        title: "Drag to resize the inspector and activity panes. Double-click to reset.",
        "aria-label": "Resize the inspector and activity panes",
        onPointerDown: (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            capturePointerForDrag(event);
            const col = event.currentTarget.closest(".ps-workspace-column");
            const columnHeight = Math.max(0, col?.getBoundingClientRect?.().height || 0);
            const dividerHeight = Math.max(0, event.currentTarget.getBoundingClientRect().height || 0);
            const { minAdjust, maxAdjust } = getDiagnosticsSplitAdjustBounds(columnHeight, dividerHeight);
            dragStateRef.current = {
                startY: event.clientY,
                start: clamp(Number(splitAdjust) || 0, minAdjust, maxAdjust),
                minAdjust,
                maxAdjust,
            };
            setDragging(true);
            document.body.classList.add("is-resizing-pane-y");
        },
        onDoubleClick: () => controller.dispatch({ type: "ui/diagnosticsSplitAdjust", diagnosticsSplitAdjust: 0 }),
        onKeyDown: (event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const col = event.currentTarget.closest(".ps-workspace-column");
            const columnHeight = Math.max(0, col?.getBoundingClientRect?.().height || 0);
            const dividerHeight = Math.max(0, event.currentTarget.getBoundingClientRect().height || 0);
            const { minAdjust, maxAdjust } = getDiagnosticsSplitAdjustBounds(columnHeight, dividerHeight);
            controller.dispatch({
                type: "ui/diagnosticsSplitAdjust",
                diagnosticsSplitAdjust: clamp(
                    (Number(splitAdjust) || 0) + (event.key === "ArrowDown" ? dividerHeight : -dividerHeight),
                    minAdjust,
                    maxAdjust,
                ),
            });
        },
    },
    React.createElement("span", { className: "ps-row-resizer-handle", "aria-hidden": "true" },
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" }),
        React.createElement("span", { className: "ps-column-resizer-dot" })));
}



// ── Providers & Budgets ─────────────────────────────────────────────────────
//
// One table. docs/proposals/providers-and-budgets-meters.md is the build spec:
// every provider the viewer can use, with what has been spent against what may
// be spent, for the day, the week and the month. Selecting a row expands its
// per-model limits and opens its day-by-day chart underneath.
//
// A cell is `used / quota`. A period with no limit shows ∞, and the figure
// beside it is still real usage — the meter runs whether or not anybody capped
// it.
//
// TWO PAIRS OF NUMBERS, AND THEY ARE NEVER MIXED. Unticked, every cell is the
// viewer's own spend against their share of the limit. Ticked, every cell is
// everyone's spend against the limit itself. The selector decides which pair a
// cell holds; the heading over the three columns says which one is on screen;
// nothing in this file recomputes either.
//
// Nothing here decides who may do what. Every change goes through the
// controller to the `cms_provider_*` procedures, the DATABASE refuses what the
// viewer may not do, and its refusal — already written for a person, and
// naming the remedy — is printed unchanged.
//
// The vocabulary is binding: provider, limit, allowance, hold, paused, period.
// Never pool, payer, grant, quota rule, or bind mode.

const BUDGET_PERIOD_OPTIONS = [
    { value: "day", label: "Daily" },
    { value: "week", label: "Weekly" },
    { value: "month", label: "Monthly" },
];
const BUDGET_PERIOD_TITLES = { day: "Daily", week: "Weekly", month: "Monthly" };

// Plain under 90%, amber to 100%, red over. Colour is never the only signal —
// the two numbers in the cell already say it — so this only tints the used
// figure and nothing depends on being able to see the tint.
const BUDGET_TONE_CLASS = { plain: "", amber: " warn", red: " over", idle: "" };

/**
 * One number format for a WHOLE axis, chosen from its top value.
 *
 * A per-value formatter is right for a table and wrong for a scale: the same
 * y-axis printed 18.4M, 13.8M, 9.21M and 4.60M, and four precisions down one
 * ruler read as four different units.
 */
function fixedScaleFormatter(max) {
    const top = Math.abs(Number(max) || 0);
    const [unit, div] = top >= 1e9 ? ["B", 1e9]
        : top >= 1e6 ? ["M", 1e6]
            : top >= 1e3 ? ["K", 1e3]
                : ["", 1];
    const scaled = top / div;
    const decimals = unit === "" ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
    return (value) => {
        const v = Number(value);
        if (!Number.isFinite(v)) return "—";
        // Zero is zero in every unit; "0.00M" is noise on the baseline.
        if (v === 0) return "0";
        return `${(v / div).toFixed(decimals)}${unit}`;
    };
}

/** Parse "20,000,000" / "20M" / "20000000" to a whole number of tokens, or null. */
function parseTokenCount(raw) {
    const s = String(raw ?? "").trim().replace(/[,_\s]/g, "").toUpperCase();
    if (!s) return null;
    const m = /^(\d+(?:\.\d+)?)([KMB])?$/.exec(s);
    if (!m) return null;
    const mult = m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : m[2] === "B" ? 1e9 : 1;
    // A whole number of tokens, as the field says. "1.5" used to round to 2 —
    // one of a bare decimal and "2.5M" is a typo and the other is meant, and
    // guessing between them is how a limit lands ten times off.
    if (!m[2] && /\./.test(m[1])) return null;
    const n = Math.round(Number(m[1]) * mult);
    // Above 2^53 a JS number stops being the integer that was typed, so the
    // value SAVED is not the value shown — and past bigint it fails deep in
    // the database as a bare "Internal server error". Refused here, where the
    // field can say so, exactly like 0 and a negative already are.
    if (!Number.isSafeInteger(n)) return null;
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * "resets in 2h 31m (00:00 UTC)".
 *
 * The clock is formatted ONCE, in the selector (formatUntilLabel), so every
 * reset on this surface is spelled the same way. This only puts the verb in
 * front of it. It used to be a second formatter here, which is how one instant
 * came to read three ways.
 */
function budgetResetPhrase(resetsLabel) {
    return resetsLabel ? `resets ${resetsLabel}` : "no reset recorded";
}

/** "3 sessions" / "1 session". */
function budgetPlural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * A model reference a session can run: `<provider>:<model>`.
 *
 * The catalog's `providerId` is the TYPE ("azure-openai"); a provider is an
 * instance of that type with a name of its own, and both a model-scoped limit
 * and a default tuple are refused by the database unless the model half names
 * the provider it belongs to.
 */
function budgetModelsForProvider(models, provider) {
    if (!provider?.typeId) return [];
    return models
        .filter((model) => model.providerId === provider.typeId)
        .map((model) => ({
            qualifiedName: `${provider.name}:${model.modelName}`,
            modelName: model.modelName,
        }));
}

/** The provider TYPES this deployment can instantiate, from its model catalog. */
function budgetProviderTypes(models) {
    const seen = new Map();
    for (const model of models) {
        if (!model.providerId || seen.has(model.providerId)) continue;
        seen.set(model.providerId, { id: model.providerId, type: model.providerType || model.providerId });
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** listModels() is flat on the web transport and grouped on the direct one. */
function budgetNormalizeModels(raw) {
    const top = Array.isArray(raw)
        ? raw
        : (Array.isArray(raw?.providers) ? raw.providers : (Array.isArray(raw?.models) ? raw.models : []));
    const flat = top.flatMap((entry) => (
        Array.isArray(entry?.models)
            ? entry.models.map((model) => ({ ...model, providerId: model.providerId || entry.providerId }))
            : [entry]
    ));
    return flat
        .filter((model) => model && (model.modelName || model.qualifiedName))
        .map((model) => ({
            modelName: model.modelName || String(model.qualifiedName).split(":").pop(),
            providerId: model.providerId || "",
            providerType: model.providerType || model.providerId || "",
        }));
}

/**
 * One sheet for every change on this surface. Local state, no shared slot: a
 * refused write is READ where the person is looking rather than dismissed, and
 * the sheet stays open so the value that was refused is still on screen.
 */
function BudgetSheet({ title, subtitle, children, footNote, confirmLabel, danger = false, busy = false,
    disabled = false, error = null, onCancel, onConfirm = null, cancelLabel = "Cancel" }) {
    // aria-modal promises focus stays inside. Keep the promise: Tab cycles
    // within the sheet, and a sheet with no input (Delete, Remove) takes focus
    // itself so the first Tab does not land behind the backdrop.
    const sheetRef = React.useRef(null);
    React.useEffect(() => {
        const root = sheetRef.current;
        if (!root) return undefined;
        const focusables = () => [...root.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
        if (!root.contains(document.activeElement)) { const f = focusables(); (f[0] || root).focus(); }
        const onKey = (event) => {
            if (event.key !== "Tab") return;
            const f = focusables();
            if (!f.length) return;
            const first = f[0];
            const last = f[f.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        root.addEventListener("keydown", onKey);
        return () => root.removeEventListener("keydown", onKey);
    }, []);
    // Capture phase, and stopPropagation: the surface's own Escape handler is
    // ALSO on capture and closes the whole workspace. It exempts INPUT/SELECT
    // targets, so a sheet whose focus sat on a button let Escape fall through
    // to it — the sheet AND the surface vanished together.
    React.useEffect(() => {
        const onKey = (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            onCancel();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onCancel]);
    return React.createElement("div", {
        className: "ps-budget-sheet-backdrop",
        // preventDefault, or the browser's own default action for this same
        // mousedown moves focus AFTER the close handler has restored it —
        // and it lands on <body>, because a backdrop is a div nothing can
        // focus. Cancel and Escape never hit this, which is why the backdrop
        // was the one close path that still stranded a keyboard user.
        onMouseDown: (event) => {
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            onCancel();
        },
    },
    React.createElement("div", {
        className: "ps-budget-sheet", role: "dialog", "aria-modal": "true", "aria-label": title,
        ref: sheetRef, tabIndex: -1,
    },
    React.createElement("div", { className: "ps-budget-sheet-top" },
        React.createElement("div", { className: "ps-budget-sheet-title" }, title),
        subtitle ? React.createElement("div", { className: "ps-budget-sheet-sub" }, subtitle) : null),
    React.createElement("div", { className: "ps-budget-sheet-body" }, children,
        error ? React.createElement("div", { className: "ps-budget-sheet-error", role: "alert" }, error) : null),
    React.createElement("div", { className: "ps-budget-sheet-foot" },
        React.createElement("span", { className: "ps-budget-sheet-note" }, footNote || ""),
        React.createElement("div", { className: "ps-budget-sheet-actions" },
            React.createElement("button", { type: "button", className: "ps-mini-button", onClick: onCancel, disabled: busy }, cancelLabel),
            // `busy` is a change in flight (the label becomes "…"); `disabled`
            // is a form that is not yet valid, where the label stays so the
            // button still says what it will do.
            onConfirm ? React.createElement("button", {
                type: "button",
                className: `ps-mini-button ${danger ? "is-danger" : "is-primary"}`,
                onClick: onConfirm, disabled: busy || disabled,
            }, busy ? "…" : confirmLabel) : null))));
}

/**
 * A labelled field inside a sheet. A <div>, not a <label>: a <label> wrapping a
 * segmented control gives its FIRST button an accessible name that swallows
 * every sibling's text ("Period Daily Weekly Monthly"), so a screen reader
 * cannot tell the options apart.
 */
function SheetField({ label, hint, children }) {
    return React.createElement("div", { className: "ps-budget-field", role: "group", "aria-label": label },
        React.createElement("span", { className: "ps-budget-label" }, label),
        children,
        hint ? React.createElement("span", { className: "ps-budget-field-hint" }, hint) : null);
}

/**
 * A segmented control: one of N words.
 *
 * Pressed buttons, not radios. A radiogroup promises the arrow keys move
 * between the options and that only one of them is a tab stop; neither is true
 * here, so this claims no contract it does not keep.
 */
function Segmented({ value, options, onChange, label = null }) {
    return React.createElement("div", {
        className: "ps-budget-seg", role: "group", "aria-label": label || undefined,
    },
    options.map((option) => React.createElement("button", {
        key: option.value, type: "button", "aria-pressed": value === option.value ? "true" : "false",
        className: `ps-budget-seg-btn${value === option.value ? " is-on" : ""}`,
        onClick: () => onChange(option.value),
    }, option.label)));
}

/**
 * One cell: the used figure, then the quota beside it.
 *
 * The two halves are marked apart. Printed as one string they read as one
 * number, and "480.0K / 500.0K" is a fact about two.
 */
function budgetCellEl(cell) {
    // Nobody signed in: the used figure is UNKNOWN, and unknown is not zero.
    const tone = cell.known ? (BUDGET_TONE_CLASS[cell.tone] || "") : " idle";
    return React.createElement(React.Fragment, null,
        React.createElement("span", { className: `ps-budget-pct${tone}` }, cell.usedLabel),
        // The provider's limit is spent even though your share is not. Marked
        // in the cell, because a plain number here means "you may spend this"
        // and you may not.
        cell.providerExhausted
            ? React.createElement("span", { className: "ps-budget-blocked", title: "The provider's own limit is spent." }, " ⏻")
            : null,
        " ",
        React.createElement("span", {
            className: `ps-budget-q ps-budget-sub${cell.uncapped ? " is-inf" : ""}`,
        }, `/ ${cell.quotaLabel}`));
}

/** What a cell says on hover: the period, its reset, and whether it is capped. */
function budgetCellTitle(row, column, cell) {
    const who = row.kind === "model" ? `${row.providerName} · ${row.label}` : row.providerName;
    const cap = cell.uncapped
        ? "no limit for this period"
        : `${cell.usedLabel} of ${cell.quotaLabel}${cell.pct == null ? "" : ` (${cell.pct}%)`}`;
    // Your share can have room while the limit it is a share OF is spent, and
    // then nothing runs. The tint alone would not say which of the two it is.
    const blocked = cell.providerExhausted
        ? " The provider's own limit for this period is spent, so nothing runs against it whatever your share says."
        : "";
    return `${who} · ${column.label} — ${cap}. It ${budgetResetPhrase(cell.resetsLabel)}.${blocked}`;
}

/**
 * The table, and the tick that decides which pair of numbers is in it.
 *
 * Rows arrive in draw order — shared providers, then the viewer's own, each
 * followed by its model rows while it is selected. They are not sorted here: a
 * sort would move a model row out from under the provider it belongs to.
 */
function ProviderTable({ controller, view, defaults = null }) {
    const select = React.useCallback((name, scope = "*") => {
        controller.selectBudgetProvider(name, scope).catch(() => {});
    }, [controller]);

    const nameCell = (row) => {
        if (row.kind === "model") {
            // Selectable in its own right: usage and any limit belong to this
            // model, so the chart follows it.
            return React.createElement("td", { className: "ps-budget-grid-name is-model" },
                React.createElement("button", {
                    type: "button", className: "ps-budget-grid-pick",
                    "aria-pressed": row.selected ? "true" : "false",
                    onClick: () => select(row.providerName, row.scope),
                },
                React.createElement("span", { className: "ps-budget-grid-mname" }, row.label),
                React.createElement("span", { className: "ps-budget-sub" }, " · model")));
        }
        return React.createElement("td", { className: "ps-budget-grid-name" },
            // ONE control for the whole cell. Selecting a provider and
            // expanding its per-model limits are the same act, so they are the
            // same button rather than two that do the same thing.
            React.createElement("button", {
                type: "button", className: "ps-budget-grid-pick",
                "aria-pressed": row.selected ? "true" : "false",
                "aria-expanded": row.modelRowCount > 0 ? (row.expanded ? "true" : "false") : undefined,
                onClick: () => select(row.providerName),
            },
            React.createElement("span", { className: "ps-budget-grid-pname" }, row.label),
            // Whose it is, for a provider that has an owner. Beside the name
            // rather than in the chip: the chip says WHAT kind of provider it
            // is, and this says whose — two different facts.
            row.ownerLabel
                ? React.createElement("span", { className: "ps-budget-grid-owner" }, `(${row.ownerLabel})`)
                : null,
            // The class, named. Shared and User look different because they
            // behave differently: one is everyone's and an administrator's to
            // change, the other is a single person's.
            row.classLabel
                ? React.createElement("span", {
                    className: `ps-budget-chip is-${row.class}`,
                    title: row.class === "shared"
                        ? "Shared: anyone may spend from it. An administrator manages its limits."
                        : (row.ownedByMe === false
                            ? "A user provider belonging to another user."
                            : "Your own provider. Only you see it or spend from it."),
                }, row.classLabel)
                : null,
            defaults?.mine?.provider === row.providerName
                ? React.createElement("span", { className: "ps-budget-chip" }, "my default")
                : null,
            defaults?.cluster?.provider === row.providerName
                ? React.createElement("span", { className: "ps-budget-chip" }, "cluster default")
                : null,
            defaults?.system?.provider === row.providerName
                ? React.createElement("span", { className: "ps-budget-chip" }, "system default")
                : null,
            // Not a class mark: a hold stops every turn against this provider
            // right now, and a screen that hides that is lying about the row.
            row.hold
                ? React.createElement("span", {
                    className: "ps-budget-chip is-hold", title: `It ${row.hold.label}.`,
                }, "on hold")
                : null,
            // A fact about how the TOTAL is divided, so it appears only where
            // the total is on screen.
            row.allowanceLabel
                ? React.createElement("span", { className: "ps-budget-grid-allow" }, row.allowanceLabel)
                : null,
            row.expandLabel
                ? React.createElement("span", { className: "ps-budget-grid-teaser" }, row.expandLabel)
                : null));
    };

    const bodyRow = (row) => React.createElement("tr", {
        key: row.key,
        className: `ps-budget-grid-row${row.kind === "model" ? " is-model" : ""}${row.selected ? " is-on" : ""}`,
        // The numbers are part of the row too. A click that started on the name
        // button is already handled there, so it is let through rather than
        // toggling the selection twice.
        onClick: (event) => {
            if (event.target?.closest?.("button")) return;
            select(row.providerName, row.kind === "model" ? row.scope : "*");
        },
    },
    nameCell(row),
    view.columns.map((column) => React.createElement("td", {
        key: column.id, className: "ps-budget-grid-num",
        // On a phone the column headings are gone and each number prints its
        // own period from this. It comes from the column rather than from the
        // stylesheet counting cells, so the two cannot drift apart.
        "data-period": column.label,
        title: budgetCellTitle(row, column, row.cells[column.id]),
    }, budgetCellEl(row.cells[column.id]))));

    return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "ps-budget-table-head" },
            React.createElement("span", { className: "ps-budget-label" },
                `Providers${view.providerCount > 0 ? ` · ${view.providerCount}` : ""}`),
            React.createElement("label", { className: "ps-budget-toggle" },
                React.createElement("input", {
                    type: "checkbox", checked: view.overall,
                    onChange: () => controller.setBudgetOverall(),
                }),
                React.createElement("span", null, view.overallLabel))),
        // A namespace that really is empty, reported only after a read that
        // SUCCEEDED. A failed read is handled above this component.
        view.empty
            ? React.createElement("div", { className: "ps-budget-empty" },
                "No provider exists yet. Add one in Admin Console → Model Providers to start spending.")
            : React.createElement("table", { className: "ps-budget-grid" },
                React.createElement("thead", null,
                    React.createElement("tr", null,
                        React.createElement("th", {
                            className: "ps-budget-grid-h is-name", rowSpan: 2, scope: "col",
                        }, "Provider"),
                        // Which pair of numbers the three columns hold. It is
                        // the heading, not a footnote, because every figure
                        // under it means something different when the tick
                        // changes.
                        React.createElement("th", {
                            className: "ps-budget-grid-h is-span", colSpan: 3, scope: "colgroup",
                        }, view.usageHeading)),
                    React.createElement("tr", null,
                        view.columns.map((column) => React.createElement("th", {
                            key: column.id, className: "ps-budget-grid-h is-num", scope: "col",
                        }, column.label)))),
                React.createElement("tbody", null, view.rows.map(bodyRow))));
}

/**
 * The selected provider's days, with the dashed line at whatever quota the Day
 * cell just showed. The chart is drawn from the same number as the row, so the
 * two cannot disagree.
 */
function ProviderDayChart({ controller, view }) {
    const series = view.series;
    const row = view.selected;
    const paneProps = {
        className: "ps-budget-chart-pane",
        "data-range-days": String(view.rangeDays),
    };

    // How many dates the x-axis can print is MEASURED, not assumed. "About
    // seven" is right at 1440px and wrong at 390px, where each slot is 15px,
    // "08-16" needs 26px, and every date came out clipped to "08-".
    const [axisNode, setAxisNode] = React.useState(null);
    const [axisWidth, setAxisWidth] = React.useState(0);
    React.useEffect(() => {
        if (!axisNode || typeof ResizeObserver === "undefined") return undefined;
        const measure = () => {
            const next = Math.round(axisNode.getBoundingClientRect().width);
            setAxisWidth((current) => (Math.abs(next - current) < 1 ? current : next));
        };
        const observer = new ResizeObserver(measure);
        observer.observe(axisNode);
        measure();
        return () => observer.disconnect();
    }, [axisNode]);

    const days = series.days;
    const dayCount = days.length;
    const xTicks = React.useMemo(() => {
        const GAP_PX = 5;    // .ps-budget-tl-x gap
        const DATE_PX = 30;  // "08-16" plus a little air, at either axis font size
        const room = axisWidth - ((dayCount - 1) * GAP_PX);
        const fits = axisWidth > 0 ? Math.floor(room / DATE_PX) : 7;
        const maxTicks = Math.max(1, Math.min(7, fits));
        const every = Math.max(1, Math.ceil(dayCount / maxTicks));
        const out = new Set();
        // Anchored on the LAST day, so today is always named and the spacing
        // runs evenly back from it.
        for (let i = dayCount - 1; i >= 0; i -= every) out.add(i);
        return out;
    }, [axisWidth, dayCount]);

    const head = React.createElement("div", { className: "ps-budget-chart-head" },
        React.createElement("span", { className: "ps-budget-chart-title" },
            React.createElement("strong", null, row.subject),
            React.createElement("span", { className: "ps-budget-sub" },
                ` · ${view.usageHeading.toLowerCase()}, by day`)),
        React.createElement("div", { className: "ps-budget-chart-range" },
            React.createElement(Segmented, {
                value: view.rangeDays,
                options: view.rangeOptions,
                label: "Chart range",
                onChange: (days) => controller.setBudgetRangeDays(days).catch(() => {}),
            }),
            React.createElement("span", { className: "ps-budget-sub" }, series.rangeLabel)));

    // A failed read is a failure, never an empty chart: "no usage" and "we could
    // not find out" are different facts and only one is safe to act on.
    if (series.failed) {
        return React.createElement("div", paneProps, head,
            React.createElement("div", { className: "ps-budget-empty is-error", role: "alert" },
                React.createElement("div", null, `The daily usage for ${row.subject} could not be read.`),
                React.createElement("div", { className: "ps-budget-sub" }, series.error)));
    }
    if (series.loading && !series.loaded) {
        return React.createElement("div", paneProps, head,
            React.createElement("div", { className: "ps-budget-empty" }, "Reading the daily usage…"));
    }

    const scaleMax = series.scaleMax;
    const ticks = [1, 0.75, 0.5, 0.25, 0];
    const tickText = fixedScaleFormatter(scaleMax);
    const activeDays = days.filter((day) => day.tokens > 0).length;
    const quotaTop = series.quotaPct == null ? null : Math.max(0, Math.min(96, 100 - series.quotaPct));

    const axisEl = React.createElement("div", { className: "ps-budget-xaxis" },
        React.createElement("div", { className: "ps-budget-xaxis-spacer" }),
        // ONE span per column, blank ones included, so a label always sits on
        // its own bar.
        React.createElement("div", { className: "ps-budget-tl-x", ref: setAxisNode },
            days.map((day, index) => React.createElement("span", {
                key: day.dayUtc,
                className: xTicks.has(index) ? "is-tick" : undefined,
            }, xTicks.has(index) ? day.label : ""))));

    return React.createElement("div", paneProps, head,
        // An administrator reading their own share sees a chart of two
        // different subjects. Say which is which, or one reads as the other.
        series.mixedScope ? React.createElement("div", { className: "ps-budget-note is-warn" },
            "The bars are what the whole fleet spent on this provider each day. "
            + "The dashed line is YOUR share of the daily limit, not the limit itself. "
            + "Tick “Show overall usage” to read both as the provider's.") : null,
        series.stale ? React.createElement("div", { className: "ps-budget-empty is-error", role: "alert" },
            React.createElement("div", null, "These figures are from an earlier read. The most recent read failed."),
            React.createElement("div", { className: "ps-budget-sub" }, series.error)) : null,
        React.createElement("div", { className: "ps-budget-chart" },
            React.createElement("div", { className: "ps-budget-yaxis-title" }, "tokens"),
            React.createElement("div", { className: "ps-budget-plotwrap" },
                React.createElement("div", { className: "ps-budget-yaxis" },
                    // A range with nothing in it and no limit gets no ruler:
                    // every tick on it would be a number nobody spent.
                    scaleMax > 0
                        ? ticks.map((frac) => React.createElement("div", {
                            key: `t${frac}`, className: "ps-budget-ytick", style: { top: `${(1 - frac) * 100}%` },
                        }, tickText(scaleMax * frac)))
                        : null),
                React.createElement("div", { className: "ps-budget-plot" },
                    scaleMax > 0
                        ? ticks.map((frac) => React.createElement("div", {
                            key: `g${frac}`, className: "ps-budget-gridline", style: { top: `${(1 - frac) * 100}%` },
                        }))
                        : null,
                    // The dashed line IS the Day cell's quota, the same object
                    // the row printed. There is nothing to draw when the day is
                    // uncapped.
                    quotaTop == null ? null : React.createElement("div", {
                        className: "ps-budget-tl-median", style: { top: `${quotaTop}%` },
                    }, React.createElement("span", null, `the Day limit · ${series.quotaLabel} a day`)),
                    React.createElement("div", { className: "ps-budget-bars" },
                        days.map((day) => React.createElement("div", {
                            key: day.dayUtc,
                            className: `ps-budget-tl-col${day.tokens === 0 ? " is-idle" : ""}`
                                + `${series.quotaTokens != null && day.tokens > series.quotaTokens ? " is-over" : ""}`,
                            title: `${day.label} · ${day.tokens
                                ? `${day.tokens.toLocaleString("en-US")} tokens · ${budgetPlural(day.turns, "turn", "turns")}`
                                : "no usage"}`,
                        },
                        React.createElement("div", {
                            className: "ps-budget-tl-bar",
                            // An idle day keeps a hairline so the column is
                            // visibly a day that happened, not a gap.
                            style: { height: day.tokens === 0 ? "2px" : `${Math.max(1, day.pct)}%` },
                        })))),
                    series.empty
                        ? React.createElement("div", { className: "ps-budget-noaxis" },
                            `No token usage on ${row.subject} in this range.`)
                        : null)),
            axisEl,
            React.createElement("div", { className: "ps-budget-xaxis-title" },
                `Daily totals · UTC · ${series.rangeLabel.toLowerCase()}`),
            React.createElement("div", { className: "ps-budget-legend" },
                React.createElement("span", null, `Peak ${series.peakLabel} tokens/day`),
                React.createElement("span", null, `${activeDays} of ${dayCount} days used`),
                series.quotaTokens != null
                    ? React.createElement("span", null, `Dashed line: ${series.quotaLabel} a day`)
                    : React.createElement("span", null, "No daily limit, so no line"))));
}

function ProviderSystemSpend({ view }) {
    const spend = view.systemSpend;
    if (!spend) return null;
    const modelLabel = (label) => String(label || "").startsWith(`${view.selectedProvider}:`)
        ? String(label).slice(view.selectedProvider.length + 1)
        : String(label || "Unknown model");
    return React.createElement("section", { className: "ps-budget-system-spend", "aria-label": "System spend" },
        React.createElement("div", { className: "ps-budget-chart-head" },
            React.createElement("span", { className: "ps-budget-chart-title" },
                React.createElement("strong", null, "System spend")),
            React.createElement("span", { className: "ps-budget-sub" }, spend.rangeLabel)),
        spend.loading && !spend.loaded
            ? React.createElement("div", { className: "ps-budget-empty" }, "Reading system spend…")
            : null,
        spend.error
            ? React.createElement("div", { className: "ps-budget-empty is-error", role: "alert" }, spend.error)
            : null,
        spend.loaded ? React.createElement(React.Fragment, null,
            // The headline: total tokens and turns as two stat tiles, then a
            // per-model table with a share bar so the mix reads at a glance
            // (77.9M of 94.7M on one model is the fact that matters).
            React.createElement("div", { className: "ps-budget-system-stats" },
                React.createElement("div", { className: "ps-budget-system-stat" },
                    React.createElement("strong", null, spend.tokensLabel),
                    React.createElement("span", null, "tokens")),
                React.createElement("div", { className: "ps-budget-system-stat" },
                    React.createElement("strong", null, formatCompactNumber(spend.turns)),
                    React.createElement("span", null, spend.turns === 1 ? "turn" : "turns")),
                spend.turns > 0
                    ? React.createElement("div", { className: "ps-budget-system-stat" },
                        React.createElement("strong", null, formatCompactNumber(Math.round(spend.tokens / spend.turns))),
                        React.createElement("span", null, "tokens / turn"))
                    : null),
            spend.models.length
                ? React.createElement("table", { className: "ps-budget-system-models" },
                    React.createElement("thead", null,
                        React.createElement("tr", null,
                            React.createElement("th", { scope: "col" }, "Model"),
                            React.createElement("th", { scope: "col", className: "is-num" }, "Tokens"),
                            React.createElement("th", { scope: "col", className: "is-share" }, "Share"),
                            React.createElement("th", { scope: "col", className: "is-num" }, "Turns"))),
                    React.createElement("tbody", null,
                        spend.models.map((model) => {
                            const share = spend.tokens > 0 ? model.tokens / spend.tokens : 0;
                            const pct = Math.round(share * 100);
                            return React.createElement("tr", { key: model.key },
                                React.createElement("td", { className: "ps-budget-system-model-name" }, modelLabel(model.label)),
                                React.createElement("td", { className: "is-num" }, model.tokensLabel),
                                React.createElement("td", { className: "is-share" },
                                    React.createElement("span", { className: "ps-budget-system-bar", role: "img", "aria-label": `${pct}% of system spend` },
                                        React.createElement("span", { className: "ps-budget-system-bar-fill", style: { width: `${Math.max(share > 0 ? 1 : 0, share * 100)}%` } })),
                                    React.createElement("span", { className: "ps-budget-system-pct" }, `${pct}%`)),
                                React.createElement("td", { className: "is-num" }, formatCompactNumber(model.turns)));
                        })))
                : React.createElement("div", { className: "ps-budget-sub" }, "No system spend in this range.")) : null);
}

/**
 * Everything one provider can be changed to: its limits, its allowance, its
 * hold, and whether it is a default.
 *
 * One sheet, because they are all edits to the row that is already named at the
 * top of it. Each section states what saving will do before the confirm is
 * reachable.
 */
function EditProviderSheet({
    row, rawRows, models, isAdmin, busy, error, onCancel, onRun,
    initialPeriod = "day", initialScope = "*",
}) {
    const shared = row.class === "shared";
    // A limit is a CHANGE, and the database refuses it from anyone who is not
    // an admin on a shared provider or the owner of a personal one. Offering
    // the section anyway meant filling in a form, pressing the button and
    // only then being told — so it is gated the way Allowance and Hold
    // already were.
    const mayManage = row.manageable === true;
    const sections = [
        ...(mayManage ? [{ value: "limit", label: "Limits" }] : []),
        ...(mayManage && isAdmin && shared ? [{ value: "allowance", label: "Allowance" }] : []),
        ...(mayManage && isAdmin ? [{ value: "hold", label: "Hold" }] : []),
    ];
    const [section, setSection] = React.useState("limit");

    // ── the limit being edited ─────────────────────────────────────────
    // Opened on the row the reader was standing on: a per-model limit row
    // means they were looking at THAT limit, and landing them on "Daily · all
    // models" makes them re-find it.
    const [period, setPeriod] = React.useState(initialPeriod);
    const [scopeKind, setScopeKind] = React.useState(initialScope === "*" ? "all" : "model");
    const [model, setModel] = React.useState(initialScope === "*" ? "" : initialScope);
    const [tokens, setTokens] = React.useState("");
    React.useEffect(() => {
        if (!model && models[0]) setModel(models[0].qualifiedName);
    }, [models, model]);

    const providerRaw = rawRows.find((raw) => raw.providerName === row.providerName && raw.rowKind !== "model") || null;
    const chosenModel = scopeKind === "model" ? (model || models[0]?.qualifiedName || "") : null;
    const targetRaw = scopeKind === "model"
        ? rawRows.find((raw) => raw.providerName === row.providerName && raw.rowKind === "model" && raw.scope === chosenModel) || null
        : providerRaw;
    // These are the PROVIDER's figures, never the viewer's share: a limit caps
    // everyone, so the sentence about it has to be about everyone.
    const targetCell = targetRaw?.periods?.[period] || null;
    const existingTokens = targetCell?.quotaTokens ?? null;
    // NULL is "not known", and it is not zero. A model row exists in the grid
    // only once that model HAS a limit, so the first limit on a model had no
    // row to read and reported 0 spent — which withheld the "this blocks now"
    // warning at exactly the moment it mattered and paused people who had
    // been told the period was empty.
    const spentTokens = targetRaw ? (Number(targetCell?.usedTokens) || 0) : null;
    const spendKnown = spentTokens != null;
    const resetsLabel = row.cells[period]?.resetsLabel || null;
    const periodLabel = BUDGET_PERIOD_TITLES[period] || period;
    const scopeLabel = chosenModel || "all models";

    // The field follows the (period, scope) being pointed at, so it always
    // shows the limit that is actually there rather than the last one typed.
    React.useEffect(() => {
        setTokens(existingTokens == null ? "" : Number(existingTokens).toLocaleString("en-US"));
    }, [existingTokens, period, chosenModel]);

    const parsed = parseTokenCount(tokens);
    const limitValid = Boolean(parsed) && (scopeKind !== "model" || Boolean(chosenModel));
    const replaces = existingTokens != null;
    // An allowance divides every limit, so what actually stops a person is
    // their SHARE of the new number, not the number. Comparing against the
    // raw limit said "nobody is blocked" while saving paused everyone whose
    // own spend was already past their slice of it.
    const allowancePctNow = Number.isFinite(row.allowancePct) ? row.allowancePct : 100;
    const newCeiling = parsed == null || allowancePctNow >= 100
        ? parsed
        : Math.max(1, Math.floor((parsed * allowancePctNow) / 100));
    const yourSpent = Number(targetCell?.yourUsedTokens);
    const wouldPause = spendKnown && parsed !== null && spentTokens >= parsed;
    const wouldPauseSomeone = !wouldPause && parsed !== null && newCeiling !== parsed
        && Number.isFinite(yourSpent) && yourSpent >= newCeiling;

    // ── the allowance ──────────────────────────────────────────────────
    const currentPct = Number.isFinite(row.allowancePct) ? row.allowancePct : 100;
    const [pctRaw, setPctRaw] = React.useState(String(currentPct));
    const pct = Number(String(pctRaw).trim());
    const pctValid = Number.isFinite(pct) && pct >= 1 && pct <= 100 && Math.floor(pct) === pct;
    const providerLimits = ["day", "week", "month"]
        .map((id) => ({ id, label: BUDGET_PERIOD_TITLES[id], tokens: providerRaw?.periods?.[id]?.quotaTokens ?? null }))
        .filter((entry) => entry.tokens != null);

    // ── the hold ───────────────────────────────────────────────────────
    const held = Boolean(row.hold);
    const [holdMode, setHoldMode] = React.useState(held ? "release" : "forever");
    const [until, setUntil] = React.useState("");
    // A datetime-local value is wall-clock with no zone. Read it as local time
    // and send the instant, so a hold set for 18:00 ends at the reader's 18:00.
    const untilIso = (() => {
        if (holdMode !== "until" || !until) return null;
        const at = new Date(until);
        return Number.isNaN(at.getTime()) ? null : at.toISOString();
    })();
    // An instant that has already passed stops nothing. The server accepts it
    // and stores it, so nothing downstream catches it — and the screen then
    // confirmed in words that the provider was stopped when it was not.
    const untilIsPast = Boolean(untilIso) && Date.parse(untilIso) <= Date.now();
    const holdValid = holdMode !== "until" || (Boolean(untilIso) && !untilIsPast);
    const holdHint = holdMode !== "until" ? null
        : untilIsPast ? "That time has already passed. A hold has to end in the future."
            : (until && !untilIso ? "That is not a time this can read." : null);

    const titles = { limit: "Limits", allowance: "Allowance", hold: "Hold" };
    const confirms = {
        limit: replaces ? "Replace limit" : "Save limit",
        allowance: "Save allowance",
        hold: holdMode === "release" ? "Release hold" : "Place hold",
    };
    const foots = {
        limit: "Limits are enforced.",
        allowance: "Applies to everyone.",
        hold: "Stops new turns.",
    };
    const valid = section === "limit" ? limitValid
        : section === "allowance" ? pctValid
            : section === "hold" ? holdValid : true;

    const submit = () => {
        if (section === "limit") {
            if (limitValid) onRun("limit", { period, model: chosenModel, tokens: parsed });
        } else if (section === "allowance") {
            if (pctValid) onRun("allowance", { pct });
        } else if (section === "hold") {
            onRun("hold", holdMode === "release"
                ? { release: true, untilUtc: null }
                : { release: false, untilUtc: untilIso });
        }
    };

    const limitBody = React.createElement(React.Fragment, null,
        React.createElement(SheetField, {
            label: "Time period",
            hint: "One limit per period and scope.",
        },
        React.createElement(Segmented, {
            value: period, onChange: setPeriod, options: BUDGET_PERIOD_OPTIONS, label: "Time period",
        })),
        React.createElement(SheetField, { label: "Applies to" },
            React.createElement(Segmented, {
                value: scopeKind, onChange: setScopeKind, label: "Applies to",
                options: [{ value: "all", label: "all models" }, { value: "model", label: "one model" }],
            }),
            scopeKind === "model" ? React.createElement("select", {
                className: "ps-budget-input", "aria-label": "Model this limit applies to",
                value: model, onChange: (event) => setModel(event.target.value),
            }, models.length === 0
                ? React.createElement("option", { value: "" }, "No models are listed for this provider's type")
                : models.map((option) => React.createElement("option", {
                    key: option.qualifiedName, value: option.qualifiedName,
                }, option.qualifiedName))) : null),
        React.createElement(SheetField, {
            label: "Tokens",
            hint: parsed
                ? `= ${parsed.toLocaleString("en-US")} tokens.`
                : tokens.trim()
                    ? "A whole number of tokens: 20,000,000 or 20M."
                    : "Remove the limit to uncap.",
        },
        React.createElement("input", {
            className: `ps-budget-input${tokens && !parsed ? " is-invalid" : ""}`, value: tokens,
            "aria-label": "Tokens",
            // No inputMode="numeric": the field accepts "20M", and a numeric
            // keypad cannot type the M.
            placeholder: "20,000,000  or  20M",
            onChange: (event) => setTokens(event.target.value),
            onKeyDown: (event) => { if (event.key === "Enter") submit(); },
        })),
        // What this period has already spent, said out loud rather than alluded
        // to. It is the provider's own figure — the one the limit measures.
        React.createElement("div", { className: "ps-budget-consequences" },
            React.createElement("div", null,
                `${periodLabel} · ${scopeLabel} — `,
                spendKnown
                    ? React.createElement(React.Fragment, null,
                        React.createElement("strong", null, `${spentTokens.toLocaleString("en-US")} tokens`),
                        shared ? " spent by users this period." : " spent this period.")
                    // Said plainly rather than guessed at zero: this period may
                    // already be spent past the number about to be saved.
                    : React.createElement(React.Fragment, null,
                        React.createElement("strong", null, "not measured yet"),
                        ". Current spend will count.")),
            resetsLabel ? React.createElement("div", { className: "ps-budget-sub" },
                `Resets ${resetsLabel}.`) : null),
        replaces ? React.createElement("div", { className: "ps-budget-note is-warn" },
            `Replaces the existing ${formatCompactNumber(existingTokens)} token limit.`) : null,
        React.createElement("div", { className: `ps-budget-note${wouldPause || wouldPauseSomeone ? " is-warn" : ""}` },
            "Current spend counts. Saving does not reset usage.",
            wouldPause
                ? ` ${spentTokens.toLocaleString("en-US")} already meets ${parsed.toLocaleString("en-US")}, so sessions on ${row.providerName} pause on their next turn${resetsLabel ? ` — until this period ${budgetResetPhrase(resetsLabel)}` : ""}.`
                : wouldPauseSomeone
                    // The provider has room and a PERSON does not. With an
                    // allowance that is the common case, and the limit alone
                    // never showed it.
                    ? ` At ${allowancePctNow}% each that is ${newCeiling.toLocaleString("en-US")} per person, which you have already spent — so sessions pause on their next turn${resetsLabel ? ` — until this period ${budgetResetPhrase(resetsLabel)}` : ""}.`
                    : ""),
        replaces ? React.createElement("div", null,
            React.createElement("button", {
                type: "button", className: "ps-mini-button is-danger", disabled: busy,
                onClick: () => onRun("removeLimit", { period, model: chosenModel }),
            }, `Remove the ${periodLabel} · ${scopeLabel} limit`),
            React.createElement("div", { className: "ps-budget-note" },
                "Usage history is kept.")) : null);

    const allowanceBody = React.createElement(React.Fragment, null,
        React.createElement(SheetField, {
            label: "Share per person",
            hint: pctValid
                ? (pct >= 100
                    ? "100% removes the per-person ceiling."
                    : `Each person may use up to ${pct}% of each limit, per period.`)
                : "A whole number from 1 to 100.",
        },
        React.createElement("input", {
            className: `ps-budget-input${pctRaw && !pctValid ? " is-invalid" : ""}`, value: pctRaw,
            // Its own name. A group label is not reliably announced when focus
            // lands straight on the field, and "edit text, blank" is not a field.
            "aria-label": "Share per person, as a percentage",
            inputMode: "numeric", placeholder: "20",
            onChange: (event) => setPctRaw(event.target.value),
            onKeyDown: (event) => { if (event.key === "Enter" && pctValid) submit(); },
        })),
        React.createElement("div", { className: "ps-budget-consequences" },
            providerLimits.length === 0
                ? React.createElement("div", { className: "ps-budget-note is-warn" },
                    "No limits yet. The allowance applies when one is added.")
                : React.createElement(React.Fragment, null,
                    providerLimits.map((entry) => React.createElement("div", { key: entry.id },
                        `${entry.label} · ${formatCompactNumber(entry.tokens)} → `,
                        React.createElement("strong", null,
                            pctValid ? `${formatCompactNumber(Math.floor(entry.tokens * pct / 100))} per person` : "—"))),
                    React.createElement("div", { className: "ps-budget-note" },
                        "The provider limit still caps total spend.")),
            pctValid && pct < currentPct ? React.createElement("div", { className: "ps-budget-note is-warn" },
                "Users already past the new ceiling pause on their next turn.") : null));

    const holdBody = React.createElement(React.Fragment, null,
        React.createElement(SheetField, { label: "What to do" },
            React.createElement(Segmented, {
                value: holdMode, onChange: setHoldMode, label: "What to do",
                options: [
                    ...(held ? [{ value: "release", label: "release it" }] : []),
                    { value: "forever", label: "hold until released" },
                    { value: "until", label: "hold until a time" },
                ],
            })),
        holdMode === "until" ? React.createElement(SheetField, {
            label: "Ends at",
            hint: holdHint || "Sessions resume at this time.",
        },
        React.createElement("input", {
            className: `ps-budget-input${until && !holdValid ? " is-invalid" : ""}`,
            "aria-label": "The hold ends at",
            type: "datetime-local", value: until,
            onChange: (event) => setUntil(event.target.value),
        })) : null,
        held ? React.createElement("div", { className: "ps-budget-consequences" },
            React.createElement("div", null, `This provider is on hold: it ${row.hold.label}.`)) : null,
        React.createElement("div", { className: `ps-budget-note${holdMode === "release" ? "" : " is-warn"}` },
            holdMode === "release"
                ? `Releasing wakes every session waiting on ${row.providerName}. A session still over a limit stays paused for that reason instead.`
                : `Every session on ${row.providerName} pauses on its next turn. Messages sent to them are kept and answered when the hold lifts.`));

    return React.createElement(BudgetSheet, {
        title: titles[section], subtitle: `${row.providerName}${shared ? " · shared" : ""}`,
        confirmLabel: confirms[section] || "",
        danger: section === "hold" && holdMode === "release",
        busy, disabled: !valid, error, onCancel,
        onConfirm: confirms[section] ? submit : null,
        cancelLabel: confirms[section] ? "Cancel" : "Done",
        footNote: foots[section],
    },
    sections.length > 1 ? React.createElement(SheetField, { label: "What to change" },
        React.createElement(Segmented, {
            value: section, onChange: setSection, options: sections, label: "What to change",
        })) : null,
    section === "limit" ? limitBody : null,
    section === "allowance" ? allowanceBody : null,
    section === "hold" ? holdBody : null);
}

/**
 * Add a provider. The name is permanent — sessions refer to it — and the
 * credential is the key itself, never a pointer to one.
 */
function CreateProviderSheet({
    types, existingNames, isAdmin, busy, error, onDirty, onCancel, onConfirm,
    initialName = "", initialShared = false, initialType = "", updateProvider = null,
}) {
    const updating = Boolean(updateProvider);
    const [name, setName] = React.useState(initialName);
    const [type, setType] = React.useState(initialType || types[0]?.id || "");
    const [credential, setCredential] = React.useState("");
    const [baseUrl, setBaseUrl] = React.useState("");
    const [shared, setShared] = React.useState(isAdmin && initialShared);
    const ref = React.useRef(null);
    React.useEffect(() => { ref.current?.focus(); }, []);
    React.useEffect(() => { if (!type && types[0]) setType(types[0].id); }, [types, type]);

    const trimmed = name.trim();
    // A name is unique across the cluster and immutable, so a clash is
    // permanent. The database refuses it too; refusing here saves the trip.
    const taken = !updating && existingNames.some((existing) => existing.toLowerCase() === trimmed.toLowerCase());
    // MAJOR 16: the database's own check constraint allows only these, and it
    // reports every violation with one fixed sentence — so a name refused for
    // its LENGTH was told to use letters and numbers, which it already did.
    // Bounded and named here instead, where the rule can be said precisely.
    const badChars = trimmed !== "" && !/^[A-Za-z0-9._-]+$/.test(trimmed);
    const tooLong = trimmed.length > 64;
    const valid = Boolean(trimmed) && !taken && !badChars && !tooLong
        && Boolean(type) && Boolean(credential.trim());
    const isGithub = /github/i.test(type);
    const submit = () => {
        if (!valid) return;
        const input = {
            name: trimmed, type, shared,
            credentials: isGithub ? { githubToken: credential.trim() } : { apiKey: credential.trim() },
            baseUrl: baseUrl.trim() || null,
        };
        setCredential("");
        onConfirm(input);
    };
    const cancel = () => {
        setCredential("");
        onCancel();
    };

    return React.createElement(BudgetSheet, {
        title: updating ? `Update key for ${trimmed}` : (isGithub ? "Add GitHub Copilot provider" : "Add model provider"),
        subtitle: shared ? "Shared" : "Personal",
        confirmLabel: updating ? "Update key" : "Add provider", busy, disabled: !valid, error, onCancel: cancel, onConfirm: submit,
        // The whole point of an update is what does NOT change. Saying so is
        // the difference between "replace the key" and "did I just make a
        // second provider?" — the Delete sheet below spells out its
        // consequences the same way.
        footNote: updating
            ? "Only the key changes. The name, type, base URL, defaults, system-session routing and usage history all stay as they are."
            : "",
    },
    React.createElement(SheetField, {
        label: "Name",
        hint: taken ? "A provider with that name already exists, and names are unique across the cluster."
            : tooLong ? `Too long: ${trimmed.length} characters, and a name may be at most 64.`
                : badChars ? "Letters, numbers, dot, dash and underscore only — no colon, no spaces, no accents: a session refers to it as \"<provider>:<model>\"."
                    : updating ? "Not changing. Sessions keep referring to it as provider:model."
                        : "Permanent. Used in provider:model.",
    },
    React.createElement("input", {
        ref, className: `ps-budget-input${updating ? " is-static" : ""}${(taken || badChars || tooLong) && trimmed ? " is-invalid" : ""}`,
        "aria-label": "Provider name",
        value: name, placeholder: "azure-prod",
        disabled: updating,
        onChange: (event) => { onDirty?.(); setName(event.target.value); },
        onKeyDown: (event) => { if (event.key === "Enter" && valid) submit(); },
    })),
    React.createElement(SheetField, {
        label: "Type",
        hint: updating ? "Not changing." : "Backend and model catalog.",
    },
    React.createElement("select", {
        className: `ps-budget-input${updating ? " is-static" : ""}`, "aria-label": "Provider type",
        value: type, disabled: updating, onChange: (event) => { onDirty?.(); setType(event.target.value); },
    }, types.length === 0
        ? React.createElement("option", { value: "" }, "No provider types are listed on this deployment")
        : types.map((option) => React.createElement("option", { key: option.id, value: option.id }, option.id)))),
    React.createElement(SheetField, {
        label: updating
            ? (isGithub ? "New GitHub Copilot token" : "New API key")
            : (isGithub ? "GitHub Copilot token" : "API key"),
        hint: updating
            ? "Replaces the current one. The existing key is never shown."
            : "Paste the token value.",
    },
    React.createElement("input", {
        className: "ps-budget-input", type: "password", autoComplete: "off",
        "aria-label": updating
            ? (isGithub ? "New GitHub Copilot token" : "New API key")
            : (isGithub ? "GitHub Copilot token" : "API key"),
        value: credential, placeholder: "Paste token",
        onChange: (event) => { onDirty?.(); setCredential(event.target.value); },
        // While updating this is the only editable field, and the Name input
        // that carries the other Enter handler is disabled — so without this
        // the sheet cannot be submitted from the keyboard at all.
        onKeyDown: (event) => { if (event.key === "Enter" && valid) submit(); },
    })),
    !updating ? React.createElement(SheetField, { label: "Base URL", hint: "Optional." },
        React.createElement("input", {
            className: "ps-budget-input", value: baseUrl, placeholder: "https://…",
            "aria-label": "Base URL",
            onChange: (event) => setBaseUrl(event.target.value),
        })) : null,
    isAdmin && !updating ? React.createElement(SheetField, { label: "Access" },
        React.createElement(Segmented, {
            value: shared ? "shared" : "mine", onChange: (value) => setShared(value === "shared"),
            label: "Access",
            options: [{ value: "shared", label: "Shared" }, { value: "mine", label: "Only me" }],
        })) : null);
}

/** Delete a provider. Its sessions are not moved anywhere — they wait. */
function DeleteProviderSheet({ row, limitCount, defaults, busy, error, onCancel, onConfirm }) {
    const isClusterDefault = defaults?.cluster?.provider === row.providerName;
    const isMyDefault = defaults?.mine?.provider === row.providerName;
    return React.createElement(BudgetSheet, {
        title: `Delete ${row.providerName}?`,
        subtitle: row.class === "shared" ? "Shared provider"
            : (row.ownedByMe === false ? "User provider · owned by another user" : "User provider"),
        confirmLabel: "Delete provider", danger: true, busy, error, onCancel, onConfirm,
        // Not "undoes this": re-creating the name only lets the waiting
        // sessions resolve again, against a fresh budget. The limits do not
        // come back.
        footNote: "Creating the name again lets waiting sessions resume, on a fresh budget.",
    },
    // One line per consequence. Each is a fact somebody could be surprised by;
    // none of them needs a paragraph.
    React.createElement("div", { className: "ps-budget-consequences" },
        React.createElement("div", null,
            "Sessions on it ", React.createElement("strong", null, "wait indefinitely"), "."),
        limitCount > 0 ? React.createElement("div", null,
            // budgetPlural already prints the count. Prefixing it printed
            // "2 2 limits".
            React.createElement("strong", null, budgetPlural(limitCount, "limit", "limits")),
            " deleted with it, and they do not come back.") : null,
        isClusterDefault ? React.createElement("div", null,
            React.createElement("strong", null, "It is the cluster default."),
            " The cluster is left with none.") : null,
        isMyDefault ? React.createElement("div", null,
            React.createElement("strong", null, "It is your default."),
            " Yours is cleared.") : null,
        React.createElement("div", { className: "ps-budget-sub" }, "Usage history is retained under this name.")));
}

/**
 * What the surface needs out of the store. selectProviderTable builds fresh
 * arrays on every call, so subscribing to it directly would re-render on every
 * unrelated dispatch — and a streaming session dispatches per token. These are
 * the raw references it actually reads, compared by identity.
 */
function budgetViewDeps(state) {
    const budget = state.budget || {};
    return [
        Boolean(state.ui?.budgetOpen), budget.loading, budget.refreshing, budget.loaded,
        budget.error, budget.grid, budget.paused, budget.overall, budget.selectedProvider,
        budget.selectedScope, budget.missingProvider, budget.series,
        state.auth?.authorization?.role, state.admin?.profile,
    ];
}

/**
 * The whole surface: a head, one table, and the selected provider's days.
 *
 * No device prop: the stylesheet reflows the table into cards on its own, so
 * there is nothing here for a phone to decide.
 */
function ProviderBudgetView({ controller }) {
    const deps = useControllerSelector(controller, budgetViewDeps, shallowEqualObject);
    const view = React.useMemo(() => selectProviderTable(controller.getState()), [controller, deps]);
    // The grid as the server sent it. The sheets need the PROVIDER's own
    // figures — a limit caps everyone — and the table's cells hold whichever
    // pair the tick is showing, which is the viewer's own half the time.
    const rawRows = React.useMemo(() => controller.getState().budget?.grid || [], [controller, deps]);

    // What the sheets need and the table does not: which type each provider is
    // an instance of, and what the two defaults currently name. Read once, and
    // a failure is not fatal — the controls that need it say they have nothing
    // to offer.
    const [models, setModels] = React.useState([]);
    const [providerTypes, setProviderTypes] = React.useState(new Map());
    const [defaults, setDefaults] = React.useState(null);
    const readDefaults = React.useCallback(() => {
        if (typeof controller.transport.getDefaults !== "function") return;
        Promise.resolve(controller.transport.getDefaults())
            .then((rows) => setDefaults(rows || null))
            .catch(() => {});
    }, [controller]);
    React.useEffect(() => {
        let live = true;
        if (typeof controller.transport.listModels === "function") {
            Promise.resolve(controller.transport.listModels())
                .then((rows) => { if (live) setModels(budgetNormalizeModels(rows)); })
                .catch(() => {});
        }
        if (typeof controller.transport.listProviders === "function") {
            Promise.resolve(controller.transport.listProviders())
                .then((rows) => {
                    if (!live) return;
                    const map = new Map();
                    for (const provider of (rows?.providers || [])) map.set(provider.name, provider.typeId || "");
                    setProviderTypes(map);
                })
                .catch(() => {});
        }
        readDefaults();
        return () => { live = false; };
    }, [controller, readDefaults]);

    // Opened by the toolbar, which loads it. Mounting with nothing behind it —
    // a restored state, a second mount — reads once rather than showing zeros.
    React.useEffect(() => {
        const budget = controller.getState().budget || {};
        if (!budget.loaded && !budget.loading && !budget.error) {
            controller.loadProviderTable().catch(() => {});
        }
    }, [controller]);

    // Limits reset, administrators raise them, sessions resume — and nothing
    // here would notice.
    React.useEffect(() => {
        const id = setInterval(() => { controller.refreshProviderTable().catch(() => {}); }, 60_000);
        return () => clearInterval(id);
    }, [controller]);

    // Escape closes the surface — the key every full-screen thing in this app
    // answers to. Not while a <select> or an input has focus, not under a
    // modal, and not while a sheet is open: Escape belongs to whatever is
    // nearest the person.
    React.useEffect(() => {
        const onKey = (event) => {
            if (event.key !== "Escape") return;
            const target = event.target;
            const tag = target && target.tagName;
            if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
            if (controller.getState().ui.modal) return;
            if (document.querySelector(".ps-budget-sheet")) return;
            event.preventDefault();
            event.stopPropagation();
            controller.closeBudget();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [controller]);

    // ── the sheets ─────────────────────────────────────────────────────
    const [sheet, setSheet] = React.useState(null);
    const [sheetBusy, setSheetBusy] = React.useState(false);
    const [sheetError, setSheetError] = React.useState(null);
    // The control the sheet was opened FROM. A sheet that closes without
    // handing focus back drops it on <body>, and the next Tab restarts at the
    // top of the document — nineteen presses from where the person was.
    const openerRef = React.useRef(null);
    const openSheet = (spec) => {
        openerRef.current = typeof document !== "undefined" ? document.activeElement : null;
        setSheetError(null); setSheetBusy(false); setSheet(spec);
    };
    const closeSheet = React.useCallback(() => {
        setSheet(null); setSheetError(null); setSheetBusy(false);
        const opener = openerRef.current;
        openerRef.current = null;
        // A control the change itself removed (Delete) is skipped rather than
        // focused into a detached node.
        if (opener && typeof opener.focus === "function" && document.contains(opener)) {
            opener.focus();
        }
    }, []);
    // Every change comes back as {ok, error, code, result} — nothing throws. A
    // refusal stays in the sheet, in the server's own words, because they name
    // the remedy and nothing this file could invent would.
    const runChange = async (run, { keepOpen = false, onDone = null } = {}) => {
        setSheetBusy(true);
        setSheetError(null);
        const outcome = await run();
        setSheetBusy(false);
        if (!outcome || outcome.ok !== true) {
            setSheetError(outcome?.error || "The change was refused.");
            return;
        }
        if (!keepOpen) closeSheet();
        if (onDone) onDone(outcome.result || null);
    };
    const say = (text) => controller.dispatch({ type: "ui/status", text });

    const selected = view.selected;
    // Edit and Remove are about the PROVIDER even while one of its model rows
    // is the row being read: a limit is edited on the provider, and there is
    // no such thing as deleting a model.
    const selectedProvider = view.selectedProviderRow;
    const modelsForSelected = selected
        ? budgetModelsForProvider(models, {
            name: selected.providerName, typeId: providerTypes.get(selected.providerName) || "",
        })
        : [];

    let sheetEl = null;
    if (sheet?.kind === "edit" && selectedProvider) {
        sheetEl = React.createElement(EditProviderSheet, {
            row: selectedProvider, rawRows, models: modelsForSelected, isAdmin: view.isAdmin,
            // MAJOR 17: the sheet opens on the limit the reader was standing
            // on, rather than always on Daily / all models.
            initialPeriod: sheet.period || "day",
            initialScope: sheet.scope || "*",
            busy: sheetBusy, error: sheetError, onCancel: closeSheet,
            onRun: (kind, payload) => {
                const name = selected.providerName;
                if (kind === "limit") {
                    return runChange(() => controller.setProviderLimit({ provider: name, ...payload }), {
                        onDone: (result) => {
                            const seeded = Number(result?.seededTokens) || 0;
                            say(seeded > 0
                                ? `Limit saved. This period had already spent ${formatCompactNumber(seeded)} tokens, and they count against it.`
                                : "Limit saved. This period has spent nothing against it yet.");
                        },
                    });
                }
                if (kind === "removeLimit") {
                    return runChange(() => controller.removeProviderLimit({ provider: name, ...payload }), {
                        onDone: () => say(`That period no longer caps ${name}.`),
                    });
                }
                if (kind === "allowance") {
                    return runChange(() => controller.setProviderAllowance({ provider: name, pct: payload.pct }), {
                        onDone: () => say(payload.pct >= 100
                            ? `Everyone shares the whole of ${name} again.`
                            : `Each person may now use up to ${payload.pct}% of each of ${name}'s limits.`),
                    });
                }
                if (kind === "hold") {
                    return runChange(() => controller.setProviderHold({ provider: name, ...payload }), {
                        // Reported from what the row says AFTER the read, not
                        // from what was sent: a hold that is not live must
                        // never be confirmed as one.
                        onDone: () => {
                            if (payload.release) {
                                say(`The hold on ${name} is released. Sessions waiting on it wake up.`);
                                return;
                            }
                            // From the STATE, which the change already
                            // re-read — `view` here is the render that opened
                            // the sheet and predates the write.
                            const raw = (controller.getState().budget?.grid || []).find(
                                (r) => r.providerName === name && r.rowKind !== "model");
                            const live = raw?.holdIndefinite === true
                                || (raw?.holdUntilUtc ? Date.parse(raw.holdUntilUtc) > Date.now() : false);
                            say(live
                                ? `${name} is on hold. No new turn runs against it until it is released.`
                                : `${name} is NOT on hold: the time given has already passed.`);
                        },
                    });
                }
                return undefined;
            },
        });
    }

    // ── the head ───────────────────────────────────────────────────────
    const head = React.createElement("div", { className: "ps-budget-head" },
        React.createElement("div", { className: "ps-budget-headline" },
            React.createElement("span", { className: "ps-budget-coin", "aria-hidden": "true" }, "◎"),
            React.createElement("h2", { className: "ps-budget-h" }, "Providers & Budgets"),
            React.createElement("span", { className: "ps-budget-sub" }, "Usage and limits")),
        React.createElement("div", { className: "ps-budget-head-actions" },
            React.createElement(IconButton, {
                icon: React.createElement(CogGlyph),
                label: "Model providers",
                className: "ps-mini-button",
                onClick: () => { controller.closeBudget(); void controller.openAdminConsole(); },
            }),
            React.createElement(IconButton, {
                icon: "↻",
                label: "Refresh providers and budgets",
                className: "ps-mini-button",
                disabled: view.loading || view.refreshing,
                onClick: () => controller.refreshProviderTable().catch(() => {}),
            }),
            React.createElement("button", {
                type: "button", className: "ps-budget-close", onClick: () => controller.closeBudget(),
                "aria-label": "Close providers and budgets", title: "Close (Esc)",
            }, "✕")));

    // A read that FAILED is never dressed up as an empty one: "no providers"
    // and "we could not find out" are different facts, and only one of them is
    // safe to act on.
    let body;
    if (view.failed) {
        body = React.createElement("div", { className: "ps-budget-empty is-error", role: "alert" },
            React.createElement("div", null, "Providers and budgets could not be read. ",
                React.createElement("button", {
                    type: "button", className: "ps-budget-link",
                    onClick: () => controller.loadProviderTable().catch(() => {}),
                }, "Try again")),
            React.createElement("div", { className: "ps-budget-sub" }, view.error));
    } else if (view.loading && !view.loaded) {
        body = React.createElement("div", { className: "ps-budget-empty" }, "Reading providers and budgets…");
    } else {
        body = React.createElement(React.Fragment, null,
            // Numbers are still on screen but the last read failed. Say they
            // are old rather than passing them off as current.
            view.stale ? React.createElement("div", { className: "ps-budget-empty is-error", role: "alert" },
                React.createElement("div", null, "These figures are from an earlier read. The most recent read failed."),
                React.createElement("div", { className: "ps-budget-sub" }, view.error)) : null,
            // One line, not a band. WHY a particular session is stopped is said
            // on the session itself, which is where the remedy is; this only
            // answers "is anything waiting right now".
            view.paused.count > 0 ? React.createElement("div", {
                className: `ps-budget-waiting${view.paused.stale ? " is-stale" : ""}`, role: "status",
            },
            view.paused.sentence,
            " ",
            view.paused.provider ? React.createElement("button", {
                type: "button", className: "ps-budget-link",
                onClick: () => {
                    // The link OPENS the row; it does not toggle it shut when
                    // the reader is already standing on it.
                    if (view.selectedProvider === view.paused.provider) return;
                    controller.selectBudgetProvider(view.paused.provider).catch(() => {});
                },
            }, `Open ${view.paused.provider}`) : null,
            // The numbers above were read fine; THIS line is the old one.
            view.paused.stale ? React.createElement("span", { className: "ps-budget-sub" },
                " This line is from an earlier read — the last one failed.") : null) : null,
            // The waiting list failed and there is nothing behind it, so there
            // is no line to mark. Say the read failed rather than nothing.
            view.paused.count === 0 && view.paused.error ? React.createElement("div", {
                className: "ps-budget-waiting is-stale", role: "status",
            }, "The list of waiting sessions could not be read. The figures below were read successfully.") : null,
            // Somebody arrived here by clicking a provider name on a stopped
            // session, and no such provider exists. Without this the selection
            // is cleared and they are left on a table with nothing selected
            // and no sign that the name they clicked is the missing thing.
            // Creating it again is the whole remedy, but provider lifecycle
            // belongs to Admin Console rather than this usage-policy surface.
            view.missing ? React.createElement("div", {
                className: "ps-budget-waiting is-missing", role: "status",
            },
            view.missing.sentence,
            " ",
            React.createElement("button", {
                type: "button", className: "ps-budget-link",
                onClick: () => { controller.closeBudget(); void controller.openAdminConsole(); },
            }, "Open Model Providers")) : null,
            React.createElement("div", {
                className: `ps-budget-body${view.refreshing ? " is-refreshing" : ""}`,
            },
            React.createElement(ProviderTable, { controller, view, defaults }),
            React.createElement("div", { className: "ps-budget-actions" },
                React.createElement(IconButton, {
                    icon: React.createElement(ManageGlyph),
                    label: "Edit usage policy",
                    className: "ps-mini-button",
                    disabled: !selectedProvider || !selectedProvider.manageable,
                    onClick: () => openSheet({
                        kind: "edit",
                        // Open on the row the reader is standing on: a model
                        // row means they were looking at THAT limit.
                        scope: selected?.kind === "model" ? selected.scope : "*",
                    }),
                }),
                React.createElement("span", { className: "ps-budget-sub" },
                    selected ? selected.providerName : "No provider selected")),
            React.createElement("div", { className: "ps-budget-foot ps-budget-sub" },
                "Manage providers and defaults in Admin Console."),
            // Selecting a row opens its days, with the dashed line at whatever
            // quota the Day cell just showed.
            selected ? React.createElement(ProviderDayChart, { controller, view }) : null,
            selected ? React.createElement(ProviderSystemSpend, { view }) : null));
    }

    return React.createElement("div", { className: "ps-budget-surface" },
        head,
        React.createElement("div", { className: "ps-budget" }, body),
        sheetEl);
}

function ModalLayer({ controller }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const touchScale = useControllerSelector(controller, (state) => Boolean(state.ui.touchScale));
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

    // Display preferences that belong beside the theme rather than in a
    // settings screen of their own. Rendered in the theme picker's footer: it
    // is the "how this looks" surface, and a checkbox there is discoverable in
    // a way a keyboard-only command never is.
    const renderTouchScaleToggle = () => React.createElement("label", {
        className: "ps-modal-toggle",
        title: "Larger type and bigger hit targets, for phones and touch screens.",
    },
        React.createElement("input", {
            type: "checkbox",
            checked: touchScale,
            onChange: (event) => controller.dispatch({ type: "ui/touchScale", enabled: event.target.checked }),
        }),
        React.createElement("span", null, "Mobile"));

    const renderListModal = (presentation, confirmLabel = "Apply", footerExtras = null, headerExtras = null) => {
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
                    // A section header is a disclosure control: one click opens
                    // or closes it. Selecting it and making the user hit the
                    // footer button would be a two-step for something that
                    // reads as a twisty.
                    onClick: () => {
                        controller.dispatch({ type: "ui/modalSelection", index: itemIndex });
                        if (item?.kind === "section") controller.toggleAgentPickerSection(item.sectionKey);
                    },
                },
                React.createElement("div", { className: "ps-line ps-modal-list-line" },
                    React.createElement(Runs, { runs, theme })));
            })
            : (modal.items || []).flatMap((item, index, allItems) => {
                const button = React.createElement("button", {
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
                    })));
                // A group heading is emitted BETWEEN buttons, never as one of
                // them: `index` still addresses items 1:1, so selectedIndex,
                // arrow-key navigation and the scroll-into-view math are all
                // untouched by grouping. Only lists whose items carry a
                // `group` (today: the theme picker) get headings at all.
                const startsGroup = item?.group && item.group !== allItems[index - 1]?.group;
                if (!startsGroup) return [button];
                return [
                    React.createElement("div", {
                        key: `group:${item.group}`,
                        className: "ps-modal-list-group",
                        "aria-hidden": "true",
                    }, item.group),
                    button,
                ];
            });

        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
        React.createElement("div", { className: `ps-modal is-list${modal.type === "themePicker" ? " is-theme-picker" : ""}`, onClick: (event) => event.stopPropagation() },
            React.createElement("div", { className: "ps-modal-header" },
                React.createElement("div", { className: "ps-modal-title" }, presentation.title),
                React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close, "aria-label": "Close", title: "Close" }, "✕"),
            ),
            headerExtras,
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
                footerExtras,
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
        return renderListModal(modalState.themePicker, "Apply Theme", renderTouchScaleToggle());
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
        // Every row is an agent now, so Enter always creates.
        const SORTS = [
            ["used", "Most used", "Ordered by how often YOU have started each agent"],
            ["name", "Name", "Alphabetical by agent name"],
            ["package", "Package", "Grouped by package name, then agent name"],
        ];
        const toolbar = React.createElement("div", { className: "ps-agent-picker-toolbar" },
            React.createElement("input", {
                type: "search",
                className: "ps-agent-picker-search",
                placeholder: "Search agents, packages, tools…",
                value: modal.query || "",
                autoFocus: true,
                "aria-label": "Search agents",
                onChange: (event) => controller.setAgentPickerQuery(event.target.value),
                // The list's own keys must still work from inside the box, but
                // every OTHER key has to stay here — the modal binds j and k to
                // move the selection, and without this you cannot type "kusto".
                onKeyDown: (event) => {
                    const passes = ["ArrowUp", "ArrowDown", "Enter", "Escape", "Tab"];
                    if (!passes.includes(event.key)) event.stopPropagation();
                },
            }),
            React.createElement("div", { className: "ps-agent-picker-sorts", role: "group", "aria-label": "Sort agents" },
                SORTS.map(([value, label, title]) => React.createElement("button", {
                    key: value,
                    type: "button",
                    className: `ps-agent-picker-sort${(modal.sort || "used") === value ? " is-on" : ""}`,
                    title,
                    "aria-pressed": (modal.sort || "used") === value ? "true" : "false",
                    onClick: () => controller.setAgentPickerSort(value),
                }, label))),
        );
        return renderListModal(modalState.sessionAgentPicker, "Create Session", null, toolbar);
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
                    }, modalState.sessionGroupName.mode === "rename" ? "Rename" : "Create and Move")),
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
    const packages = view.packages || {};
    const showPackages = view.section === "packages";
    const showWorkers = view.section === "workers";
    const [providerSheet, setProviderSheet] = React.useState(null);
    const [providerSheetBusy, setProviderSheetBusy] = React.useState(false);
    const [providerSheetError, setProviderSheetError] = React.useState(null);
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

    const onClose = React.useCallback(() => {
        controller.closeAdminConsole();
    }, [controller]);
    const closeProviderSheet = React.useCallback(() => {
        setProviderSheet(null);
        setProviderSheetBusy(false);
        setProviderSheetError(null);
        // The sheet's own error is local state and goes with it. The PANE
        // banner is not: a failed mutation writes it into the store, and
        // nothing cleared it until the next mutation succeeded — so Cancel
        // left a red band describing a change that was abandoned.
        controller.dismissAdminModelProviderMutationError();
    }, [controller]);
    const submitProvider = React.useCallback(async (input) => {
        setProviderSheetBusy(true);
        setProviderSheetError(null);
        const outcome = providerSheet?.update
            ? await controller.updateAdminProviderCredential({ name: input.name, credentials: input.credentials })
            : await controller.createAdminProvider(input);
        setProviderSheetBusy(false);
        if (!outcome?.ok) {
            setProviderSheetError(outcome?.error || `The provider key could not be ${providerSheet?.update ? "updated" : "created"}.`);
            return;
        }
        closeProviderSheet();
    }, [closeProviderSheet, controller, providerSheet]);

    const principalLabel = formatAdminPrincipalLabel(view.principal);

    const header = React.createElement("header", { className: "ps-admin-console__header" },
        React.createElement("h2", null, "Admin Console"),
        React.createElement("span", { className: "ps-admin-console__who" }, principalLabel),
        React.createElement("button", {
            type: "button",
            className: "ps-mini-button is-icon",
            onClick: onClose,
            title: "Close the admin console",
            "aria-label": "Close the admin console",
        }, "\u2715"));

    const providerSection = React.createElement(AdminModelProvidersSection, {
        controller,
        view,
        // One failure should say itself once. While a sheet is open it shows
        // the message itself, and the pane printed the SAME text behind it.
        sheetOpen: Boolean(providerSheet),
        // Open clean: a banner from a previous, abandoned attempt must not
        // greet the next one.
        onAddPersonal: () => { controller.dismissAdminModelProviderMutationError(); setProviderSheet({ shared: false, github: true }); },
        onAddShared: () => { controller.dismissAdminModelProviderMutationError(); setProviderSheet({ shared: true, github: false }); },
        onUpdatePersonal: (provider) => { controller.dismissAdminModelProviderMutationError(); setProviderSheet({ update: provider }); },
    });

    const tree = React.createElement(AdminSettingsTree, { controller, view });
    const detail = React.createElement(AdminPackageDetailPane, { controller, view });
    const workspacePane = showPackages && packages.selectedName
        ? React.createElement(AdminPackageWorkspacePane, { controller, view, layout: wsLayout, onLayout: updateWsLayout })
        : null;
    const dialog = packages.addDialog?.open
        ? React.createElement(AdminAddPackageDialog, { controller, dialog: packages.addDialog })
        : null;
    const createProviderDialog = providerSheet
        ? React.createElement(CreateProviderSheet, {
            types: view.modelProviders?.providerTypes || [],
            existingNames: [
                ...(view.modelProviders?.sharedProviders || []),
                ...(view.modelProviders?.myProviders || []),
            ].map((provider) => provider.name),
            isAdmin: view.isAdmin,
            initialShared: providerSheet.shared,
            updateProvider: providerSheet.update || null,
            initialType: providerSheet.github
                ? (view.modelProviders?.providerTypes || []).find((type) => /github/i.test(type.id))?.id || ""
                : (providerSheet.update?.typeId || ""),
            initialName: providerSheet.update?.name || "",
            busy: providerSheetBusy,
            error: providerSheetError,
            // Editing a field is the person answering the error. Leaving the
            // old failure sitting under the input while they retype makes it
            // look like the new value is already rejected.
            onDirty: () => setProviderSheetError(null),
            onCancel: closeProviderSheet,
            onConfirm: submitProvider,
        })
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
            body = React.createElement("div", { className: "ps-admin-mobile-stack" }, tree, providerSection);
        }
        return React.createElement("div", { className: "ps-admin-console is-mobile" },
            header,
            view.loadError ? React.createElement("div", { className: "ps-admin-console__error", role: "alert" }, view.loadError) : null,
            body,
            dialog,
            createProviderDialog);
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
                showPackages ? detail : showWorkers ? React.createElement(AdminWorkersPane, { controller, view }) : providerSection),
            workspacePane),
        dialog,
        createProviderDialog);
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
                type: "button",
                className: "ps-mini-button is-icon",
                onClick: () => controller.refreshAdminWorkers(),
                disabled: Boolean(workers.loading),
                title: workers.loading ? "Refreshing…" : "Refresh the worker list",
                "aria-label": "Refresh the worker list",
            }, React.createElement("svg", { viewBox: "0 0 20 20", width: 15, height: 15, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
                React.createElement("path", { d: "M16.2 8.2A6.4 6.4 0 0 0 4.6 6.4M3.8 11.8a6.4 6.4 0 0 0 11.6 1.8" }),
                React.createElement("path", { d: "M16.4 3.6v4.6h-4.6M3.6 16.4v-4.6h4.6" })))),
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
                // The selector says WHICH copy this row is — one name can be a
                // shared package and a user copy at once (scope shadowing).
                ? () => controller.selectAdminPackage(row.name, {
                    scope: row.scope === "shared" ? "shared" : "user",
                    ...(row.scope !== "shared" && row.owner?.provider && row.owner?.subject
                        ? { owner: { provider: row.owner.provider, subject: row.owner.subject } }
                        : {}),
                })
                : () => {
                    if (row.id === "providers" || row.id === "myProviders") {
                        controller.setAdminSection("providers");
                        controller.setAdminModelProviderPage("mine");
                    } else if (row.id === "sharedProviders") {
                        controller.setAdminSection("providers");
                        controller.setAdminModelProviderPage("shared");
                    } else {
                        controller.setAdminSection(row.id === "agents" ? "packages" : "workers");
                    }
                };
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
        view.section === "packages" ? React.createElement("button", {
            type: "button",
            className: "ps-admin-tree__add",
            onClick: () => controller.openAdminAddPackage(),
        }, "+ Add package") : null);
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
    // Download is a pure read that streams to the browser, so it does not go
    // through runAdminPackageAction (which mutates and refreshes the detail).
    const downloadPackage = async () => {
        try {
            await controller.transport.saveAgentPackageDownload(
                detail.name,
                detail.activeSemver ?? null,
                { scope: detail.scope, owner: detail.owner ?? null },
            );
        } catch (err) {
            window.alert(`Could not download ${detail.name}: ${err?.message || err}`);
        }
    };
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
                            : (detail.canEdit
                                ? React.createElement("button", { type: "button", className: "ps-mini-button", onClick: act("pin", version.semver), disabled: Boolean(pending) }, "Pin")
                                : null)))))
            : null,
        // Editors live on the shared copy only. Everyone sees the list;
        // only the owner/admin changes it.
        detail.scope === "shared"
            ? React.createElement(AdminPackageEditorsSection, { controller, detail, pending })
            : null,
        detail.canEdit
            ? React.createElement("div", { className: "ps-admin-detail__actions" },
                detail.source && detail.canManage
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
                // Promote MOVES this row to shared scope, so it only works
                // while the shared name is free. Once a shared copy exists,
                // the update path is republish: this version's exact bytes
                // become a new version of the existing shared package.
                detail.scope === "user" && detail.hasSharedCounterpart
                    ? React.createElement("button", {
                        type: "button",
                        className: "ps-mini-button",
                        onClick: act("republish", detail.activeSemver),
                        disabled: Boolean(pending) || !detail.activeSemver,
                        title: `Publish ${detail.name}@${detail.activeSemver ?? "?"} into the existing shared package`,
                    }, pending === "republish" ? "Publishing…" : `Publish ${detail.activeSemver ?? ""} to shared`)
                    : (detail.canManage
                        ? React.createElement("button", { type: "button", className: "ps-mini-button", onClick: act(detail.scope === "shared" ? "demote" : "promote"), disabled: Boolean(pending),
                            title: detail.scope === "shared" && detail.editors.length ? "Demoting revokes every editor grant" : undefined },
                            detail.scope === "shared" ? "Demote to user" : "Promote to shared")
                        : null),
                detail.scope === "shared" && !detail.hasOwnUserCounterpart
                    ? React.createElement("button", {
                        type: "button",
                        className: "ps-mini-button",
                        onClick: act("republish", detail.activeSemver),
                        disabled: Boolean(pending) || !detail.activeSemver,
                        title: "Copy the active version into your user scope as a private test bench",
                    }, pending === "republish" ? "Copying…" : "Copy to my user scope")
                    : null,
                // Getting a published package back OUT. The Web API has always
                // served it; without this the only way was the CLI, which is a
                // strange gap for a console that can publish, promote and
                // delete. Feature-detected: a host with nowhere to put a file
                // does not offer it.
                typeof controller.transport.saveAgentPackageDownload === "function"
                    ? React.createElement("button", {
                        type: "button",
                        className: "ps-mini-button",
                        onClick: () => downloadPackage(),
                        disabled: Boolean(pending) || !detail.activeSemver,
                        title: `Download ${detail.name}@${detail.activeSemver ?? "?"} as the .tgz the CLI would push`,
                    }, pending === "download" ? "Downloading…" : "Download")
                    : null,
                React.createElement("button", { type: "button", className: "ps-mini-button", onClick: act(detail.enabled ? "disable" : "enable"), disabled: Boolean(pending) },
                    detail.enabled ? "Disable" : "Enable"),
                detail.canManage
                    ? React.createElement("button", { type: "button", className: "ps-mini-button is-danger", onClick: confirmDelete, disabled: Boolean(pending) }, "Delete")
                    : null)
            : React.createElement("p", { className: "ps-admin-console__hint" },
                "Read-only: only the package creator, a granted editor, or an admin can modify it."),
        detail.actionError
            ? React.createElement("div", { className: "ps-admin-console__error", role: "alert" }, detail.actionError)
            : null);
}

/**
 * Editors of a SHARED package: named users who may publish, pin and
 * enable/disable it (never scope, delete, or this list). Everyone who can
 * see the package sees the list; only the owner/admin changes it. Grantees
 * are picked from the same member directory the session-share dialog uses.
 */
function AdminPackageEditorsSection({ controller, detail, pending }) {
    const [query, setQuery] = React.useState("");
    const [directory, setDirectory] = React.useState([]);
    React.useEffect(() => {
        if (!detail.canManage || typeof controller.transport.listKnownUsers !== "function") return undefined;
        let cancelled = false;
        controller.transport.listKnownUsers({ limit: 500 })
            .then((users) => { if (!cancelled) setDirectory(Array.isArray(users) ? users : []); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [controller, detail.canManage]);

    const editorKeys = new Set(detail.editors.map((e) => `${e.provider}${e.subject}`));
    const q = query.trim().toLowerCase();
    const suggestions = q
        ? directory.filter((u) => !editorKeys.has(`${u.provider}${u.subject}`) && (
            (u.displayName && u.displayName.toLowerCase().includes(q))
            || (u.email && u.email.toLowerCase().includes(q))
            || (u.subject && u.subject.toLowerCase().includes(q)))).slice(0, 8)
        : [];
    const grant = (user) => {
        if (!user?.provider || !user?.subject) return;
        setQuery("");
        controller.runAdminPackageAction("grantEditor", { provider: user.provider, subject: user.subject });
    };
    // Enter/Add grants only an EXACT match, or the single remaining
    // suggestion. A typo must never hand write access to whoever happens
    // to sort first in the directory — the person picks from the list.
    const grantTyped = () => {
        const text = query.trim();
        if (!text) return;
        const exact = directory.find((u) =>
            (u.displayName && u.displayName.toLowerCase() === text.toLowerCase())
            || (u.email && u.email.toLowerCase() === text.toLowerCase())
            || (u.subject && u.subject.toLowerCase() === text.toLowerCase()));
        if (exact) return grant(exact);
        if (suggestions.length === 1) return grant(suggestions[0]);
    };

    return React.createElement("div", { className: "ps-admin-editors" },
        React.createElement("div", { className: "ps-admin-detail__label" }, "Editors"),
        detail.editors.length
            ? React.createElement("div", { className: "ps-admin-detail__chips" },
                detail.editors.map((e) => React.createElement("span", {
                    key: `${e.provider}${e.subject}`,
                    className: "ps-agent-chip",
                    title: `${e.provider}:${e.subject}${e.grantedByDisplay ? ` · granted by ${e.grantedByDisplay}` : ""}`,
                },
                    e.label,
                    detail.canManage
                        ? React.createElement("button", {
                            type: "button",
                            className: "ps-chip-remove",
                            "aria-label": `Remove editor ${e.label}`,
                            disabled: Boolean(pending),
                            onClick: () => controller.runAdminPackageAction("revokeEditor", { provider: e.provider, subject: e.subject }),
                        }, "×")
                        : null)))
            : React.createElement("p", { className: "ps-admin-console__hint" },
                detail.canManage
                    ? "No editors yet. Add a person to let them publish, pin and enable this package. Grants are revoked if the package is demoted."
                    : "Only the owner and admins can change this package."),
        detail.canManage
            ? React.createElement("div", { className: "ps-admin-editors__add" },
                React.createElement("input", {
                    type: "text",
                    className: "ps-input",
                    placeholder: "Add editor by name, email, or id…",
                    value: query,
                    disabled: Boolean(pending),
                    onChange: (event) => setQuery(event.target.value),
                    onKeyDown: (event) => { if (event.key === "Enter") { event.preventDefault(); grantTyped(); } },
                    "aria-label": "Add editor",
                }),
                React.createElement("button", { type: "button", className: "ps-mini-button", onClick: grantTyped, disabled: Boolean(pending) || !query.trim() }, "Add"),
                suggestions.length
                    ? React.createElement("div", { className: "ps-admin-editors__suggestions", role: "listbox" },
                        suggestions.map((u) => React.createElement("button", {
                            key: `${u.provider}${u.subject}`,
                            type: "button",
                            role: "option",
                            className: "ps-admin-editors__suggestion",
                            onClick: () => grant(u),
                        }, u.displayName || u.email || u.subject, u.email && u.displayName ? React.createElement("i", null, ` ${u.email}`) : null)))
                    : null)
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

function adminDefaultModel(defaultView) {
    return defaultView?.configured?.model || "";
}

function AdminDefaultSelect({ label, hint, value, choices, disabled, emptyLabel, onChange }) {
    return React.createElement("label", { className: "ps-admin-provider-default" },
        React.createElement("span", { className: "ps-admin-detail__label" }, label),
        React.createElement("select", {
            className: "ps-budget-input",
            value,
            disabled,
            "aria-label": label,
            onChange: (event) => onChange(event.target.value),
        },
        React.createElement("option", { value: "" }, emptyLabel),
        value && !choices.some((choice) => choice.qualifiedName === value)
            ? React.createElement("option", { value }, `${value} (currently configured)`)
            : null,
        choices.map((choice) => React.createElement("option", {
            key: choice.qualifiedName,
            value: choice.qualifiedName,
        }, `${choice.provider} · ${choice.model}`))),
        hint ? React.createElement("span", { className: "ps-admin-console__hint" }, hint) : null);
}

function AdminProviderRows({ providers, isAdmin, personal, busy, onSystemUse, onUpdate, onDelete }) {
    if (!providers.length) {
        return React.createElement("p", { className: "ps-admin-console__hint" },
            personal ? "No personal providers yet." : "No shared providers are configured.");
    }
    return React.createElement("div", { className: "ps-admin-provider-list" },
        providers.map((provider) => React.createElement("div", {
            key: provider.name,
            className: "ps-admin-provider-row",
        },
        React.createElement("div", { className: "ps-admin-provider-row__identity" },
            // Truncates when the row is tight (see the CSS), so the full name
            // has to be recoverable on hover.
            React.createElement("strong", { title: provider.name }, provider.name),
            React.createElement("span", { className: `ps-scope-badge is-${provider.class === "shared" ? "shared" : "user"}` }, provider.class),
            provider.isMyDefault ? React.createElement("span", { className: "ps-scope-badge is-off" }, "my default") : null,
            provider.isClusterDefault ? React.createElement("span", { className: "ps-scope-badge is-off" }, "cluster default") : null,
            provider.isSystemDefault ? React.createElement("span", { className: "ps-scope-badge is-off" }, "system default") : null),
        React.createElement("div", { className: "ps-admin-provider-row__actions" },
            personal && isAdmin ? React.createElement("label", { className: "ps-admin-console__system-toggle" },
                React.createElement("input", {
                    type: "checkbox",
                    checked: provider.systemUseEnabled,
                    disabled: busy,
                    onChange: (event) => onSystemUse(provider.name, event.target.checked),
                }),
                "Allow system sessions") : null,
            personal ? React.createElement("button", {
                type: "button",
                className: "ps-mini-button",
                // Three providers means three identical "Update Key" buttons
                // to a screen reader. The trash below already names its row.
                "aria-label": `Update key for ${provider.name}`,
                title: `Update key for ${provider.name}`,
                disabled: busy,
                onClick: () => onUpdate(provider),
            }, "Update key") : null,
            React.createElement(IconButton, {
                icon: React.createElement(TrashGlyph),
                label: `Delete ${provider.name}`,
                className: "ps-mini-button is-danger",
                disabled: busy,
                onClick: () => onDelete(provider),
            })))));
}

function AdminModelProvidersSection({ controller, view, onAddPersonal, onAddShared, onUpdatePersonal, sheetOpen = false }) {
    const providers = view.modelProviders || {};
    const pending = Boolean(providers.mutation?.pending);
    const systemConfigured = adminDefaultModel(providers.systemSessionDefault);
    const [systemDraft, setSystemDraft] = React.useState(systemConfigured);
    const [restartDisposition, setRestartDisposition] = React.useState("");
    const [restartResult, setRestartResult] = React.useState(null);

    React.useEffect(() => {
        setSystemDraft(systemConfigured);
    }, [systemConfigured]);

    const choiceFor = (choices, qualifiedName) => choices.find((choice) => choice.qualifiedName === qualifiedName) || null;
    const setDefault = (scope, choices, qualifiedName) => {
        void controller.setAdminModelDefault(scope, choiceFor(choices, qualifiedName));
    };
    const deleteProvider = (provider) => {
        if (!window.confirm(`Delete ${provider.name}? Sessions using it will wait until that provider name exists again.`)) return;
        void controller.deleteAdminProvider(provider.name, { shared: provider.class === "shared" });
    };
    const applySystemDefault = async () => {
        setRestartResult(null);
        const outcome = await controller.setAdminSystemModelDefault(
            choiceFor(providers.systemChoices || [], systemDraft),
            { restartDisposition: restartDisposition || null },
        );
        if (outcome?.ok) setRestartResult(outcome.result?.restart || { requested: false });
    };
    const inheritingAgents = (providers.systemAgentRoutes || []).filter((route) => !route.override);
    const sharedPage = providers.page === "shared" && view.isAdmin;

    const pageHeader = React.createElement("div", { className: "ps-admin-provider-heading" },
        React.createElement("h3", null, "Model Providers"),
        React.createElement(IconButton, {
            icon: "↻",
            label: "Refresh model providers",
            className: "ps-mini-button",
            disabled: providers.loading,
            onClick: () => controller.refreshAdminModelProviders(),
        }));

    const myPage = React.createElement(React.Fragment, null,
        React.createElement("div", { className: "ps-admin-provider-block" },
            React.createElement("div", { className: "ps-admin-provider-block__head" },
                React.createElement("h4", null, "My Providers"),
                React.createElement("button", {
                    type: "button", className: "ps-primary-button",
                    onClick: onAddPersonal, disabled: pending,
                }, "Add provider")),
            React.createElement(AdminProviderRows, {
                providers: providers.myProviders || [], isAdmin: view.isAdmin, personal: true, busy: pending,
                onSystemUse: (name, enabled) => controller.setAdminProviderSystemUse(name, enabled),
                onUpdate: onUpdatePersonal,
                onDelete: deleteProvider,
            })),
        React.createElement("div", { className: "ps-admin-provider-block" },
            React.createElement(AdminDefaultSelect, {
                label: "My Session Default",
                hint: `Effective: ${providers.mySessionDefault?.effective?.model || "none"}.`,
                value: adminDefaultModel(providers.mySessionDefault),
                choices: providers.userChoices || [],
                disabled: pending,
                emptyLabel: "Use cluster default",
                onChange: (value) => setDefault("user", providers.userChoices || [], value),
            })));

    const sharedProvidersPage = React.createElement(React.Fragment, null,
        React.createElement("div", { className: "ps-admin-provider-block" },
            React.createElement("div", { className: "ps-admin-provider-block__head" },
                React.createElement("h4", null, "Shared Providers"),
                React.createElement("button", {
                    type: "button", className: "ps-primary-button",
                    onClick: onAddShared, disabled: pending,
                }, "Add provider")),
            React.createElement(AdminProviderRows, {
                providers: providers.sharedProviders || [], isAdmin: true, personal: false, busy: pending,
                onSystemUse: () => {}, onDelete: deleteProvider,
            })),
        React.createElement("div", { className: "ps-admin-provider-block" },
            React.createElement(AdminDefaultSelect, {
                label: "Cluster Session Default",
                hint: `Effective: ${providers.clusterSessionDefault?.effective?.model || "none"}.`,
                value: adminDefaultModel(providers.clusterSessionDefault),
                choices: providers.clusterChoices || [],
                disabled: pending,
                emptyLabel: "Use first shared provider",
                onChange: (value) => setDefault("cluster", providers.clusterChoices || [], value),
            })),
        React.createElement("div", { className: "ps-admin-provider-block" },
            React.createElement("h4", null, "System Session Default"),
            React.createElement(AdminDefaultSelect, {
                label: "Model",
                hint: "Shared and system-enabled personal providers.",
                value: systemDraft,
                choices: providers.systemChoices || [],
                disabled: pending,
                emptyLabel: "Use first eligible provider",
                onChange: setSystemDraft,
            }),
            React.createElement("div", { className: "ps-admin-detail__label" }, "Existing system sessions"),
            React.createElement(Segmented, {
                value: restartDisposition,
                onChange: setRestartDisposition,
                label: "Existing system sessions",
                options: [
                    { value: "", label: "Future only" },
                    { value: "complete", label: "Complete & restart" },
                    { value: "terminate", label: "Terminate & restart" },
                    { value: "hard_delete", label: "Hard delete & restart" },
                ],
            }),
            React.createElement("div", { className: "ps-admin-provider-apply" },
                React.createElement("p", { className: "ps-admin-console__hint" },
                    `${inheritingAgents.length} agent${inheritingAgents.length === 1 ? "" : "s"} inherit this default.`),
                React.createElement("button", {
                    type: "button", className: "ps-primary-button", disabled: pending, onClick: applySystemDefault,
                }, pending && providers.mutation?.pending === "systemDefault" ? "Applying…" : "Apply")),
            restartResult?.requested ? React.createElement("p", { className: "ps-admin-console__status" },
                `${restartResult.restarted}/${restartResult.affected} restarted${restartResult.failures?.length ? ` · ${restartResult.failures.length} failed` : ""}.`) : null),
        React.createElement("div", { className: "ps-admin-provider-block" },
            React.createElement("h4", null, "System Agent Overrides"),
            (providers.systemAgentRoutes || []).length === 0
                ? React.createElement("p", { className: "ps-admin-console__hint" }, "No system agents.")
                : React.createElement("div", { className: "ps-admin-override-table" },
                    (providers.systemAgentRoutes || []).map((route) => React.createElement("div", {
                        key: route.agentId, className: "ps-admin-override-row",
                    },
                    React.createElement("div", { className: "ps-admin-override-row__agent" },
                        React.createElement("strong", null, route.title),
                        React.createElement("span", null, route.effectiveModel || "blocked"),
                        React.createElement("small", null, route.override ? "override" : "system default")),
                    React.createElement("select", {
                        className: "ps-budget-input",
                        value: route.override?.model || "",
                        disabled: pending,
                        "aria-label": `Model override for ${route.title}`,
                        onChange: (event) => {
                            const choice = choiceFor(providers.systemChoices || [], event.target.value);
                            if (choice) void controller.setAdminSystemAgentModel(route.agentId, choice);
                            else void controller.clearAdminSystemAgentModel(route.agentId);
                        },
                    },
                    React.createElement("option", { value: "" }, "Inherit system default"),
                    (providers.systemChoices || []).map((choice) => React.createElement("option", {
                        key: choice.qualifiedName, value: choice.qualifiedName,
                    }, `${choice.provider} · ${choice.model}`))))))));

    return React.createElement("section", { className: "ps-admin-detail ps-admin-model-providers" },
        pageHeader,
        // A mutation error belongs to the sheet that raised it while that sheet
        // is up. `providers.error` is different — it is the LOAD failing, which
        // is about the pane itself, so it still shows.
        providers.error || (providers.mutation?.error && !sheetOpen)
            ? React.createElement("div", { className: "ps-admin-console__error", role: "alert" },
                (!sheetOpen && providers.mutation?.error) || providers.error)
            : null,
        sharedPage ? sharedProvidersPage : myPage);
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
    }));
    return new PilotSwarmUiController({ store, transport });
}

export function PilotSwarmWebApp({ controller }) {
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
            try {
                const probe = document.createElement("span");
                probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;";
                // Measure with the font real lines render in — an off-context
                // probe can inherit a different size and skew the column count.
                // Longhands, not the `font` shorthand: Safari serializes the
                // shorthand as "" whenever the longhands do not reduce to a
                // canonical form, which silently reverted the probe to its
                // parent's font.
                const sample = document.querySelector(".ps-scroll-panel .ps-line") || document.querySelector(".ps-line");
                if (sample) {
                    const cs = window.getComputedStyle(sample);
                    probe.style.fontFamily = cs.fontFamily;
                    probe.style.fontSize = cs.fontSize;
                    probe.style.fontWeight = cs.fontWeight;
                    probe.style.letterSpacing = cs.letterSpacing;
                }
                probe.textContent = "0".repeat(100);
                (sample?.parentElement || document.body).appendChild(probe);
                const charWidth = (probe.getBoundingClientRect().width / 100) || 8;
                probe.remove();
                // Layout viewport, NOT window.innerWidth: on iOS innerWidth tracks
                // the VISUAL viewport, so a probe taken while pinch-zoomed (or with
                // the keyboard up) publishes a wildly wrong column count and the
                // sequence grid is built for a viewport that doesn't exist.
                const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
                const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
                controller.dispatch({
                    type: "ui/viewport",
                    width: Math.floor(layoutWidth / charWidth),
                    height: Math.floor(layoutHeight / SCROLL_ROW_HEIGHT),
                });
            } catch {
                // A probe crash keeps the last published (or fallback) size;
                // the pane-clamp below self-corrects the inspector regardless.
            }
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
    // The phone's Main layout: split | chat | sessions (cycled by the Main
    // toolbar button). Desktop has real columns and needs no such cycle.
    const [mobileMainLayout, setMobileMainLayout] = React.useState("split");
    const state = useControllerSelector(controller, (rootState) => ({
        themeId: rootState.ui.themeId,
        touchScale: Boolean(rootState.ui.touchScale),
        sessionDetailCollapsed: Boolean(rootState.ui.sessionDetailCollapsed),
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
        rightPaneMode: rootState.ui.rightPaneMode || "panes",
        // The two optional desktop columns, independent of each other.
        canvasOpen: rootState.ui.canvasOpen === true,
        diagnosticsOpen: rootState.ui.diagnosticsOpen === true,
        canvasMaximized: rootState.ui.canvasMaximized === true,
        canvasZen: rootState.ui.canvasZen === true,
        // Live reference — reducer updates replace the object, so
        // shallow-equal sees changes and the save effect fires.
        canvasPrefs: rootState.canvas?.prefs,
        activeSessionIsGroup: Boolean(rootState.sessions.activeSessionId && rootState.sessions.byId[rootState.sessions.activeSessionId]?.isGroup),
        paneAdjust: rootState.ui.layout?.paneAdjust ?? 0,
        sessionPaneAdjust: rootState.ui.layout?.sessionPaneAdjust ?? 0,
        portalSessionColumnAdjust: rootState.ui.layout?.portalSessionColumnAdjust ?? 0,
        activityPaneAdjust: rootState.ui.layout?.activityPaneAdjust ?? 0,
        canvasPaneAdjust: rootState.ui.layout?.canvasPaneAdjust ?? 0,
        diagnosticsPaneAdjust: rootState.ui.layout?.diagnosticsPaneAdjust ?? 0,
        diagnosticsSplitAdjust: rootState.ui.layout?.diagnosticsSplitAdjust ?? 0,
        focusRegion: rootState.ui.focusRegion,
        requestedFocusRegion: rootState.ui.requestedFocusRegion,
        inspectorTab: rootState.ui.inspectorTab,
        filesFullscreen: Boolean(rootState.files.fullscreen),
        selectedArtifactId: rootState.files.selectedArtifactId || null,
        artifactPaneOpen: Boolean(rootState.files.paneOpen),
        adminVisible: Boolean(rootState.admin?.visible),
        // Providers & Budgets takes the workspace, like the admin console. The
        // reducer keeps the two apart — opening either closes the other — so
        // this only decides which one is drawn.
        budgetOpen: Boolean(rootState.ui?.budgetOpen),
    }), shallowEqualObject);
    const profileSettingsHydratedRef = React.useRef(false);
    const lastProfileSettingsJsonRef = React.useRef(null);
    // Last-known value of the OTHER device class's chat-view slot. The save
    // endpoint replaces the whole settings object, so this is what keeps a
    // desktop save from erasing the phone's preference.
    const otherTouchScaleRef = React.useRef(null);
    // Last-known stored rightPaneMode — the desktop-owned slot a phone must
    // carry through its saves untouched (see profileSettingsFromViewState).
    const desktopRightPaneModeRef = React.useRef(null);
    // Same preservation contract as desktopRightPaneModeRef: a phone must not
    // overwrite the desktop's column toggles with its own (absent) ones.
    const desktopPanesRef = React.useRef(null);
    const profileSettingsSaveTimerRef = React.useRef(null);
    const profileSettingsPollTimerRef = React.useRef(null);
    const profileSettingsPollInFlightRef = React.useRef(false);
    const profileSettingsSaveInFlightRef = React.useRef(false);
    const appliedProfileSettingsJsonRef = React.useRef(null);
    const defaultProfileSettingsRef = React.useRef(null);
    const [mobilePane, setMobilePane] = React.useState("workspace");
    const mobile = (viewport.width || window.innerWidth || 0) < MOBILE_BREAKPOINT;
    const readOnlyChatPane = state.activeSessionIsGroup;
    const effectivePromptRows = readOnlyChatPane ? 0 : state.promptRows;

    useKeyboardShortcuts(controller, mobile);

    // Keyboard takeover (phone): while the on-screen keyboard is up and the
    // composer summoned it, the conversation owns the visual viewport — the
    // portal header, toolbar and session list fold away via a body class and
    // the transcript snaps to newest. The chat pane's own header stays as the
    // context strip (session title · status · model), and tapping anywhere
    // outside the composer dismisses the keyboard and restores everything.
    const keyboardTakeover = useKeyboardTakeover(mobile && mobilePane === "workspace" && !state.adminVisible);
    React.useEffect(() => {
        if (typeof document === "undefined") return undefined;
        document.body.classList.toggle("ps-kb-takeover", keyboardTakeover);
        return () => document.body.classList.remove("ps-kb-takeover");
    }, [keyboardTakeover]);
    React.useEffect(() => {
        if (!keyboardTakeover) return;
        // Typing means replying to the newest message; a transcript left
        // scrolled to last week would have the user typing blind.
        controller.applyPaneVisualScrollOffset?.("chat", 0, { followBottom: true });
    }, [keyboardTakeover, controller]);

    // The agent-driven canvas flip, phone edition. The desktop column follows
    // ui.rightPaneMode by itself; the phone's pane lives in local tab state,
    // so it follows the flip TICK instead (which fires even when the mode was
    // already "canvas" — e.g. a persisted mode with the user on Main).
    const canvasShellView = useControllerSelector(controller, selectCanvasView, shallowEqualObject);
    // "canvas" is a fourth value of mobilePane, alongside workspace, activity
    // and inspector — the canvas is one more thing that can be showing in the
    // content region, not a screen layered over the app.
    const mobileCanvasOpen = mobilePane === "canvas";
    // Which pane the canvas was opened FROM. Toggling it off puts that back —
    // chat, activity or inspector — instead of dropping the user on Main.
    const paneBeforeCanvasRef = React.useRef("workspace");
    // Once opened, the canvas stays MOUNTED (hidden) for the rest of the
    // session selection — page state (typed input, scroll, game progress)
    // survives toggling. A session switch remounts fresh via the key below.
    const [mobileCanvasEverOpened, setMobileCanvasEverOpened] = React.useState(false);
    const [desktopCanvasEverOpened, setDesktopCanvasEverOpened] = React.useState(false);
    React.useEffect(() => {
        setMobilePane((current) => (current === "canvas" ? (paneBeforeCanvasRef.current || "workspace") : current));
        setMobileCanvasEverOpened(false);
        setDesktopCanvasEverOpened(false);
    }, [canvasShellView.sessionId]);
    // iOS scroll-chaining: while the canvas is up, a pan that Safari decides
    // is not the iframe's must not scroll the app shell behind it.
    React.useEffect(() => {
        if (typeof document === "undefined") return undefined;
        document.body.classList.toggle("ps-canvas-lock", Boolean(mobile && mobileCanvasOpen));
        return () => document.body.classList.remove("ps-canvas-lock");
    }, [mobile, mobileCanvasOpen]);
    const openMobileCanvas = React.useCallback(() => {
        if (mobilePane !== "canvas") paneBeforeCanvasRef.current = mobilePane;
        setMobilePane("canvas");
        setMobileCanvasEverOpened(true);
        // Entering by hand un-opts-out, same as the desktop toggle.
        controller.dispatch({ type: "ui/rightPaneMode", mode: "canvas", sessionId: canvasShellView.sessionId });
    }, [controller, mobilePane, canvasShellView.sessionId]);
    const closeMobileCanvas = React.useCallback(() => {
        setMobilePane(paneBeforeCanvasRef.current || "workspace");
        // Mirror the desktop ✕ exactly: a deliberate close is the opt-out
        // gesture — later draws badge the toggle instead of re-covering the
        // transcript, and reopening clears the opt-out.
        controller.dispatch({ type: "ui/rightPaneMode", mode: "panes", sessionId: canvasShellView.sessionId, manual: true });
    }, [controller, canvasShellView.sessionId]);
    const canvasFlipSeqRef = React.useRef(canvasShellView.flipSeq);
    React.useEffect(() => {
        if (canvasShellView.flipSeq === canvasFlipSeqRef.current) return;
        canvasFlipSeqRef.current = canvasShellView.flipSeq;
        if (mobile) openMobileCanvas();
    }, [canvasShellView.flipSeq, mobile, openMobileCanvas]);
    const toggleMobileCanvas = React.useCallback(() => {
        if (mobileCanvasOpen) { closeMobileCanvas(); return; }
        openMobileCanvas();
    }, [mobileCanvasOpen, closeMobileCanvas, openMobileCanvas]);

    // gridViewport used to be PUBLISHED here via controller.setViewport — a
    // second writer to ui.layout that derived columns from the hard-coded
    // GRID_CELL_WIDTH instead of the rendered font. The two publishers fought
    // (last writer wins), which is how a phone ended up laying out its
    // inspector for a column count no probe ever measured. The font-probe
    // effect is the only publisher now; gridViewport stays local to the
    // desktop pane splitter below.

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
                if (typeof remoteNormalized[otherTouchScaleKey()] === "boolean") {
                    otherTouchScaleRef.current = remoteNormalized[otherTouchScaleKey()];
                }
                if (remoteNormalized.rightPaneMode === "canvas" || remoteNormalized.rightPaneMode === "panes") {
                    desktopRightPaneModeRef.current = remoteNormalized.rightPaneMode;
                }
                // Its own check: a profile written by this build carries
                // desktopPanes and need not carry the legacy enum at all.
                if (remoteNormalized.desktopPanes) {
                    desktopPanesRef.current = remoteNormalized.desktopPanes;
                }
                defaultProfileSettingsRef.current = buildDefaultProfileSettingsFromState(
                    controller.getState(), otherTouchScaleRef.current, desktopRightPaneModeRef.current, desktopPanesRef.current,
                );
                // First visit on a desktop wide enough to hold it: open the
                // canvas. A workspace that opens as chat alone hides the thing
                // most sessions are FOR, and the canvas needs real width to be
                // worth showing — below the breakpoint chat alone is better.
                //
                // Folded into the settings rather than dispatched separately.
                // A separate dispatch raced the re-baseline at the end of this
                // same poll: the new value was recorded as "already saved",
                // never written, and the next poll put it back. Going through
                // the settings means the normal apply-and-save path carries it.
                //
                // Only when NOTHING is stored. An explicit choice, including
                // closing the canvas, is a preference from then on. Not
                // live-responsive either: narrowing the window never closes a
                // canvas the user opened on purpose.
                const wantsDefaultCanvas = !hasStoredDesktopPanes(remoteNormalized)
                    && !isNarrowViewport()
                    && window.innerWidth >= PORTAL_CANVAS_DEFAULT_MIN_VIEWPORT_PX;
                const settings = materializeProfileSettings(
                    profile?.profileSettings,
                    defaultProfileSettingsRef.current,
                );
                if (wantsDefaultCanvas) settings.desktopPanes = { canvasOpen: true, diagnosticsOpen: false };
                const settingsJson = JSON.stringify(settings);
                const currentSettingsBeforeApply = profileSettingsFromViewState(
                    controller.getState(), otherTouchScaleRef.current, desktopRightPaneModeRef.current, desktopPanesRef.current,
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

                // First run on this account, on a desktop wide enough to hold
                // it: open the canvas. A workspace that opens as chat alone
                // hides the thing most sessions are FOR, and the canvas needs
                // real width to be worth showing — below the breakpoint chat
                // alone is the better default.
                //
                // Once only, and only when nothing is stored. An explicit
                // choice, including closing it, is a stored preference from
                // then on and is never second-guessed. Not live-responsive
                // either: narrowing the window does not close a canvas the
                // user opened on purpose.
                // remoteNormalized, NOT `settings`: the merged object always
                // carries desktopPanes because the defaults are synthesized
                // from current state, so it can never say "unset" and the
                // default below would never fire.

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
                        controller.getState(), otherTouchScaleRef.current, desktopRightPaneModeRef.current, desktopPanesRef.current,
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
        const settings = profileSettingsFromViewState(state, otherTouchScaleRef.current, desktopRightPaneModeRef.current, desktopPanesRef.current);
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
    }, [controller, state.activeSessionId, state.activityPaneAdjust, state.canvasOpen, state.canvasPaneAdjust, state.canvasPrefs, state.canvasZen, state.collapsedSessionIds, state.diagnosticsOpen, state.diagnosticsPaneAdjust, state.diagnosticsSplitAdjust, state.ownerFilter, state.paneAdjust, state.manualOrder, state.pinnedIds, state.portalSessionColumnAdjust, state.rightPaneMode, state.sessionDetailCollapsed, state.sessionPaneAdjust, state.themeId, state.touchScale]);

    React.useEffect(() => {
        applyDocumentTheme(state.themeId);
        applyTouchScale(state.touchScale);
    }, [state.themeId, state.touchScale]);

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
        // Follow focus ONLY into the two panes that are nothing but focus
        // targets. Mapping chat/sessions/prompt back to Main fought the
        // toolbar: the sessions-only layout's list reclaims focus, which
        // bounced the user out of Inspector the instant they tapped it.
        // Returning to Main is the Main button's job now.
        //
        // Gate on the RAW request, not the normalized region: on a phone a
        // workspace region (sessions/chat) normalizes to inspector, so the
        // Main button's own setFocus("chat") would otherwise land here as an
        // "inspector" focus and yank the user into diagnostics the instant
        // they asked for the workspace. Only a focus the caller genuinely
        // aimed at inspector/activity switches the pane.
        const requested = state.requestedFocusRegion;
        if (mobile
            && (state.focusRegion === "inspector" || state.focusRegion === "activity")
            && (requested === "inspector" || requested === "activity")) {
            setMobilePane(state.focusRegion);
        }
    }, [mobile, state.focusRegion, state.requestedFocusRegion]);

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

    // The takeover pane only makes sense on desktop; the phone has its own
    // full-viewport overlay and no column to take over.
    const artifactPaneActive = !mobile
        && state.artifactPaneOpen
        && Boolean(state.selectedArtifactId)
        && !filesFullscreenActive;

    // Canvas mode claims the column beneath the reader: the reader still takes
    // precedence while open, and its ✕ leaves rightPaneMode untouched — so
    // closing a preview returns to the canvas, restore-what-was-displaced.
    const canvasModeActive = !mobile
        && state.canvasOpen
        && !filesFullscreenActive;
    // sessionId is a dep ON PURPOSE, not just canvasModeActive. The reset
    // effect above wipes the gate whenever the session settles or switches —
    // and on a cold load the settings poll applies canvasOpen BEFORE the
    // sessions list has loaded, so activeSessionId lands in a LATER commit.
    // Keyed on canvasModeActive alone this never re-fired (the flag had not
    // changed), the gate stayed false, and a canvas that was open by stored
    // preference or by the wide-screen default simply never rendered.
    // Effects run in declaration order, so within one commit the reset runs
    // first and this one wins: active canvas => mounted canvas, always.
    React.useEffect(() => {
        if (canvasModeActive) setDesktopCanvasEverOpened(true);
    }, [canvasModeActive, canvasShellView.sessionId]);

    // Diagnostics — Inspector + Activity as one column, beside the canvas
    // rather than instead of it. The artifact reader still takes the whole
    // right side while it is open, as it always did.
    const diagnosticsActive = !mobile
        && state.diagnosticsOpen
        && !filesFullscreenActive
        && !artifactPaneActive
        // Zen is chat + canvas only; diagnostics keeps its stored toggle and
        // returns when zen ends.
        && !(state.canvasZen && state.canvasOpen);
    // Whether the right side of the workspace exists at all. Both columns off
    // is the default: sessions and chat, nothing else. An absent column takes
    // no width and grows no resizer — off means gone, not collapsed.
    const rightSideActive = artifactPaneActive || canvasModeActive || diagnosticsActive;

    // In the STORE, not local state: the header owns the way out (the rev
    // strip is promoted up there while full screen), and every other toolbar
    // button has to be able to drop it before doing its own job.
    const canvasMaximized = state.canvasMaximized && canvasModeActive;
    // Zen: chat rail + canvas workbench. Diagnostics steps aside but keeps
    // its stored toggle; the session list hides entirely.
    const zenActive = state.canvasZen && canvasModeActive && !artifactPaneActive;
    const zenRailPx = Math.max(260, Math.min(720,
        Number(state.canvasPrefs?.[state.activeSessionId]?.zenRailPx) || 380));
    // Escape steps down one rung: full screen -> zen -> normal workspace.
    React.useEffect(() => {
        if (!canvasMaximized && !zenActive) return undefined;
        const onKey = (e) => {
            if (e.key !== "Escape") return;
            controller.dispatch(canvasMaximized
                ? { type: "ui/canvasMaximized", on: false }
                : { type: "ui/canvasZen", on: false });
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [controller, canvasMaximized, zenActive]);

    // The right block is exactly as wide as the columns in it. Pixels, not a
    // share of the window: when a column closes, its pixels go to chat and
    // sessions — never to the surviving column. That is the whole model.
    const canvasColPx = Math.max(0, PORTAL_CANVAS_COL_DEFAULT_PX + (Number(state.canvasPaneAdjust) || 0));
    const diagColPx = Math.max(0, PORTAL_DIAG_COL_DEFAULT_PX + (Number(state.diagnosticsPaneAdjust) || 0));
    const rightSidePx = (canvasModeActive ? canvasColPx : 0)
        + (canvasModeActive && diagnosticsActive ? 1 : 0) // the hairline seam
        + (diagnosticsActive ? diagColPx : 0);

    // Closing hands the column back — or collapses it again, if the user had
    // already resized it away before opening the pane. Both cases live in the
    // controller so the decision is testable without a DOM.
    const closeArtifactPane = React.useCallback(() => {
        controller.closeArtifactPane().catch(() => {});
    }, [controller]);

    const estimatedMainGridWidth = Math.max(0, (viewport.width || 0) * 0.68);
    const measuredMainGridWidth = mainGridViewport.width || estimatedMainGridWidth;
    const sessionColumnWidth = portalSessionColumnWidth(measuredMainGridWidth, state.portalSessionColumnAdjust);
    const sessionColumnMode = zenActive ? "hidden" : portalSessionColumnMode(sessionColumnWidth);
    const sessionColumnTrack = sessionColumnMode === "hidden"
        ? "0px"
        : `clamp(0px, calc(${PORTAL_SESSION_COLUMN_RATIO * 100}% + ${Number(state.portalSessionColumnAdjust) || 0}px), max(0px, calc(100% - 14rem - 32px)))`;

    const desktopWorkspace = React.createElement("div", {
        className: `ps-workspace-grid${rightSideActive ? "" : " is-right-hidden"}`,
        style: {
            // With both optional columns off there is no right side and no
            // resizer for one: chat takes the whole width. Leaving a 0fr track
            // and its 16px resizer behind would put a drag handle against the
            // window edge that reveals nothing.
            //
            // With the canvas up the right track gets a pixel FLOOR. The fr
            // ratio comes from computeLegacyLayout, which was tuned when the
            // right column only ever held the inspector/activity split — it
            // left the canvas around 200px, too narrow to read a page in.
            // Capped at 55% so the floor can never crush chat on a narrow
            // window; below that the user drags, or closes a column.
            gridTemplateColumns: artifactPaneActive
                ? `minmax(0, ${layout.leftWidth}fr) var(--ps-resizer-track, 16px) minmax(0, ${layout.rightWidth}fr)`
                : (zenActive
                    // Zen: chat is a rail, the canvas is the workbench. The
                    // rail width is remembered for THIS session only.
                    ? `${zenRailPx}px var(--ps-resizer-track, 16px) minmax(0, 1fr)`
                    : (rightSideActive
                        ? `minmax(0, 1fr) var(--ps-resizer-track, 16px) min(${rightSidePx}px, 60%)`
                        : "minmax(0, 1fr)")),
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
    rightSideActive
        ? (artifactPaneActive
            ? React.createElement(ColumnResizeHandle, { controller, paneAdjust: state.paneAdjust })
            : (zenActive
                ? React.createElement(ZenRailResizeHandle, { controller, sessionId: state.activeSessionId, railPx: zenRailPx })
                : React.createElement(ChatRightResizeHandle, {
                    controller,
                    target: canvasModeActive ? "canvas" : "diagnostics",
                    adjust: canvasModeActive ? state.canvasPaneAdjust : state.diagnosticsPaneAdjust,
                })))
        : null,
    // The right side of the workspace: canvas and diagnostics, side by side
    // and independent. Either, both, or neither.
    //
    // A flex ROW rather than more grid tracks. The outer grid's third track is
    // still sized against chat by the handle above, so that drag keeps meaning
    // exactly what it always meant: chat versus everything to its right.
    //
    // DOM order is the visual order: canvas, then diagnostics. Diagnostics is
    // always rightmost, whether or not the canvas is up.
    //
    // The artifact reader still takes the WHOLE right side while it is open —
    // canvas, inspector and activity all step aside — which is why
    // diagnosticsActive already excludes it.
    React.createElement("div", { className: `ps-workspace-column-host is-split${canvasMaximized ? " has-maximized" : ""}` },
    artifactPaneActive
        ? React.createElement("div", { className: "ps-workspace-column is-artifact" },
            React.createElement(ArtifactTakeoverPane, { controller, onClose: closeArtifactPane }))
        : null,
    // The canvas keeps its DOCUMENT alive across toggles: once opened for this
    // session it stays mounted in a hidden layer — unmounting destroys typed
    // input, scroll position, and any running page. Session switches remount
    // fresh via the key. It is FIRST in the DOM so it sits left of
    // diagnostics; while hidden it is display:none and takes no width.
    desktopCanvasEverOpened
        ? React.createElement("div", {
            key: `canvas:${state.activeSessionId || ""}`,
            className: `ps-workspace-column is-artifact ps-canvas-layer${canvasModeActive && !artifactPaneActive ? "" : " is-hidden"}${canvasMaximized && canvasModeActive && !artifactPaneActive ? " is-maximized" : ""}`,
            // Sharing the right side: canvas takes a fixed slice and
            // diagnostics absorbs the rest, so the handle between them moves
            // one number. Alone, or full screen, it simply fills its box.
            style: canvasModeActive && !artifactPaneActive && diagnosticsActive && !canvasMaximized
                ? { flex: `0 0 ${canvasColPx}px`, minWidth: 0 }
                : undefined,
            ...(canvasModeActive && !artifactPaneActive ? {} : { inert: true, "aria-hidden": "true" }),
        },
            React.createElement(CanvasPane, {
                controller,
                visible: canvasModeActive && !artifactPaneActive,
                maximized: canvasMaximized,
            }))
        : null,
    // Only when BOTH are up. With one column the outer chat/right handle is
    // already the only split there is, and a second handle would resize
    // nothing.
    canvasModeActive && diagnosticsActive
        ? React.createElement(CanvasDiagnosticsResizeHandle, { controller, canvasPaneAdjust: state.canvasPaneAdjust, diagnosticsPaneAdjust: state.diagnosticsPaneAdjust })
        : null,
    // Diagnostics: yesterday's inspector-over-activity column, unchanged
    // inside, now behind its own toggle and rightmost.
    diagnosticsActive
        ? React.createElement("div", {
            className: "ps-workspace-column",
            style: {
                // Continuous PIXEL split, minmax-clamped so neither pane can
                // be dragged away or collapse behind your back. The old
                // `${rows}fr` template rode the TUI's row-quantized layout —
                // ~20px notches and threshold-triggered collapse flips.
                // minmax(0,...): either pane may be dragged fully shut and
                // pulled back open with the same seam. The handle clamps the
                // adjust to the column's real height at drag time, so the bar
                // tracks the pointer 1:1 instead of detaching at a floor.
                gridTemplateRows: `minmax(0px, calc(50% + ${Math.round(Number(state.diagnosticsSplitAdjust) || 0)}px)) var(--ps-resizer-track, 16px) minmax(0px, 1fr)`,
                ...(canvasModeActive ? { flex: "1 1 0%", minWidth: 0 } : null),
            },
        },
            React.createElement("div", {
                className: "ps-workspace-pane-slot",
                style: { gridRow: "1" },
            },
                React.createElement(InspectorPane, { controller, mobile: false })),
            React.createElement("div", {
                style: { gridRow: "2", minHeight: 0, display: "flex", flexDirection: "column" },
            },
                React.createElement(DiagnosticsSplitResizeHandle, { controller, splitAdjust: state.diagnosticsSplitAdjust })),
            React.createElement("div", {
                className: "ps-workspace-pane-slot",
                style: { gridRow: "3" },
            },
                // The artifact preview takes over the activity slot while an
                // artifact is selected, so it inherits the row resizer and can
                // be sized freely. It yields back to Activity the moment the
                // selection clears.
                artifactPreviewDetached
                    ? React.createElement(FilesPane, { controller, focused: false, previewOnly: true })
                    : React.createElement(ActivityPane, { controller })))
        : null));
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
    // The canvas fills the whole region, so there is nothing to render under
    // it — the layer below is a SIBLING of this content and covers it. Drawing
    // a pane here would only be invisible work.
    else if (mobilePane === "canvas") mobileContent = null;
    else mobileContent = React.createElement(MobileWorkspace, { controller, layout: mobileMainLayout });

    // The phone's canvas layer: a sibling of the content region's pane, NOT a
    // child of any pane. That is deliberate — panes mount and unmount as the
    // toolbar switches between Main, Activity and Inspector, and the canvas
    // frame has to survive all of it. Only a session change (which rekeys it)
    // or a reload may take a running page down.
    const mobileCanvasLayer = mobile && mobileCanvasEverOpened
        ? React.createElement(MobileCanvasLayer, {
            key: `canvas:${canvasShellView.sessionId || ""}`,
            controller,
            visible: mobileCanvasOpen,
        })
        : null;

    return React.createElement(ControllerContext.Provider, { value: controller },
        React.createElement("div", { ref: viewportRef, className: "ps-web-shell" },
        // The phone's toolbar carries its NAVIGATION (the three view modes,
        // plus the Main layout cycle), so it renders on every pane — hiding it
        // anywhere would trap the user with no way back.
        React.createElement(Toolbar, {
            controller,
            mobile,
            canvasPaneOpen: mobileCanvasOpen,
            onToggleCanvasPane: toggleMobileCanvas,
            mobilePane,
            mobileMainLayout,
            onSelectMobilePane: (paneId, focus) => {
                // Tapping Main while already on Main cycles its layout; from
                // another pane (the canvas included) it just returns you to
                // Main, unchanged.
                if (paneId === "workspace" && mobilePane === "workspace") {
                    setMobileMainLayout((current) => (
                        current === "split" ? "chat" : current === "chat" ? "sessions" : "split"
                    ));
                }
                // The budget surface REPLACES the workspace, so a pane the
                // phone switches to would render behind it and the tap would
                // look dead. Picking a pane puts it away. Already closed, the
                // reducer returns the same state and nothing re-renders.
                controller.closeBudget();
                setMobilePane(paneId);
                if (focus) controller.setFocus(focus);
            },
        }),
        React.createElement("div", { className: "ps-workspace" },
            state.adminVisible
                ? React.createElement(AdminConsolePanel, { controller, mobile })
                : state.budgetOpen
                    ? React.createElement(ProviderBudgetView, { controller })
                    : (filesFullscreenActive
                        ? fullscreenWorkspace
                        : (mobile ? mobileContent : desktopWorkspace)),
            mobileCanvasLayer),
        mobile && filesFullscreenActive
            ? React.createElement(MobileArtifactOverlay, { controller })
            : null,
        React.createElement(ModalLayer, { controller })));
}
