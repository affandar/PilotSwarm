/**
 * Agent package source fetchers — GitHub / Azure DevOps / URL archives.
 *
 * Each fetcher resolves a source to (extracted directory, commit sha) in a
 * temp dir; syncAgentSourceOnce then locates the registered subdirectory and
 * rides the one publish pipeline (validate → canonical pack → artifact →
 * registry). No git binary anywhere — pure REST archive downloads, matching
 * the images (node slim, no git, tar present).
 *
 * Upstream archives are UNTRUSTED input in shape (even in a trusted system,
 * a repo can contain surprising tars): tar extraction pre-scans the listing
 * and rejects absolute paths and "..", the zip reader enforces the same, and
 * whatever survives extraction is then re-validated + canonically repacked —
 * symlinks and junk never reach the registry.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { spawn } from "child_process";
import type { AgentSourceRow, SessionCatalog } from "./cms.js";
import type { AgentPackagePublishContext, PublishOutcome } from "./agent-package-service.js";
import { publishAgentPackageDir } from "./agent-package-service.js";
import { AGENT_PACKAGE_MAX_COMPRESSED_BYTES } from "./agent-package-format.js";

// Upstream archives are bigger than packed packages (whole repo vs one dir),
// but still bounded: nothing legitimate needs more than this.
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_INFLATED_ENTRY_BYTES = 128 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 60_000;

interface FetchedSource {
    /** Directory containing the repo/archive content (prefix dirs collapsed). */
    rootDir: string;
    commitSha: string | null;
    cleanup: () => void;
}

function assertSafeArchivePath(name: string): void {
    const normalized = name.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
        throw new Error(`archive entry has non-relative path: ${name}`);
    }
    if (normalized.split("/").some((part) => part === "..")) {
        throw new Error(`archive entry escapes extraction root: ${name}`);
    }
}

async function fetchWithTimeout(url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
    } finally {
        clearTimeout(timer);
    }
}

async function downloadToFile(url: string, headers: Record<string, string>, destFile: string): Promise<void> {
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) {
        throw new Error(`download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_ARCHIVE_BYTES) {
        throw new Error(`archive too large: ${declared} bytes (limit ${MAX_ARCHIVE_BYTES})`);
    }
    // Stream with a running cap — Content-Length is advisory, not a bound.
    const reader = res.body?.getReader?.();
    if (!reader) {
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error(`archive too large: ${bytes.length} bytes`);
        fs.writeFileSync(destFile, bytes);
        return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ARCHIVE_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error(`archive too large: exceeded ${MAX_ARCHIVE_BYTES} bytes while downloading`);
        }
        chunks.push(Buffer.from(value));
    }
    fs.writeFileSync(destFile, Buffer.concat(chunks));
}

// ─── tar.gz extraction (system tar + pre-scan) ───────────────────

async function runTar(args: string[]): Promise<string> {
    return await new Promise((resolve, reject) => {
        const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += String(d); });
        child.stderr.on("data", (d) => { stderr += String(d); });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`tar ${args[0]} failed (exit ${code}): ${stderr.trim().slice(0, 500)}`));
        });
    });
}

async function extractTarGzArchive(archiveFile: string, destDir: string): Promise<void> {
    const listing = await runTar(["-tzf", archiveFile]);
    for (const line of listing.split("\n")) {
        const name = line.trim();
        if (name) assertSafeArchivePath(name);
    }
    fs.mkdirSync(destDir, { recursive: true });
    await runTar(["--no-same-owner", "-xzf", archiveFile, "-C", destDir]);
}

// ─── zip extraction (minimal reader: stored + deflate) ───────────
// ADO's items API only serves $format=zip and the images ship no unzip
// binary, so this stays dependency-free.

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

export function extractZipArchive(zip: Buffer, destDir: string): void {
    // EOCD: scan the trailing 64KB+22 for the signature.
    let eocd = -1;
    const scanStart = Math.max(0, zip.length - 65_557);
    for (let i = zip.length - 22; i >= scanStart; i--) {
        if (zip.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("zip: end-of-central-directory not found");
    const entryCount = zip.readUInt16LE(eocd + 10);
    let offset = zip.readUInt32LE(eocd + 16);

    const root = path.resolve(destDir);
    fs.mkdirSync(root, { recursive: true });
    for (let i = 0; i < entryCount; i++) {
        if (zip.readUInt32LE(offset) !== CDFH_SIG) throw new Error("zip: bad central directory entry");
        const method = zip.readUInt16LE(offset + 10);
        const compressedSize = zip.readUInt32LE(offset + 20);
        const nameLen = zip.readUInt16LE(offset + 28);
        const extraLen = zip.readUInt16LE(offset + 30);
        const commentLen = zip.readUInt16LE(offset + 32);
        const localOffset = zip.readUInt32LE(offset + 42);
        const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
        offset += 46 + nameLen + extraLen + commentLen;

        assertSafeArchivePath(name);
        const target = path.resolve(root, name);
        if (target !== root && !target.startsWith(root + path.sep)) {
            throw new Error(`zip entry escapes destination: ${name}`);
        }
        if (name.endsWith("/")) {
            fs.mkdirSync(target, { recursive: true });
            continue;
        }
        if (zip.readUInt32LE(localOffset) !== LFH_SIG) throw new Error(`zip: bad local header for ${name}`);
        const lfhNameLen = zip.readUInt16LE(localOffset + 26);
        const lfhExtraLen = zip.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lfhNameLen + lfhExtraLen;
        const data = zip.subarray(dataStart, dataStart + compressedSize);
        let body: Buffer;
        if (method === 0) body = Buffer.from(data);
        else if (method === 8) body = zlib.inflateRawSync(data, { maxOutputLength: MAX_INFLATED_ENTRY_BYTES });
        else throw new Error(`zip: unsupported compression method ${method} for ${name}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
    }
}

/** Collapse single-directory archive prefixes (github tarball style). */
function collapseSingleRoot(dir: string): string {
    const entries = fs.readdirSync(dir).filter((n) => n !== "__MACOSX");
    if (entries.length === 1) {
        const only = path.join(dir, entries[0]);
        // lstat: a lone root SYMLINK must never be followed — validation
        // would otherwise walk (and name files from) its target directory.
        if (fs.lstatSync(only).isDirectory()) return only;
    }
    return dir;
}

// ─── per-kind fetchers ───────────────────────────────────────────

function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } {
    const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl ?? "");
    if (!match) throw new Error(`not a recognizable GitHub repo URL: ${repoUrl}`);
    return { owner: match[1], repo: match[2] };
}

/**
 * Entra access token for Azure DevOps (resource 499b84ac-…) from the
 * deployment's ambient identity (workload identity / managed identity /
 * az login in dev). Bounded and best-effort: null means "no ambient
 * identity here" and the caller falls through to anonymous.
 */
async function acquireAdoIdentityToken(): Promise<string | null> {
    try {
        const { DefaultAzureCredential } = await import("@azure/identity");
        const credential = new DefaultAzureCredential();
        const token = await Promise.race([
            credential.getToken("499b84ac-1321-427f-aa17-267ca6975798/.default"),
            new Promise<null>((resolve) => {
                const timer = setTimeout(() => resolve(null), 8_000);
                timer.unref?.();
            }),
        ]);
        return token && typeof token === "object" && "token" in token ? (token as { token: string }).token : null;
    } catch {
        return null;
    }
}

async function fetchGitHub(source: AgentSourceRow, token: string | null, tmpDir: string): Promise<FetchedSource> {
    const { owner, repo } = parseGitHubRepo(source.repoUrl ?? "");
    const headers: Record<string, string> = {
        "user-agent": "pilotswarm-agent-packages",
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const ref = source.ref || "HEAD";
    const commitRes = await fetchWithTimeout(
        `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
        { headers },
    );
    if (!commitRes.ok) {
        throw new Error(`GitHub ref resolution failed: HTTP ${commitRes.status} for ${owner}/${repo}@${ref}`);
    }
    const commitSha = String(((await commitRes.json()) as any)?.sha ?? "");
    if (!commitSha) throw new Error(`GitHub ref resolution returned no sha for ${owner}/${repo}@${ref}`);

    const archive = path.join(tmpDir, "src.tar.gz");
    await downloadToFile(`https://api.github.com/repos/${owner}/${repo}/tarball/${commitSha}`, headers, archive);
    const extractDir = path.join(tmpDir, "x");
    await extractTarGzArchive(archive, extractDir);
    return { rootDir: collapseSingleRoot(extractDir), commitSha, cleanup: () => {} };
}

function parseAdoRepo(repoUrl: string): { org: string; project: string; repo: string } {
    const match = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/.exec(repoUrl ?? "");
    if (!match) throw new Error(`not a recognizable Azure DevOps repo URL (expected https://dev.azure.com/{org}/{project}/_git/{repo}): ${repoUrl}`);
    return { org: match[1], project: decodeURIComponent(match[2]), repo: decodeURIComponent(match[3]) };
}

async function fetchAdo(source: AgentSourceRow, token: string | null, tmpDir: string): Promise<FetchedSource> {
    const { org, project, repo } = parseAdoRepo(source.repoUrl ?? "");
    const base = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
    // A PAT authenticates as Basic; an Entra access token (three dot-joined
    // JWT segments — the workload-identity fallback) authenticates as Bearer.
    const isJwt = Boolean(token && token.split(".").length === 3);
    const headers: Record<string, string> = {
        "user-agent": "pilotswarm-agent-packages",
        ...(token
            ? { authorization: isJwt ? `Bearer ${token}` : `Basic ${Buffer.from(`:${token}`).toString("base64")}` }
            : {}),
    };
    const ref = source.ref || "main";
    const refRes = await fetchWithTimeout(
        `${base}/refs?filter=heads/${encodeURIComponent(ref)}&api-version=7.1`, { headers },
    );
    if (refRes.status === 401 || refRes.status === 203) {
        throw new Error(
            `Azure DevOps rejected the request for ${repo}@${ref}`
            + (token
                ? " — the supplied credential lacks repo read access"
                : " — supply a PAT, or grant this deployment's workload identity read access to the repo"),
        );
    }
    if (!refRes.ok) throw new Error(`ADO ref resolution failed: HTTP ${refRes.status} for ${repo}@${ref}`);
    const refBody: any = await refRes.json();
    const commitSha: string | null = refBody?.value?.[0]?.objectId ?? null;
    if (!commitSha) throw new Error(`ADO branch not found: ${repo}@${ref}`);

    const archive = path.join(tmpDir, "src.zip");
    await downloadToFile(
        `${base}/items?path=/&versionDescriptor.version=${encodeURIComponent(ref)}&versionDescriptor.versionType=branch&$format=zip&resolveLfs=true&api-version=7.1`,
        headers, archive,
    );
    const extractDir = path.join(tmpDir, "x");
    extractZipArchive(fs.readFileSync(archive), extractDir);
    return { rootDir: collapseSingleRoot(extractDir), commitSha, cleanup: () => {} };
}

async function fetchUrl(source: AgentSourceRow, token: string | null, tmpDir: string): Promise<FetchedSource> {
    const url = source.url ?? "";
    if (!/^https?:\/\//.test(url)) throw new Error(`source url must be http(s): ${url}`);
    const headers: Record<string, string> = {
        "user-agent": "pilotswarm-agent-packages",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
    const isZip = /\.zip($|\?)/i.test(url);
    const archive = path.join(tmpDir, isZip ? "src.zip" : "src.tar.gz");
    await downloadToFile(url, headers, archive);
    const extractDir = path.join(tmpDir, "x");
    if (isZip) extractZipArchive(fs.readFileSync(archive), extractDir);
    else await extractTarGzArchive(archive, extractDir);
    return { rootDir: collapseSingleRoot(extractDir), commitSha: null, cleanup: () => {} };
}

// ─── sync orchestration ──────────────────────────────────────────

export interface SyncSourceResult {
    status: "published" | "noop" | "unchanged" | "error";
    commitSha: string | null;
    outcome?: PublishOutcome;
    error?: string;
}

/**
 * One full sync pass for a registered source. Records the result on the
 * source row (last_sync_*) and never throws — callers read `status`.
 * `reservedAgentNames` guards baked-agent shadowing at validation time.
 */
export async function syncAgentSourceOnce(
    ctx: AgentPackagePublishContext & { catalog: SessionCatalog },
    sourceId: string,
    opts: { isAdmin: boolean; reservedAgentNames?: string[] } ,
): Promise<SyncSourceResult> {
    const source = await ctx.catalog.getAgentSource(sourceId);
    if (!source) return { status: "error", commitSha: null, error: `source ${sourceId} not found` };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-agent-sync-"));
    try {
        // Credential chain: stored PAT → (GitHub) the registering user's
        // stored GitHub key → (ADO) the deployment's Entra workload identity
        // → anonymous. "PAT optional" means the user's identity does the work
        // when one is not supplied.
        let token = await ctx.catalog.getAgentSourceToken(sourceId);
        if (!token && source.kind === "github" && source.owner) {
            token = await ctx.catalog.getUserGitHubCopilotKey(source.owner).catch(() => null);
        }
        if (!token && source.kind === "ado") {
            token = await acquireAdoIdentityToken();
        }
        let fetched: FetchedSource;
        switch (source.kind) {
            case "github": fetched = await fetchGitHub(source, token, tmpDir); break;
            case "ado": fetched = await fetchAdo(source, token, tmpDir); break;
            case "url": fetched = await fetchUrl(source, token, tmpDir); break;
            default:
                return { status: "error", commitSha: null, error: `source kind "${source.kind}" cannot be synced` };
        }

        // Same-commit short-circuit: nothing to download twice, nothing to pack.
        if (fetched.commitSha && source.lastCommitSha === fetched.commitSha && source.lastSyncStatus === "ok") {
            await ctx.catalog.updateAgentSourceSync(sourceId, "ok", null, fetched.commitSha);
            return { status: "unchanged", commitSha: fetched.commitSha };
        }

        const packageDir = source.path
            ? path.join(fetched.rootDir, source.path.replace(/^\/+/, ""))
            : fetched.rootDir;
        const resolvedPackageDir = path.resolve(packageDir);
        if (resolvedPackageDir !== path.resolve(fetched.rootDir)
            && !resolvedPackageDir.startsWith(path.resolve(fetched.rootDir) + path.sep)) {
            throw new Error(`source path escapes the fetched repository: ${source.path}`);
        }
        if (!fs.existsSync(resolvedPackageDir)) {
            throw new Error(`path "${source.path}" does not exist in the fetched ${source.kind} source`);
        }
        // The registered path may point at the MANIFEST FILE itself
        // (plugin.json) rather than its directory — the manifest is the
        // package's anchor, so both spellings mean the same package.
        const packageRoot = fs.statSync(resolvedPackageDir).isFile()
            ? (path.basename(resolvedPackageDir) === "plugin.json"
                ? path.dirname(resolvedPackageDir)
                : (() => { throw new Error(`path "${source.path}" must be a package directory or its plugin.json manifest`); })())
            : resolvedPackageDir;

        const outcome = await publishAgentPackageDir(ctx, {
            dir: packageRoot,
            scope: source.scope,
            owner: source.owner,
            createdBy: source.createdBy,
            isAdmin: opts.isAdmin,
            sourceId,
            commitSha: fetched.commitSha,
            validate: { reservedAgentNames: opts.reservedAgentNames },
        });
        await ctx.catalog.updateAgentSourceSync(sourceId, "ok", null, fetched.commitSha);
        return { status: outcome.status, commitSha: fetched.commitSha, outcome };
    } catch (error: any) {
        const message = String(error?.message ?? error);
        try { await ctx.catalog.updateAgentSourceSync(sourceId, "error", message.slice(0, 2000), null); } catch { /* ignore */ }
        return { status: "error", commitSha: null, error: message };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}
