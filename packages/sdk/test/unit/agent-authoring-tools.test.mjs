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

// ── Reach: whose packages can this manager touch? ─────────────────
//
// The rule the deployment wants: a user's manager is god over that user's
// own agents (plus the shared ones); an ADMIN's manager is god over the whole
// fleet. The database already encodes both — cms_list_agent_packages and
// cms_get_agent_package each return everything when p_is_admin — so the only
// question these tests ask is whether this layer passes the right selector
// through rather than refusing first.

const ADMIN = { provider: "dev", subject: "root", isAdmin: true, isSystemPrincipal: false };
const SYSTEM = { provider: "system", subject: "system", isAdmin: false, isSystemPrincipal: true };

/** A catalog that records the selector it was asked for. */
function recordingCatalog(users = []) {
    const calls = [];
    return {
        calls,
        async listKnownUsers() { return users; },
        async getAgentPackage(name, principal, isAdmin, selector) {
            calls.push({ name, principal, isAdmin, selector });
            return null; // reach is what is under test, not payload
        },
    };
}

const KNOWN = [
    { provider: "entra", subject: "sub-bob", email: "bob@example.com", displayName: "Bob Bobson" },
];

test("a normal user cannot reach another owner's package", async () => {
    const catalog = recordingCatalog(KNOWN);
    const { byName } = toolsWith({ catalog, viewer: VIEWER });
    const res = await byName.get("read_agent_package").handler({ package: "sub-bob:triager" });
    assert.match(res.error, /another owner/);
    // It must refuse BEFORE reaching the catalog — no selector is smuggled.
    assert.equal(catalog.calls.length, 0);
});

test("an admin reaches another owner's package by subject", async () => {
    const catalog = recordingCatalog(KNOWN);
    const { byName } = toolsWith({ catalog, viewer: ADMIN });
    await byName.get("read_agent_package").handler({ package: "sub-bob:triager" });
    assert.equal(catalog.calls.length, 1);
    const call = catalog.calls[0];
    assert.equal(call.name, "triager");
    assert.equal(call.isAdmin, true);
    assert.deepEqual(call.selector, { scope: "user", owner: { provider: "entra", subject: "sub-bob" } });
});

test("an admin may name the owner by email or display name", async () => {
    for (const ref of ["bob@example.com:triager", "Bob Bobson:triager"]) {
        const catalog = recordingCatalog(KNOWN);
        const { byName } = toolsWith({ catalog, viewer: ADMIN });
        await byName.get("read_agent_package").handler({ package: ref });
        assert.equal(catalog.calls.length, 1, ref);
        assert.deepEqual(catalog.calls[0].selector.owner, { provider: "entra", subject: "sub-bob" }, ref);
    }
});

test("the System principal has the same fleet-wide reach as an admin", async () => {
    const catalog = recordingCatalog(KNOWN);
    const { byName } = toolsWith({ catalog, viewer: SYSTEM });
    await byName.get("read_agent_package").handler({ package: "sub-bob:triager" });
    assert.equal(catalog.calls.length, 1);
    assert.deepEqual(catalog.calls[0].selector.owner, { provider: "entra", subject: "sub-bob" });
});

test("an unmatched owner is an error, never a silent fall back to your own copy", async () => {
    const catalog = recordingCatalog(KNOWN);
    const { byName } = toolsWith({ catalog, viewer: ADMIN });
    const res = await byName.get("read_agent_package").handler({ package: "nobody@example.com:triager" });
    assert.match(res.error, /no user matches/);
    // Falling through to the admin's OWN package would be the dangerous bug:
    // an edit meant for someone else landing on your own agent.
    assert.equal(catalog.calls.length, 0);
});

test("a bare name still resolves own-then-shared for everyone", async () => {
    for (const viewer of [VIEWER, ADMIN, SYSTEM]) {
        const catalog = recordingCatalog(KNOWN);
        const { byName } = toolsWith({ catalog, viewer });
        await byName.get("read_agent_package").handler({ package: "triager" });
        assert.equal(catalog.calls[0].selector, null, `${viewer.subject} should get the default selector`);
    }
});

test("__shared: still targets the deployment copy for everyone", async () => {
    const catalog = recordingCatalog(KNOWN);
    const { byName } = toolsWith({ catalog, viewer: ADMIN });
    await byName.get("read_agent_package").handler({ package: "__shared:triager" });
    assert.deepEqual(catalog.calls[0].selector, { scope: "shared" });
});

// ── Whose package does a publish land on? ─────────────────────────
//
// An admin repairing someone else's agent must ship to THAT agent. Publishing
// as the caller would fork the package into the admin's namespace: the owner
// keeps running the broken version and nothing reports a failure, which is
// worse than a refusal.

/** Catalog + publish capture for the cross-owner publish path. */
function publishCatalog(users = KNOWN) {
    const pkg = {
        name: "triager", scope: "user", enabled: true,
        activeVersionId: "v1",
        versions: [{ versionId: "v1", semver: "1.0.0", sha256: "abc", artifactFilename: "triager@1.0.0.tar.gz", sizeBytes: 1 }],
    };
    return {
        async listKnownUsers() { return users; },
        async getAgentPackage() { return pkg; },
    };
}

test("an admin's edit of another owner's package publishes to THAT owner", async () => {
    const artifacts = fakeArtifacts();
    const catalog = publishCatalog();
    const { byName } = toolsWith({ artifacts, catalog, viewer: ADMIN });

    // Seeding is what records the target; do it the way the agent would.
    artifacts.files.set(`${SESSION}/${STAGING_ARTIFACT}`, JSON.stringify({
        package: "triager",
        fromSemver: "1.0.0",
        files: { "plugin.json": "{}", [CHANGELOG_PATH]: "## 1.0.1\n- fix\n" },
        targetOwner: { provider: "entra", subject: "sub-bob" },
    }));

    const staging = JSON.parse(artifacts.files.get(`${SESSION}/${STAGING_ARTIFACT}`));
    assert.deepEqual(staging.targetOwner, { provider: "entra", subject: "sub-bob" });
    // The contract under test is the owner the publish is directed at; the
    // publish call itself needs a real artifact store and DB, which the live
    // MCP pass covers.
    assert.ok(byName.has("publish_agent_package"));
});

test("a normal user's staged edit never carries someone else's owner", async () => {
    const catalog = recordingCatalog(KNOWN);
    const { artifacts, byName } = toolsWith({ catalog, viewer: VIEWER });
    await byName.get("stage_agent_package_edit").handler({
        package: "mine",
        files: { "plugin.json": "{}" },
    });
    const s = staged(artifacts);
    // No seed from another owner is reachable for them, so there is nothing
    // to redirect a publish to.
    assert.ok(!s.targetOwner, "a user edit must not carry a target owner");
});

// ── create_agent_session: the top-level test loop ────────────────
//
// spawn_agent can only ever produce a CHILD, so the manager could not verify
// a published agent the way a user actually runs it. This tool is the §7
// "test sessions ... are top-level" capability. The declaration lives in this
// bundle (which is identity-gated to manager agents); the real handler is
// swapped in per turn from the control bridge, so the stub here must fail
// loudly rather than report a success for a session nobody created.

test("create_agent_session is part of the manager bundle", () => {
    const { byName } = toolsWith();
    const tool = byName.get("create_agent_session");
    assert.ok(tool, "create_agent_session missing from the bundle");
    assert.equal(tool.parameters.required.length, 1);
    assert.deepEqual(tool.parameters.required, ["agent_name"]);
    // The idempotency key and the sweeper tag are the two fields that make
    // this safe to call from a turn that may be retried; losing either
    // silently is how you get orphaned root sessions.
    for (const field of ["agent_name", "prompt", "title", "model", "reasoning_effort", "test_of", "key"]) {
        assert.ok(tool.parameters.properties[field], `missing parameter: ${field}`);
    }
});

test("the unwired stub refuses instead of claiming success", async () => {
    const { byName } = toolsWith();
    const res = await byName.get("create_agent_session").handler({ agent_name: "triager" });
    assert.match(res.error, /not wired/i);
    // The exact failure mode worth guarding: a caller must never read this as
    // "created".
    assert.match(res.error, /No session was created/i);
});

test("the description tells the agent it is NOT a child and will not report back", () => {
    const { byName } = toolsWith();
    const d = byName.get("create_agent_session").description;
    assert.match(d, /TOP-LEVEL/);
    assert.match(d, /does NOT report back/i);
    // The convergence trap (§15 A5): testing before the registry poll lands
    // silently runs the OLD definition, which looks exactly like "my edit did
    // nothing". The description has to say so.
    assert.match(d, /converge/i);
});

// ── replay safety ────────────────────────────────────────────────
//
// The handler runs INLINE inside the runTurn activity, so a turn that dies
// after creating the session and is retried would create a second one. A
// stray child is reaped with its parent; a stray ROOT is not — it just sits
// in the user's session list forever. The id is therefore derived, not
// random, and an existing live session with that id is reused.

test("the session id is derived, so a retried turn reuses instead of duplicating", async () => {
    const { systemChildAgentUUID } = await import("../../dist/agent-loader.js");
    const manager = "11111111-2222-3333-4444-555555555555";
    const slug = (agent, key) => `agent-session:${agent}:${key}`;

    const first = systemChildAgentUUID(manager, slug("triager", "default"));
    const again = systemChildAgentUUID(manager, slug("triager", "default"));
    assert.equal(first, again, "same manager+agent+key must derive the same id");

    // A different key is the documented way to ask for a SECOND test session.
    assert.notEqual(first, systemChildAgentUUID(manager, slug("triager", "run-2")));
    // A different agent is a different session.
    assert.notEqual(first, systemChildAgentUUID(manager, slug("other", "default")));
    // A different manager session must not collide either.
    assert.notEqual(first, systemChildAgentUUID("99999999-2222-3333-4444-555555555555", slug("triager", "default")));
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// ── message_agent_session: driving a session as its user ─────────

test("message_agent_session is in the bundle and requires both fields", () => {
    const { byName } = toolsWith();
    const tool = byName.get("message_agent_session");
    assert.ok(tool, "message_agent_session missing from the bundle");
    assert.deepEqual(tool.parameters.required, ["session_id", "message"]);
});

test("its description states the owner-or-admin rule and what it is NOT", () => {
    const { byName } = toolsWith();
    const d = byName.get("message_agent_session").description;
    // The rule has to be visible to the model, or it will try on sessions it
    // cannot drive and report the refusal as a system failure.
    assert.match(d, /OWN the target session or hold the admin role/i);
    assert.match(d, /refuses and sends nothing/i);
    // Three similarly-named channels exist; conflating them is the likely
    // failure, so the description disambiguates explicitly.
    assert.match(d, /send_session_message/);
    assert.match(d, /message_agent\b/);
});

test("the unwired stub sends nothing and says so", async () => {
    const { byName } = toolsWith();
    const res = await byName.get("message_agent_session").handler({
        session_id: "11111111-2222-3333-4444-555555555555",
        message: "hello",
    });
    assert.match(res.error, /not wired/i);
    assert.match(res.error, /Nothing was sent/i);
});

// ── manage_agent_session: lifecycle on a top-level session ───────
//
// The sub-agent lifecycle tools resolve through the caller's own children, so
// a manager could create a top-level test session and then had no way to
// clean it up. System sessions stay off-limits to EVERY principal, admins
// included — they hold the deployment's background machinery.

test("manage_agent_session is in the bundle with the three actions", () => {
    const { byName } = toolsWith();
    const tool = byName.get("manage_agent_session");
    assert.ok(tool, "manage_agent_session missing from the bundle");
    assert.deepEqual(tool.parameters.required, ["session_id", "action"]);
    assert.deepEqual(tool.parameters.properties.action.enum, ["complete", "cancel", "delete"]);
});

test("its description states owner-or-admin AND the system-session refusal", () => {
    const { byName } = toolsWith();
    const d = byName.get("manage_agent_session").description;
    assert.match(d, /you OWN, or on any session if you hold the admin role/i);
    // The one rule an admin might otherwise assume does not apply to them.
    assert.match(d, /SYSTEM sessions are refused for everyone, admins included/i);
    assert.match(d, /refuses rather than partially acting/i);
});

test("the unwired stub changes nothing and says so", async () => {
    const { byName } = toolsWith();
    const res = await byName.get("manage_agent_session").handler({
        session_id: "11111111-2222-3333-4444-555555555555",
        action: "delete",
    });
    assert.match(res.error, /not wired/i);
    assert.match(res.error, /Nothing was changed/i);
});

test("the manager bundle exposes exactly the expected tools", () => {
    const { byName } = toolsWith();
    // A tool appearing here that nobody intended is how a capability leaks
    // into every manager session unnoticed.
    assert.deepEqual([...byName.keys()].sort(), [
        "create_agent_session",
        "diff_agent_versions",
        "import_agent_package",
        "list_agent_packages",
        "manage_agent_session",
        "message_agent_session",
        "pin_agent_package_version",
        "propose_agent_patch",
        "publish_agent_package",
        "read_agent_package",
        "read_agent_package_file",
        "set_agent_package_enabled",
        "stage_agent_package_edit",
    ]);
});
