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
    readAgentPackageTarGz,
    stageAgentPackageDir,
    validateAgentPackageDir,
    type AgentPackageManifest,
    type AgentPackageValidation,
    type PackedAgentPackage,
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

const packageEntryCache = new Map<string, ReturnType<typeof readAgentPackageTarGz>>();
let packageEntryCacheBytes = 0;
const PACKAGE_ENTRY_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const PACKAGE_ENTRY_CACHE_MAX_ITEMS = 8;

/** Validate + pack + publish a package directory. */
export async function publishAgentPackageDir(
    ctx: AgentPackagePublishContext,
    opts: PublishAgentPackageDirOptions,
): Promise<PublishOutcome> {
    // Stage once: a manifest-declared layout is validated AND packed from
    // the same canonical staging tree, so the published bytes are exactly
    // the validated bytes. Convention-mode dirs pass through untouched.
    const staged = stageAgentPackageDir(opts.dir);
    if (!staged.staged && staged.issues.length > 0) {
        throw new AgentPackageValidationError({ ok: false, errors: staged.issues, warnings: [] });
    }
    let validation: AgentPackageValidation;
    let packed: PackedAgentPackage;
    try {
        validation = await validateAgentPackageDir(staged.dir, { ...(opts.validate ?? {}), preStaged: staged.staged });
        if (!validation.ok || !validation.manifest) {
            throw new AgentPackageValidationError(validation);
        }
        packed = packAgentPackage(staged.dir);
    } finally {
        staged.cleanup();
    }
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

/**
 * Package names that collide with fixed /agent-packages/* route segments —
 * a package named "sources" would make GET /agent-packages/sources ambiguous.
 */
const RESERVED_PACKAGE_NAMES = new Set(["sources", "upload", "worker-state"]);

/** Publish already-validated, already-packed canonical bytes. */
export async function publishPackedAgentPackage(
    ctx: AgentPackagePublishContext,
    opts: PublishPackedOptions,
): Promise<PublishOutcome> {
    const { manifest, targz, sha256 } = opts;
    const name = manifest.name;
    const semver = manifest.version;
    if (RESERVED_PACKAGE_NAMES.has(name)) {
        throw new Error(`AGENT_PACKAGE_BAD_NAME: "${name}" is a reserved name — pick another package name`);
    }
    if (targz.length > AGENT_PACKAGE_MAX_COMPRESSED_BYTES) {
        throw Object.assign(
            new Error(`package exceeds compressed size limit: ${targz.length} bytes`),
            { code: "PAYLOAD_TOO_LARGE" },
        );
    }
    const artifactSessionId = agentPackagesArtifactSessionId();
    const artifactFilename = agentPackageArtifactFilename(name, semver, sha256);

    // Fast pre-check: an identical republish never touches the artifact store,
    // and same-semver content changes or foreign-package publishes fail before
    // any bytes move. The publish proc re-checks all of it atomically — this
    // is purely to keep the common cases cheap and clean.
    // isAdmin=true on this READ is deliberate: publish must see a same-named
    // package owned by ANYONE to produce the right forbidden/conflict answer.
    // Authorization uses opts.isAdmin below; nothing from the foreign package
    // is returned to the caller.
    // The selector pins the TARGET copy. Without it, name resolution walks
    // "own copy, then shared" — so publishing to SHARED while owning a
    // same-named user copy dedup'd against the USER copy and reported a
    // no-op without ever touching the shared package.
    const existing = await ctx.catalog.getAgentPackage(name, opts.owner, true, {
        scope: opts.scope,
        ...(opts.scope === "user" && opts.owner ? { owner: opts.owner } : {}),
    });
    if (existing) {
        // Same rule as cms_publish_agent_package: admin, owner, or a granted
        // editor. This pre-check runs before any bytes move; the proc
        // re-checks atomically. Keep the two in step — an editor refused
        // HERE never reaches the proc that would have admitted them.
        const actorOwns = opts.isAdmin || (
            existing.owner != null && opts.owner != null
            && existing.owner.provider === opts.owner.provider
            && existing.owner.subject === opts.owner.subject
        );
        const actorEdits = !actorOwns && await ctx.catalog.isAgentPackageEditor(existing.packageId, opts.owner);
        if (!actorOwns && !actorEdits) {
            throw new Error(
                `AGENT_PACKAGE_FORBIDDEN: only the package creator, an editor, or an admin can publish new versions of "${name}"`,
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

    // Agent-name overlap across ENABLED packages makes bare-name session
    // creation ambiguous, and on workers that predate per-copy binding it can
    // serve one package's prompt with another's tool handlers. Warn — never
    // block: same-name copies across scopes are the supported shadowing
    // pattern, and this read is best-effort.
    //
    // PRIVACY: only warn about copies the publisher can already SEE — shared
    // packages, and their own user-scope copies. The install manifest is
    // fleet-wide (it carries every tenant's packages), so reporting a collision
    // with another user's private package would leak that package's existence,
    // name, and owner identity to any publisher — an enumeration oracle. An
    // admin publishing legitimately sees everything anyway.
    const warnings = [...(opts.warnings ?? [])];
    try {
        const ourAgents = new Set(
            (manifest.agents ?? []).map((a) => a.name).filter(Boolean),
        );
        if (ourAgents.size > 0) {
            const installed = await ctx.catalog.getAgentPackagesInstallManifest();
            for (const entry of installed) {
                const isOwn = entry.owner?.provider === opts.owner?.provider
                    && entry.owner?.subject === opts.owner?.subject;
                const isSelf = entry.name === name && entry.scope === opts.scope
                    && (entry.scope === "shared" || isOwn);
                if (isSelf) continue;
                // Skip copies this publisher cannot see: another user's
                // user-scope package (unless the publisher is an admin).
                const visible = entry.scope === "shared" || isOwn || opts.isAdmin;
                if (!visible) continue;
                const theirAgents = ((entry.manifest as any)?.agents ?? [])
                    .map((a: any) => a?.name)
                    .filter(Boolean);
                const overlap = theirAgents.filter((n: string) => ourAgents.has(n));
                if (overlap.length > 0) {
                    // Only name the owner for a copy the reader already sees the
                    // owner of (their own, or admin). Shared copies belong to
                    // the deployment, so no owner is named.
                    const ownerNote = entry.scope === "user" && entry.owner && (isOwn || opts.isAdmin)
                        ? `, owner ${entry.owner.provider}:${entry.owner.subject}`
                        : "";
                    warnings.push({
                        code: "AGENT_NAME_COLLISION",
                        message: `agent name(s) ${overlap.map((n: string) => `"${n}"`).join(", ")} `
                            + `also exist in enabled package "${entry.name}" (${entry.scope}${ownerNote}). `
                            + `Bare-name session creation is ambiguous while both are enabled — `
                            + `rename the agent or disable one copy.`,
                    });
                }
            }
        }
    } catch { /* warning pass is best-effort; never blocks a publish */ }

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
            warnings,
        };
    } catch (error) {
        // Clean up OUR just-uploaded blob (the registry rejected the row) — but
        // only if no published version references it. Blob files are
        // content-addressed (name@semver.sha), so this exact file may already
        // back a same-bytes copy in the other scope (a republish, or another
        // user's identical publish). Deleting a still-referenced blob would
        // strand that copy fleet-wide. The failed publish rolled back, so any
        // reference the registry reports now belongs to a DIFFERENT package.
        try {
            const refs = await ctx.catalog.countAgentPackageArtifactRefs(artifactFilename);
            if (refs === 0) {
                await ctx.artifactStore.deleteArtifact(artifactSessionId, artifactFilename);
            }
        } catch { /* best-effort cleanup; a leaked blob is harmless, a deleted shared one is not */ }
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

export async function resolveAgentPackageVersion(
    catalog: SessionCatalog,
    name: string,
    actor: AgentPrincipal | null,
    isAdmin: boolean,
    selector?: import("./cms.js").AgentPackageSelector | null,
    semver?: string | null,
) {
    const detail = await catalog.getAgentPackage(name, actor, isAdmin, selector);
    if (!detail) throw Object.assign(new Error(`package "${name}" not found`), { code: "NOT_FOUND" });
    const version = semver
        ? detail.versions.find((candidate) => candidate.semver === semver)
        : detail.versions.find((candidate) => candidate.versionId === detail.activeVersionId) ?? detail.versions[0];
    if (!version) {
        throw Object.assign(
            new Error(`package "${name}" has no ${semver ? `version ${semver}` : "versions"}`),
            { code: "NOT_FOUND" },
        );
    }
    return { detail, version };
}

export async function readAgentPackageVersionEntries(
    ctx: AgentPackagePublishContext,
    name: string,
    actor: AgentPrincipal | null,
    isAdmin: boolean,
    selector?: import("./cms.js").AgentPackageSelector | null,
    semver?: string | null,
) {
    const resolved = await resolveAgentPackageVersion(catalogOrThrow(ctx), name, actor, isAdmin, selector, semver);
    const cacheKey = `${resolved.version.artifactFilename}:${resolved.version.sha256}`;
    let entries = packageEntryCache.get(cacheKey);
    if (entries) {
        packageEntryCache.delete(cacheKey);
        packageEntryCache.set(cacheKey, entries);
    } else {
        const targz = await fetchAgentPackageTarGz(ctx.artifactStore, resolved.version.artifactFilename, resolved.version.sha256);
        entries = readAgentPackageTarGz(targz);
        packageEntryCache.set(cacheKey, entries);
        packageEntryCacheBytes += entries.reduce((sum, entry) => sum + entry.body.length, 0);
        while ((packageEntryCache.size > PACKAGE_ENTRY_CACHE_MAX_ITEMS
            || packageEntryCacheBytes > PACKAGE_ENTRY_CACHE_MAX_BYTES) && packageEntryCache.size > 1) {
            const oldestKey = packageEntryCache.keys().next().value as string;
            const oldest = packageEntryCache.get(oldestKey) ?? [];
            packageEntryCacheBytes -= oldest.reduce((sum, entry) => sum + entry.body.length, 0);
            packageEntryCache.delete(oldestKey);
        }
    }
    return { ...resolved, entries };
}

function catalogOrThrow(ctx: AgentPackagePublishContext): SessionCatalog {
    if (!ctx.catalog) throw new Error("agent package catalog is unavailable");
    return ctx.catalog;
}

/** Delete a package's registry rows and then its blobs (post-commit cleanup). */
export async function deleteAgentPackageEverywhere(
    ctx: AgentPackagePublishContext,
    name: string,
    actor: AgentPrincipal | null,
    isAdmin: boolean,
    selector?: import("./cms.js").AgentPackageSelector | null,
): Promise<void> {
    const filenames = await ctx.catalog.deleteAgentPackage(name, actor, isAdmin, selector);
    const artifactSessionId = agentPackagesArtifactSessionId();
    for (const filename of filenames) {
        try {
            await ctx.artifactStore.deleteArtifact(artifactSessionId, filename);
        } catch (error: any) {
            console.warn(`[agent-packages] blob cleanup failed for ${filename} (orphaned in the artifact store): ${error?.message ?? error}`);
        }
    }
}
