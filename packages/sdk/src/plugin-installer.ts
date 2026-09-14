import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
    caseFoldPluginPath,
    normalizedPluginSpecKey,
    parsePluginSpecs,
    PluginSpecError,
    type GitPluginSpec,
    type PluginSpec,
} from "./plugin-source-spec.js";
import {
    createGitPluginSourceResolver,
    type GitPluginSourceResolver,
} from "./git-plugin-source.js";

export interface InstalledPluginSpec {
    spec: PluginSpec;
    /** Absolute plugin directory ready to pass to pluginDirs. */
    pluginDir: string;
    /** Materialized checkout root, or null for local sources. */
    destinationDir: string | null;
}

export interface PluginFileSystem {
    mkdir(dir: string, options: { recursive: true }): Promise<unknown>;
    mkdtemp(prefix: string): Promise<string>;
    realpath(candidate: string): Promise<string>;
    rename(from: string, to: string): Promise<void>;
    rm(candidate: string, options: { recursive: true; force: true }): Promise<void>;
    stat(candidate: string): Promise<{ isDirectory(): boolean }>;
}

export interface InstallPluginSpecsOptions {
    destinationRoot: string;
    cwd?: string;
    fileSystem?: PluginFileSystem;
    git?: GitPluginSourceResolver;
}

export class PluginInstallError extends Error {
    readonly code = "PLUGIN_INSTALL_FAILED";
    readonly index: number;
    readonly spec: PluginSpec;
    readonly cleanupError: unknown;

    constructor(index: number, spec: PluginSpec, cause: unknown, cleanupError?: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        const cleanupDetail = cleanupError
            ? `; cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
            : "";
        super(`Plugin source ${index} (${spec.kind}) failed: ${detail}${cleanupDetail}`, { cause });
        this.name = "PluginInstallError";
        this.index = index;
        this.spec = spec;
        this.cleanupError = cleanupError;
    }
}

const NODE_FILE_SYSTEM: PluginFileSystem = {
    mkdir: (dir, options) => fs.mkdir(dir, options),
    mkdtemp: (prefix) => fs.mkdtemp(prefix),
    realpath: (candidate) => fs.realpath(candidate),
    rename: (from, to) => fs.rename(from, to),
    rm: (candidate, options) => fs.rm(candidate, options),
    stat: (candidate) => fs.stat(candidate),
};

/**
 * Install all sources or throw. Failures are never converted to a partial
 * success result. Git checkouts are staged under destinationRoot and renamed
 * only after the requested plugin path passes containment checks.
 */
export async function installPluginSpecs(
    input: string | readonly unknown[],
    options: InstallPluginSpecsOptions,
): Promise<InstalledPluginSpec[]> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const specs = parsePluginSpecs(input).map((spec): PluginSpec =>
        spec.kind === "git"
            ? { ...spec, repository: resolveGitRepository(spec.repository, cwd) }
            : spec);
    if (specs.length === 0) return [];

    const fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM;
    await fileSystem.mkdir(options.destinationRoot, { recursive: true });
    const destinationRoot = await fileSystem.realpath(options.destinationRoot);
    const git = options.git ?? createGitPluginSourceResolver();

    const localPaths = new Map<number, string>();
    const resolvedKeys = new Map<string, number>();
    for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index];
        try {
            const localPath = spec.kind === "local"
                ? await resolveDirectory(path.resolve(cwd, spec.path), fileSystem)
                : null;
            const key = localPath
                ? `local:${caseFoldPluginPath(localPath)}`
                : normalizedPluginSpecKey(spec);
            const prior = resolvedKeys.get(key);
            if (prior !== undefined) {
                throw new PluginSpecError(`Plugin source ${index} duplicates source ${prior}`, index);
            }
            resolvedKeys.set(key, index);
            if (localPath) localPaths.set(index, localPath);
        } catch (cause) {
            if (cause instanceof PluginSpecError) throw cause;
            throw new PluginInstallError(index, spec, cause);
        }
    }

    const installed: InstalledPluginSpec[] = [];
    for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index];
        if (spec.kind === "local") {
            installed.push({ spec, pluginDir: localPaths.get(index)!, destinationDir: null });
            continue;
        }
        installed.push(await installGitSpec(index, spec, destinationRoot, fileSystem, git));
    }
    return installed;
}

async function installGitSpec(
    index: number,
    spec: GitPluginSpec,
    destinationRoot: string,
    fileSystem: PluginFileSystem,
    git: GitPluginSourceResolver,
): Promise<InstalledPluginSpec> {
    const destinationDir = path.join(destinationRoot, `git-${sourceHash(spec)}`);
    let stagingDir: string;
    try {
        stagingDir = await fileSystem.mkdtemp(path.join(destinationRoot, ".plugin-source-"));
    } catch (cause) {
        throw new PluginInstallError(index, spec, cause);
    }
    const checkoutDir = path.join(stagingDir, "repository");
    const backupDir = `${stagingDir}.previous`;
    let previousMoved = false;
    try {
        await git.checkout(spec, checkoutDir);
        await resolveContainedPluginDir(stagingDir, checkoutDir, spec.path, fileSystem);
        try {
            await fileSystem.rename(destinationDir, backupDir);
            previousMoved = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }
        await fileSystem.rename(stagingDir, destinationDir);
    } catch (cause) {
        const cleanupErrors: unknown[] = [];
        if (previousMoved) {
            try {
                await fileSystem.rm(destinationDir, { recursive: true, force: true });
                await fileSystem.rename(backupDir, destinationDir);
                previousMoved = false;
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        try {
            await fileSystem.rm(stagingDir, { recursive: true, force: true });
        } catch (error) {
            cleanupErrors.push(error);
        }
        throw new PluginInstallError(
            index,
            spec,
            cause,
            cleanupErrors.length === 0
                ? undefined
                : cleanupErrors.length === 1
                    ? cleanupErrors[0]
                    : new AggregateError(cleanupErrors, "Plugin replacement recovery failed"),
        );
    }
    if (previousMoved) {
        try {
            await fileSystem.rm(backupDir, { recursive: true, force: true });
        } catch (cleanupError) {
            throw new PluginInstallError(
                index,
                spec,
                new Error("Plugin replacement succeeded but the previous checkout could not be removed"),
                cleanupError,
            );
        }
    }
    return {
        spec,
        destinationDir,
        pluginDir: path.join(destinationDir, "repository", ...spec.path.split("/")),
    };
}

async function resolveContainedPluginDir(
    stagingDir: string,
    checkoutDir: string,
    pluginPath: string,
    fileSystem: PluginFileSystem,
): Promise<string> {
    const stagingRoot = await resolveDirectory(stagingDir, fileSystem);
    const root = await resolveDirectory(checkoutDir, fileSystem);
    assertContained(stagingRoot, root, "Git checkout escapes its staging directory");
    const candidate = path.join(root, ...pluginPath.split("/"));
    const resolved = await resolveDirectory(candidate, fileSystem);
    assertContained(root, resolved, `plugin path escapes the Git checkout: ${pluginPath}`);
    return resolved;
}

function assertContained(root: string, candidate: string, message: string): void {
    const relative = path.relative(root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(message);
    }
}

async function resolveDirectory(candidate: string, fileSystem: PluginFileSystem): Promise<string> {
    const resolved = await fileSystem.realpath(candidate);
    const stat = await fileSystem.stat(resolved);
    if (!stat.isDirectory()) {
        throw new Error(`plugin path is not a directory: ${candidate}`);
    }
    return resolved;
}

function sourceHash(spec: GitPluginSpec): string {
    return createHash("sha256").update(normalizedPluginSpecKey(spec)).digest("hex").slice(0, 16);
}

function resolveGitRepository(repository: string, cwd: string): string {
    if (path.isAbsolute(repository) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(repository)) {
        return repository;
    }
    return path.resolve(cwd, repository);
}
