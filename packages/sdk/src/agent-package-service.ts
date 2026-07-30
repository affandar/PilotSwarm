/**
 * Agent package service — the one publish pipeline every source kind rides.
 *
 * validate → canonical pack → artifact upload (reserved identity, sha-named
 * blob) → cms_publish_agent_package (atomic). The CLI's `agents push`, the
 * portal's upload op, and the repo-source sync all call publishAgentPackageDir
 * (or publishPackedAgentPackage when the bytes were packed from a fetched
 * archive) so there is exactly one code path that can put a package into the
 * registry. See docs/proposals/agent-packages.md.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ArtifactStore } from "./session-store.js";
import type {
    AgentPackageScope,
    AgentPrincipal,
    PublishAgentPackageResult,
    SessionCatalog,
} from "./cms.js";
import {
    AGENT_PACKAGE_MAX_COMPRESSED_BYTES,
    agentPackageArtifactFilename,
    agentPackagesArtifactSessionId,
    agentPackageTarSha256,
    packAgentPackage,
    validateAgentPackageDir,
    type AgentPackageManifest,
    type AgentPackageValidation,
    type ValidateAgentPackageOptions,
} from "./agent-package-format.js";

export interface AgentPackagePublishContext {
    catalog: SessionCatalog;
    artifactStore: ArtifactStore;
}

export interface PublishAgentPackageDirOptions {
    dir: string;
    scope: AgentPackageScope;
    owner: AgentPrincipal | null;
    createdBy?: string | null;
    isAdmin: boolean;
    sourceId?: string | null;
    commitSha?: string | null;
    validate?: ValidateAgentPackageOptions;
}

export class AgentPackageValidationError extends Error {
    readonly validation: AgentPackageValidation;
    constructor(validation: AgentPackageValidation) {
        super(
            "agent package failed validation:\n" +
            validation.errors.map((e) => `  - [${e.code}] ${e.message}`).join("\n"),
        );
        this.name = "AgentPackageValidationError";
        this.validation = validation;
    }
}

export interface PublishOutcome extends PublishAgentPackageResult {
    name: string;
    semver: string;
    sha256: string;
    sizeBytes: number;
    artifactFilename: string;
    manifest: AgentPackageManifest;
    warnings: AgentPackageValidation["warnings"];
}

/** Validate + pack + publish a package directory. */
export async function publishAgentPackageDir(
    ctx: AgentPackagePublishContext,
    opts: PublishAgentPackageDirOptions,
): Promise<PublishOutcome> {
    const validation = await validateAgentPackageDir(opts.dir, opts.validate);
    if (!validation.ok || !validation.manifest) {
        throw new AgentPackageValidationError(validation);
    }
    const packed = packAgentPackage(opts.dir);
    return await publishPackedAgentPackage(ctx, {
        manifest: validation.manifest,
        warnings: validation.warnings,
        targz: packed.targz,
        sha256: packed.sha256,
        scope: opts.scope,
        owner: opts.owner,
        createdBy: opts.createdBy ?? null,
        isAdmin: opts.isAdmin,
        sourceId: opts.sourceId ?? null,
        commitSha: opts.commitSha ?? null,
    });
}

export interface PublishPackedOptions {
    manifest: AgentPackageManifest;
    warnings?: AgentPackageValidation["warnings"];
    targz: Buffer;
    sha256: string;
    scope: AgentPackageScope;
    owner: AgentPrincipal | null;
    createdBy: string | null;
    isAdmin: boolean;
    sourceId: string | null;
    commitSha: string | null;
}

/** Publish already-validated, already-packed canonical bytes. */
export async function publishPackedAgentPackage(
    ctx: AgentPackagePublishContext,
    opts: PublishPackedOptions,
): Promise<PublishOutcome> {
    const { manifest, targz, sha256 } = opts;
    const name = manifest.name;
    const semver = manifest.version;
    if (targz.length > AGENT_PACKAGE_MAX_COMPRESSED_BYTES) {
        throw new Error(`package exceeds compressed size limit: ${targz.length} bytes`);
    }
    const artifactSessionId = agentPackagesArtifactSessionId();
    const artifactFilename = agentPackageArtifactFilename(name, semver, sha256);

    // Fast pre-check: an identical republish never touches the artifact store,
    // and same-semver content changes or foreign-package publishes fail before
    // any bytes move. The publish proc re-checks all of it atomically — this
    // is purely to keep the common cases cheap and clean.
    // isAdmin=true on this READ is deliberate: names are globally unique, so
    // publish must see a same-named package owned by ANYONE to produce the
    // right forbidden/conflict answer. Authorization uses opts.isAdmin below;
    // nothing from the foreign package is returned to the caller.
    const existing = await ctx.catalog.getAgentPackage(name, opts.owner, true);
    if (existing) {
        const actorOwns = opts.isAdmin || (
            existing.owner != null && opts.owner != null
            && existing.owner.provider === opts.owner.provider
            && existing.owner.subject === opts.owner.subject
        );
        if (!actorOwns) {
            throw new Error(
                `AGENT_PACKAGE_FORBIDDEN: only the package creator or an admin can publish new versions of "${name}"`,
            );
        }
        const existingVersion = existing.versions.find((v) => v.semver === semver);
        if (existingVersion) {
            if (existingVersion.sha256 === sha256) {
                return {
                    status: "noop",
                    packageId: existing.packageId,
                    versionId: existingVersion.versionId,
                    name, semver, sha256,
                    sizeBytes: targz.length,
                    artifactFilename: existingVersion.artifactFilename,
                    manifest,
                    warnings: opts.warnings ?? [],
                };
            }
            throw new Error(
                `AGENT_PACKAGE_SEMVER_CONFLICT: ${name}@${semver} is already published with different content — published versions are immutable, bump the version`,
            );
        }
    }

    // Upload the blob first so a committed registry row never dangles. The
    // sha-suffixed filename means a same-semver race writes two DISTINCT
    // blobs; the proc picks one winner and the loser cleans up its own blob.
    const tmpPath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "ps-agent-pkg-")),
        artifactFilename,
    );
    try {
        fs.writeFileSync(tmpPath, targz);
        await ctx.artifactStore.uploadArtifactFromFile(
            artifactSessionId, artifactFilename, tmpPath, "application/gzip",
        );
    } finally {
        fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true });
    }

    try {
        const result = await ctx.catalog.publishAgentPackage({
            name,
            scope: opts.scope,
            owner: opts.owner,
            sourceId: opts.sourceId,
            semver,
            sha256,
            sizeBytes: targz.length,
            artifactFilename,
            commitSha: opts.commitSha,
            manifest: manifest as unknown as Record<string, unknown>,
            createdBy: opts.createdBy,
            isAdmin: opts.isAdmin,
        });
        return {
            ...result,
            name, semver, sha256,
            sizeBytes: targz.length,
            artifactFilename,
            manifest,
            warnings: opts.warnings ?? [],
        };
    } catch (error) {
        // Our blob is orphaned (registry rejected the row) — best-effort cleanup.
        try { await ctx.artifactStore.deleteArtifact(artifactSessionId, artifactFilename); } catch { /* ignore */ }
        throw error;
    }
}

/** Download a package tarball and verify it against the registry sha256. */
export async function fetchAgentPackageTarGz(
    artifactStore: ArtifactStore,
    artifactFilename: string,
    expectedSha256: string,
): Promise<Buffer> {
    const artifactSessionId = agentPackagesArtifactSessionId();
    const result = await artifactStore.downloadArtifact(artifactSessionId, artifactFilename);
    const body: Buffer = Buffer.isBuffer((result as any).body)
        ? (result as any).body
        : Buffer.from((result as any).body ?? []);
    // Identity is the sha of the UNCOMPRESSED canonical tar (gzip bytes are
    // not stable across zlib builds) — verify by decompress-and-hash.
    const actual = agentPackageTarSha256(body);
    if (actual !== expectedSha256) {
        throw new Error(
            `AGENT_PACKAGE_SHA_MISMATCH: ${artifactFilename} downloaded with tar sha256 ${actual}, registry says ${expectedSha256}`,
        );
    }
    return body;
}

/** Delete a package's registry rows and then its blobs (post-commit cleanup). */
export async function deleteAgentPackageEverywhere(
    ctx: AgentPackagePublishContext,
    name: string,
    actor: AgentPrincipal | null,
    isAdmin: boolean,
): Promise<void> {
    const filenames = await ctx.catalog.deleteAgentPackage(name, actor, isAdmin);
    const artifactSessionId = agentPackagesArtifactSessionId();
    for (const filename of filenames) {
        try {
            await ctx.artifactStore.deleteArtifact(artifactSessionId, filename);
        } catch (error: any) {
            console.warn(`[agent-packages] blob cleanup failed for ${filename} (orphaned in the artifact store): ${error?.message ?? error}`);
        }
    }
}
