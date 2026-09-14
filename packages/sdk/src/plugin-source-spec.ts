/**
 * Provider-neutral external plugin source specifications.
 *
 * JSON keeps the contract unambiguous and extensible without embedding any
 * hosting provider's URL, identity, or credential policy.
 */

import * as path from "node:path";

export interface LocalPluginSpec {
    kind: "local";
    /** Existing plugin directory. Relative paths are resolved from cwd. */
    path: string;
}

export interface GitPluginSpec {
    kind: "git";
    /** Provider-neutral Git URL or local repository path. */
    repository: string;
    /** Plugin directory within the checkout. */
    path: string;
    /** Branch, tag, or commit to fetch. Defaults to the remote HEAD. */
    ref?: string;
}

export type PluginSpec = LocalPluginSpec | GitPluginSpec;

export class PluginSpecError extends Error {
    readonly code = "INVALID_PLUGIN_SPEC";
    readonly index: number | undefined;

    constructor(message: string, index?: number, options?: ErrorOptions) {
        super(message, options);
        this.name = "PluginSpecError";
        this.index = index;
    }
}

/**
 * Parse and validate a JSON array or already-decoded array of PluginSpec
 * objects. Validation is strict so misspelled fields cannot silently change
 * source identity or ref selection.
 */
export function parsePluginSpecs(input: string | readonly unknown[]): PluginSpec[] {
    let value: unknown = input;
    if (typeof input === "string") {
        if (!input.trim()) return [];
        try {
            value = JSON.parse(input);
        } catch (cause) {
            throw new PluginSpecError("Plugin specs must be valid JSON", undefined, { cause });
        }
    }
    if (!Array.isArray(value)) {
        throw new PluginSpecError("Plugin specs must be a JSON array");
    }

    const specs = value.map((candidate, index) => validatePluginSpec(candidate, index));
    const seen = new Map<string, number>();
    for (let index = 0; index < specs.length; index += 1) {
        const key = normalizedPluginSpecKey(specs[index]);
        const prior = seen.get(key);
        if (prior !== undefined) {
            throw new PluginSpecError(`Plugin source ${index} duplicates source ${prior}`, index);
        }
        seen.set(key, index);
    }
    return specs;
}

function validatePluginSpec(candidate: unknown, index: number): PluginSpec {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw invalid(index, "must be an object");
    }
    const record = candidate as Record<string, unknown>;
    if (record.kind === "local") {
        rejectUnknownKeys(record, ["kind", "path"], index);
        return { kind: "local", path: requiredString(record.path, index, "path") };
    }
    if (record.kind === "git") {
        rejectUnknownKeys(record, ["kind", "repository", "path", "ref"], index);
        const repository = validateRepository(requiredString(record.repository, index, "repository"), index);
        const pluginPath = normalizePluginPath(requiredString(record.path, index, "path"), index);
        const ref = record.ref === undefined
            ? undefined
            : validateRef(requiredString(record.ref, index, "ref"), index);
        return { kind: "git", repository, path: pluginPath, ...(ref ? { ref } : {}) };
    }
    throw invalid(index, 'kind must be "local" or "git"');
}

function requiredString(value: unknown, index: number, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw invalid(index, `${field} must be a non-empty string`);
    }
    if (/[\0\r\n]/.test(value)) {
        throw invalid(index, `${field} must not contain control characters`);
    }
    return value.trim();
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: string[], index: number): void {
    const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw invalid(index, `contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
    }
}

function normalizePluginPath(value: string, index: number): string {
    const portable = value.replace(/\\/g, "/");
    if (portable.startsWith("/") || /^[A-Za-z]:/.test(portable)) {
        throw invalid(index, "git path must be relative");
    }
    const segments = portable.split("/");
    if (segments.includes("..")) {
        throw invalid(index, "git path must not contain traversal");
    }
    if (segments.some((segment) => segment.includes(":"))) {
        throw invalid(index, "git path must not contain ':'");
    }
    return segments.filter((segment) => segment && segment !== ".").join("/") || ".";
}

function validateRepository(value: string, index: number): string {
    if (value.startsWith("-")) {
        throw invalid(index, "repository must not begin with '-'");
    }
    if (isWindowsDrivePath(value)) return value;
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
        if (value.includes(":")) {
            throw invalid(index, "repository must be a URL or local path, not scp-like syntax");
        }
        return value;
    }

    let url: URL;
    try {
        url = new URL(value);
    } catch (cause) {
        throw new PluginSpecError(`Plugin source ${index}: repository URL is invalid`, index, { cause });
    }
    if (!["https:", "ssh:", "file:"].includes(url.protocol)) {
        throw invalid(index, "repository URL must use https, ssh, or file");
    }
    if (url.password || (url.protocol === "https:" && url.username)) {
        throw invalid(index, "repository URL must not contain credentials");
    }
    if (url.search || url.hash) {
        throw invalid(index, "repository URL must not contain a query or fragment");
    }
    return value;
}

function validateRef(value: string, index: number): string {
    if (value.startsWith("-")
        || /[\x00-\x20\x7f~^:?*[\]\\]/.test(value)
        || value.includes("..")
        || value.includes("@{")
        || value.includes("//")
        || value.startsWith("/")
        || value.endsWith("/")
        || value.endsWith(".")
        || value.endsWith(".lock")) {
        throw invalid(index, "ref is not a valid branch, tag, or commit name");
    }
    return value;
}

function invalid(index: number, message: string): PluginSpecError {
    return new PluginSpecError(`Plugin source ${index}: ${message}`, index);
}

/** @internal Shared with the installer for duplicate and cache identity. */
export function normalizedPluginSpecKey(spec: PluginSpec): string {
    if (spec.kind === "local") {
        const normalized = path.normalize(spec.path);
        return `local:${caseFoldPluginPath(normalized)}`;
    }
    return `git:${spec.repository}\0${spec.ref ?? "HEAD"}\0${spec.path}`;
}

/** @internal */
export function caseFoldPluginPath(value: string): string {
    return process.platform === "win32" ? value.toLowerCase() : value;
}

function isWindowsDrivePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value);
}
