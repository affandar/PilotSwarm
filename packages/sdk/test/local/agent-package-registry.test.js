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

            // A stranger cannot publish into someone else's package…
            await expectRegistryError(
                catalog.publishAgentPackage(publishInput(name, "1.1.0", { owner: STRANGER })),
                "AGENT_PACKAGE_FORBIDDEN",
            );

            // …but an admin can.
            const adminPush = await catalog.publishAgentPackage(
                publishInput(name, "1.1.0", { owner: STRANGER, isAdmin: true }),
            );
            assertEqual(adminPush.status, "published");

            // Publishing activates the published version.
            const detail = await catalog.getAgentPackage(name, OWNER, false);
            const active = detail.versions.find((v) => v.versionId === detail.activeVersionId);
            assertEqual(active.semver, "1.1.0");
            assertEqual(detail.versions.length, 2);
        } finally {
            await catalog.close();
        }
    });

    it("scope changes ride promote/demote, never publish", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const name = `pkg-scope-${env.runId}`;
            await catalog.publishAgentPackage(publishInput(name, "1.0.0"));
            await expectRegistryError(
                catalog.publishAgentPackage(publishInput(name, "1.1.0", { scope: "shared" })),
                "AGENT_PACKAGE_SCOPE_MISMATCH",
            );
            await catalog.setAgentPackageScope(name, "shared", OWNER, false);
            const bumped = await catalog.publishAgentPackage(publishInput(name, "1.1.0", { scope: "shared" }));
            assertEqual(bumped.status, "published");
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
            await expectRegistryError(
                catalog.setAgentPackageScope(name, "shared", null, false),
                "AGENT_PACKAGE_FORBIDDEN",
            );
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

            await expectRegistryError(
                catalog.setAgentPackageScope(name, "shared", STRANGER, false),
                "AGENT_PACKAGE_FORBIDDEN",
            );
            await expectRegistryError(
                catalog.deleteAgentPackage(name, STRANGER, false),
                "AGENT_PACKAGE_FORBIDDEN",
            );
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
