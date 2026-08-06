/**
 * show_artifact must exist in BOTH halves, or it is silently broken.
 *
 * A PilotSwarm system tool is declared once in systemToolDefs() (what the LLM
 * is shown when the session is created) and implemented again as a real
 * handler in runTurn(). The two failure modes are both quiet:
 *
 *   - handler with no declaration → the model never sees the tool and never
 *     calls it. Nothing errors; the feature just does not exist.
 *   - declaration with no handler → the model calls it and gets back the
 *     literal string "stub".
 *
 * Nothing at runtime notices either one, which is why this test exists.
 *
 * Run: node --test test/unit/show-artifact-tool.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ManagedSession } from "../../dist/managed-session.js";

const SOURCE = readFileSync(
    fileURLToPath(new URL("../../src/managed-session.ts", import.meta.url)),
    "utf8",
);

function declaredTool(name) {
    return ManagedSession.systemToolDefs().find((tool) => tool.name === name) || null;
}

test("show_artifact is declared to the model", () => {
    const tool = declaredTool("show_artifact");
    assert.ok(tool, "show_artifact missing from systemToolDefs() — the model cannot call what it cannot see");
    assert.match(tool.description, /portal/i, "the description has to say where the file appears");
    assert.deepEqual(tool.parameters.required, ["filename"]);
    assert.deepEqual(
        Object.keys(tool.parameters.properties).sort(),
        ["filename", "fullscreen", "note"],
    );
});

test("the declaration and the per-turn handler share one schema object", () => {
    // Every other system tool carries a "keep in sync with systemToolDefs()"
    // comment because its schema is written out twice. This one is built from
    // SHOW_ARTIFACT_TOOL_SPEC in both places, so drift is impossible rather
    // than merely discouraged — assert that stays true.
    const uses = SOURCE.match(/\.\.\.SHOW_ARTIFACT_TOOL_SPEC|defineTool\("show_artifact", SHOW_ARTIFACT_TOOL_SPEC\)/g) || [];
    assert.equal(uses.length, 2, "both the declaration and the handler must build from the shared spec");
});

test("show_artifact is registered in the per-turn tool list", () => {
    // The declaration alone is inert: runTurn() assembles systemToolsForTurn
    // from named locals, and a tool left out of that array falls through to
    // the declaration stub.
    const turnList = /const systemToolsForTurn[\s\S]*?\]\.filter/.exec(SOURCE);
    assert.ok(turnList, "could not locate systemToolsForTurn");
    assert.match(turnList[0], /\bshowArtifactTool\b/, "show_artifact is declared but never wired into the turn");
});

test("show_artifact counts as a system tool name", () => {
    // SYSTEM_TOOL_NAMES is what stops a user-supplied tool of the same name
    // from shadowing the built-in one.
    const set = /const SYSTEM_TOOL_NAMES = new Set\(\[[^\]]*\]\)/.exec(SOURCE);
    assert.ok(set, "could not locate SYSTEM_TOOL_NAMES");
    assert.match(set[0], /"show_artifact"/);
});

test("the handler emits the durable event the portal listens for", () => {
    // session.artifact_presented is the contract between the worker and the
    // portal. Renaming it on one side only is the third quiet failure mode.
    const handler = /defineTool\("show_artifact", \{[\s\S]*?\n        \}\);/.exec(SOURCE);
    assert.ok(handler, "could not locate the show_artifact handler");
    assert.match(handler[0], /eventType: "session\.artifact_presented"/);
    assert.match(handler[0], /artifact:\/\/\$\{this\.sessionId\}/, "the returned link must be a reopenable artifact:// ref");
});
