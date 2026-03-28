import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { assertEqual, assertIncludes } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readRepoFile(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

function loadTuiStringGuards() {
    const tui = readRepoFile("packages/cli/cli/tui.js");
    const start = tui.indexOf("function asDisplayText(");
    const end = tui.indexOf("// ─── Create blessed screen");
    if (start < 0 || end < 0 || end <= start) {
        throw new Error("Unable to locate TUI string guard helpers");
    }
    const snippet = `${tui.slice(start, end)}
exports = { asDisplayText, safeSlice, safeTail, normalizePodName, shortId };`;
    const context = { exports: {} };
    new vm.Script(snippet).runInNewContext(context);
    return context.exports;
}

describe("TUI null guards", () => {
    it("coerces nullable ids and labels before slicing", () => {
        const helpers = loadTuiStringGuards();

        assertEqual(helpers.asDisplayText(null), "", "null display text should fall back to empty");
        assertEqual(helpers.safeSlice(null, 0, 5), "", "safeSlice should not throw on null");
        assertEqual(helpers.normalizePodName(null), "unknown", "worker labels should normalize null pod names");
        assertEqual(helpers.safeTail(helpers.normalizePodName(null), 5), "known", "tail slicing should still work on normalized pod names");
        assertEqual(helpers.shortId(null), "", "shortId should not throw on null ids");
        assertEqual(helpers.shortId("session-12345678-1234"), "678-1234", "shortId should still trim session prefixes");
    });

    it("uses the null-safe helpers in the worker/session render paths", () => {
        const tui = readRepoFile("packages/cli/cli/tui.js");

        assertIncludes(tui, "function safeSlice(value, start, end, fallback = \"\")", "TUI should define a shared null-safe slicer");
        assertIncludes(tui, "const short = workerNodeId ? safeTail(workerNodeId, 5) : \"(unk)\"", "sequence nodes should null-safe pod names");
        assertIncludes(tui, "const normalizedPodName = normalizePodName(podName);", "orchestration logs should normalize pod names before rendering");
        assertIncludes(tui, "podName = normalizePodName(podName);", "worker panes should normalize pod names before use");
        assertIncludes(tui, "content=${safeSlice(response.content, 0, 80)}", "response previews should use null-safe slicing");
    });
});
