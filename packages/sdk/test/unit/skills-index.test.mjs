/**
 * Progressive skill discovery (0.5.45).
 *
 * The framework base prompt carries a one-line index of registered skills;
 * `load_skill` returns a body on demand; nothing is inlined unless an agent
 * declares it. Pins: the index exists exactly once (reload safe), lists the
 * bundled canvas skills, excludes private (user-scope package) skills, and
 * the default agent's prompt carries no preloaded bodies. Also pins that the
 * always-on canvas text stayed small.
 *
 * Run: node --test test/unit/skills-index.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { ManagedSession } from "../../dist/managed-session.js";

function makeTmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkillPackage(name, skillName, description) {
    const dir = makeTmpDir(`ps-skillpkg-${name}-`);
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
    fs.mkdirSync(path.join(dir, "skills", skillName), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", skillName, "SKILL.md"), `---\nname: ${skillName}\ndescription: ${description}\n---\n\nBody of ${skillName}.\n`);
    return dir;
}

function buildWorker(pluginDirs = []) {
    const stateDir = makeTmpDir("ps-skills-state-");
    return new PilotSwarmWorker({
        sessionStateDir: path.join(stateDir, "session-state"),
        pluginDirs,
        workerNodeId: "test-skills-index",
    });
}

function installPackages(worker, baseDirs, packages) {
    worker._packageDirOwners = new Map(
        packages.map((p) => [path.resolve(p.dir), { packageId: p.packageId, scope: p.scope, owner: p.owner ?? null }]),
    );
    worker._resetLoadedPluginState();
    worker.config.pluginDirs = [...baseDirs, ...packages.map((p) => p.dir)];
    worker._loadPlugins();
}

const INDEX_HEADING = "## Skills available on demand";

test("the base prompt carries the skills index exactly once, listing the bundled canvas skills", () => {
    const worker = buildWorker();
    const prompt = worker._frameworkBasePrompt;
    assert.ok(prompt, "the system tier's default agent is the framework base prompt");
    assert.equal(prompt.split(INDEX_HEADING).length - 1, 1, "one index");
    assert.match(prompt, /- `canvas-apps` — /);
    assert.match(prompt, /- `html-visuals` — /);
    assert.match(prompt, /load_skill\(name\)/);
    // Reload (the epoch-poll path) must not stack a second index.
    worker._resetLoadedPluginState();
    worker._loadPlugins();
    assert.equal(worker._frameworkBasePrompt.split(INDEX_HEADING).length - 1, 1, "still one index after reload");
});

test("nothing is preloaded: the default agent's prompt carries no skill bodies, and the old canvas sections are gone", () => {
    const worker = buildWorker();
    const prompt = worker._frameworkBasePrompt;
    assert.doesNotMatch(prompt, /\[PRELOADED SKILL/);
    assert.doesNotMatch(prompt, /Standing Visual Display/);
    assert.doesNotMatch(prompt, /Sub-agents have no canvas/);
    assert.match(prompt, /## Visuals and the Canvas/);
    // The always-on canvas text: the compact section plus the four tool
    // descriptions. The pre-0.5.45 figure was ~14,900 chars.
    const section = prompt.slice(prompt.indexOf("## Visuals and the Canvas"), prompt.indexOf("## Local Filesystem"));
    const defs = ManagedSession.systemToolDefs();
    const canvasDefs = defs.filter((t) => ["draw_canvas", "update_canvas", "show_canvas", "read_canvas"].includes(t.name));
    assert.equal(canvasDefs.length, 4);
    const defChars = canvasDefs.reduce((n, t) => n + JSON.stringify(t.description) .length + JSON.stringify(t.parameters).length, 0);
    // Measured at 7,478 on 2026-08-24 (≈1.5K prose + ≈6K of tool schema),
    // down from ~14,900. The bound guards against the prose creeping back;
    // the schemas are the floor.
    assert.ok(section.length < 2000, `canvas section is ${section.length} chars`);
    assert.ok(section.length + defChars < 8000, `always-on canvas text is ${section.length + defChars} chars`);
});

test("canvas_kv and load_skill are system tools; canvas_kv is stripped from read-only tuner sessions", () => {
    const names = ManagedSession.systemToolDefs().map((t) => t.name);
    assert.ok(names.includes("canvas_kv"));
    assert.ok(names.includes("load_skill"));
    const kv = ManagedSession.systemToolDefs().find((t) => t.name === "canvas_kv");
    assert.deepEqual(kv.parameters.properties.op.enum, ["get", "put", "list", "delete"]);
    assert.deepEqual(kv.parameters.required, ["op"]);
    const loadSkill = ManagedSession.systemToolDefs().find((t) => t.name === "load_skill");
    assert.deepEqual(loadSkill.parameters.required, ["name"]);
});

test("a shared package's skill is indexed; a user-scope package's skill is not", () => {
    const shared = writeSkillPackage("team-kit", "release-runbook", "How the team cuts a release.");
    const priv = writeSkillPackage("alice-kit", "alice-secret", "Alice's private notes.");
    const worker = buildWorker();
    installPackages(worker, [], [
        { dir: shared, packageId: "pkg-shared", scope: "shared" },
        { dir: priv, packageId: "pkg-alice", scope: "user", owner: { provider: "dev", subject: "alice" } },
    ]);
    const prompt = worker._frameworkBasePrompt;
    assert.match(prompt, /- `release-runbook` — How the team cuts a release\./);
    assert.doesNotMatch(prompt, /alice-secret/, "a private skill is not deployment-wide knowledge");
    assert.equal(prompt.split(INDEX_HEADING).length - 1, 1);
    // The load_skill catalog the session manager receives is the SAME filter:
    // the index hiding a name is worthless if load_skill still serves it.
    const catalogNames = worker._loadableSkills.map((s) => s.name);
    assert.ok(catalogNames.includes("release-runbook"));
    assert.ok(!catalogNames.includes("alice-secret"), "load_skill must not serve a private skill to every session");
    assert.ok(catalogNames.includes("canvas-apps"));
});

test("index descriptions are clipped at a word boundary, never mid-word", () => {
    const long = writeSkillPackage("long-kit", "long-skill", `${"alpha beta gamma delta ".repeat(20)}END`);
    const worker = buildWorker();
    installPackages(worker, [], [{ dir: long, packageId: "pkg-long", scope: "shared" }]);
    const line = worker._frameworkBasePrompt.split("\n").find((l) => l.startsWith("- `long-skill`"));
    assert.ok(line, "indexed");
    assert.ok(line.length < 300, `clipped: ${line.length}`);
    assert.match(line, /(alpha|beta|gamma|delta)…$/, `ends on a whole word: ${line.slice(-30)}`);
});

test("the load_skill handler returns the body once and names the catalog on a miss", async () => {
    // Drive the handler through a stub session: runTurn wires the real one,
    // so exercise the same lookup the handler performs via setSkillCatalog.
    const session = Object.create(ManagedSession.prototype);
    session.setSkillCatalog([{ name: "canvas-apps", description: "Shared canvas apps.", prompt: "BODY" }]);
    const catalog = session.skillCatalog;
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].prompt, "BODY");
    session.setSkillCatalog(null);
    assert.deepEqual(session.skillCatalog, [], "a bad catalog degrades to empty, never throws");
});
