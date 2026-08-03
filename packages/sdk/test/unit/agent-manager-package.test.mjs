/**
 * The shipped agent-manager package: what it promises the user.
 *
 * This bundle is unusually privileged — it reaches every session the account
 * can see, and can delete them. Two things therefore have to survive every
 * future edit to the prompt, and neither is enforceable in code:
 *
 *   1. the splash tells the user the blast radius, on both surfaces;
 *   2. the prompt names the destructive actions and requires a yes first.
 *
 * A prompt is data, so the only way to keep these is to assert on them.
 *
 * Run: node --test test/unit/agent-manager-package.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentFiles } from "../../dist/agent-loader.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const pkgDir = path.join(repoRoot, "agent-packages/agent-manager");
const agent = loadAgentFiles(path.join(pkgDir, "agents"))[0];
const prompt = fs.readFileSync(path.join(pkgDir, "agents/agent-manager.agent.md"), "utf8");

test("the package and agent parse at all", () => {
    assert.ok(agent, "agent-manager.agent.md did not load");
    assert.equal(agent.name, "agent-manager");
    // The description must be real prose, not the YAML block-scalar marker
    // that shipped in 1.0.0 and read as "|" in every picker.
    assert.notEqual(agent.description?.trim(), "|");
    assert.ok((agent.description || "").length > 40, "description looks truncated");
});

test("the desktop splash warns about session reach", () => {
    const splash = agent.splash || "";
    assert.match(splash, /REACH EVERY SESSION/i);
    assert.match(splash, /cancel/i);
    assert.match(splash, /delete/i);
    assert.match(splash, /asks before anything destructive/i);
});

test("the mobile splash carries the same warning", () => {
    // The phone is where someone is most likely to fire a destructive action
    // without reading carefully, so it must not be the surface that omits it.
    const splash = agent.splashMobile || "";
    assert.match(splash, /REACHES EVERY SESSION/i);
    assert.match(splash, /destructive/i);
});

test("the splash box is aligned once colour tags are stripped", () => {
    // A ragged warning box reads as a rendering bug and undermines the
    // warning it is carrying.
    // Scope to the warning box: the ASCII-art letterforms also contain ║.
    const stripped = (agent.splash || "").split("\n").map((l) => l.replace(/\{[^}]*\}/g, ""));
    // Anchor on the long ═ runs: the letterforms use ╔ and ╚ too, just never
    // ten of them in a row.
    const top = stripped.findIndex((l) => /╔═{10,}╗/.test(l));
    const bottom = stripped.findIndex((l) => /╚═{10,}╝/.test(l));
    assert.ok(top >= 0 && bottom > top, "warning box not found in the splash");
    const boxLines = stripped.slice(top, bottom + 1);
    assert.ok(boxLines.length >= 5, "warning box not found in the splash");
    const widths = new Set(boxLines.map((l) => [...l].length));
    assert.equal(widths.size, 1, `warning box lines differ in width: ${[...widths].join(", ")}`);
});

test("the prompt requires approval before destructive actions", () => {
    assert.match(prompt, /ASK BEFORE ANYTHING DESTRUCTIVE/);
    // Every destructive tool has to be named, or the model will reason by
    // analogy about the ones that are missing.
    for (const tool of [
        "manage_agent_session",
        "message_agent_session",
        "set_agent_package_enabled",
        "pin_agent_package_version",
        "publish_agent_package",
    ]) {
        assert.ok(prompt.includes(tool), `destructive-action table omits ${tool}`);
    }
});

test("the prompt forbids acting first and asking later", () => {
    assert.match(prompt, /Ask, then stop/);
    assert.match(prompt, /Do not call the tool in the same turn you asked in/);
    // Unattended runs are the case where "nobody objected" is most tempting.
    assert.match(prompt, /nobody said no.{0,30}not consent/is);
});

test("the prompt still keeps reads free", () => {
    // Over-gating is its own failure: an agent that asks permission to read
    // is useless for diagnosis.
    assert.match(prompt, /Reading is always fine/i);
});

test("declared tools match the tools the bundle actually provides", () => {
    // A declared-but-nonexistent tool is invisible-to-the-model dead weight;
    // the reverse is a capability nobody reviewed.
    for (const tool of ["create_agent_session", "message_agent_session", "manage_agent_session"]) {
        assert.ok(agent.tools?.includes(tool), `frontmatter does not declare ${tool}`);
    }
});

test("the package ships a CHANGELOG with an entry for its current version", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "plugin.json"), "utf8"));
    const changelog = fs.readFileSync(path.join(pkgDir, "CHANGELOG.md"), "utf8");
    assert.ok(
        changelog.includes(`## ${manifest.version}`),
        `CHANGELOG.md has no entry for ${manifest.version}`,
    );
});
