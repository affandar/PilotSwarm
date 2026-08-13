/**
 * Portal-surface agent-package ops — NodeSdkTransport layer, live PG.
 *
 * Exercises exactly what the /api/v1 dispatcher calls: inline-files upload
 * through the one publish pipeline, the baked+registry catalog union with
 * viewer scoping, the create-time user-scope gate, workspace tree/file
 * preview, reserved-name enforcement against the SDK's bundled agents, and
 * delete. No express server needed — runtime.call() arms are one-line
 * delegations to these methods.
 *
 * Run: npx vitest run test/local/agent-package-portal-ops.test.js
 */

import { describe, it } from "vitest";
import * as path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { NodeSdkTransport } from "../../../app/tui/src/node-sdk-transport.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

const ALICE = { provider: "test", subject: "portal-alice", email: "alice@test" };
const BOB = { provider: "test", subject: "portal-bob", email: "bob@test" };

function b64(text) {
    return Buffer.from(text, "utf8").toString("base64");
}

function fixtureFiles({ name = "portal-kit", version = "1.0.0", agentName = "portal-triager" } = {}) {
    return [
        { path: "plugin.json", contentBase64: b64(JSON.stringify({ name, version, description: "portal fixture" })) },
        {
            path: `agents/${agentName}.agent.md`,
            contentBase64: b64([
                "---", `name: ${agentName}`, "description: Portal fixture agent",
                "schemaVersion: 1", `version: ${version}`, "---", "", "You are the portal fixture.",
            ].join("\n")),
        },
        { path: "skills/pfx/SKILL.md", contentBase64: b64("---\nname: pfx\ndescription: pfx\n---\n\nKnow things.") },
    ];
}

async function makeTransport(env) {
    process.env.PILOTSWARM_CMS_SCHEMA = env.cmsSchema;
    process.env.ARTIFACT_DIR = path.join(env.baseDir, "portal-artifacts");
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    delete process.env.AZURE_STORAGE_ACCOUNT_URL;
    const transport = new NodeSdkTransport({ store: env.store, mode: "remote" });
    return transport;
}

async function closeTransport(transport) {
    if (transport._agentPkgCatalog) await transport._agentPkgCatalog.close();
}

describe("agent-package portal ops", () => {
    it("upload → union catalog → user-scope gate → workspace → delete", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const transport = await makeTransport(env);
        try {
            // ── Upload publishes through the one pipeline ────────────
            const outcome = await transport.uploadAgentPackage(fixtureFiles(), "user", ALICE, false);
            assertEqual(outcome.status, "published");
            assertEqual(outcome.name, "portal-kit");
            assertEqual(outcome.semver, "1.0.0");

            // ── Catalog union is viewer-scoped ───────────────────────
            const aliceView = await transport.listCreatableAgents(ALICE, false);
            const aliceEntry = aliceView.find((a) => a.name === "portal-triager");
            assert(aliceEntry, "owner sees their user-scope package agent");
            assertEqual(aliceEntry.source, "package");
            assertEqual(aliceEntry.packageName, "portal-kit");
            assertEqual(aliceEntry.packageSemver, "1.0.0");
            assertEqual(aliceEntry.scope, "user");

            const bobView = await transport.listCreatableAgents(BOB, false);
            assert(!bobView.some((a) => a.name === "portal-triager"),
                "stranger must NOT see a foreign user-scope agent");

            // ── Create-time gate ─────────────────────────────────────
            await transport._authorizePackageAgentCreate("portal-triager", ALICE, false); // no throw
            let denied = null;
            try {
                await transport._authorizePackageAgentCreate("portal-triager", BOB, false);
            } catch (error) { denied = error; }
            assertEqual(denied?.code, "FORBIDDEN", "stranger create is FORBIDDEN");

            // ── Promote → visible to everyone ────────────────────────
            await transport.setAgentPackageScope("portal-kit", "shared", ALICE, false);
            const bobAfter = await transport.listCreatableAgents(BOB, false);
            assert(bobAfter.some((a) => a.name === "portal-triager"), "promoted agent is visible to all");
            await transport._authorizePackageAgentCreate("portal-triager", BOB, false); // now passes

            // ── Workspace viewer ─────────────────────────────────────
            const tree = await transport.getAgentPackageTree("portal-kit", null, ALICE, false);
            assertEqual(tree.semver, "1.0.0");
            assert(tree.dirs.includes("agents") && tree.dirs.includes("skills/pfx"), "tree lists directories");
            assert(tree.files.some((f) => f.path === "agents/portal-triager.agent.md"), "tree lists files");

            const file = await transport.getAgentPackageFile("portal-kit", null, "agents/portal-triager.agent.md", ALICE, false);
            assertEqual(file.encoding, "utf8");
            assert(file.content.includes("You are the portal fixture."), "preview returns file content");
            assertEqual(file.truncated, false);

            let missing = null;
            try {
                await transport.getAgentPackageFile("portal-kit", null, "nope.txt", ALICE, false);
            } catch (error) { missing = error; }
            assertEqual(missing?.code, "NOT_FOUND");

            // ── Delete removes everything ────────────────────────────
            await transport.deleteAgentPackage("portal-kit", ALICE, false);
            const gone = await transport.listCreatableAgents(ALICE, false);
            assert(!gone.some((a) => a.name === "portal-triager"), "deleted package leaves the union");
        } finally {
            await closeTransport(transport);
        }
    });

    it("scope shadowing: selectors target the named copy; republish updates an existing shared package; publish-to-shared never no-ops against the user copy", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const transport = await makeTransport(env);
        const NAME = "shadow-pair";
        const files = (version) => fixtureFiles({ name: NAME, version, agentName: "shadow-analyst" });
        try {
            // Alice keeps a private copy AND a shared copy under ONE name.
            const userOut = await transport.uploadAgentPackage(files("1.0.0"), "user", ALICE, false);
            assertEqual(userOut.status, "published");

            // Publishing the IDENTICAL bytes to shared must create the shared
            // package — the old name-only pre-check resolved Alice's user copy,
            // saw the same semver+sha there, and silently reported "noop"
            // without ever touching shared scope.
            const sharedOut = await transport.uploadAgentPackage(files("1.0.0"), "shared", ALICE, false);
            assertEqual(sharedOut.status, "published", "publish-to-shared must not dedup against the user copy");
            // Both copies now declare the same agent name — the publisher says so.
            assert((sharedOut.warnings ?? []).some((w) => w.code === "AGENT_NAME_COLLISION"),
                "same agent name across enabled copies must surface an AGENT_NAME_COLLISION warning");

            // Republishing identical bytes into the SAME scope is still a noop.
            const idempotent = await transport.uploadAgentPackage(files("1.0.0"), "shared", ALICE, false);
            assertEqual(idempotent.status, "noop");

            // The user copy moves ahead; the shared one stays put.
            await transport.uploadAgentPackage(files("1.1.0"), "user", ALICE, false);
            const userCopy = await transport.getAgentPackage(NAME, ALICE, false, { scope: "user" });
            const sharedCopy = await transport.getAgentPackage(NAME, ALICE, false, { scope: "shared" });
            assertEqual(userCopy.scope, "user");
            assertEqual(sharedCopy.scope, "shared");
            assertEqual(userCopy.versions.length, 2, "user copy has 1.0.0 + 1.1.0");
            assertEqual(sharedCopy.versions.length, 1, "shared history is its own, not the user copy's");
            // Bare-name resolution still walks own-copy-first for the owner.
            const bare = await transport.getAgentPackage(NAME, ALICE, false);
            assertEqual(bare.scope, "user");

            // Promote cannot update an existing shared package — that is what
            // republish is for.
            let taken = null;
            try {
                await transport.setAgentPackageScope(NAME, "shared", ALICE, false);
            } catch (error) { taken = error; }
            assert(String(taken?.message).includes("AGENT_PACKAGE_NAME_TAKEN"),
                "promote against an existing shared name must fail legibly");

            // Republish: the tested user version becomes a new version of the
            // EXISTING shared package, exact bytes.
            const republished = await transport.republishAgentPackageVersion(NAME, "1.1.0", "shared", ALICE, false);
            assertEqual(republished.status, "published");
            const sharedAfter = await transport.getAgentPackage(NAME, ALICE, false, { scope: "shared" });
            assertEqual(sharedAfter.versions.length, 2, "shared package gained 1.1.0");
            const sharedActive = sharedAfter.versions.find((v) => v.versionId === sharedAfter.activeVersionId);
            assertEqual(sharedActive.semver, "1.1.0");
            // Idempotent: same bytes again → noop, not a conflict.
            const again = await transport.republishAgentPackageVersion(NAME, "1.1.0", "shared", ALICE, false);
            assertEqual(again.status, "noop");

            // Pin with a scope selector moves the SHARED pointer and leaves
            // the user copy alone — the console-rollback bug this fixes.
            await transport.pinAgentPackageVersion(NAME, "1.0.0", ALICE, false, { scope: "shared" });
            const sharedPinned = await transport.getAgentPackage(NAME, ALICE, false, { scope: "shared" });
            const sharedPinnedActive = sharedPinned.versions.find((v) => v.versionId === sharedPinned.activeVersionId);
            assertEqual(sharedPinnedActive.semver, "1.0.0", "shared rolled back to 1.0.0");
            const userAfterPin = await transport.getAgentPackage(NAME, ALICE, false, { scope: "user" });
            const userActive = userAfterPin.versions.find((v) => v.versionId === userAfterPin.activeVersionId);
            assertEqual(userActive.semver, "1.1.0", "user copy pin unaffected");

            // A DISABLED user copy must not capture name-only mutations made
            // through the selector path either: pin the shared copy while the
            // user copy is disabled.
            await transport.setAgentPackageEnabled(NAME, false, ALICE, false, { scope: "user" });
            await transport.pinAgentPackageVersion(NAME, "1.1.0", ALICE, false, { scope: "shared" });
            const sharedRepinned = await transport.getAgentPackage(NAME, ALICE, false, { scope: "shared" });
            assertEqual(
                sharedRepinned.versions.find((v) => v.versionId === sharedRepinned.activeVersionId).semver,
                "1.1.0",
            );

            // Delete ONLY the selected copy — and the shared copy's BYTES must
            // survive. user 1.1.0 and shared 1.1.0 are identical bytes → one
            // content-addressed blob; the pre-fix delete returned that filename
            // and destroyed it, quarantining the shared package fleet-wide.
            await transport.deleteAgentPackage(NAME, ALICE, false, { scope: "user" });
            const sharedSurvives = await transport.getAgentPackage(NAME, ALICE, false, { scope: "shared" });
            assert(sharedSurvives, "deleting the user copy must not touch the shared package");
            const userGone = await transport.getAgentPackage(NAME, ALICE, false, { scope: "user" });
            assert(!userGone, "user copy deleted");
            // The shared active version's blob must still be FETCHABLE — the
            // registry row surviving is not enough; the bytes must be there.
            const sharedActiveVer = sharedAfter.versions.find((v) => v.versionId === sharedAfter.activeVersionId);
            const file = await transport.getAgentPackageFile(NAME, sharedActiveVer.semver, "plugin.json", ALICE, false, { scope: "shared" });
            assert(file?.content?.includes(`"${NAME}"`), "shared blob is intact and fetchable after the user copy was deleted");

            await transport.deleteAgentPackage(NAME, ALICE, false, { scope: "shared" });
        } finally {
            await closeTransport(transport);
        }
    });

    it("upload rejects invalid packages, unsafe paths, and reserved names", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const transport = await makeTransport(env);
        try {
            // Invalid semver → structured validation failure.
            let invalid = null;
            try {
                await transport.uploadAgentPackage(
                    fixtureFiles({ name: "bad-kit", version: "not-semver" }), "user", ALICE, false);
            } catch (error) { invalid = error; }
            assertEqual(invalid?.code, "VALIDATION_FAILED");
            assert(invalid.validation.errors.some((e) => e.code === "invalid_version"));

            // Path traversal in the upload envelope.
            let traversal = null;
            try {
                await transport.uploadAgentPackage(
                    [{ path: "../evil.md", contentBase64: b64("x") }], "user", ALICE, false);
            } catch (error) { traversal = error; }
            assert(String(traversal?.message).includes("not a safe relative path"));

            // Shadowing a bundled agent (sweeper) — end-to-end through
            // listBundledAgentNames, including a fuzzy spelling.
            let reserved = null;
            try {
                await transport.uploadAgentPackage(
                    fixtureFiles({ name: "shadow-kit", version: "1.0.0", agentName: "Swee-per" }),
                    "user", ALICE, false);
            } catch (error) { reserved = error; }
            assertEqual(reserved?.code, "VALIDATION_FAILED");
            assert(reserved.validation.errors.some((e) => e.code === "reserved_agent_name"),
                "fuzzy sweeper spelling must be rejected");
        } finally {
            await closeTransport(transport);
        }
    });
});
