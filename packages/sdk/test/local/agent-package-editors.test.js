/**
 * Agent-package editors (migration 0063) — procs only, no LLM turns.
 *
 * An editor is a named user with WRITE access to a SHARED package: publish
 * new versions, pin, enable/disable. Not scope changes, not delete, not the
 * editor list. Demoting the package to user scope deletes every grant.
 *
 * Also pins the picker change that ships in the same migration:
 * cms_list_users shows a user with an email and no display name.
 *
 * Run: npx vitest run test/local/agent-package-editors.test.js
 */

import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

const OWNER = { provider: "test", subject: "ed-owner" };
const EDITOR = { provider: "test", subject: "ed-editor" };
const STRANGER = { provider: "test", subject: "ed-stranger" };

function manifestFor(name, version) {
    return {
        name, version,
        description: "test package",
        agents: [{ name: `${name}-agent`, description: "an agent" }],
        skills: [], mcpServers: [], hasTools: false, fileCount: 2, rawBytes: 128,
    };
}

function publishInput(name, semver, overrides = {}) {
    return {
        name,
        scope: "shared",
        owner: OWNER,
        sourceId: null,
        semver,
        sha256: `sha-${name}-${semver}`,
        sizeBytes: 1024,
        artifactFilename: `${name}@${semver}.abc.tar.gz`,
        commitSha: null,
        manifest: manifestFor(name, semver),
        createdBy: "ed-owner@test",
        isAdmin: false,
        ...overrides,
    };
}

async function expectRegistryError(promise, marker) {
    try {
        await promise;
    } catch (error) {
        assert(String(error?.message ?? error).includes(marker),
            `expected error containing ${marker}, got: ${error?.message ?? error}`);
        return;
    }
    throw new Error(`expected an error containing ${marker}, but the call succeeded`);
}

/** Sorted, comma-joined editor subjects — a string, so assertEqual can compare it. */
async function editorSubjects(catalog, name) {
    return (await catalog.listAgentPackageEditors(name)).map((e) => e.subject).sort().join(",");
}
const subjectsOf = (...principals) => principals.map((p) => p.subject).sort().join(",");

describe("agent-package editors", () => {
    it("grant rules: shared copy only, never the owner, owner-or-admin grants", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            // A package that exists only as the actor's PRIVATE copy: the
            // answer is "not shared", never "does not exist" — the owner is
            // looking right at it. A stranger, who cannot see it, gets
            // NOT_FOUND (no existence oracle).
            const privateName = `ed-private-${env.runId}`;
            await catalog.publishAgentPackage(publishInput(privateName, "1.0.0", { scope: "user" }));
            await expectRegistryError(
                catalog.grantAgentPackageEditor(privateName, EDITOR, OWNER, false),
                "AGENT_PACKAGE_NOT_SHARED",
            );
            await expectRegistryError(
                catalog.grantAgentPackageEditor(privateName, EDITOR, { provider: "test", subject: "ed-admin" }, true),
                "AGENT_PACKAGE_NOT_SHARED",
            );
            await expectRegistryError(
                catalog.grantAgentPackageEditor(privateName, EDITOR, STRANGER, false),
                "AGENT_PACKAGE_NOT_FOUND",
            );
            await expectRegistryError(
                catalog.revokeAgentPackageEditor(privateName, EDITOR, OWNER, false),
                "AGENT_PACKAGE_NOT_SHARED",
            );
            await expectRegistryError(
                catalog.listAgentPackageEditors(`ed-nope-${env.runId}`),
                "AGENT_PACKAGE_NOT_FOUND",
            );

            const name = `ed-grant-${env.runId}`;
            await catalog.publishAgentPackage(publishInput(name, "1.0.0"));

            await expectRegistryError(
                catalog.grantAgentPackageEditor(name, OWNER, OWNER, false),
                "AGENT_PACKAGE_EDITOR_IS_OWNER",
            );
            await expectRegistryError(
                catalog.grantAgentPackageEditor(name, EDITOR, STRANGER, false),
                "AGENT_PACKAGE_FORBIDDEN",
            );

            await catalog.grantAgentPackageEditor(name, EDITOR, OWNER, false);
            await catalog.grantAgentPackageEditor(name, EDITOR, OWNER, false); // idempotent
            assertEqual(await editorSubjects(catalog, name), subjectsOf(EDITOR));

            // An admin who owns nothing here can grant and revoke too.
            await catalog.grantAgentPackageEditor(name, STRANGER, { provider: "test", subject: "ed-admin" }, true);
            assertEqual(await editorSubjects(catalog, name), subjectsOf(EDITOR, STRANGER));
            await catalog.revokeAgentPackageEditor(name, STRANGER, { provider: "test", subject: "ed-admin" }, true);
            assertEqual(await editorSubjects(catalog, name), subjectsOf(EDITOR));

            // Editors cannot manage the editor list.
            await expectRegistryError(
                catalog.grantAgentPackageEditor(name, STRANGER, EDITOR, false),
                "AGENT_PACKAGE_FORBIDDEN",
            );
            await expectRegistryError(
                catalog.revokeAgentPackageEditor(name, EDITOR, EDITOR, false),
                "AGENT_PACKAGE_FORBIDDEN",
            );
        } finally {
            await catalog.close?.();
        }
    });

    it("editor may publish, pin and enable; may not demote or delete; stranger may do none", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `ed-rights-${env.runId}`;
            const first = await catalog.publishAgentPackage(publishInput(name, "1.0.0"));
            await catalog.grantAgentPackageEditor(name, EDITOR, OWNER, false);

            // Before: a non-editor is refused exactly as before.
            await expectRegistryError(
                catalog.publishAgentPackage(publishInput(name, "1.1.0", { owner: STRANGER })),
                "AGENT_PACKAGE_FORBIDDEN",
            );
            await expectRegistryError(catalog.pinAgentPackageVersion(name, "1.0.0", STRANGER, false, { scope: "shared" }), "AGENT_PACKAGE_FORBIDDEN");
            await expectRegistryError(catalog.setAgentPackageEnabled(name, false, STRANGER, false, { scope: "shared" }), "AGENT_PACKAGE_FORBIDDEN");

            // Editor publishes a new version INTO the shared package. The row
            // keeps its owner and the editor's identity is on the version.
            const pushed = await catalog.publishAgentPackage(
                publishInput(name, "1.1.0", { owner: EDITOR, createdBy: "ed-editor@test" }),
            );
            assertEqual(pushed.status, "published");
            assertEqual(pushed.packageId, first.packageId, "editor publish lands in the SAME package");
            const detail = await catalog.getAgentPackage(name, EDITOR, false, { scope: "shared" });
            assertEqual(detail.owner.subject, OWNER.subject, "owner unchanged by an editor publish");
            assertEqual(detail.versions.length, 2);
            assertEqual(detail.canEdit, true);
            assertEqual(detail.versions.find((v) => v.semver === "1.1.0").createdBy, "ed-editor@test");

            // Editor pins and toggles; selector-less works too (editors own
            // no copy, so the bare name falls through to shared).
            await catalog.pinAgentPackageVersion(name, "1.0.0", EDITOR, false, { scope: "shared" });
            await catalog.setAgentPackageEnabled(name, false, EDITOR, false);
            await catalog.setAgentPackageEnabled(name, true, EDITOR, false);
            const pinned = await catalog.getAgentPackage(name, EDITOR, false, { scope: "shared" });
            assertEqual(pinned.versions.find((v) => v.versionId === pinned.activeVersionId).semver, "1.0.0");

            // Editor may NOT change scope or delete.
            await expectRegistryError(catalog.setAgentPackageScope(name, "user", EDITOR, false, { scope: "shared" }), "AGENT_PACKAGE_FORBIDDEN");
            await expectRegistryError(catalog.deleteAgentPackage(name, EDITOR, false, { scope: "shared" }), "AGENT_PACKAGE_FORBIDDEN");
            assert((await catalog.getAgentPackage(name, OWNER, false, { scope: "shared" })) != null, "package survived the refused delete");

            // A user-scope copy of the same name is a DIFFERENT package: the
            // grant on the shared copy gives nothing there.
            await catalog.publishAgentPackage(publishInput(name, "9.0.0", { scope: "user", owner: STRANGER }));
            await expectRegistryError(
                catalog.pinAgentPackageVersion(name, "9.0.0", EDITOR, false, { scope: "user", owner: STRANGER }),
                "AGENT_PACKAGE_FORBIDDEN",
            );
        } finally {
            await catalog.close?.();
        }
    });

    it("demotion revokes every editor; a failed demotion keeps them; re-promotion starts empty", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `ed-demote-${env.runId}`;
            await catalog.publishAgentPackage(publishInput(name, "1.0.0"));
            await catalog.grantAgentPackageEditor(name, EDITOR, OWNER, false);
            await catalog.grantAgentPackageEditor(name, STRANGER, OWNER, false);
            assertEqual(await editorSubjects(catalog, name), subjectsOf(EDITOR, STRANGER));

            // Owner already holds a user copy → demotion collides and FAILS;
            // the grants must be exactly as they were.
            await catalog.publishAgentPackage(publishInput(name, "0.1.0", { scope: "user" }));
            await expectRegistryError(
                catalog.setAgentPackageScope(name, "user", OWNER, false, { scope: "shared" }),
                "AGENT_PACKAGE_NAME_TAKEN",
            );
            assertEqual(await editorSubjects(catalog, name), subjectsOf(EDITOR, STRANGER), "failed demotion left the grants alone");

            // Clear the collision, demote for real → grants gone.
            await catalog.deleteAgentPackage(name, OWNER, false, { scope: "user" });
            await catalog.setAgentPackageScope(name, "user", OWNER, false, { scope: "shared" });
            // No shared copy any more: the editor list is NOT_FOUND, not
            // "empty" — and the rows themselves are gone (re-promote below
            // proves it: it starts with zero editors).
            await expectRegistryError(catalog.listAgentPackageEditors(name), "AGENT_PACKAGE_NOT_FOUND");
            const demoted = await catalog.getAgentPackage(name, EDITOR, false, { owner: OWNER });
            assertEqual(demoted, null, "the former editor cannot even see the private copy");

            // Re-share: nobody is an editor until granted again.
            await catalog.setAgentPackageScope(name, "shared", OWNER, false);
            assertEqual(await editorSubjects(catalog, name), "");
            await expectRegistryError(
                catalog.pinAgentPackageVersion(name, "1.0.0", EDITOR, false, { scope: "shared" }),
                "AGENT_PACKAGE_FORBIDDEN",
            );
        } finally {
            await catalog.close?.();
        }
    });

    it("reads carry can_edit; grant and revoke never bump the registry epoch", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `ed-reads-${env.runId}`;
            await catalog.publishAgentPackage(publishInput(name, "1.0.0"));

            const before = await catalog.agentRegistryEpoch();
            await catalog.grantAgentPackageEditor(name, EDITOR, OWNER, false);
            await catalog.revokeAgentPackageEditor(name, STRANGER, OWNER, false);
            assertEqual(await catalog.agentRegistryEpoch(), before, "who may edit is not something a worker installs");

            const asEditor = (await catalog.listAgentPackages(EDITOR, false)).find((p) => p.name === name);
            const asStranger = (await catalog.listAgentPackages(STRANGER, false)).find((p) => p.name === name);
            const asOwner = (await catalog.listAgentPackages(OWNER, false)).find((p) => p.name === name);
            assertEqual(asEditor.canEdit, true);
            assertEqual(asStranger.canEdit, false);
            assertEqual(asOwner.canEdit, true);

            const strangerDetail = await catalog.getAgentPackage(name, STRANGER, false);
            assertEqual(strangerDetail.canEdit, false);
            assertEqual(strangerDetail.editors.map((e) => e.subject).join(","), subjectsOf(EDITOR), "the editor list is visible to any viewer of a shared package");
        } finally {
            await catalog.close?.();
        }
    });

    it("picker: a never-seen grantee stays hidden; a user with an email and no name is shown", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `ed-picker-${env.runId}`;
            await catalog.publishAgentPackage(publishInput(name, "1.0.0"));
            const ghost = { provider: "test", subject: `ed-ghost-${env.runId}` };
            await catalog.grantAgentPackageEditor(name, ghost, OWNER, false);

            const subjects = () => catalog.listKnownUsers({ limit: 2000 }).then((rows) => rows.map((u) => u.subject));
            assert(!(await subjects()).includes(ghost.subject), "a raw-id grantee with no name and no email is not in the directory");

            // The ghost signs in with a token that carries an email but no
            // name — the case the old filter hid forever.
            await catalog.setUserRole({ ...ghost, email: "ghost@example.test", displayName: null }, "user");
            assert((await subjects()).includes(ghost.subject), "email alone makes a signed-in user findable");
        } finally {
            await catalog.close?.();
        }
    });

    it("an editor grant keyed by EMAIL follows the person to their real principal on first sign-in", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `ed-adopt-${env.runId}`;
            await catalog.publishAgentPackage(publishInput(name, "1.0.0"));
            // The owner grants by typing an email: the placeholder row is
            // keyed (provider, subject = the email).
            const email = `adopt-${env.runId}@example.test`;
            await catalog.grantAgentPackageEditor(name, { provider: "test", subject: email }, OWNER, false);
            assertEqual(await editorSubjects(catalog, name), email);

            // First real sign-in: OID-keyed subject, same email. 0032's ghost
            // adoption must carry the editor row across and delete the
            // placeholder — before this fix the FK on agent_package_editors
            // made the whole registration roll back.
            const real = { provider: "test", subject: `oid-${env.runId}` };
            await catalog.setUserRole({ ...real, email, displayName: "Adopted Person" }, "user");
            assertEqual(await editorSubjects(catalog, name), real.subject, "grant re-pointed to the real principal");
            assert(await catalog.isAgentPackageEditor(
                (await catalog.getAgentPackage(name, OWNER, false, { scope: "shared" })).packageId, real),
                "the real principal is now the editor");
            assert(!(await catalog.listKnownUsers({ limit: 2000 })).some((u) => u.subject === email),
                "the placeholder row is gone");
        } finally {
            await catalog.close?.();
        }
    });
});
