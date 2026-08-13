/**
 * Agent-package registry tests (migration 0038) — procs only, no LLM turns.
 *
 * Covers the publish state machine (published / noop / semver-conflict /
 * forbidden), user-scope visibility as THE privacy boundary, the
 * epoch-bumps-on-every-mutation sweep, pin/rollback, the install manifest,
 * worker fleet state, and the write-only auth_token posture.
 *
 * Run: npx vitest run test/local/agent-package-registry.test.js
 */

import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

const OWNER = { provider: "test", subject: "pkg-owner" };
const STRANGER = { provider: "test", subject: "pkg-stranger" };

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
        scope: "user",
        owner: OWNER,
        sourceId: null,
        semver,
        sha256: `sha-${name}-${semver}`,
        sizeBytes: 1024,
        artifactFilename: `${name}@${semver}.abc.tar.gz`,
        commitSha: null,
        manifest: manifestFor(name, semver),
        createdBy: "pkg-owner@test",
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

describe("agent-package registry", () => {
    it("publish state machine: published, noop, semver conflict, forbidden", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `pkg-pub-${env.runId}`;

            const first = await catalog.publishAgentPackage(publishInput(name, "1.0.0"));
            assertEqual(first.status, "published");

            // Identical (semver, sha) republish → noop, ids preserved.
            const again = await catalog.publishAgentPackage(publishInput(name, "1.0.0"));
            assertEqual(again.status, "noop");
            assertEqual(again.packageId, first.packageId);
            assertEqual(again.versionId, first.versionId);

            // Same semver, different content → immutable-version conflict.
            await expectRegistryError(
                catalog.publishAgentPackage(publishInput(name, "1.0.0", { sha256: "sha-DIFFERENT" })),
                "AGENT_PACKAGE_SEMVER_CONFLICT",
            );

            // A stranger publishing the same NAME no longer collides with the
            // owner's package — it lands in the stranger's own namespace (0043).
            // This is the headline of per-user namespaces: the first publisher
            // of a word no longer owns it deployment-wide.
            const strangerCopy = await catalog.publishAgentPackage(
                publishInput(name, "1.1.0", { owner: STRANGER }),
            );
            assertEqual(strangerCopy.status, "published");
            assert(strangerCopy.packageId !== first.packageId,
                "same name + different owner must be a DIFFERENT package, not a hijack");

            // The owner's copy is untouched by the stranger's publish.
            const ownerAfter = await catalog.getAgentPackage(name, OWNER, false);
            assertEqual(ownerAfter.packageId, first.packageId);
            assertEqual(ownerAfter.versions.length, 1, "stranger's version must not appear in the owner's package");

            // An admin can still publish into the owner's package, by naming it.
            const adminPush = await catalog.publishAgentPackage(
                publishInput(name, "1.1.0", { owner: OWNER, isAdmin: true }),
            );
            assertEqual(adminPush.status, "published");
            assertEqual(adminPush.packageId, first.packageId);

            // Publishing activates the published version.
            const detail = await catalog.getAgentPackage(name, OWNER, false);
            const active = detail.versions.find((v) => v.versionId === detail.activeVersionId);
            assertEqual(active.semver, "1.1.0");
            assertEqual(detail.versions.length, 2);
        } finally {
            await catalog.close();
        }
    });

    it("scope is part of identity: a user copy and a shared copy coexist", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `pkg-scope-${env.runId}`;
            const userCopy = await catalog.publishAgentPackage(publishInput(name, "1.0.0"));

            // AGENT_PACKAGE_SCOPE_MISMATCH is gone by design (0043). Under
            // global uniqueness, publishing the same name at a different scope
            // was a conflict; now scope is part of identity, so this simply
            // creates the shared package alongside the user one — which is how
            // a user keeps a personal copy of something also published fleet-wide.
            const sharedCopy = await catalog.publishAgentPackage(
                publishInput(name, "1.1.0", { scope: "shared", isAdmin: true }),
            );
            assertEqual(sharedCopy.status, "published");
            assert(sharedCopy.packageId !== userCopy.packageId,
                "user-scope and shared-scope copies of a name are different packages");

            // Resolution: the owner's own copy shadows the shared one.
            const resolvedForOwner = await catalog.getAgentPackage(name, OWNER, false);
            assertEqual(resolvedForOwner.packageId, userCopy.packageId,
                "own enabled copy shadows shared");

            // Disabling the personal copy is the recovery path: shared takes over.
            await catalog.setAgentPackageEnabled(name, false, OWNER, false, { scope: "user" });
            const resolvedAfterDisable = await catalog.getAgentPackage(name, OWNER, false);
            assertEqual(resolvedAfterDisable.packageId, sharedCopy.packageId,
                "a disabled personal copy falls through to shared");

            // An explicit selector still reaches the disabled copy — otherwise
            // disabling one would be irreversible.
            const pinned = await catalog.getAgentPackage(name, OWNER, false, { scope: "user" });
            assertEqual(pinned.packageId, userCopy.packageId);
            assertEqual(pinned.enabled, false);

            // Promotion is exclusive: shared already holds the name.
            await catalog.setAgentPackageEnabled(name, true, OWNER, false, { scope: "user" });
            await expectRegistryError(
                catalog.setAgentPackageScope(name, "shared", OWNER, false, { scope: "user" }),
                "AGENT_PACKAGE_NAME_TAKEN",
            );
        } finally {
            await catalog.close();
        }
    });

    it("delete returns only ORPHANED blobs — a same-bytes sibling keeps its file (0046)", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `pkg-blob-${env.runId}`;
            // Two packages, one NAME, IDENTICAL bytes → one content-addressed
            // blob filename (name@semver.sha) shared by both version rows.
            const sharedSha = `sha-${name}-shared`;
            const userVer = await catalog.publishAgentPackage(publishInput(name, "1.0.0", {
                sha256: sharedSha, artifactFilename: `${name}@1.0.0.shared.tar.gz`,
            }));
            const sharedVer = await catalog.publishAgentPackage(publishInput(name, "1.0.0", {
                scope: "shared", isAdmin: true,
                sha256: sharedSha, artifactFilename: `${name}@1.0.0.shared.tar.gz`,
            }));
            assert(userVer.packageId !== sharedVer.packageId, "two packages");

            // Deleting the user copy must return ZERO filenames to clean up:
            // the shared copy still references the one shared blob.
            const orphanedByUserDelete = await catalog.deleteAgentPackage(name, OWNER, false, { scope: "user" });
            assertEqual(orphanedByUserDelete.length, 0,
                "the shared sibling still references the blob, so nothing is orphaned");

            // Now deleting the last (shared) copy DOES orphan the blob.
            const orphanedBySharedDelete = await catalog.deleteAgentPackage(name, OWNER, true, { scope: "shared" });
            assert(orphanedBySharedDelete.includes(`${name}@1.0.0.shared.tar.gz`),
                "the last reference gone → the blob is returned for cleanup");
        } finally {
            await catalog.close();
        }
    });

    it("null principals: owner-less publish is admin-only; NULL-owner packages are admin-managed", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `pkg-null-${env.runId}`;
            await expectRegistryError(
                catalog.publishAgentPackage(publishInput(name, "1.0.0", { owner: null })),
                "AGENT_PACKAGE_FORBIDDEN",
            );
            const adminPush = await catalog.publishAgentPackage(
                publishInput(name, "1.0.0", { owner: null, isAdmin: true }),
            );
            assertEqual(adminPush.status, "published");

            // A NULL-owner package rejects every non-admin mutation — including
            // publish by a null principal (the asymmetry the review closed).
            await expectRegistryError(
                catalog.publishAgentPackage(publishInput(name, "1.1.0", { owner: null })),
                "AGENT_PACKAGE_FORBIDDEN",
            );
            // Under namespaces a null non-admin principal has no namespace of
            // its own, so a name it does not own reads as NOT_FOUND rather than
            // FORBIDDEN. That is both correct (the name does not exist for this
            // caller) and better — a refusal no longer confirms the package is
            // there.
            await expectRegistryError(
                catalog.setAgentPackageScope(name, "shared", null, false),
                "AGENT_PACKAGE_NOT_FOUND",
            );
            // Admins keep reaching NULL-owner packages, which is what stops
            // 0043 from orphaning rows that predate owner stamping.
            await catalog.setAgentPackageScope(name, "shared", null, true);

            // And a null non-admin viewer sees only shared packages.
            const names = (await catalog.listAgentPackages(null, false)).map((p) => p.name);
            assert(names.includes(name), "shared NULL-owner package visible to all");
        } finally {
            await catalog.close();
        }
    });

    it("user-scope visibility is enforced in list and get", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const userPkg = `pkg-vis-user-${env.runId}`;
            const sharedPkg = `pkg-vis-shared-${env.runId}`;
            await catalog.publishAgentPackage(publishInput(userPkg, "1.0.0"));
            await catalog.publishAgentPackage(publishInput(sharedPkg, "1.0.0", { scope: "shared" }));

            const mine = (await catalog.listAgentPackages(OWNER, false)).map((p) => p.name);
            assert(mine.includes(userPkg), "owner sees own user package");
            assert(mine.includes(sharedPkg), "owner sees shared package");

            const theirs = (await catalog.listAgentPackages(STRANGER, false)).map((p) => p.name);
            assert(!theirs.includes(userPkg), "stranger must NOT see a foreign user package");
            assert(theirs.includes(sharedPkg), "stranger sees shared package");

            const adminView = (await catalog.listAgentPackages(STRANGER, true)).map((p) => p.name);
            assert(adminView.includes(userPkg), "admin sees everything");

            assertEqual(await catalog.getAgentPackage(userPkg, STRANGER, false), null);
            assert(await catalog.getAgentPackage(userPkg, STRANGER, true) !== null, "admin get succeeds");
        } finally {
            await catalog.close();
        }
    });

    it("every worker-visible mutation bumps the epoch; observations do not", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `pkg-epoch-${env.runId}`;
            const epochs = [await catalog.agentRegistryEpoch()];
            const expectBump = async (label, fn) => {
                await fn();
                const next = await catalog.agentRegistryEpoch();
                assert(next > epochs[epochs.length - 1], `${label} must bump the epoch`);
                epochs.push(next);
            };
            const expectNoBump = async (label, fn) => {
                await fn();
                const next = await catalog.agentRegistryEpoch();
                assertEqual(next, epochs[epochs.length - 1], `${label} must NOT bump the epoch`);
            };

            await expectBump("publish", () => catalog.publishAgentPackage(publishInput(name, "1.0.0")));
            await expectNoBump("noop republish", () => catalog.publishAgentPackage(publishInput(name, "1.0.0")));
            await expectBump("second publish", () => catalog.publishAgentPackage(publishInput(name, "1.1.0")));
            await expectBump("scope flip", () => catalog.setAgentPackageScope(name, "shared", OWNER, false));
            await expectBump("disable", () => catalog.setAgentPackageEnabled(name, false, OWNER, false));
            await expectBump("enable", () => catalog.setAgentPackageEnabled(name, true, OWNER, false));
            await expectBump("pin", () => catalog.pinAgentPackageVersion(name, "1.0.0", OWNER, false));
            await expectNoBump("worker state upsert", () => catalog.upsertAgentWorkerState("w-test", 1, {}));
            await expectBump("delete", () => catalog.deleteAgentPackage(name, OWNER, false));
        } finally {
            await catalog.close();
        }
    });

    it("pin moves the active version; install manifest honors enabled + active", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `pkg-pin-${env.runId}`;
            await catalog.publishAgentPackage(publishInput(name, "1.0.0"));
            await catalog.publishAgentPackage(publishInput(name, "2.0.0"));

            let entry = (await catalog.getAgentPackagesInstallManifest()).find((e) => e.name === name);
            assertEqual(entry.semver, "2.0.0");

            await catalog.pinAgentPackageVersion(name, "1.0.0", OWNER, false);
            entry = (await catalog.getAgentPackagesInstallManifest()).find((e) => e.name === name);
            assertEqual(entry.semver, "1.0.0", "pin rolls the manifest back");

            await expectRegistryError(
                catalog.pinAgentPackageVersion(name, "9.9.9", OWNER, false),
                "AGENT_PACKAGE_VERSION_NOT_FOUND",
            );

            await catalog.setAgentPackageEnabled(name, false, OWNER, false);
            entry = (await catalog.getAgentPackagesInstallManifest()).find((e) => e.name === name);
            assertEqual(entry, undefined, "disabled packages leave the install manifest");
        } finally {
            await catalog.close();
        }
    });

    it("mutations are creator-or-admin; delete returns artifact filenames", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `pkg-authz-${env.runId}`;
            await catalog.publishAgentPackage(publishInput(name, "1.0.0"));
            await catalog.publishAgentPackage(publishInput(name, "1.1.0"));

            // A stranger naming someone else's package resolves inside their
            // OWN namespace, where it does not exist — so NOT_FOUND, not
            // FORBIDDEN. The refusal no longer discloses that the package
            // exists at all.
            await expectRegistryError(
                catalog.setAgentPackageScope(name, "shared", STRANGER, false),
                "AGENT_PACKAGE_NOT_FOUND",
            );
            await expectRegistryError(
                catalog.deleteAgentPackage(name, STRANGER, false),
                "AGENT_PACKAGE_NOT_FOUND",
            );
            // A stranger who HAS a copy of the name must still not reach the
            // owner's: same word, different package.
            await catalog.publishAgentPackage(publishInput(name, "9.0.0", { owner: STRANGER }));
            await catalog.deleteAgentPackage(name, STRANGER, false);
            assert(await catalog.getAgentPackage(name, OWNER, false),
                "deleting your own copy must not touch anyone else's");

            await expectRegistryError(
                catalog.deleteAgentPackage(`missing-${env.runId}`, OWNER, false),
                "AGENT_PACKAGE_NOT_FOUND",
            );

            const filenames = await catalog.deleteAgentPackage(name, STRANGER, true);
            assertEqual(
                filenames.sort().join(","),
                `${name}@1.0.0.abc.tar.gz,${name}@1.1.0.abc.tar.gz`,
                "delete returns every version's artifact filename for cleanup",
            );

            assertEqual(await catalog.getAgentPackage(name, OWNER, true), null);
        } finally {
            await catalog.close();
        }
    });

    it("sources: write-only token posture and creator-or-admin visibility", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const sourceId = `src-${env.runId}`;
            await catalog.registerAgentSource({
                sourceId,
                kind: "github",
                repoUrl: "https://github.com/acme/agents",
                ref: "main",
                path: "/packages/kit",
                authToken: "ghp_secret_token_value",
                owner: OWNER,
                createdBy: "pkg-owner@test",
            });

            const rows = await catalog.listAgentSources(OWNER, false);
            const row = rows.find((r) => r.sourceId === sourceId);
            assertEqual(row.authTokenSet, true);
            assert(!JSON.stringify(row).includes("ghp_secret_token_value"),
                "no listing row may ever carry the raw token");

            const strangerRows = await catalog.listAgentSources(STRANGER, false);
            assertEqual(strangerRows.find((r) => r.sourceId === sourceId), undefined,
                "sources are creator-or-admin visible");

            // Internal-only raw read (used by sync fetchers).
            assertEqual(await catalog.getAgentSourceToken(sourceId), "ghp_secret_token_value");

            await catalog.updateAgentSourceSync(sourceId, "ok", null, "abc1234");
            const after = await catalog.getAgentSource(sourceId);
            assertEqual(after.lastSyncStatus, "ok");
            assertEqual(after.lastCommitSha, "abc1234");

            await expectRegistryError(
                catalog.deleteAgentSource(sourceId, STRANGER, false),
                "AGENT_PACKAGE_FORBIDDEN",
            );
            await catalog.deleteAgentSource(sourceId, OWNER, false);
            assertEqual(await catalog.getAgentSource(sourceId), null);
        } finally {
            await catalog.close();
        }
    });

    it("worker fleet state upserts and lists", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const workerId = `worker-${env.runId}`;
            await catalog.upsertAgentWorkerState(workerId, 3, { "pkg-a": { semver: "1.0.0", status: "ok" } });
            await catalog.upsertAgentWorkerState(workerId, 4, { "pkg-a": { semver: "1.1.0", status: "ok" } });

            const rows = await catalog.listAgentWorkerState();
            const row = rows.find((r) => r.workerNodeId === workerId);
            assertEqual(row.epoch, 4);
            assertEqual(row.installed["pkg-a"].semver, "1.1.0");
            assert(row.updatedAt instanceof Date);
        } finally {
            await catalog.close();
        }
    });
});
