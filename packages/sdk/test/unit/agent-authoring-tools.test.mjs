/**
 * Agent Manager authoring tools — staging, changelog discipline, publish.
 *
 * These tools are how an agent writes agents, so the failure modes are not
 * "wrong output" but "shipped something nobody reviewed" and "wrote outside
 * the package". Both are covered here.
 *
 * The approval gate itself is DELIBERATELY NOT enforced in the tool — it lives
 * in the Agent Manager's prompt as a discipline ("show the diff, wait for an
 * explicit yes"). So these tests assert the things the tool *does* own:
 * provenance, changelog presence, and path containment.
 *
 * Run: node --test test/unit/agent-authoring-tools.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    createAgentManagerTools,
    STAGING_ARTIFACT,
    CHANGELOG_PATH,
} from "../../dist/agent-manager-tools.js";

const VIEWER = { provider: "dev", subject: "alice", isAdmin: false, isSystemPrincipal: false };
const SESSION = "sess-authoring";

/** In-memory artifact store with just the surface these tools use. */
function fakeArtifacts() {
    const files = new Map();
    return {
        files,
        async uploadArtifact(sessionId, filename, content) {
            files.set(`${sessionId}/${filename}`, Buffer.isBuffer(content) ? content.toString("utf8") : String(content));
            return { filename };
        },
        async downloadArtifactText(sessionId, filename) {
            const v = files.get(`${sessionId}/${filename}`);
            if (v == null) throw new Error("not found");
            return v;
        },
        async deleteArtifact(sessionId, filename) { return files.delete(`${sessionId}/${filename}`); },
    };
}

function toolsWith({ artifacts = fakeArtifacts(), catalog = {}, viewer = VIEWER } = {}) {
    const list = createAgentManagerTools({
        catalog,
        artifactStore: artifacts,
        sessionId: SESSION,
        resolveViewer: async () => viewer,
    });
    return { artifacts, byName: new Map(list.map((t) => [t.name, t])) };
}

const staged = (artifacts) => JSON.parse(artifacts.files.get(`${SESSION}/${STAGING_ARTIFACT}`));

// ── The surface exists ────────────────────────────────────────────

test("the authoring tools are registered alongside the curation ones", () => {
    const { byName } = toolsWith();
    for (const name of [
        "read_agent_package_file", "stage_agent_package_edit",
        "propose_agent_patch", "publish_agent_package",
    ]) {
        assert.ok(byName.has(name), `${name} must be registered`);
    }
});

test("every tool has a declaration AND a handler", () => {
    // The agent-self-regen lesson: a handler-only tool is invisible to the
    // model, and a declaration-only tool throws when it finally gets called.
    const { byName } = toolsWith();
    for (const [name, tool] of byName) {
        assert.equal(typeof tool.handler, "function", `${name} needs a handler`);
        assert.ok(tool.description && tool.description.length > 20, `${name} needs a real description`);
        assert.ok(tool.parameters?.type === "object", `${name} needs an object parameter schema`);
    }
});

// ── Staging ───────────────────────────────────────────────────────

test("a brand-new package starts from an empty staging area", async () => {
    const { artifacts, byName } = toolsWith();
    const result = await byName.get("stage_agent_package_edit").handler({
        package: "brand-new",
        files: { "plugin.json": '{"name":"brand-new"}', "agents/x.agent.md": "---\nname: x\n---\nhi" },
    });
    assert.deepEqual(result.files, ["agents/x.agent.md", "plugin.json"]);
    assert.equal(result.seededFrom, null);
    assert.equal(staged(artifacts).package, "brand-new");
});

test("staging accumulates across calls and honours removals", async () => {
    const { artifacts, byName } = toolsWith();
    const stage = byName.get("stage_agent_package_edit");
    await stage.handler({ package: "p", files: { "a.md": "1", "b.md": "2" } });
    await stage.handler({ package: "p", files: { "c.md": "3" } });
    assert.deepEqual(staged(artifacts).files, { "a.md": "1", "b.md": "2", "c.md": "3" });
    await stage.handler({ package: "p", remove: ["b.md"] });
    assert.deepEqual(Object.keys(staged(artifacts).files).sort(), ["a.md", "c.md"]);
});

test("reset discards a previous edit instead of merging into it", async () => {
    const { artifacts, byName } = toolsWith();
    const stage = byName.get("stage_agent_package_edit");
    await stage.handler({ package: "p", files: { "old.md": "x" } });
    await stage.handler({ package: "p", reset: true, files: { "new.md": "y" } });
    assert.deepEqual(Object.keys(staged(artifacts).files), ["new.md"]);
});

test("staging for a different package does not inherit the previous one's files", async () => {
    // Otherwise an agent editing two packages in one session silently
    // publishes the first package's content into the second.
    const { artifacts, byName } = toolsWith();
    const stage = byName.get("stage_agent_package_edit");
    await stage.handler({ package: "first", files: { "first-only.md": "x" } });
    await stage.handler({ package: "second", files: { "second-only.md": "y" } });
    assert.deepEqual(Object.keys(staged(artifacts).files), ["second-only.md"]);
    assert.equal(staged(artifacts).package, "second");
});

test("staging nudges toward a changelog when none is present", async () => {
    const { byName } = toolsWith();
    const without = await byName.get("stage_agent_package_edit").handler({ package: "p", files: { "a.md": "1" } });
    assert.equal(without.hasChangelog, false);
    assert.match(without.note, /CHANGELOG/);

    const withIt = await byName.get("stage_agent_package_edit").handler({
        package: "p", files: { [CHANGELOG_PATH]: "## 1.0.0\n\n- first" },
    });
    assert.equal(withIt.hasChangelog, true);
    assert.equal(withIt.note, undefined);
});

// ── Publish: what the tool actually enforces ──────────────────────

test("publish refuses when nothing is staged", async () => {
    const { byName } = toolsWith();
    const out = await byName.get("publish_agent_package").handler({
        package: "p", semver: "1.0.0", approved_by: "alice",
    });
    assert.match(out.error, /nothing staged/);
});

test("publish refuses a staged tree with no CHANGELOG", async () => {
    const { byName } = toolsWith();
    await byName.get("stage_agent_package_edit").handler({ package: "p", files: { "plugin.json": "{}" } });
    const out = await byName.get("publish_agent_package").handler({
        package: "p", semver: "1.0.0", approved_by: "alice",
    });
    assert.match(out.error, /CHANGELOG/);
});

test("publish refuses when the CHANGELOG does not mention THIS version", async () => {
    // Guards the drift that makes a changelog worthless: an entry for 1.0.0
    // shipped as 1.1.0 tells a future reader the wrong story.
    const { byName } = toolsWith();
    await byName.get("stage_agent_package_edit").handler({
        package: "p",
        files: { "plugin.json": "{}", [CHANGELOG_PATH]: "## 1.0.0\n\n- initial" },
    });
    const out = await byName.get("publish_agent_package").handler({
        package: "p", semver: "1.1.0", approved_by: "alice",
    });
    assert.match(out.error, /no entry for 1\.1\.0/);
});

test("publish requires an approver — provenance is not optional", async () => {
    // `approved_by` is how a reader tells an agent-authored version from a
    // human `agents push`. A schema without it lets that distinction blur.
    const { byName } = toolsWith();
    const schema = byName.get("publish_agent_package").parameters;
    assert.ok(schema.required.includes("approved_by"), "approved_by must be required");
    assert.ok(schema.required.includes("semver"), "semver must be required");
});

test("publish refuses a staged path that escapes the package root", async () => {
    // Staged paths are MODEL-authored. `..` in one would write outside the
    // temp package dir at publish time.
    const { byName } = toolsWith();
    await byName.get("stage_agent_package_edit").handler({
        package: "p",
        files: {
            "plugin.json": "{}",
            [CHANGELOG_PATH]: "## 1.0.0\n- x",
            "../../escape.md": "pwned",
        },
    });
    const out = await byName.get("publish_agent_package").handler({
        package: "p", semver: "1.0.0", approved_by: "alice",
    });
    assert.match(out.error, /escapes the package root/);
});

// ── Propose: the approval surface ─────────────────────────────────

test("propose refuses when nothing is staged for that package", async () => {
    const { byName } = toolsWith({
        catalog: { async getAgentPackage() { return null; } },
    });
    const out = await byName.get("propose_agent_patch").handler({ package: "p" });
    assert.match(out.error, /nothing staged/i);
});

test("propose points the agent at the approval step it must not skip", async () => {
    const { artifacts, byName } = toolsWith({
        // No published base: a brand-new package is an all-added diff.
        catalog: { async getAgentPackage() { return null; } },
    });
    await byName.get("stage_agent_package_edit").handler({
        package: "p",
        files: { "plugin.json": "{}", [CHANGELOG_PATH]: "## 1.0.0\n- first" },
    });
    const out = await byName.get("propose_agent_patch").handler({ package: "p" });
    assert.ok(out.written > 0, "patch artifacts must be written");
    assert.match(out.next, /WAIT for an explicit approval/);
    // The artifacts really landed, which is what a human reviews.
    const written = [...artifacts.files.keys()].filter((k) => k.endsWith(".patch"));
    assert.equal(written.length, out.written);
});

test("propose warns when a change does not touch the changelog", async () => {
    const { byName } = toolsWith({ catalog: { async getAgentPackage() { return null; } } });
    await byName.get("stage_agent_package_edit").handler({ package: "p", files: { "plugin.json": "{}" } });
    const out = await byName.get("propose_agent_patch").handler({ package: "p" });
    assert.equal(out.changelogUpdated, false);
    assert.match(out.warning, /CHANGELOG/);
});
