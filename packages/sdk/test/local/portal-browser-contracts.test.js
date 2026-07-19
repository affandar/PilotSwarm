import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PortalRuntime } from "../../../app/web/runtime.js";
import { computeAnchoredScrollTop, isScrollViewportAtBottom, mergeBoxTableCellFragments } from "../../../app/ui/react/src/web-app.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readRepoFile(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("portal browser contracts", () => {
    it("reconstructs wrapped box-table cells without inserting spaces into file extensions or identifier punctuation", () => {
        assert(mergeBoxTableCellFragments(["OrcasExperienceFeatureConstants", ".cs,"]) === "OrcasExperienceFeatureConstants.cs,", "wrapped file extensions should rejoin without an inserted space");
        assert(mergeBoxTableCellFragments(["PostgreSqlDbEngineReplication.c", "s,"]) === "PostgreSqlDbEngineReplication.cs,", "split file extensions should rejoin without an inserted space");
        assert(mergeBoxTableCellFragments(["Feature", "gating"]) === "Feature gating", "normal word-wrapped text should still rejoin with a space");
    });

    it("treats sticky browser panes as bottom-pinned only at the bottom edge", () => {
        assert(isScrollViewportAtBottom({ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 }), "an exact bottom scroll position should be bottom-pinned");
        assert(isScrollViewportAtBottom({ scrollHeight: 1000, clientHeight: 200, scrollTop: 799.75 }), "fractional browser scroll noise should still count as bottom-pinned");
        assert(!isScrollViewportAtBottom({ scrollHeight: 1000, clientHeight: 200, scrollTop: 799 }), "scrolling up by a visible pixel should disable bottom-pinning");
    });

    it("re-anchors sticky browser panes when their viewport height changes", () => {
        const viewport = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
        assertEqual(computeAnchoredScrollTop(viewport, 0, "bottom"), 800, "bottom mode should anchor to the live tail");

        viewport.clientHeight = 160;
        assertEqual(computeAnchoredScrollTop(viewport, 0, "bottom"), 840, "a mounted bottom strip should re-anchor the transcript after reducing viewport height");
        assertEqual(computeAnchoredScrollTop(viewport, 2, "bottom"), 808, "bottom mode should preserve a deliberate row offset after resize");
        assertEqual(computeAnchoredScrollTop(viewport, 2, "top"), 32, "top mode should preserve its row offset after resize");

        viewport.scrollTop = 315;
        assertEqual(computeAnchoredScrollTop(viewport, 2, "top", true), 315, "paused sticky panes should preserve the user's real scroll position");
    });

    it("stamps the authenticated creator as group owner, never inferring it from selected sessions", async () => {
        const authOwner = {
            provider: "entra",
            subject: "auth-user",
            email: "auth@example.com",
            displayName: "Auth User",
        };
        const inputOwner = {
            provider: "entra",
            subject: "input-user",
            email: "input@example.com",
            displayName: "Input User",
        };
        const runtime = new PortalRuntime({ mode: "remote" });
        // Groups are private per-user organization: ownership comes from the
        // authenticated principal, never from the owner of a selected session
        // (security model). The transport is never consulted for owner.
        runtime.transport = {
            getSession: async () => { throw new Error("resolveSessionGroupOwner must not read sessions"); },
        };

        const withAuth = await runtime.resolveSessionGroupOwner(
            { owner: inputOwner, sessionIds: ["session-a"] },
            authOwner,
        );
        assertEqual(withAuth.provider, authOwner.provider, "authenticated creator provider should own the group");
        assertEqual(withAuth.subject, authOwner.subject, "authenticated creator subject should own the group");

        // No auth principal (e.g. no-auth deployment): fall back to the input
        // owner when present, else the shared anonymous principal.
        const withInput = await runtime.resolveSessionGroupOwner({ owner: inputOwner }, null);
        assertEqual(withInput.subject, inputOwner.subject, "input owner is used when there is no auth principal");

        const anon = await runtime.resolveSessionGroupOwner({}, null);
        assertEqual(anon.provider, "anonymous", "no-auth deployments own groups as the anonymous principal");
        assertEqual(anon.subject, "anonymous", "no-auth deployments own groups as the anonymous principal");
    });

    it("supports browser-native artifact uploads through the portal transport", () => {
        const browserTransport = readRepoFile("packages/app/web/src/browser-transport.js");
        const httpTransport = readRepoFile("packages/sdk/api/src/http-api-transport.js");
        const runtime = readRepoFile("packages/app/web/runtime.js");
        const nodeTransport = readRepoFile("packages/app/tui/src/node-sdk-transport.js");
        const server = readRepoFile("packages/app/web/server.js");
        const controller = readRepoFile("packages/app/ui/core/src/controller.js");
        const state = readRepoFile("packages/app/ui/core/src/state.js");
        const webApp = readRepoFile("packages/app/ui/react/src/web-app.js");
        const css = readRepoFile("packages/app/web/src/index.css");

        // The browser transport is HttpApiTransport (pilotswarm-sdk/api)
        // plus browser conveniences; the shared method surface lives there.
        assertIncludes(browserTransport, "extends HttpApiTransport", "browser transport should ride the shared Web API transport");
        assertIncludes(browserTransport, "async uploadArtifactFromFile(sessionId, file)", "browser transport should upload dropped/selected files");
        assertIncludes(httpTransport, "async deleteArtifact(sessionId, filename)", "web transport should expose single-artifact deletion for the viewer");
        assertIncludes(browserTransport, "await file.arrayBuffer()", "browser transport should read uploaded files as raw bytes instead of text");
        assertIncludes(browserTransport, '"base64"', "browser transport should tag upload payloads with a binary-safe encoding");
        assertIncludes(httpTransport, 'this.api.call("uploadArtifact"', "web transport should send uploads through the uploadArtifact operation");
        assertIncludes(runtime, 'case "uploadArtifact":', "portal runtime should expose artifact upload RPC");
        assertIncludes(runtime, 'case "deleteArtifact":', "portal runtime should expose single-artifact deletion RPC");
        assertIncludes(runtime, "safeParams.contentEncoding", "portal runtime should forward upload contentEncoding to the node transport");
        assertIncludes(runtime, "async downloadArtifactBinary(sessionId, filename", "portal runtime should expose a raw-byte artifact download path for HTTP downloads");
        assertIncludes(httpTransport, "async getUserStats(opts)", "web transport should expose user stats");
        assertIncludes(runtime, 'case "getUserStats":', "portal runtime should expose user stats RPC");
        assertIncludes(httpTransport, "async listSessionsPage(opts = {})", "web transport should expose bounded session paging");
        assertIncludes(httpTransport, 'this.api.call("listSessionsPage"', "web transport should call the bounded session paging operation");
        assertIncludes(httpTransport, "async getTopEventEmitters(opts = {})", "web transport should expose top event emitter diagnostics");
        assertIncludes(httpTransport, 'this.api.call("getTopEventEmitters"', "web transport should call the top event emitter diagnostics operation");
        assertIncludes(runtime, 'case "listSessionsPage":', "portal runtime should expose bounded session paging RPC");
        assertIncludes(runtime, "normalizeSessionPageOptions(safeParams)", "portal runtime should guard bounded session paging params");
        assertIncludes(runtime, 'params.cursor != null && typeof params.cursor !== "object"', "portal runtime should reject malformed session page cursors");
        assertIncludes(runtime, 'case "getTopEventEmitters":', "portal runtime should expose top event emitter diagnostics RPC");
        assertIncludes(runtime, "normalizeTopEventEmitterOptions(safeParams)", "portal runtime should guard top emitter diagnostic params");
        assertIncludes(runtime, "params.since == null", "portal runtime should require a since value for top emitter diagnostics");
        assertIncludes(nodeTransport, "async listSessionsPage(opts)", "node transport should expose bounded session paging");
        assertIncludes(nodeTransport, "this.mgmt.listSessionsPage({ ...safeOpts", "node transport should delegate bounded session paging to management (threading the placement viewer)");
        assertIncludes(nodeTransport, "async getTopEventEmitters(opts)", "node transport should expose top event emitter diagnostics");
        assertIncludes(nodeTransport, "return this.mgmt.getTopEventEmitters(opts);", "node transport should delegate top emitter diagnostics to management");
        assertIncludes(controller, "loadSessionCatalogPageWindow(this.transport)", "shared controller should consume bounded session pages when available");
        assertIncludes(nodeTransport, "async uploadArtifactContent(sessionId, filename, content, contentType", "node transport should accept browser-supplied artifact content");
        assertIncludes(nodeTransport, "async deleteArtifact(sessionId, filename)", "node transport should expose single-artifact deletion against the artifact store");
        assertIncludes(nodeTransport, 'if (contentEncoding === "base64")', "node transport should decode base64 upload payloads back to raw bytes");
        assertIncludes(nodeTransport, "return Array.isArray(artifacts)", "node transport should preserve artifact metadata records for shared UI callers");
        assertIncludes(server, "const artifact = await runtime.downloadArtifactBinary(sessionId, filename, req.auth);", "portal download route should fetch raw artifact bytes from the runtime");
        assertIncludes(server, "res.send(artifact.body);", "portal download route should send raw bytes instead of text strings");
        assertIncludes(controller, "findArtifactEntry(current?.entries, filename)", "shared controller should look up artifact metadata before previewing a file");
        assertIncludes(controller, "entry?.isBinary === true", "shared controller should skip downloadArtifact when metadata already marks a file binary");
        assertIncludes(controller, 'typeof this.transport.getArtifactMetadata === "function"', "shared controller should support metadata lookups when list payloads do not include artifact metadata");
        assertIncludes(state, "export function normalizeArtifactEntries(entries)", "shared state helpers should normalize artifact metadata entries for both portal and terminal hosts");
        assertIncludes(webApp, "BinaryArtifactPreviewPanel", "portal files pane should render a dedicated binary artifact preview card");
        assertIncludes(webApp, "filesView.previewIsBinary", "portal preview rendering should branch on binary artifact metadata");
        assertIncludes(css, ".ps-binary-preview-card", "portal stylesheet should style the binary artifact preview card");
    });

    it("keeps portal-only UI features aligned with browser constraints", () => {
        const portalApp = readRepoFile("packages/app/web/src/App.jsx");
        const webApp = readRepoFile("packages/app/ui/react/src/web-app.js");
        const sharedTui = readRepoFile("packages/app/ui/react/src/components.js");
        const cliPlatform = readRepoFile("packages/app/tui/src/platform.js");
        const cliApp = readRepoFile("packages/app/tui/src/app.js");
        const cliIndex = readRepoFile("packages/app/tui/src/index.js");
        const nodeTransport = readRepoFile("packages/app/tui/src/node-sdk-transport.js");
        const layout = readRepoFile("packages/app/ui/core/src/layout.js");
        const state = readRepoFile("packages/app/ui/core/src/state.js");
        const selectors = readRepoFile("packages/app/ui/core/src/selectors.js");
        const css = readRepoFile("packages/app/web/src/index.css");

        assertIncludes(portalApp, "portal-header-version", "portal header should render a version indicator near sign-out");
        assertIncludes(webApp, 'controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER)', "web app should expose new-session model selection");
        assertIncludes(sharedTui, "selectReasoningEffortPickerModal", "native TUI should render the reasoning-effort picker overlay");
        assertIncludes(sharedTui, "ReasoningEffortPickerModalContainer", "native TUI should mount the reasoning-effort picker container");
        assertIncludes(webApp, "presentation.rowItemIndexes", "portal list modal should support row-to-item mapping for grouped pickers");
        assertIncludes(webApp, 'querySelector(".ps-list-button.is-selected")', "portal list modals should keep the selected row visible in the browser");
        assertIncludes(webApp, 'selected.scrollIntoView({ block: "nearest" });', "portal list modals should scroll the selected option into view");
        assertIncludes(webApp, "modalOpen: Boolean(state.ui.modal)", "portal focus-managed panes should know when a modal is open");
        assertIncludes(webApp, "if (viewState.modalOpen || !viewState.focused || !viewState.activeSessionId) return;", "session-pane focus management should stand down while modals are open");
        assertIncludes(webApp, "if (!active || promptState.modalOpen || !promptState.focused || !inputNode) return;", "prompt focus management should stand down while modals are open");
        assertIncludes(webApp, "controller.uploadArtifactFiles(nextFiles)", "portal uploads should flow through the shared artifact-upload controller path");
        assert(!webApp.includes("controller.uploadPromptAttachmentFiles(nextFiles)"), "prompt composer should no longer own browser artifact uploads");
        assertIncludes(webApp, "clearBrowserPreferenceCache()", "portal should purge legacy browser preference cache at startup");
        assertIncludes(webApp, "LEGACY_BROWSER_PREFERENCE_STORAGE_KEYS", "portal should know the old localStorage preference keys to clear");
        assertIncludes(webApp, "LEGACY_BROWSER_PREFERENCE_COOKIE_NAMES", "portal should know the old preference cookies to clear");
        assert(!webApp.includes("window.localStorage.getItem"), "portal should not read preferences from browser localStorage");
        assert(!webApp.includes("window.localStorage.setItem"), "portal should not write preferences to browser localStorage");
        assertIncludes(webApp, "profileSettings/apply", "portal should hydrate user UI preferences from database profile settings");
        assertIncludes(webApp, "getCurrentUserProfile()", "portal should read the current user's database-backed profile settings");
        assertIncludes(webApp, "setCurrentUserProfileSettings", "portal should persist user UI preferences to database profile settings");
        assertIncludes(webApp, "onSelect: (event) => controller.setPromptCursor", "portal prompt selection should not restore stale textarea text after send");
        assertIncludes(webApp, "PROFILE_SETTINGS_POLL_MS = 5000", "portal should poll profile settings every 5 seconds");
        assertIncludes(webApp, "setInterval(() =>", "portal should continuously refresh remote profile settings");
        assertIncludes(webApp, "appliedProfileSettingsJsonRef.current !== settingsJson", "portal should skip profile-settings re-dispatch when payload is unchanged");
        assertIncludes(webApp, "supportsArtifactBrowser(controller)", "portal should keep the artifact browser available when transport-backed artifacts exist");
        assertIncludes(webApp, 'label: "Delete"', "portal files pane should surface artifact deletion directly from the viewer (now an icon button)");
        assert(!webApp.includes("Keyboard Shortcuts"), "portal keybinding legend should be removed");
        assert(!webApp.includes('label: "Keys"'), "portal toolbar should no longer expose a Keys button");
        assert(!webApp.includes('label: "Prompt"'), "portal toolbar should no longer expose a Prompt button");
        assertIncludes(webApp, 'key: `stats-view:${mode}`', "portal stats pane should render explicit session/fleet/users buttons");
        assertIncludes(webApp, "controller.setStatsViewMode(mode)", "portal stats buttons should use the shared controller stats-view path");
        assert(!webApp.includes("PromptOverlay"), "portal prompt overlay should be removed");
        assertIncludes(webApp, "controller.acceptPromptReferenceAutocomplete()", "portal prompt should accept @ / @@ autocomplete on Tab");
        assertIncludes(webApp, 'modal.sessionOptions?.mode === "switchModel" ? "Switch Model" : "Create Session"', "portal switch-model picker should label its confirm action as Switch Model");
        assertIncludes(nodeTransport, "async getSessionTokensByModel(sessionId)", "node transport should expose per-session model buckets to portal and TUI stats");
        assertIncludes(nodeTransport, "return this.mgmt.getSessionTokensByModel(sessionId);", "node transport should forward per-session model buckets to management API");
        assertIncludes(webApp, 'controller.handleCommand(UI_COMMANDS.DOWNLOAD_SELECTED_FILE)', "portal files pane should download the selected artifact");
        assertIncludes(webApp, 'controller.handleCommand(UI_COMMANDS.DELETE_SELECTED_FILE)', "portal files pane should delete the selected artifact through the shared command");
        assertIncludes(webApp, 'label: "Upload"', "portal files pane should surface an upload affordance directly in the files pane (now an icon button)");
        assertIncludes(webApp, 'label: "Download"', "portal files pane should surface a download affordance directly in the files pane (now an icon button)");
        assertIncludes(webApp, 'viewState.fullscreen ? "Exit fullscreen" : "Fullscreen"', "portal files pane should offer a fullscreen toggle (now an icon button with a tooltip label)");
        assertIncludes(webApp, "ps-workspace-full", "portal should render a dedicated fullscreen files workspace");
        assertIncludes(webApp, 'title: [{ text: "Sessions", color: "yellow", bold: true }]', "portal should keep the Sessions title data plain while the panel chrome paints the full header strip");
        assertIncludes(webApp, "React.createElement(Line, {", "portal file rows should render through the shared line component");
        assertIncludes(webApp, "view.fullscreen\n        ? previewPane", "portal fullscreen files mode should hide the artifact list");
        assertIncludes(webApp, "MarkdownPreviewPanel", "portal should render markdown previews through a dedicated component");
        assertIncludes(webApp, "ps-markdown-preview", "portal markdown previews should use the rich markdown container");
        assertIncludes(webApp, "const isExternalHref = /^https?:\\/\\//i.test(href)", "portal chat runs should treat external hrefs as clickable anchors");
        assertIncludes(webApp, 'renderInlineMarkdown(row[cellIndex] || "", theme, `chat-table:${index}:${rowIndex}:${cellIndex}`)', "portal structured chat tables should render inline markdown inside body cells");
        assertIncludes(webApp, 'stickyBottom: inspector.activeTab === "logs"', "portal log pane should use sticky follow-bottom scroll semantics");
        assertIncludes(webApp, "const PROGRAMMATIC_SCROLL_TOLERANCE_PX = SCROLL_BOTTOM_EPSILON_PX", "portal live panes should not ignore visible user scroll movement while auto-scrolling");
        assertIncludes(webApp, 'const observer = new ResizeObserver(() => {', "portal live panes should reapply their scroll anchor when sticky layout changes the viewport size");
        assertIncludes(webApp, 'className: inspector.activeTab === "history" || inspector.activeTab === "logs" ? "is-wrapped" : "is-preserve"', "portal inspector logs should wrap instead of preserving horizontal overflow");
        assertIncludes(webApp, 'className: "is-wrapped"', "portal activity pane should render wrapped lines");
        assertIncludes(webApp, 'type: "code"', "portal chat renderer should recognize code fence blocks");
        assertIncludes(webApp, "ps-chat-code-block", "portal chat renderer should render code fences with a dedicated code block style");
        assertIncludes(webApp, "controller.adjustSessionPaneSplit", "web app should support resizing the session list vertically");
        assertIncludes(webApp, "controller.adjustActivityPaneSplit", "web app should support resizing the inspector/activity split vertically");
        assertIncludes(layout, "sessionPaneAdjust", "layout computation should persist vertical session-pane adjustments");
        assertIncludes(state, "normalizeStoredLayoutAdjustments", "shared state should normalize persisted pane-size adjustments");
        assertIncludes(state, "themeId: getTheme(themeId)?.id || DEFAULT_THEME_ID", "shared initial state should honor persisted theme ids and fall back when a saved theme no longer ships");
        assertIncludes(state, "...initialLayoutAdjustments", "shared initial state should hydrate persisted pane-size adjustments into ui.layout");
        assertIncludes(state, "followBottom:", "shared UI state should track follow-bottom scroll mode for live panes");
        assertIncludes(sharedTui, "buildSessionTitleRightRuns", "shared TUI shell should compose RSS and version chrome");
        assertIncludes(sharedTui, 'title: [{ text: "Sessions", color: "yellow", bold: true }]', "terminal host should keep the Sessions title data plain while the TUI pane chrome stays unhighlighted");
        assert(!cliPlatform.includes('activeHighlightBackground'), "terminal pane chrome should not tint the title row background");
        assertIncludes(cliApp, "PILOTSWARM_CLI_VERSION_LABEL", "TUI host should pass its version label into the shared app");
        assertIncludes(cliIndex, "layoutAdjustments: userConfig.layoutAdjustments", "native TUI should restore persisted pane sizes from its config file");
        assertIncludes(cliIndex, "patch.layoutAdjustments = currentLayoutAdjustments", "native TUI should persist pane-size adjustments back to its config file");
        assertIncludes(css, "linear-gradient(", "portal panels should paint the full header strip with a card-like gradient");
        assertIncludes(css, "border-bottom: 1px solid color-mix(in srgb, var(--ps-panel-accent, var(--ps-border)) 28%, transparent);", "portal panels should separate the painted header strip from the pane body");
        assertIncludes(css, "min-height: 30px;", "portal panels should keep the card header compact");
        assertIncludes(css, "padding: 4px 10px 4px;", "portal panels should reduce header padding so the card header is slimmer");
        assert(!css.includes(".ps-chat-table-wrap.is-fit-width,\n.ps-md-table-wrap.is-fit-width {\n  width: 100%;"), "small portal tables should not be forced to span the full pane width");
        assertIncludes(css, ".portal-header-version", "portal stylesheet should style the header version badge");
        assertIncludes(css, ".ps-workspace-full", "portal stylesheet should size the fullscreen files workspace");
        assertIncludes(css, ".ps-markdown-preview", "portal stylesheet should style markdown previews");
        assertIncludes(css, ".ps-chat-focus-body .ps-line", "chat focus mode should keep transcript lines wrapped within the viewport");
        assertIncludes(selectors, "rowItemIndexes", "model picker presentation should preserve grouped-row to item-index mapping");
        assertIncludes(selectors, "x delete", "shared files-pane hints should document artifact deletion");
    });
});
