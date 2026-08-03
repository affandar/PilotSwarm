/**
 * Agent package installer — materializes the registry's install manifest into
 * a local cache directory and loads package worker modules.
 *
 * Used by PilotSwarmWorker at startup and on every registry-epoch refresh
 * (and by the portal for its catalog/workspace needs). Per-package failures
 * quarantine that package only — a corrupted tarball or a broken
 * worker-module must never take the worker down or block other packages.
 *
 * Cache layout: <cacheDir>/<name>@<semver>.<sha12>/ with a
 * .pilotswarm-meta.json sidecar carrying the verified sha256. A directory
 * whose sidecar matches the registry sha is reused without downloading —
 * this is the "never re-pull the same package" guarantee.
 */

import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import type { ArtifactStore } from "./session-store.js";
import type { AgentPackageInstallEntry, SessionCatalog } from "./cms.js";
import { extractAgentPackageTarGz } from "./agent-package-format.js";
import { fetchAgentPackageTarGz } from "./agent-package-service.js";

const META_FILENAME = ".pilotswarm-meta.json";

export interface InstalledAgentPackage {
    name: string;
    semver: string;
    sha256: string;
    scope: "shared" | "user";
    owner: { provider: string; subject: string } | null;
    manifest: Record<string, unknown>;
    /** Absolute unpacked directory (loadable as a plugin dir). */
    dir: string;
    /** Absolute path to tools/worker-module.js when the package ships tools. */
    workerModulePath: string | null;
    status: "ok" | "error";
    error?: string;
}

export interface AgentPackageInstallResult {
    epoch: number;
    packages: InstalledAgentPackage[];
    /** Plugin dirs of every OK package, install-manifest order. */
    pluginDirs: string[];
}

/**
 * Cache directory name for one installed package.
 *
 * The OWNER DISCRIMINATOR is load-bearing, not cosmetic. With per-user
 * namespaces (migration 0043) two people can publish the same `name`, and if
 * their content is byte-identical the old `name@semver.sha` key resolved to
 * the SAME directory for both. That collapses package provenance — and
 * provenance is the only thing keeping a user-scope agent private, because the
 * worker holds every tenant's packages at once. Two owners sharing a directory
 * meant one of them being denied their own agent.
 *
 * Shared packages keep the historical bare `name@semver.sha` shape, so
 * existing caches for them stay valid and are not needlessly re-downloaded.
 */
function cacheDirNameFor(entry: AgentPackageInstallEntry): string {
    const base = `${entry.name}@${entry.semver}.${entry.sha256.slice(0, 12)}`;
    if (entry.scope !== "user" || !entry.owner) return base;
    // Short, stable, filesystem-safe: the package id already IS the identity
    // of (scope, owner, name), so it needs no further encoding.
    return `${base}.u${String(entry.packageId).replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;
}

/** The GC key for a cache dir: everything before the version marker. */
function cacheDirPackageName(dirName: string): string {
    return dirName.split("@")[0];
}

function readMetaSha(dir: string): string | null {
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILENAME), "utf8"));
        return typeof meta?.sha256 === "string" ? meta.sha256 : null;
    } catch {
        return null;
    }
}

/**
 * Materialize every enabled package's active version into cacheDir.
 * Reads the epoch FIRST so a mutation that lands mid-install makes the next
 * poll see a newer epoch and re-converge (never lost, at worst one interval
 * late).
 */
export async function installAgentPackages(opts: {
    catalog: SessionCatalog;
    artifactStore: ArtifactStore;
    cacheDir: string;
}): Promise<AgentPackageInstallResult> {
    const epoch = await opts.catalog.agentRegistryEpoch();
    const manifest = await opts.catalog.getAgentPackagesInstallManifest();
    fs.mkdirSync(opts.cacheDir, { recursive: true });

    const packages: InstalledAgentPackage[] = [];
    for (const entry of manifest) {
        const dir = path.join(opts.cacheDir, cacheDirNameFor(entry));
        const installed: InstalledAgentPackage = {
            name: entry.name,
            semver: entry.semver,
            sha256: entry.sha256,
            scope: entry.scope,
            owner: entry.owner,
            manifest: entry.manifest,
            dir,
            workerModulePath: null,
            status: "ok",
        };
        try {
            if (readMetaSha(dir) !== entry.sha256) {
                const targz = await fetchAgentPackageTarGz(
                    opts.artifactStore, entry.artifactFilename, entry.sha256,
                );
                // Unpack to a sibling tmp dir, stamp the sidecar, then rename
                // into place so a crash mid-unpack never yields a half dir
                // that passes the sidecar check.
                const tmp = fs.mkdtempSync(path.join(opts.cacheDir, ".tmp-"));
                try {
                    extractAgentPackageTarGz(targz, tmp);
                    fs.writeFileSync(
                        path.join(tmp, META_FILENAME),
                        JSON.stringify({ sha256: entry.sha256, semver: entry.semver, installedAt: new Date().toISOString() }),
                    );
                    try {
                        fs.rmSync(dir, { recursive: true, force: true });
                        fs.renameSync(tmp, dir);
                    } catch (raceError) {
                        // Shared-cache race (local multi-worker): if a
                        // concurrent installer won and the dir now carries the
                        // right sha, that IS success — content is identical.
                        if (readMetaSha(dir) === entry.sha256) {
                            fs.rmSync(tmp, { recursive: true, force: true });
                        } else {
                            throw raceError;
                        }
                    }
                } catch (error) {
                    fs.rmSync(tmp, { recursive: true, force: true });
                    throw error;
                }
            }
            const workerModule = path.join(dir, "tools", "worker-module.js");
            installed.workerModulePath = fs.existsSync(workerModule) ? workerModule : null;
        } catch (error: any) {
            installed.status = "error";
            installed.error = String(error?.message ?? error);
        }
        packages.push(installed);
    }

    // Prune cache dirs whose PACKAGE no longer exists in the manifest at all.
    // Old-version dirs of live packages are kept deliberately: warm sessions'
    // stdio MCP servers may still run from them; pods recycle the rest.
    //
    // Keyed on the package NAME rather than the full dir key, because the key
    // now carries an owner discriminator: pruning on the whole key would
    // delete every older version the moment one was superseded.
    const liveNames = new Set(manifest.map((entry) => entry.name));
    try {
        for (const dirName of fs.readdirSync(opts.cacheDir)) {
            if (dirName.startsWith(".")) continue;
            if (!liveNames.has(cacheDirPackageName(dirName))) {
                fs.rmSync(path.join(opts.cacheDir, dirName), { recursive: true, force: true });
            }
        }
    } catch { /* best-effort GC */ }

    return {
        epoch,
        packages,
        pluginDirs: packages.filter((p) => p.status === "ok").map((p) => p.dir),
    };
}

/**
 * Import a package worker-module and return its tools.
 *
 * The import URL is cache-busted by the package sha, so a refreshed package
 * version gets a genuinely fresh module while an unchanged one reuses the
 * ESM cache. Module contract (same as the CLI --worker module):
 *   export default { createTools({ workerNodeId }) => Tool[] }  // or
 *   export default { tools: Tool[] }                            // or
 *   export const tools = [...]
 */
export async function loadAgentPackageTools(
    pkg: InstalledAgentPackage,
    context: { workerNodeId?: string },
): Promise<any[]> {
    if (!pkg.workerModulePath) return [];
    const url = `${pathToFileURL(pkg.workerModulePath).href}?v=${pkg.sha256.slice(0, 12)}`;
    const mod: any = await import(url);
    const surface = mod?.default ?? mod;
    let tools: any[] = [];
    if (typeof surface?.createTools === "function") {
        tools = await surface.createTools({ workerNodeId: context.workerNodeId });
    } else if (Array.isArray(surface?.tools)) {
        tools = surface.tools;
    } else if (Array.isArray(mod?.tools)) {
        tools = mod.tools;
    }
    if (!Array.isArray(tools)) return [];
    return tools.filter((t) => t && typeof (t as any).name === "string");
}
