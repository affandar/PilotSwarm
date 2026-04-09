import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIncludes } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readRepoFile(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("portal browser contracts", () => {
    it("supports browser-native artifact uploads through the portal transport", () => {
        const browserTransport = readRepoFile("packages/portal/src/browser-transport.js");
        const runtime = readRepoFile("packages/portal/runtime.js");
        const nodeTransport = readRepoFile("packages/cli/src/node-sdk-transport.js");

        assertIncludes(browserTransport, "async uploadArtifactFromFile(sessionId, file)", "browser transport should upload dropped/selected files");
        assertIncludes(browserTransport, 'return this.rpc("uploadArtifact"', "browser transport should send uploads through portal RPC");
        assertIncludes(runtime, 'case "uploadArtifact":', "portal runtime should expose artifact upload RPC");
        assertIncludes(nodeTransport, "async uploadArtifactContent(sessionId, filename, content, contentType", "node transport should accept browser-supplied artifact content");
    });

    it("keeps portal-only UI features aligned with browser constraints", () => {
        const webApp = readRepoFile("packages/ui-react/src/web-app.js");
        const layout = readRepoFile("packages/ui-core/src/layout.js");
        const state = readRepoFile("packages/ui-core/src/state.js");
        const css = readRepoFile("packages/portal/src/index.css");

        assertIncludes(webApp, 'controller.handleCommand(UI_COMMANDS.OPEN_MODEL_PICKER)', "web app should expose new-session model selection");
        assertIncludes(webApp, "controller.uploadArtifactFiles(nextFiles)", "portal uploads should flow through the shared artifact-upload controller path");
        assert(!webApp.includes("controller.uploadPromptAttachmentFiles(nextFiles)"), "prompt composer should no longer own browser artifact uploads");
        assertIncludes(webApp, "document.cookie =", "portal theme persistence should be cookie-backed");
        assertIncludes(webApp, "supportsArtifactBrowser(controller)", "portal should keep the artifact browser available when transport-backed artifacts exist");
        assertIncludes(webApp, "Keyboard Shortcuts", "portal should render a dedicated keybinding legend");
        assertIncludes(webApp, '}, "Prompt")', "portal toolbar should expose a prompt overlay affordance");
        assertIncludes(webApp, "PromptOverlay", "portal should support a dedicated prompt overlay for remote/mobile access");
        assertIncludes(webApp, "controller.acceptPromptReferenceAutocomplete()", "portal prompt should accept @ / @@ autocomplete on Tab");
        assertIncludes(webApp, '["Tab", "Accept @ / @@ autocomplete"]', "portal legend should document prompt reference autocomplete");
        assertIncludes(webApp, 'controller.handleCommand(UI_COMMANDS.DOWNLOAD_SELECTED_FILE)', "portal files pane should download the selected artifact");
        assertIncludes(webApp, '}, "Upload")', "portal files pane should surface artifact uploads directly");
        assertIncludes(webApp, "ps-workspace-full", "portal should render a dedicated fullscreen files workspace");
        assertIncludes(webApp, "React.createElement(Line, {", "portal file rows should render through the shared line component");
        assertIncludes(webApp, "view.fullscreen\n        ? previewPane", "portal fullscreen files mode should hide the artifact list");
        assertIncludes(webApp, "MarkdownPreviewPanel", "portal should render markdown previews through a dedicated component");
        assertIncludes(webApp, "ps-markdown-preview", "portal markdown previews should use the rich markdown container");
        assertIncludes(webApp, 'type: "code"', "portal chat renderer should recognize code fence blocks");
        assertIncludes(webApp, "ps-chat-code-block", "portal chat renderer should render code fences with a dedicated code block style");
        assertIncludes(webApp, "controller.adjustSessionPaneSplit", "web app should support resizing the session list vertically");
        assertIncludes(layout, "sessionPaneAdjust", "layout computation should persist vertical session-pane adjustments");
        assertIncludes(state, "themeId: themeId || DEFAULT_THEME_ID", "shared initial state should honor persisted theme ids");
        assertIncludes(css, ".ps-workspace-full", "portal stylesheet should size the fullscreen files workspace");
        assertIncludes(css, ".ps-markdown-preview", "portal stylesheet should style markdown previews");
    });
});
