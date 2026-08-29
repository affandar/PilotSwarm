/**
 * Resolve the exact Markdown instructions for one durable Job state.
 *
 * User and platform lifecycle sources remain separate. Workers do not build a
 * combined package or load every state: activation probes only the current
 * state's conventional Prefix.State.md path in each pinned source.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

export type LifecycleStateOwner = "user" | "platform";
export type LifecycleStateSourceKind = "ado" | "github";

export interface LifecycleStateSource {
    /** Stable identity, such as user-diagnostic or standard-fix-delivery@1. */
    sourceId: string;
    owner: LifecycleStateOwner;
    /** Filename prefix in this source, such as HelloWorld or StandardFix. */
    filePrefix: string;
    /** Safe source-relative directory containing the state files. */
    basePath?: string;
    kind?: LifecycleStateSourceKind;
    repository?: string;
    repositoryUrl?: string;
    requestedRef?: string;
    resolvedCommit?: string;
    version?: string | number;
    digest?: string;
}

export interface LifecycleStateReader {
    /**
     * Return the exact Markdown text, or null when this source has no file at
     * the requested path. Other source failures must be thrown.
     */
    readStateMarkdown(source: Readonly<LifecycleStateSource>, sourcePath: string): Promise<string | null>;
}

export interface LoadLifecycleStateInput {
    lifecycleName: string;
    state: string;
    sources: readonly LifecycleStateSource[];
    reader: LifecycleStateReader;
}

export interface LoadedLifecycleState {
    lifecycleName: string;
    state: string;
    owner: LifecycleStateOwner;
    source: Readonly<LifecycleStateSource>;
    sourcePath: string;
    /** Exact Markdown returned by the source reader. */
    markdown: string;
    sha256: string;
}

export type LifecycleStateLoadErrorCode =
    | "invalid_lifecycle_name"
    | "invalid_state"
    | "invalid_sources"
    | "invalid_source"
    | "invalid_source_id"
    | "duplicate_source"
    | "invalid_owner"
    | "invalid_file_prefix"
    | "invalid_base_path"
    | "invalid_source_metadata"
    | "invalid_markdown"
    | "state_not_found"
    | "ambiguous_state";

export class LifecycleStateLoadError extends Error {
    readonly code: LifecycleStateLoadErrorCode;
    readonly state?: string;
    readonly sourceId?: string;
    readonly sourcePath?: string;

    constructor(
        code: LifecycleStateLoadErrorCode,
        message: string,
        details: { state?: string; sourceId?: string; sourcePath?: string } = {},
    ) {
        super(message);
        this.name = "LifecycleStateLoadError";
        this.code = code;
        this.state = details.state;
        this.sourceId = details.sourceId;
        this.sourcePath = details.sourcePath;
    }
}

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SOURCE_METADATA_FIELDS = new Set([
    "sourceId",
    "owner",
    "filePrefix",
    "basePath",
    "kind",
    "repository",
    "repositoryUrl",
    "requestedRef",
    "resolvedCommit",
    "version",
    "digest",
]);

function requireIdentifier(
    value: string,
    code: "invalid_lifecycle_name" | "invalid_state" | "invalid_file_prefix",
    label: string,
    sourceId?: string,
): string {
    if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
        throw new LifecycleStateLoadError(
            code,
            `${label} must start with a letter and contain only letters, digits, hyphens, or underscores`,
            { sourceId },
        );
    }
    return value;
}

function requireSourceId(value: string): string {
    if (typeof value !== "string" || value.trim() !== value || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new LifecycleStateLoadError(
            "invalid_source_id",
            "lifecycle sourceId must be a non-empty trimmed string without control characters",
        );
    }
    return value;
}

function requireOwner(value: LifecycleStateOwner, sourceId: string): LifecycleStateOwner {
    if (value !== "user" && value !== "platform") {
        throw new LifecycleStateLoadError(
            "invalid_owner",
            `lifecycle source owner must be "user" or "platform": ${JSON.stringify(value)}`,
            { sourceId },
        );
    }
    return value;
}

function requireBasePath(value: string | undefined, sourceId: string): string {
    if (value === undefined || value === "") return "";
    if (typeof value !== "string"
        || value.includes("\\")
        || value.includes("\0")
        || path.posix.isAbsolute(value)
        || /^[A-Za-z]:/.test(value)) {
        throw new LifecycleStateLoadError(
            "invalid_base_path",
            `lifecycle basePath must be source-relative and use "/" separators: ${JSON.stringify(value)}`,
            { sourceId, sourcePath: value },
        );
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
        throw new LifecycleStateLoadError(
            "invalid_base_path",
            `lifecycle basePath contains an unsafe segment: ${JSON.stringify(value)}`,
            { sourceId, sourcePath: value },
        );
    }
    return value;
}

function immutableSource(source: LifecycleStateSource): Readonly<LifecycleStateSource> {
    const sourceId = requireSourceId(source.sourceId);
    const owner = requireOwner(source.owner, sourceId);
    const filePrefix = requireIdentifier(source.filePrefix, "invalid_file_prefix", "filePrefix", sourceId);
    const basePath = requireBasePath(source.basePath, sourceId);

    for (const [field, value] of Object.entries(source)) {
        if (!SOURCE_METADATA_FIELDS.has(field)) continue;
        if (value !== undefined
            && typeof value !== "string"
            && !(field === "version" && typeof value === "number" && Number.isFinite(value))) {
            throw new LifecycleStateLoadError(
                "invalid_source_metadata",
                `lifecycle source ${field} must be a string${field === "version" ? " or finite number" : ""} when present`,
                { sourceId },
            );
        }
    }

    return Object.freeze({
        sourceId,
        owner,
        filePrefix,
        ...(basePath ? { basePath } : {}),
        ...(source.kind !== undefined ? { kind: source.kind } : {}),
        ...(source.repository !== undefined ? { repository: source.repository } : {}),
        ...(source.repositoryUrl !== undefined ? { repositoryUrl: source.repositoryUrl } : {}),
        ...(source.requestedRef !== undefined ? { requestedRef: source.requestedRef } : {}),
        ...(source.resolvedCommit !== undefined ? { resolvedCommit: source.resolvedCommit } : {}),
        ...(source.version !== undefined ? { version: source.version } : {}),
        ...(source.digest !== undefined ? { digest: source.digest } : {}),
    });
}

const AZURE_DEVOPS_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

export interface RemoteLifecycleStateReaderOptions {
    fetch?: typeof fetch;
    githubToken?: string;
    adoPat?: string;
    adoToken?: string;
    adoCredential?: TokenCredential;
}

interface ParsedRepository {
    kind: LifecycleStateSourceKind;
    endpoint: URL;
}

function requireResolvedCommit(source: Readonly<LifecycleStateSource>): string {
    const commit = source.resolvedCommit?.trim();
    if (!commit) {
        throw new Error(`Lifecycle source ${source.sourceId} must pin resolvedCommit before remote reads`);
    }
    return commit;
}

function parseRepository(source: Readonly<LifecycleStateSource>): ParsedRepository {
    const raw = source.repositoryUrl?.trim()
        || (source.repository?.startsWith("https://") ? source.repository.trim() : "");
    if (!raw) {
        throw new Error(`Lifecycle source ${source.sourceId} requires repositoryUrl for remote reads`);
    }

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`Lifecycle source ${source.sourceId} has an invalid repositoryUrl`);
    }
    if (url.protocol !== "https:") {
        throw new Error(`Lifecycle source ${source.sourceId} repositoryUrl must use HTTPS`);
    }

    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const inferredKind: LifecycleStateSourceKind | undefined = host === "github.com"
        ? "github"
        : host === "dev.azure.com" || host.endsWith(".visualstudio.com")
            ? "ado"
            : undefined;
    const kind = source.kind ?? inferredKind;
    if (!kind || kind !== inferredKind) {
        throw new Error(`Lifecycle source ${source.sourceId} repository kind does not match its URL`);
    }

    if (kind === "github") {
        if (segments.length !== 2) {
            throw new Error(`GitHub lifecycle source ${source.sourceId} must identify one owner/repository`);
        }
        const [owner, repositoryWithSuffix] = segments;
        const repository = repositoryWithSuffix.replace(/\.git$/i, "");
        return {
            kind,
            endpoint: new URL(
                `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/`,
            ),
        };
    }

    let organization: string;
    let project: string;
    let repository: string;
    if (host === "dev.azure.com") {
        if (segments.length !== 4 || segments[2].toLowerCase() !== "_git") {
            throw new Error(`Azure DevOps lifecycle source ${source.sourceId} must use an organization/project/_git/repository URL`);
        }
        [organization, project, , repository] = segments;
    } else {
        if (segments.length !== 3 || segments[1].toLowerCase() !== "_git") {
            throw new Error(`Azure DevOps lifecycle source ${source.sourceId} must use a project/_git/repository URL`);
        }
        organization = host.slice(0, -".visualstudio.com".length);
        [project, , repository] = segments;
    }
    return {
        kind,
        endpoint: new URL(
            `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}/items`,
        ),
    };
}

/**
 * Read exact lifecycle Markdown from pinned GitHub or Azure DevOps commits.
 * A 404 means that source does not supply the requested state; every other
 * failure is surfaced to the worker.
 */
export class RemoteLifecycleStateReader implements LifecycleStateReader {
    private readonly fetchImpl: typeof fetch;
    private readonly githubToken?: string;
    private readonly adoPat?: string;
    private readonly adoToken?: string;
    private adoCredential?: TokenCredential;

    constructor(options: RemoteLifecycleStateReaderOptions = {}) {
        this.fetchImpl = options.fetch ?? fetch;
        this.githubToken = options.githubToken?.trim() || undefined;
        this.adoPat = options.adoPat?.trim() || undefined;
        this.adoToken = options.adoToken?.trim() || undefined;
        this.adoCredential = options.adoCredential;
    }

    async readStateMarkdown(
        source: Readonly<LifecycleStateSource>,
        sourcePath: string,
    ): Promise<string | null> {
        const repository = parseRepository(source);
        const commit = requireResolvedCommit(source);
        if (repository.kind === "github") {
            const endpoint = new URL(sourcePath.split("/").map(encodeURIComponent).join("/"), repository.endpoint);
            endpoint.searchParams.set("ref", commit);
            const response = await this.fetchImpl(endpoint, {
                headers: {
                    accept: "application/vnd.github.raw+json",
                    "user-agent": "PilotSwarm-lifecycle-state-loader",
                    ...(this.githubToken ? { authorization: `Bearer ${this.githubToken}` } : {}),
                },
            });
            if (response.status === 404) return null;
            if (!response.ok) {
                throw new Error(
                    `GitHub lifecycle read failed for ${source.sourceId}:${sourcePath}: HTTP ${response.status} ${await response.text()}`,
                );
            }
            const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
            if (contentType.includes("application/json") || contentType.includes("text/html")) {
                throw new Error(
                    `GitHub lifecycle read did not return raw Markdown for ${source.sourceId}:${sourcePath}`,
                );
            }
            return await response.text();
        }

        const endpoint = new URL(repository.endpoint);
        endpoint.searchParams.set("path", `/${sourcePath}`);
        endpoint.searchParams.set("versionDescriptor.versionType", "commit");
        endpoint.searchParams.set("versionDescriptor.version", commit);
        endpoint.searchParams.set("includeContent", "true");
        endpoint.searchParams.set("api-version", "7.1");
        const credentialToken = this.adoPat || this.adoToken
            ? undefined
            : await (this.adoCredential ??= new DefaultAzureCredential()).getToken(AZURE_DEVOPS_SCOPE);
        const token = this.adoPat ? undefined : this.adoToken ?? credentialToken?.token;
        const response = await this.fetchImpl(endpoint, {
            headers: {
                accept: "application/json",
                ...(this.adoPat
                    ? { authorization: `Basic ${Buffer.from(`:${this.adoPat}`, "utf8").toString("base64")}` }
                    : {}),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
        });
        if (response.status === 404) return null;
        if (response.status !== 200) {
            throw new Error(
                `Azure DevOps lifecycle read failed for ${source.sourceId}:${sourcePath}: HTTP ${response.status} ${await response.text()}`,
            );
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("json")) {
            throw new Error(
                `Azure DevOps lifecycle read did not return JSON content for ${source.sourceId}:${sourcePath}`,
            );
        }
        const body = await response.json() as { content?: unknown };
        if (typeof body.content !== "string") {
            throw new Error(`Azure DevOps lifecycle read returned no text content for ${source.sourceId}:${sourcePath}`);
        }
        return body.content;
    }
}

export function lifecycleStateMarkdownPath(
    source: Pick<LifecycleStateSource, "sourceId" | "filePrefix" | "basePath">,
    state: string,
): string {
    const sourceId = requireSourceId(source.sourceId);
    const filePrefix = requireIdentifier(source.filePrefix, "invalid_file_prefix", "filePrefix", sourceId);
    const normalizedState = requireIdentifier(state, "invalid_state", "state");
    const basePath = requireBasePath(source.basePath, sourceId);
    const filename = `${filePrefix}.${normalizedState}.md`;
    return basePath ? `${basePath}/${filename}` : filename;
}

/**
 * Load one state from separate pinned user/platform sources.
 *
 * Every source is probed for the one conventional state path. Zero matches are
 * missing; multiple matches are ambiguous until ownership policy defines
 * precedence.
 */
export async function loadLifecycleStateMarkdown(
    input: LoadLifecycleStateInput,
): Promise<Readonly<LoadedLifecycleState>> {
    const lifecycleName = requireIdentifier(
        input.lifecycleName,
        "invalid_lifecycle_name",
        "lifecycleName",
    );
    const state = requireIdentifier(input.state, "invalid_state", "state");
    if (!Array.isArray(input.sources)) {
        throw new LifecycleStateLoadError("invalid_sources", "lifecycle sources must be an array", { state });
    }

    const sourceIds = new Set<string>();
    const sources = input.sources.map((source) => {
        if (!source || typeof source !== "object" || Array.isArray(source)) {
            throw new LifecycleStateLoadError("invalid_source", "each lifecycle source must be an object", { state });
        }
        const immutable = immutableSource(source);
        if (sourceIds.has(immutable.sourceId)) {
            throw new LifecycleStateLoadError(
                "duplicate_source",
                `duplicate lifecycle source: ${immutable.sourceId}`,
                { state, sourceId: immutable.sourceId },
            );
        }
        sourceIds.add(immutable.sourceId);
        return immutable;
    });

    const results = await Promise.all(sources.map(async (source) => {
        const sourcePath = lifecycleStateMarkdownPath(source, state);
        const markdown = await input.reader.readStateMarkdown(source, sourcePath);
        if (markdown === null) return null;
        if (typeof markdown !== "string") {
            throw new LifecycleStateLoadError(
                "invalid_markdown",
                `lifecycle source ${source.sourceId} returned non-text Markdown for ${sourcePath}`,
                { state, sourceId: source.sourceId, sourcePath },
            );
        }
        return {
            source,
            sourcePath,
            markdown,
        };
    }));
    const matches = results.filter((result): result is NonNullable<typeof result> => result !== null);

    if (matches.length === 0) {
        throw new LifecycleStateLoadError(
            "state_not_found",
            `state ${state} was not found in any source for lifecycle ${lifecycleName}`,
            { state },
        );
    }
    if (matches.length > 1) {
        const sourceList = matches.map((match) => match.source.sourceId).join(", ");
        throw new LifecycleStateLoadError(
            "ambiguous_state",
            `state ${state} is supplied by multiple lifecycle sources: ${sourceList}`,
            { state },
        );
    }

    const [match] = matches;
    return Object.freeze({
        lifecycleName,
        state,
        owner: match.source.owner,
        source: match.source,
        sourcePath: match.sourcePath,
        markdown: match.markdown,
        sha256: createHash("sha256").update(match.markdown, "utf8").digest("hex"),
    });
}
