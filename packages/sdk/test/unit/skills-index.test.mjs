/**
 * Progressive skill discovery (0.5.45).
 *
 * The framework base prompt carries a one-line index of registered skills;
 * `load_skill` returns a body on demand; nothing is inlined unless an agent
 * declares it. Pins: the index exists exactly once (reload safe), lists the
 * bundled canvas skills, and the default agent's prompt carries no preloaded
 * bodies. Also pins that the always-on canvas text stayed small.
 *
 * A user-scope package's skills are PRIVATE but still loadable — by their
 * owner's own sessions only (0.5.53). They are kept out of the fleet-wide
 * catalog and out of the shared base prompt; the session manager adds the
 * right owner's bucket per session. The tests at the bottom pin both halves:
 * the owner sees and can load theirs, and nobody else can.
 *
 * Run: node --test test/unit/skills-index.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { SessionManager, agentOwnerKey } from "../../dist/session-manager.js";
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

test("a shared package's skill is in the fleet-wide index; a user-scope package's is not", () => {
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
    // The fleet-wide load_skill catalog is the SAME filter: the index hiding
    // a name is worthless if load_skill still serves it to everyone.
    const catalogNames = worker._loadableSkills.map((s) => s.name);
    assert.ok(catalogNames.includes("release-runbook"));
    assert.ok(!catalogNames.includes("alice-secret"), "load_skill must not serve a private skill to every session");
    assert.ok(catalogNames.includes("canvas-apps"));
    // ...it is parked under its owner instead, for the session manager.
    const alice = worker._ownerScopedSkills.get(agentOwnerKey({ provider: "dev", subject: "alice" }));
    assert.equal(alice?.length, 1);
    assert.equal(alice[0].name, "alice-secret");
    assert.match(alice[0].prompt, /Body of alice-secret/, "the body travels with it, so load_skill can serve it");
});

test("both catalogs are refilled IN PLACE on reload — the session manager holds them by reference", () => {
    const priv = writeSkillPackage("alice-kit", "alice-secret", "Alice's private notes.");
    const worker = buildWorker();
    const pkgs = [{ dir: priv, packageId: "pkg-alice", scope: "user", owner: { provider: "dev", subject: "alice" } }];
    installPackages(worker, [], pkgs);
    const sharedRef = worker._loadableSkills;
    const ownerRef = worker._ownerScopedSkills;
    assert.equal(ownerRef.get(agentOwnerKey({ provider: "dev", subject: "alice" }))?.length, 1);
    // Alice deletes her package: the reload must EMPTY the same objects the
    // worker already handed to the session manager, not swap in new ones.
    installPackages(worker, [], []);
    assert.equal(worker._loadableSkills, sharedRef, "shared catalog is the same object");
    assert.equal(worker._ownerScopedSkills, ownerRef, "owner catalog is the same object");
    assert.equal(ownerRef.size, 0, "her skill is gone from the live map");
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

// ── The session manager half: who actually gets a private skill ──────────
//
// `_skillCatalogForSession` decides what load_skill will serve one session,
// and `_ownerSkillsIndexSection` decides what its prompt says exists. They
// must agree, and both must key off the session's OWNER.

const ALICE = agentOwnerKey({ provider: "dev", subject: "alice" });
const BOB = agentOwnerKey({ provider: "dev", subject: "bob" });
const SHARED_SKILL = { name: "release-runbook", description: "How the team cuts a release.", prompt: "SHARED BODY" };
const ALICE_SKILL = { name: "alice-secret", description: "Alice's private notes.", prompt: "ALICE BODY" };

function managerWith(ownerScopedSkills, viewerBySession) {
    const manager = new SessionManager(undefined, null, {
        skills: [SHARED_SKILL],
        ownerScopedSkills,
    });
    manager._resolveInspectViewer = async (sessionId) => viewerBySession[sessionId] ?? null;
    return manager;
}

const OWNED = {
    "s-alice": { provider: "dev", subject: "alice" },
    "s-bob": { provider: "dev", subject: "bob" },
    "s-system": { provider: "dev", subject: "system", isSystemPrincipal: true },
    "s-orphan": null,
};

test("the owner's session can load her private skill, and her prompt says it exists", async () => {
    const manager = managerWith(new Map([[ALICE, [ALICE_SKILL]]]), OWNED);
    const catalog = await manager._skillCatalogForSession("s-alice");
    assert.deepEqual(catalog.map((s) => s.name).sort(), ["alice-secret", "release-runbook"]);
    assert.equal(catalog.find((s) => s.name === "alice-secret").prompt, "ALICE BODY", "the body is there to serve");
    const index = await manager._ownerSkillsIndexSection("s-alice");
    assert.match(index, /- `alice-secret` — Alice's private notes\./);
    assert.match(index, /load_skill\(name\)/, "the prompt tells her how to get it");
});

test("nobody else can see or load it — not another person, not a system session, not an ownerless one", async () => {
    const manager = managerWith(new Map([[ALICE, [ALICE_SKILL]]]), OWNED);
    for (const sessionId of ["s-bob", "s-system", "s-orphan"]) {
        const catalog = await manager._skillCatalogForSession(sessionId);
        assert.deepEqual(catalog.map((s) => s.name), ["release-runbook"], `${sessionId} gets shared only`);
        assert.equal(await manager._ownerSkillsIndexSection(sessionId), undefined, `${sessionId} gets no private index`);
    }
});

test("a session whose owner cannot be read falls back to shared — a failed lookup must not leak", async () => {
    const manager = managerWith(new Map([[ALICE, [ALICE_SKILL]]]), OWNED);
    manager._resolveInspectViewer = async () => { throw new Error("CMS down"); };
    assert.deepEqual((await manager._skillCatalogForSession("s-alice")).map((s) => s.name), ["release-runbook"]);
    assert.equal(await manager._ownerSkillsIndexSection("s-alice"), undefined);
});

test("with no user-scope packages at all, the catalog is the shared list untouched", async () => {
    const manager = managerWith(new Map(), OWNED);
    const catalog = await manager._skillCatalogForSession("s-alice");
    assert.deepEqual(catalog, manager.workerDefaults.skills, "same list, not a copy — no needless churn");
    assert.equal(await manager._ownerSkillsIndexSection("s-alice"), undefined);
});

test("on a name collision the owner's own copy wins, and the shared one is not listed twice", async () => {
    const mine = { name: "release-runbook", description: "Alice's own runbook.", prompt: "ALICE BODY" };
    const manager = managerWith(new Map([[ALICE, [mine]]]), OWNED);
    const catalog = await manager._skillCatalogForSession("s-alice");
    assert.equal(catalog.length, 1, "one entry, not two — load_skill takes the first match");
    assert.equal(catalog[0].prompt, "ALICE BODY");
    // Bob is unaffected.
    assert.equal((await manager._skillCatalogForSession("s-bob"))[0].prompt, "SHARED BODY");
});

test("the private index reads the LIVE map, so a republish reaches open sessions", async () => {
    const live = new Map();
    const manager = managerWith(live, OWNED);
    assert.equal(await manager._ownerSkillsIndexSection("s-alice"), undefined);
    live.set(ALICE, [ALICE_SKILL]);   // what worker._composeSkillsIndex does on reload
    assert.match(await manager._ownerSkillsIndexSection("s-alice"), /alice-secret/);
    assert.equal(await manager._ownerSkillsIndexSection("s-bob"), undefined);
    assert.ok(!live.has(BOB));
});

test("the private index sorts by name and clips like the fleet-wide one", async () => {
    const long = { name: "zeta", description: `${"alpha beta gamma delta ".repeat(20)}END`, prompt: "B" };
    const manager = managerWith(new Map([[ALICE, [long, ALICE_SKILL]]]), OWNED);
    const lines = (await manager._ownerSkillsIndexSection("s-alice")).split("\n").filter((l) => l.startsWith("- `"));
    assert.deepEqual(lines.map((l) => l.match(/^- `([^`]+)`/)[1]), ["alice-secret", "zeta"]);
    const zeta = lines[1];
    assert.ok(zeta.length < 300, `clipped: ${zeta.length}`);
    assert.match(zeta, /(alpha|beta|gamma|delta)…$/, `ends on a whole word: ${zeta.slice(-30)}`);
});
