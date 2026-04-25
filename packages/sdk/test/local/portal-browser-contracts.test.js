import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isScrollViewportAtBottom, mergeBoxTableCellFragments } from "../../../ui-react/src/web-app.js";
import { assert, assertIncludes } from "../helpers/assertions.js";

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

    it("supports browser-native artifact uploads through the portal transport", () => {
        const browserTransport = readRepoFile("packages/portal/src/browser-transport.js");
        const runtime = readRepoFile("packages/portal/runtime.js");
        const nodeTransport = readRepoFile("packages/cli/src/node-sdk-transport.js");
        const server = readRepoFile("packages/portal/server.js");
        const controller = readRepoFile("packages/ui-core/src/controller.js");
        const state = readRepoFile("packages/ui-core/src/state.js");
        const webApp = readRepoFile("packages/ui-react/src/web-app.js");
        const css = readRepoFile("packages/portal/src/index.css");

        assertIncludes(browserTransport, "async uploadArtifactFromFile(sessionId, file)", "browser transport should upload dropped/selected files");
        assertIncludes(browserTransport, "async deleteArtifact(sessionId, filename)", "browser transport should expose single-artifact deletion for the viewer");
        assertIncludes(browserTransport, "await file.arrayBuffer()", "browser transport should read uploaded files as raw bytes instead of text");
        assertIncludes(browserTransport, 'contentEncoding: "base64"', "browser transport should tag upload RPC payloads with a binary-safe encoding");
        assertIncludes(browserTransport, 'return this.rpc("uploadArtifact"', "browser transport should send uploads through portal RPC");
        assertIncludes(runtime, 'case "uploadArtifact":', "portal runtime should expose artifact upload RPC");
        assertIncludes(runtime, 'case "deleteArtifact":', "portal runtime should expose single-artifact deletion RPC");
        assertIncludes(runtime, "safeParams.contentEncoding", "portal runtime should forward upload contentEncoding to the node transport");
        assertIncludes(runtime, "async downloadArtifactBinary(sessionId, filename)", "portal runtime should expose a raw-byte artifact download path for HTTP downloads");
        assertIncludes(browserTransport, "async getUserStats(opts)", "browser transport should expose user stats RPC");
        assertIncludes(runtime, 'case "getUserStats":', "portal runtime should expose user stats RPC");
        assertIncludes(browserTransport, "async cancelPendingMessage(sessionId, clientMessageIds)", "browser transport should expose queued prompt cancellation RPC");
        assertIncludes(browserTransport, 'return this.rpc("cancelPendingMessage"', "browser transport should send cancellation tombstones through portal RPC");
        assertIncludes(runtime, 'case "cancelPendingMessage":', "portal runtime should expose queued prompt cancellation RPC");
        assertIncludes(runtime, "this.transport.cancelPendingMessage(safeParams.sessionId, safeParams.clientMessageIds)", "portal runtime should forward cancellation ids to node transport");
        assertIncludes(nodeTransport, "async uploadArtifactContent(sessionId, filename, content, contentType", "node transport should accept browser-supplied artifact content");
        assertIncludes(nodeTransport, "async deleteArtifact(sessionId, filename)", "node transport should expose single-artifact deletion against the artifact store");
        assertIncludes(nodeTransport, 'if (contentEncoding === "base64")', "node transport should decode base64 upload payloads back to raw bytes");
        assertIncludes(nodeTransport, "return Array.isArray(artifacts)", "node transport should preserve artifact metadata records for shared UI callers");
        assertIncludes(server, "const artifact = await runtime.downloadArtifactBinary(sessionId, filename);", "portal download route should fetch raw artifact bytes from the runtime");
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
        const portalApp = readRepoFile("packages/portal/src/App.jsx");
        const webApp = readRepoFile("packages/ui-react/src/web-app.js");
        const sharedTui = readRepoFile("packages/ui-react/src/components.js");
        const cliPlatform = readRepoFile("packages/cli/src/platform.js");
        const cliApp = readRepoFile("packages/cli/src/app.js");
        const cliIndex = readRepoFile("packages/cli/src/index.js");
        const layout = readRepoFile("packages/ui-core/src/layout.js");
        const state = readRepoFile("packages/ui-core/src/state.js");
        const selectors = readRepoFile("packages/ui-core/src/selectors.js");
        const css = readRepoFile("packages/portal/src/index.css");

        assertIncludes(portalApp, "portal-header-version", "portal header should render a version indicator near sign-out");
        assertIncludes(webApp, 'controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER)', "web app should expose new-session model selection");
        assertIncludes(webApp, "presentation.rowItemIndexes", "portal list modal should support row-to-item mapping for grouped pickers");
        assertIncludes(webApp, 'querySelector(".ps-list-button.is-selected")', "portal list modals should keep the selected row visible in the browser");
        assertIncludes(webApp, 'selected.scrollIntoView({ block: "nearest" });', "portal list modals should scroll the selected option into view");
        assertIncludes(webApp, "modalOpen: Boolean(state.ui.modal)", "portal focus-managed panes should know when a modal is open");
        assertIncludes(webApp, "if (viewState.modalOpen || !viewState.focused || !viewState.activeSessionId) return;", "session-pane focus management should stand down while modals are open");
        assertIncludes(webApp, "if (!active || promptState.modalOpen || !promptState.focused || !inputNode) return;", "prompt focus management should stand down while modals are open");
        assertIncludes(webApp, "controller.uploadArtifactFiles(nextFiles)", "portal uploads should flow through the shared artifact-upload controller path");
        assert(!webApp.includes("controller.uploadPromptAttachmentFiles(nextFiles)"), "prompt composer should no longer own browser artifact uploads");
        assertIncludes(webApp, "document.cookie =", "portal theme persistence should be cookie-backed");
        assertIncludes(webApp, 'const LAYOUT_STORAGE_KEY = "pilotswarm.layoutAdjustments"', "portal should define a dedicated storage key for persisted pane sizes");
        assertIncludes(webApp, "readStoredLayoutAdjustments()", "portal controller bootstrap should restore persisted pane sizes");
        assertIncludes(webApp, "writeStoredLayoutAdjustments({", "portal should persist pane-size adjustments when they change");
        assertIncludes(webApp, "supportsArtifactBrowser(controller)", "portal should keep the artifact browser available when transport-backed artifacts exist");
        assertIncludes(webApp, '}, "Delete")', "portal files pane should surface artifact deletion directly from the viewer");
        assertIncludes(webApp, "Keyboard Shortcuts", "portal should render a dedicated keybinding legend");
        assertIncludes(webApp, '}, "Prompt")', "portal toolbar should expose a prompt overlay affordance");
        assertIncludes(webApp, 'key: `stats-view:${mode}`', "portal stats pane should render explicit session/fleet/users buttons");
        assertIncludes(webApp, "controller.setStatsViewMode(mode)", "portal stats buttons should use the shared controller stats-view path");
        assertIncludes(webApp, "PromptOverlay", "portal should support a dedicated prompt overlay for remote/mobile access");
        assertIncludes(webApp, "controller.acceptPromptReferenceAutocomplete()", "portal prompt should accept @ / @@ autocomplete on Tab");
        assertIncludes(webApp, '["Tab", "Accept @ / @@ autocomplete"]', "portal legend should document prompt reference autocomplete");
        assertIncludes(webApp, 'controller.handleCommand(UI_COMMANDS.DOWNLOAD_SELECTED_FILE)', "portal files pane should download the selected artifact");
        assertIncludes(webApp, 'controller.handleCommand(UI_COMMANDS.DELETE_SELECTED_FILE)', "portal files pane should delete the selected artifact through the shared command");
        assertIncludes(webApp, '}, "Up")', "portal files pane should surface a shortened upload label directly in the files pane");
        assertIncludes(webApp, '}, "Down")', "portal files pane should surface a shortened download label directly in the files pane");
        assertIncludes(webApp, 'viewState.fullscreen ? "Close" : "FS"', "portal files pane should shorten the fullscreen action label for mobile layouts");
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
        assertIncludes(webApp, 'className: inspector.activeTab === "history" || inspector.activeTab === "logs" ? "is-wrapped" : "is-preserve"', "portal inspector logs should wrap instead of preserving horizontal overflow");
        assertIncludes(webApp, 'className: "is-wrapped"', "portal activity pane should render wrapped lines");
        assertIncludes(webApp, 'type: "code"', "portal chat renderer should recognize code fence blocks");
        assertIncludes(webApp, "ps-chat-code-block", "portal chat renderer should render code fences with a dedicated code block style");
        assertIncludes(webApp, "selectOutboxOverlayLines(selectorState", "portal chat should render queued prompts outside scrollback");
        assertIncludes(webApp, "bottomStickyLines: outboxLines", "portal chat should pin queued prompts below the scrollable transcript");
        assertIncludes(css, ".ps-panel-bottom-sticky", "portal stylesheet should style the fixed queued prompt strip");
        assertIncludes(webApp, "controller.adjustSessionPaneSplit", "web app should support resizing the session list vertically");
        assertIncludes(webApp, "controller.adjustActivityPaneSplit", "web app should support resizing the inspector/activity split vertically");
        assertIncludes(layout, "sessionPaneAdjust", "layout computation should persist vertical session-pane adjustments");
        assertIncludes(state, "normalizeStoredLayoutAdjustments", "shared state should normalize persisted pane-size adjustments");
        assertIncludes(state, "themeId: themeId || DEFAULT_THEME_ID", "shared initial state should honor persisted theme ids");
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
