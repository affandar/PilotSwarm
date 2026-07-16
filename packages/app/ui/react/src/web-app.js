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
    getPromptInputRows,
    getTheme,
    parseTerminalMarkupRuns,
    PilotSwarmUiController,
    tokenizeInlineMarkdown,
    selectActivityPane,
    selectAdminConsole,
    selectArtifactPickerModal,
    selectArtifactUploadModal,
    selectLiveActivityLines,
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
    history: "History",
    files: "Files",
    stats: "Stats",
};
// Glyphs for the icon-only Inspector tab row (labels move into hover/long-press
// tooltips via IconButton, matching the session toolbar treatment).
// Monochrome line-art codepoints only — emoji-default glyphs (📄 📊 🗑 ⏹) get
// force-rendered as colored emoji on iOS and clash with the rest of the UI.
const INSPECTOR_TAB_ICONS = {
    sequence: "⇶",
    logs: "≣",
    nodes: "⬡",
    history: "⟲",
    files: "⧉",
    stats: "▁▄▇",
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
        normalized.sessionOwnerFilter = candidate.sessionOwnerFilter;
    }
    if (hasOwn(candidate, "layoutAdjustments")) {
        normalized.layoutAdjustments = normalizeStoredLayoutAdjustments(candidate.layoutAdjustments);
    }
    if (hasOwn(candidate, "pinnedSessionIds")) {
        normalized.pinnedSessionIds = normalizeStoredPinnedSessionIds(candidate.pinnedSessionIds);
    }
    if (hasOwn(candidate, "collapsedSessionIds")) {
        normalized.collapsedSessionIds = normalizeStoredCollapsedSessionIdsToArray(candidate.collapsedSessionIds);
    }
    if (hasOwn(candidate, "activeSessionId")) {
        const id = candidate.activeSessionId == null ? null : String(candidate.activeSessionId).trim();
        normalized.activeSessionId = id || null;
    }
    if (candidate.chatViewMode === "summary" || candidate.chatViewMode === "transcript") {
        normalized.chatViewMode = candidate.chatViewMode;
    }
    return normalized;
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

function profileSettingsFromViewState(state) {
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
        collapsedSessionIds: state.collapsedSessionIds,
        activeSessionId: state.activeSessionId,
        chatViewMode: state.chatViewMode,
    });
}

function buildDefaultProfileSettingsFromState(state) {
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
        collapsedSessionIds: state?.sessions?.collapsedIds,
        activeSessionId: state?.sessions?.activeSessionId,
        chatViewMode: state?.ui?.chatViewMode,
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
        ...(hasOwn(normalizedRemote, "collapsedSessionIds")
            ? { collapsedSessionIds: normalizedRemote.collapsedSessionIds }
            : {}),
        ...(hasOwn(normalizedRemote, "activeSessionId")
            ? { activeSessionId: normalizedRemote.activeSessionId }
            : {}),
        ...(hasOwn(normalizedRemote, "chatViewMode")
            ? { chatViewMode: normalizedRemote.chatViewMode }
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
    // Sequence uses preserved-width lines inside padded, scroll-synced containers.
    // Reserve a few extra columns so content that fits visually does not trip a cosmetic x-scrollbar.
    const overflowGuardColumns = inspectorTab === "sequence" ? 3 : 0;
    return Math.max(20, paneWidth - 4 - overflowGuardColumns);
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
        // recognize and render them (e.g. markdownTable → HTML <table>).
        if (line?.kind === "markdownTable") {
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
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        const preservePausedStickyScroll = stickyBottom
            && scrollMode === "top"
            && previousViewportState?.scrollMode === "top"
            && previousViewportState?.scrollOffset === scrollOffset;
        const offsetPixels = Math.max(0, Number(scrollOffset) || 0) * SCROLL_ROW_HEIGHT;
        const nextScrollTop = preservePausedStickyScroll
            ? Math.max(0, Math.min(node.scrollTop, maxScroll))
            : scrollMode === "bottom"
                ? Math.max(0, maxScroll - offsetPixels)
                : Math.min(maxScroll, offsetPixels);
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
    }, [normalizedLines, ref, scrollMode, scrollOffset, stickyBottom]);

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
        controller.dispatch({
            type: "ui/scroll",
            pane: paneKey,
            offset: pixels / SCROLL_ROW_HEIGHT,
        });
        if (paneKey === "chat" && scrollMode === "bottom" && node.scrollTop <= PROGRAMMATIC_SCROLL_TOLERANCE_PX) {
            controller.armChatTopHistoryLoad?.();
        }
    }, [controller, paneKey, ref, scrollMode, stickyBottom]);

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
            const href = String(run?.href || "").trim();
            const isExternalHref = /^https?:\/\//i.test(href);

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

function Line({ line, theme, className = "" }) {
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
}

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
        if (!node) return;
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        const nextScrollTop = Math.min(maxScroll, Math.max(0, Number(scrollOffset) || 0) * SCROLL_ROW_HEIGHT);
        if (Math.abs(node.scrollTop - nextScrollTop) > 2) {
            programmaticScrollRef.current = true;
            node.scrollTop = nextScrollTop;
            window.requestAnimationFrame(() => {
                programmaticScrollRef.current = false;
            });
        }
    }, [ref, scrollOffset]);

    return React.useCallback(() => {
        if (programmaticScrollRef.current) return;
        const node = ref.current;
        if (!node || !paneKey) return;
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
                return React.createElement("section", { key: `block:${index}`, className: "ps-md-code-block" },
                    React.createElement("div", { className: "ps-md-code-header" }, block.language || "text"),
                    React.createElement("pre", { className: "ps-md-code-pre" },
                        React.createElement("code", null, block.content)));
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

function MarkdownPreviewPanel({ controller, title, color, focused, scrollOffset = 0, paneKey, theme, content }) {
    const ref = React.useRef(null);
    const onScroll = usePanePixelScroll(ref, scrollOffset, paneKey, controller);

    return React.createElement(Panel, { title, color, focused, theme },
        React.createElement("div", {
            ref,
            className: "ps-scroll-panel ps-markdown-scroll",
            onScroll,
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

function BinaryArtifactPreviewPanel({ title, color, focused, theme, filename, contentType, sizeBytes, source, uploadedAt }) {
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

    return React.createElement(Panel, { title, color, focused, theme },
        React.createElement("div", { className: "ps-binary-preview-card" },
            React.createElement("div", { className: "ps-binary-preview-kicker" }, "Binary artifact"),
            React.createElement("h3", { className: "ps-binary-preview-title" }, filename || "Artifact"),
            meta.length > 0
                ? React.createElement("div", { className: "ps-binary-preview-meta" }, meta.join("  •  "))
                : null,
            uploadedLabel
                ? React.createElement("div", { className: "ps-binary-preview-time" }, `Uploaded ${uploadedLabel}`)
                : null,
            React.createElement("p", { className: "ps-binary-preview-copy" },
                "Preview is intentionally disabled for non-text artifacts in the browser workspace. Use Download to save the file and open it in the default app.")));
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

function StructuredChatBlocks({ lines, theme }) {
    const blocks = React.useMemo(() => parseStructuredChatBlocks(lines), [lines]);

    return React.createElement(React.Fragment, null,
        blocks.map((block, index) => {
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
                return React.createElement("section", { key: `code:${index}`, className: "ps-md-code-block ps-chat-code-block" },
                    React.createElement("div", { className: "ps-md-code-header" }, block.language || "text"),
                    React.createElement("pre", { className: "ps-md-code-pre" },
                        React.createElement("code", null, block.content || "")));
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
                    (block.bodyLines || []).map((bodyRuns, bodyIndex) => React.createElement("div", {
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
    return React.createElement("section", {
        className: `ps-panel${focused ? " is-focused" : ""}${className ? ` ${className}` : ""}`,
        style: { "--ps-panel-accent": accent || "var(--ps-border)" },
    },
    React.createElement("header", { className: "ps-panel-header" },
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
    ),
    React.createElement("div", { className: "ps-panel-body" }, children));
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


function ScrollLinesPanel({ title, titleRight = null, color, focused, actions, lines, stickyLines = [], bottomStickyLines = [], scrollOffset = 0, scrollMode = "top", paneKey, controller, className = "", panelClassName = "", topContent = null, bottomContent = null, structuredBlocks = false, stickyBottom = false, renderBody = null }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const ref = React.useRef(null);
    const stickyRef = React.useRef(null);
    const syncingHorizontalRef = React.useRef(false);
    const { normalizedLines, onScroll, onWheel, onTouchStart, onTouchMove, onTouchEnd } = useScrollSync(ref, lines, scrollOffset, scrollMode, paneKey, controller, { stickyBottom });
    const normalizedSticky = React.useMemo(() => normalizeLines(stickyLines), [stickyLines]);
    const normalizedBottomSticky = React.useMemo(() => normalizeLines(bottomStickyLines), [bottomStickyLines]);
    const preserveHorizontalScroll = className.includes("is-preserve") && panelClassName.includes("has-preserved-sticky");

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
        React.createElement("div", { ref, className: `ps-scroll-panel ${className}${scrollShadow.down ? " is-scrolled-down" : ""}${scrollShadow.up ? " is-scrolled-up" : ""}`.trim(), onScroll: handleBodyScroll, onWheel, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd },
            typeof renderBody === "function"
                ? renderBody(normalizedLines, theme)
                : structuredBlocks
                ? React.createElement(StructuredChatBlocks, { lines: normalizedLines, theme })
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

function SessionRowContent({ row, theme, structured = false }) {
    const hasStructuredRuns = structured && Array.isArray(row.titleRuns);
    if (!hasStructuredRuns) {
        return Array.isArray(row.runs)
            ? React.createElement(Runs, { runs: row.runs, theme })
            : row.text;
    }

    // Dense row: the title takes one line (clamped by CSS) and the context %
    // is pinned to the right. The full id · time · model · ctx detail unfolds
    // only under the selected row.
    const ctxRuns = Array.isArray(row.ctxRuns) ? row.ctxRuns : [];
    const detailRuns = Array.isArray(row.detailRuns)
        ? row.detailRuns
        : (Array.isArray(row.selectedMetaRuns) ? row.selectedMetaRuns : []);
    const hasCtx = ctxRuns.length > 0;
    const hasDetail = row.active && detailRuns.length > 0;

    return React.createElement(React.Fragment, null,
        React.createElement("div", { className: "ps-session-row-line" },
            React.createElement("div", { className: "ps-session-row-title" },
                React.createElement(Runs, { runs: row.titleRuns, theme })),
            hasCtx
                ? React.createElement("div", { className: "ps-session-row-ctx" },
                    React.createElement(Runs, { runs: ctxRuns, theme }))
                : null),
        hasDetail
            ? React.createElement("div", { className: "ps-session-row-detail" },
                React.createElement(Runs, { runs: detailRuns, theme }))
            : null);
}

function SessionPane({ controller, actions = null, panelClassName = "", structuredRows = false }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const sessionButtonRefs = React.useRef(new Map());
    const viewState = useControllerSelector(controller, (state) => ({
        activeSessionId: state.sessions.activeSessionId,
        sessionsById: state.sessions.byId,
        sessionsFlat: state.sessions.flat,
        filterQuery: state.sessions.filterQuery || "",
        ownerFilter: state.sessions.ownerFilter,
        pinnedIds: state.sessions.pinnedIds,
        selectedIds: state.sessions.selectedIds,
        selectMode: state.sessions.selectMode,
        auth: state.auth,
        connectionMode: state.connection?.mode || "local",
        modalOpen: Boolean(state.ui.modal),
        focused: state.ui.focusRegion === "sessions",
    }), shallowEqualObject);
    const rows = React.useMemo(() => selectSessionRows({
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: viewState.sessionsById,
            flat: viewState.sessionsFlat,
            filterQuery: viewState.filterQuery,
            ownerFilter: viewState.ownerFilter,
            pinnedIds: viewState.pinnedIds,
            selectedIds: viewState.selectedIds,
            selectMode: viewState.selectMode,
        },
        auth: viewState.auth,
        connection: {
            mode: viewState.connectionMode,
        },
    }), [viewState.activeSessionId, viewState.auth, viewState.connectionMode, viewState.filterQuery, viewState.ownerFilter, viewState.pinnedIds, viewState.selectedIds, viewState.selectMode, viewState.sessionsById, viewState.sessionsFlat]);
    const activeSession = viewState.activeSessionId
        ? viewState.sessionsById[viewState.activeSessionId] || null
        : null;
    // "Modify" combines rename + sharing in one modal (opened from the toolbar
    // so the composer chrome stays minimal, esp. on mobile). Rename AND sharing
    // are owner/admin-only (session:manage / session:share), so the button is
    // disabled for anyone else — the server enforces too, but a disabled button
    // is clearer than a 403.
    const [modifyOpen, setModifyOpen] = React.useState(false);
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
    const activeSessionActionLabel = activeSession?.isGroup
        ? "Delete"
        : isBulkSelection
            ? `Terminate (${selectedCount})`
            : activeSession?.isSystem
                ? "Restart"
                : "Terminate";
    const hasExplicitSelection = selectedCount > 0;
    const groupableIds = hasExplicitSelection
        ? viewState.selectedIds.filter((id) => {
            const session = viewState.sessionsById[id];
            return session && !session.isSystem && !session.isGroup && !session.parentSessionId;
        })
        : (activeSession && !activeSession.isSystem && !activeSession.isGroup && !activeSession.parentSessionId ? [activeSession.sessionId] : []);
    const canMoveToGroup = groupableIds.length > 0;
    const combinedPanelClassName = `ps-session-pane${panelClassName ? ` ${panelClassName}` : ""}`;
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
                className: "ps-mini-button",
                icon: "📌",
                onClick: () => controller.handleCommand(UI_COMMANDS.PIN_SESSION).catch(() => {}),
                disabled: !canPinActiveSession,
                active: isActivePinned,
                label: canPinActiveSession
                    ? (isActivePinned ? "Unpin this session" : "Pin this session to the top of the list")
                    : "Only top-level non-system sessions can be pinned",
            }),
        React.createElement(IconButton, {
            className: "ps-mini-button",
            icon: groupableIds.length > 1 ? `⊞${groupableIds.length}` : "⊞",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_MOVE_TO_GROUP).catch(() => {}),
            disabled: !canMoveToGroup,
            label: canMoveToGroup
                ? (groupableIds.length > 1 ? `Move ${groupableIds.length} selected sessions to a group` : "Move this session to a group")
                : "Select a top-level non-system session to move to a group",
        }),
        React.createElement(IconButton, {
            className: "ps-mini-button",
            icon: React.createElement(ShareGlyph),
            onClick: () => {
                const sid = activeSession?.sessionId;
                if (!sid || typeof window === "undefined" || !window.location) return;
                const url = `${window.location.origin}${window.location.pathname}?session=${encodeURIComponent(sid)}`;
                if (navigator?.clipboard?.writeText) navigator.clipboard.writeText(url).catch(() => {});
                controller.dispatch({ type: "ui/status", text: "Session link copied to clipboard" });
            },
            disabled: !activeSession || activeSession.isGroup || isBulkSelection,
            label: "Share — copy a direct link to this session",
        }),
        React.createElement(IconButton, {
            className: "ps-mini-button",
            icon: "✎",
            onClick: () => setModifyOpen(true),
            disabled: !canModifyActiveSession || isBulkSelection,
            label: isBulkSelection ? "Disabled while multiple sessions are selected" : "Modify — rename and share access",
        }),
        React.createElement(IconButton, {
            className: "ps-mini-button",
            icon: activeSession?.isSystem ? "↻" : "⊗",
            onClick: () => controller.handleCommand(activeSession?.isGroup ? UI_COMMANDS.DELETE_SESSION : UI_COMMANDS.OPEN_TERMINATE_PICKER).catch(() => {}),
            disabled: !canTerminate,
            label: isBulkSelection
                ? `Terminate ${selectedCount} selected sessions (Mark Completed, Cancel, or Delete)`
                : activeSession?.isGroup
                    ? (activeGroupCanDelete ? "Delete this empty group" : "This group cannot be deleted yet")
                    : activeSession?.isSystem
                        ? "Restart this system session (complete, terminate, or hard delete)"
                        : `${activeSessionActionLabel} — mark completed, cancel, or delete`,
        }),
        actions);

    return React.createElement(React.Fragment, null,
    React.createElement(Panel, {
        title: [{ text: "Sessions", color: "yellow", bold: true }],
        color: "yellow",
        focused: viewState.focused,
        theme,
        actions: panelActions,
        className: combinedPanelClassName,
    },
    React.createElement("div", { className: "ps-action-list ps-session-list" },
        rows.length === 0
            ? React.createElement("div", { className: "ps-empty-state" }, viewState.filterQuery
                ? `No sessions matched "@@${viewState.filterQuery}".`
                : "No sessions yet.")
            : rows.map((row) => React.createElement("button", {
                key: row.sessionId,
                type: "button",
                ref: (node) => setSessionButtonRef(row.sessionId, node),
                className: `ps-list-button ps-session-list-button${row.active ? " is-selected" : ""}${row.selected ? " is-multiselected" : ""}${row.pinned ? " is-pinned" : ""}`,
                tabIndex: row.active ? 0 : -1,
                "aria-selected": row.active ? "true" : "false",
                onClick: (event) => {
                    // Cmd/Ctrl-click toggles multi-selection (any row).
                    if (event.metaKey || event.ctrlKey) {
                        event.preventDefault();
                        if (!viewState.selectMode) {
                            controller.dispatch({ type: "sessions/selectMode", enabled: true });
                        }
                        controller.dispatch({ type: "sessions/selectToggle", sessionId: row.sessionId });
                        controller.setFocus("sessions");
                        return;
                    }
                    // Shift-click selects a contiguous range from the active row.
                    if (event.shiftKey && viewState.activeSessionId) {
                        event.preventDefault();
                        const ids = rows.map((r) => r.sessionId);
                        const startIndex = ids.indexOf(viewState.activeSessionId);
                        const endIndex = ids.indexOf(row.sessionId);
                        if (startIndex >= 0 && endIndex >= 0) {
                            const [from, to] = startIndex <= endIndex
                                ? [startIndex, endIndex]
                                : [endIndex, startIndex];
                            const range = ids.slice(from, to + 1);
                            const merged = Array.from(new Set([...(viewState.selectedIds || []), ...range]));
                            controller.setSessionSelection(merged);
                            controller.setFocus("sessions");
                            return;
                        }
                    }
                    const shouldToggleChildren = row.hasChildren && row.active;
                    if (shouldToggleChildren) {
                        controller.dispatch({
                            type: row.collapsed ? "sessions/expand" : "sessions/collapse",
                            sessionId: row.sessionId,
                        });
                        controller.setFocus("sessions");
                        return;
                    }
                    // A normal click on a different row clears any
                    // multi-selection and switches the active session.
                    if (viewState.selectMode) {
                        controller.dispatch({ type: "sessions/selectClear" });
                    }
                    controller.setFocus("sessions");
                    if (!row.active) {
                        controller.loadSession(row.sessionId).catch(() => {});
                    }
                },
            },
            React.createElement("div", {
                className: "ps-line ps-session-row-content",
                style: { paddingInlineStart: `${Math.max(0, row.depth) * 18}px` },
            },
                React.createElement(SessionRowContent, { row, theme, structured: structuredRows })),
            )),
    )),
    (modifyOpen && activeSession && !activeSession.isGroup)
        ? React.createElement(SessionModifyModal, {
            controller,
            sessionId: activeSession.sessionId,
            initialTitle: activeSession.title || "",
            principal: viewState.auth?.principal || null,
            onClose: () => setModifyOpen(false),
            onChanged: () => {},
        })
        : null);
}

const VISIBILITY_META = {
    private: { glyph: "🔒", label: "Private" },
    shared_read: { glyph: "👁", label: "Shared · read" },
    shared_write: { glyph: "✎", label: "Shared · write" },
};

// The standard "share" glyph (three connected nodes). Inherits the button's
// text color via currentColor. Used for the session deep-link Share button.
function ShareGlyph() {
    return React.createElement("svg", {
        className: "ps-share-glyph", viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": "true",
    },
    React.createElement("circle", { cx: "18", cy: "5", r: "3" }),
    React.createElement("circle", { cx: "6", cy: "12", r: "3" }),
    React.createElement("circle", { cx: "18", cy: "19", r: "3" }),
    React.createElement("line", { x1: "8.6", y1: "10.5", x2: "15.4", y2: "6.5" }),
    React.createElement("line", { x1: "8.6", y1: "13.5", x2: "15.4", y2: "17.5" }));
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
    React.useEffect(() => reload(), [reload]);
    return { access: state.access, loading: state.loading, reload };
}

// Combined "Modify" modal opened from the session list toolbar: rename plus
// (for the owner/admin) sharing — visibility + per-person grants. Fetches its
// own access snapshot so callers only pass the session id + current title.
function SessionModifyModal({ controller, sessionId, initialTitle, principal, onClose, onChanged }) {
    const [access, setAccess] = React.useState(null);
    const [title, setTitle] = React.useState(initialTitle || "");
    const [shares, setShares] = React.useState([]);
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
            .then((rows) => setShares(Array.isArray(rows) ? rows : []))
            .catch(() => setShares([]));
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
    const applyVisibility = (value) => run(async () => {
        await controller.transport.setSessionVisibility(sessionId, value);
        setVisibility(value);
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
    const grantTo = (grantee) => run(async () => {
        await controller.transport.grantSessionShare(
            sessionId,
            { provider: grantee.provider, subject: grantee.subject, email: grantee.email ?? null, displayName: grantee.displayName ?? null },
            granteeAccess,
        );
        setGranteeQuery("");
        loadShares();
    });
    const addGrant = () => {
        const grantee = resolveGrantee(granteeQuery);
        if (grantee) grantTo(grantee);
    };

    // Autocomplete suggestions: directory members matching the query, minus
    // the owner and anyone already granted.
    const grantedKeys = new Set(shares.map((r) => `${r.provider}${r.subject}`));
    const ownerKey = access?.owner ? `${access.owner.provider}${access.owner.subject}` : null;
    const q = granteeQuery.trim().toLowerCase();
    const suggestions = q
        ? directory.filter((u) => {
            const key = `${u.provider}${u.subject}`;
            if (key === ownerKey || grantedKeys.has(key)) return false;
            return (u.displayName && u.displayName.toLowerCase().includes(q))
                || (u.email && u.email.toLowerCase().includes(q))
                || (u.subject && u.subject.toLowerCase().includes(q));
        }).slice(0, 25)
        : [];
    const revoke = (row) => run(async () => {
        await controller.transport.revokeSessionShare(sessionId, { provider: row.provider, subject: row.subject });
        loadShares();
    });

    const canManage = Boolean(access?.canManage);
    const stop = (e) => e.stopPropagation();
    return React.createElement("div", { className: "ps-share-overlay", onClick: onClose },
        React.createElement("div", { className: "ps-share-modal", onClick: stop },
            React.createElement("div", { className: "ps-share-modal-head" },
                React.createElement("span", null, "Modify session"),
                React.createElement("button", { className: "ps-modal-close", onClick: onClose }, "✕")),

            // ── Rename ────────────────────────────────────────────────
            React.createElement("div", { className: "ps-share-section-label" }, "Name"),
            React.createElement("div", { className: "ps-share-add-row" },
                React.createElement("input", {
                    className: "ps-share-add-input", placeholder: "Session title",
                    value: title, disabled: busy,
                    onChange: (e) => setTitle(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") saveTitle(); },
                }),
                React.createElement("button", { className: "ps-mini-button", disabled: busy || !title.trim(), onClick: saveTitle }, "Save")),

            // ── Sharing (owner / admin only) ──────────────────────────
            canManage ? React.createElement(React.Fragment, null,
                React.createElement("div", { className: "ps-share-section-label" }, "General access"),
                React.createElement("div", { className: "ps-share-section-sub" }, "The baseline level for everyone signed in to this workspace."),
                ["private", "shared_read", "shared_write"].map((value) =>
                    React.createElement("label", { key: value, className: `ps-share-radio${visibility === value ? " is-active" : ""}` },
                        React.createElement("input", {
                            type: "radio", name: "visibility", checked: visibility === value,
                            disabled: busy, onChange: () => applyVisibility(value),
                        }),
                        React.createElement("span", { className: "ps-share-radio-glyph" }, VISIBILITY_META[value].glyph),
                        React.createElement("span", null, VISIBILITY_META[value].label),
                        React.createElement("span", { className: "ps-share-radio-hint" },
                            value === "private" ? "only you and admins"
                                : value === "shared_read" ? "everyone here can view"
                                    : "everyone here can view and send"))),
                React.createElement("div", { className: "ps-share-section-label" }, "Special access"),
                React.createElement("div", { className: "ps-share-section-sub" }, "Give specific people more than the general level. A person's grant wins over general access."),
                shares.length === 0
                    ? React.createElement("div", { className: "ps-share-empty" }, "No individual grants — everyone has the general access above.")
                    : shares.map((row) => React.createElement("div", { key: `${row.provider}/${row.subject}`, className: "ps-share-grant-row" },
                        React.createElement("span", { className: "ps-share-grant-name" }, row.displayName || row.subject),
                        React.createElement("span", { className: "ps-share-grant-access" }, `can ${row.access}`),
                        React.createElement("button", { className: "ps-mini-button", disabled: busy, onClick: () => revoke(row) }, "Revoke"))),
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
                                onClick: () => grantTo(u),
                            },
                            React.createElement("span", { className: "ps-share-suggestion-name" }, u.displayName || u.subject),
                            u.email ? React.createElement("span", { className: "ps-share-suggestion-email" }, u.email) : null)))
                        : null),
                React.createElement("div", { className: "ps-share-foot-hint" },
                    "Sharing applies to this session and its sub-agents. Suggestions are people who have "
                    + "signed in before — you can also grant by email to someone who hasn't; it takes effect "
                    + "when they first sign in."))
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
    const lines = React.useMemo(
        () => selectChatLines(selectorState, viewState.contentWidth, { tableMode: "sentinel" }),
        [selectorState, viewState.contentWidth],
    );
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
    const composerBase = showComposer && !viewState.activeSessionIsGroup && viewState.chatViewMode !== "summary";
    const readOnly = Boolean(access) && access.canWrite === false;
    const composer = composerBase
        ? React.createElement("div", { className: "ps-chat-composer" },
            readOnly
                ? React.createElement("div", { className: "ps-composer-readonly" },
                    `You have view access to this session. Ask ${access.owner?.displayName || access.owner?.email || "the owner"} for write access to participate.`)
                : React.createElement(PromptComposer, { controller, mobile, active: true }))
        : null;

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
        bottomContent: composer,
        structuredBlocks: true,
    });
}

function MobileWorkspace({ controller, sessionsCollapsed, setSessionsCollapsed }) {
    const themeId = useControllerSelector(controller, (state) => state.ui.themeId);
    const theme = getTheme(themeId);
    const sessionToggle = React.createElement("button", {
        type: "button",
        className: "ps-mini-button",
        onClick: () => setSessionsCollapsed((current) => !current),
    }, sessionsCollapsed ? "Show" : "Hide");

    return React.createElement("div", { className: "ps-mobile-workspace" },
        sessionsCollapsed
            ? React.createElement(Panel, {
                title: [{ text: "Sessions", color: "yellow", bold: true }],
                color: "yellow",
                focused: false,
                theme,
                actions: sessionToggle,
                className: "ps-mobile-session-collapsed",
            },
            React.createElement("div", { className: "ps-mobile-session-summary" }, "Session list collapsed."))
            : React.createElement(SessionPane, {
                controller,
                actions: sessionToggle,
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
            icon: INSPECTOR_TAB_ICONS[tab] || "•",
            label: INSPECTOR_TAB_LABELS[tab] || tab,
            active: activeTab === tab,
            onClick: () => {
                controller.setFocus("inspector");
                controller.selectInspectorTab(tab).catch(() => {});
            },
        })));
}

function FilesPane({ controller, focused, mobile = false }) {
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

    const panelActions = React.createElement(React.Fragment, null,
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
            icon: "↥",
            label: "Upload",
            onClick: openUploadPicker,
            disabled: !viewState.canBrowserUpload && !viewState.canPathUpload,
        }),
        React.createElement(IconButton, {
            icon: "↧",
            label: "Download",
            onClick: () => controller.handleCommand(UI_COMMANDS.DOWNLOAD_SELECTED_FILE).catch(() => {}),
            disabled: !hasSelection,
        }),
        viewState.canDeleteArtifacts ? React.createElement(IconButton, {
            icon: "✕",
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
            icon: "▾",
            label: "Filter",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_FILES_FILTER).catch(() => {}),
        }),
        React.createElement(IconButton, {
            icon: viewState.fullscreen ? "⇱" : "⛶",
            label: viewState.fullscreen ? "Exit fullscreen" : "Fullscreen",
            onClick: () => controller.handleCommand(UI_COMMANDS.TOGGLE_FILE_PREVIEW_FULLSCREEN).catch(() => {}),
        }));

    const listContent = items.length === 0
        ? normalizeLines(filesView.listBodyLines || []).map((line, index) => React.createElement(Line, {
            key: `empty:${index}`,
            line,
            theme,
        }))
        : items.map((item, index) => React.createElement("button", {
            key: item.id,
            type: "button",
            className: `ps-list-button${index === filesView.selectedIndex ? " is-selected" : ""}`,
            onClick: () => {
                controller.setFocus("inspector");
                controller.selectFileBrowserItem(item).catch(() => {});
            },
        }, React.createElement(Line, {
            line: normalizeLines([filesView.listBodyLines?.[index]])[0],
            theme,
        })));

    const previewPane = filesView.previewRenderMode === "markdown"
        && !filesView.previewLoading
        && !filesView.previewError
        ? React.createElement(MarkdownPreviewPanel, {
            controller,
            title: filesView.previewTitle,
            color: "cyan",
            focused: false,
            scrollOffset: viewState.previewScroll,
            paneKey: "filePreview",
            theme,
            content: filesView.previewContent || "",
        })
        : filesView.previewIsBinary
            && !filesView.previewLoading
            && !filesView.previewError
            ? React.createElement(BinaryArtifactPreviewPanel, {
                title: filesView.previewTitle,
                color: "cyan",
                focused: false,
                theme,
                filename: filesView.selectedFilename,
                contentType: filesView.previewContentType,
                sizeBytes: filesView.previewSizeBytes,
                source: filesView.previewSource,
                uploadedAt: filesView.previewUploadedAt,
            })
        : React.createElement(ScrollLinesPanel, {
            controller,
            title: filesView.previewTitle,
            color: "cyan",
            focused: false,
            lines: filesView.previewLines,
            scrollOffset: viewState.previewScroll,
            scrollMode: "top",
            paneKey: "filePreview",
            className: "is-preview is-wrapped",
        });
    const view = viewState;

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
        : React.createElement("div", { className: "ps-files-grid" },
            React.createElement(Panel, { title: filesView.listTitle, color: "cyan", theme },
                React.createElement("div", { className: "ps-action-list" }, listContent)),
            previewPane,
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
        ui: {
            inspectorTab: viewState.inspectorTab,
            statsViewMode: viewState.statsViewMode,
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
        viewState.connection,
        viewState.executionHistoryBySessionId,
        viewState.executionHistoryFormat,
        viewState.fleetStats,
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
            icon: "▾",
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
        renderBody: inspector.activeTab === "sequence" ? renderSequenceBody : null,
        scrollOffset: viewState.scroll,
        scrollMode: inspector.activeTab === "sequence"
            ? "bottom"
            : inspector.activeTab === "logs" && viewState.followBottom
                ? "bottom"
                : "top",
        stickyBottom: inspector.activeTab === "logs",
        paneKey: "inspector",
        className: inspector.activeTab === "history" || inspector.activeTab === "logs" ? "is-wrapped" : "is-preserve",
        panelClassName: `${inspector.activeTab === "sequence" ? "has-preserved-sticky" : ""}${panelClassName ? ` ${panelClassName}` : ""}`.trim(),
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
        };
    }, shallowEqualObject);
    const selectorState = React.useMemo(() => ({
        sessions: {
            activeSessionId: viewState.activeSessionId,
            byId: viewState.activeSessionId && viewState.activeSession
                ? { [viewState.activeSessionId]: viewState.activeSession }
                : {},
        },
        history: {
            bySessionId: viewState.activeSessionId && viewState.activeHistory
                ? new Map([[viewState.activeSessionId, viewState.activeHistory]])
                : new Map(),
        },
    }), [viewState.activeHistory, viewState.activeSession, viewState.activeSessionId]);
    const activity = React.useMemo(
        () => selectActivityPane(selectorState, viewState.maxLines),
        [selectorState, viewState.maxLines],
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
        panelClassName,
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
        content = React.createElement(SessionPane, {
            controller,
            panelClassName: "ps-chat-focus-pane",
            structuredRows: mobile,
            actions: React.createElement("button", {
                type: "button",
                className: "ps-mini-button",
                onClick: onClose,
            }, "Close"),
        });
    } else if (pane === "inspector") {
        content = React.createElement(InspectorPane, {
            controller,
            mobile: false,
            panelClassName: "ps-chat-focus-pane",
            extraActions: React.createElement("button", {
                type: "button",
                className: "ps-mini-button",
                onClick: onClose,
            }, "Close"),
        });
    } else if (pane === "activity") {
        content = React.createElement(ActivityPane, {
            controller,
            panelClassName: "ps-chat-focus-pane",
            extraActions: React.createElement("button", {
                type: "button",
                className: "ps-mini-button",
                onClick: onClose,
            }, "Close"),
        });
    }

    const paneMeta = CHAT_FOCUS_PANES.find((entry) => entry.id === pane);
    return React.createElement("div", {
        className: `ps-chat-focus-overlay${paneMeta?.side === "left" ? " is-left" : " is-right"}`,
    }, content);
}

function ChatFocusWorkspace({ controller, openPane, onTogglePane, onExitFocus, mobile = false }) {
    const focusRegion = useControllerSelector(controller, (state) => state.ui.focusRegion);

    const rail = mobile
        ? React.createElement("div", { className: "ps-chat-focus-rail" },
            React.createElement("button", {
                type: "button",
                className: "ps-mini-button ps-chat-focus-button",
                onClick: onExitFocus,
            }, "Exit Focus"),
            React.createElement("button", {
                type: "button",
                className: `ps-mini-button ps-chat-focus-button${openPane === "sessions" ? " is-active" : ""}`,
                onClick: () => onTogglePane("sessions"),
            }, "Sessions"))
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
        };
    }, shallowEqualObject);
    const inputRef = React.useRef(null);

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
        className: `ps-prompt-shell${mobile ? " is-mobile" : ""}`,
    },
        React.createElement("label", { className: "ps-prompt-label" }, promptState.answerMode ? "answer" : selectedCancelling ? "cancelling" : selectedQueued ? "queued" : promptState.editingPending ? "pending" : "you"),
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
    const adminVisible = useControllerSelector(controller, (state) => Boolean(state.admin?.visible));
    const chatView = useControllerSelector(controller, (state) => ({
        mode: state.ui.chatViewMode || "transcript",
        activeSessionIsGroup: Boolean(state.sessions.activeSessionId && state.sessions.byId[state.sessions.activeSessionId]?.isGroup),
        hasActiveSession: Boolean(state.sessions.activeSessionId && state.sessions.byId[state.sessions.activeSessionId]),
    }), shallowEqualObject);
    const switchModelDisabled = !chatView.hasActiveSession || chatView.activeSessionIsGroup;

    // Icon-first toolbar: the glyph is the affordance, the label rides a
    // tooltip (desktop hover via title; mobile long-press via IconButton).
    const buttonDefs = [
        {
            key: "new",
            icon: "＋",
            label: "New session",
            onClick: () => controller.handleCommand(UI_COMMANDS.NEW_SESSION).catch(() => {}),
        },
        {
            key: "model",
            icon: "＋⚙",
            label: "New session + choose model",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER).catch(() => {}),
        },
        {
            key: "switch-model",
            icon: "⇄",
            label: switchModelDisabled ? "Select a session to switch its model" : "Switch the selected session's model",
            onClick: () => controller.openSwitchModelPicker().catch((err) => {
                controller.dispatch({ type: "ui/status", text: err?.message || String(err) || "Failed to switch model" });
            }),
            disabled: switchModelDisabled,
        },
        {
            key: "filter",
            icon: "▾",
            label: "Filter sessions",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_SESSION_FILTER).catch(() => {}),
        },
        {
            key: "theme",
            icon: "◑",
            label: "Theme",
            onClick: () => controller.handleCommand(UI_COMMANDS.OPEN_THEME_PICKER).catch(() => {}),
        },
        {
            key: "summary",
            icon: chatView.mode === "summary" ? "💬" : "≣",
            label: chatView.activeSessionIsGroup
                ? "Groups show group details"
                : (chatView.mode === "summary" ? "Show chat transcript" : "Show summary"),
            onClick: () => controller.setChatViewMode(chatView.mode === "summary" ? "transcript" : "summary"),
            disabled: chatView.activeSessionIsGroup,
            active: chatView.mode === "summary",
        },
        ...(onToggleChatFocus ? [{
            key: "focus",
            icon: chatFocusMode ? "⇱" : "⛶",
            label: chatFocusMode ? "Exit focus mode" : "Focus the chat pane",
            onClick: onToggleChatFocus,
            disabled: chatFocusDisabled,
            active: chatFocusMode,
        }] : []),
        {
            key: "admin",
            icon: "⚙",
            label: adminVisible ? "Close admin console" : "Admin console",
            onClick: () => controller.handleCommand(adminVisible ? UI_COMMANDS.CLOSE_ADMIN_CONSOLE : UI_COMMANDS.OPEN_ADMIN_CONSOLE).catch(() => {}),
            active: adminVisible,
        },
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

    return React.createElement("div", { className: "ps-toolbar" },
        React.createElement("div", { className: "ps-toolbar-actions" }, buttonDefs.map(renderButton)),
    );
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

        const onPointerMove = (event) => {
            const dragState = dragStateRef.current;
            if (!dragState) return;
            const deltaCells = Math.round((event.clientX - dragState.startX) / GRID_CELL_WIDTH);
            const deltaIncrement = deltaCells - dragState.appliedCells;
            if (!deltaIncrement) return;
            controller.adjustPaneSplit(deltaIncrement);
            dragState.appliedCells = deltaCells;
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
                    className: `ps-list-button ps-modal-list-button${itemIndex === modal.selectedIndex ? " is-selected" : ""}${usesHangingIndent ? " is-hanging" : ""}`,
                    onClick: () => controller.dispatch({ type: "ui/modalSelection", index: itemIndex }),
                },
                React.createElement("div", { className: "ps-line ps-modal-list-line" },
                    React.createElement(Runs, { runs, theme })));
            })
            : (modal.items || []).map((item, index) => React.createElement("button", {
                key: item.id || index,
                type: "button",
                className: `ps-list-button ps-modal-list-button${index === modal.selectedIndex ? " is-selected" : ""}${usesHangingIndent ? " is-hanging" : ""}`,
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
        React.createElement("div", { className: `ps-modal${modal.type === "themePicker" ? " is-theme-picker" : ""}`, onClick: (event) => event.stopPropagation() },
            React.createElement("div", { className: "ps-modal-header" },
                React.createElement("div", { className: "ps-modal-title" }, presentation.title),
                React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
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
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal is-narrow", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, modalState.confirm.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
                ),
                React.createElement("div", { className: "ps-modal-body", style: { padding: "16px 20px" } },
                    React.createElement("p", { style: { color: "#94a3b8", margin: 0 } }, modalState.confirm.message),
                ),
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
        return React.createElement("div", { className: "ps-modal-backdrop", onClick: close },
            React.createElement("div", { className: "ps-modal", onClick: (event) => event.stopPropagation() },
                React.createElement("div", { className: "ps-modal-header" },
                    React.createElement("div", { className: "ps-modal-title" }, presentation.title),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
                ),
                React.createElement("div", { className: "ps-modal-grid" },
                    React.createElement("div", { ref: listModalRef, className: "ps-modal-list" },
                        (modal.items || []).map((item, index) => React.createElement("button", {
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
                            })))),
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
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
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
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
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
                    React.createElement("div", { className: "ps-modal-title" }, modal.title || "Terminate session"),
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
                ),
                React.createElement("div", { className: "ps-modal-body", style: { padding: "12px 16px 4px" } },
                    React.createElement("p", { style: { color: "#94a3b8", margin: 0 } }, bodyText)),
                React.createElement("div", {
                    className: "ps-modal-body",
                    style: { padding: "10px 16px 16px", display: "flex", flexDirection: "column", gap: 8 },
                },
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
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
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
                    React.createElement("button", { type: "button", className: "ps-modal-close", onClick: close }, "Close"),
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

function useKeyboardShortcuts(controller, mobile) {
    React.useEffect(() => {
        const handler = (event) => {
            const target = event.target;
            const editable = target instanceof HTMLElement
                && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
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

function AdminConsolePanel({ controller }) {
    const view = useControllerSelector(controller, selectAdminConsole, shallowEqualObject);
    const draftRef = React.useRef(null);

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

    return React.createElement("div", { className: "ps-admin-console" },
        React.createElement("header", { className: "ps-admin-console__header" },
            React.createElement("h2", null, "Admin Console"),
            React.createElement("button", {
                type: "button",
                className: "ps-mini-button",
                onClick: onClose,
            }, "Close")),
        React.createElement("section", { className: "ps-admin-console__identity" },
            React.createElement("dl", null,
                React.createElement("dt", null, "Signed in as"),
                React.createElement("dd", null, principalLabel))),
        view.loadError
            ? React.createElement("div", { className: "ps-admin-console__error", role: "alert" }, view.loadError)
            : null,
        React.createElement("section", { className: "ps-admin-console__section" },
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
                    }, view.loading ? "Refreshing..." : "Refresh"))));
}

export function createWebPilotSwarmController({ transport, mode = "remote", branding = null } = {}) {
    clearBrowserPreferenceCache();
    const store = createStore(appReducer, createInitialState({
        mode,
        branding,
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
        adminVisible: Boolean(rootState.admin?.visible),
    }), shallowEqualObject);
    const profileSettingsHydratedRef = React.useRef(false);
    const lastProfileSettingsJsonRef = React.useRef(null);
    const profileSettingsSaveTimerRef = React.useRef(null);
    const profileSettingsPollTimerRef = React.useRef(null);
    const profileSettingsPollInFlightRef = React.useRef(false);
    const profileSettingsSaveInFlightRef = React.useRef(false);
    const appliedProfileSettingsJsonRef = React.useRef(null);
    const defaultProfileSettingsRef = React.useRef(null);
    const [mobilePane, setMobilePane] = React.useState("workspace");
    const [mobileSessionsCollapsed, setMobileSessionsCollapsed] = React.useState(false);
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
                defaultProfileSettingsRef.current = buildDefaultProfileSettingsFromState(controller.getState());
                const settings = materializeProfileSettings(
                    profile?.profileSettings,
                    defaultProfileSettingsRef.current,
                );
                const settingsJson = JSON.stringify(settings);
                const currentSettingsBeforeApply = profileSettingsFromViewState(controller.getState());
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

                const currentSettings = profileSettingsFromViewState(controller.getState());
                lastProfileSettingsJsonRef.current = JSON.stringify(currentSettings);
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
        const settings = profileSettingsFromViewState(state);
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
    }, [controller, state.activeSessionId, state.activityPaneAdjust, state.chatViewMode, state.collapsedSessionIds, state.ownerFilter, state.paneAdjust, state.pinnedIds, state.portalSessionColumnAdjust, state.sessionPaneAdjust, state.themeId]);

    React.useEffect(() => {
        applyDocumentTheme(state.themeId);
    }, [state.themeId]);

    React.useEffect(() => {
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
            gridTemplateColumns: `minmax(0, ${layout.leftWidth}fr) 16px minmax(0, ${layout.rightWidth}fr)`,
        },
    },
    React.createElement("div", {
        ref: mainGridRef,
        className: `ps-workspace-main-grid is-session-${sessionColumnMode}`,
        style: {
            gridTemplateColumns: `${sessionColumnTrack} 16px minmax(14rem, 1fr)`,
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
        style: { gridTemplateRows: `${layout.inspectorPaneHeight}fr 16px ${layout.activityPaneHeight}fr` },
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
        !layout.activityHidden ? React.createElement(ActivityPane, { controller }) : null)));
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
    if (filesFullscreenActive) mobileContent = React.createElement("div", { className: "ps-mobile-pane-fill" },
        React.createElement(InspectorPane, { controller, mobile: true }));
    else if (mobilePane === "inspector") mobileContent = React.createElement("div", { className: "ps-mobile-pane-fill" },
        React.createElement(InspectorPane, { controller, mobile: true }));
    else if (mobilePane === "activity") mobileContent = React.createElement("div", { className: "ps-mobile-pane-fill" },
        React.createElement(ActivityPane, { controller }));
    else mobileContent = React.createElement(MobileWorkspace, {
        controller,
        sessionsCollapsed: mobileSessionsCollapsed,
        setSessionsCollapsed: setMobileSessionsCollapsed,
    });

    return React.createElement("div", { ref: viewportRef, className: "ps-web-shell" },
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
                ? React.createElement(AdminConsolePanel, { controller })
                : (filesFullscreenActive
                    ? fullscreenWorkspace
                    : (chatFocusMode
                        ? chatFocusWorkspace
                        : (mobile ? mobileContent : desktopWorkspace)))),
        mobile && !chatFocusMode ? React.createElement(MobileNav, { activePane: mobilePane, setActivePane: setMobilePane, controller }) : null,
        React.createElement(ModalLayer, { controller }));
}
