/**
 * Client-side agent-package import.
 *
 * The portal reads GitHub / Azure DevOps repos FROM THE BROWSER, using the
 * viewer's own credentials, and hands the collected files to the standard
 * upload op — so every package arrives through one mechanism (files →
 * canonical tar.gz in the artifact store) and the server never makes an
 * outbound call to a code host or stores anyone's token.
 *
 * Host-agnostic on purpose: `fetch` and the auth token are injected, so this
 * is exercised by plain node tests. Base64 encoding works in both runtimes.
 *
 * GitHub: the tree listing comes from api.github.com (1 request); file bytes
 * come from raw.githubusercontent.com when anonymous (CORS-open, no API rate
 * limit) or from the blobs API when a PAT is supplied (private repos).
 * Azure DevOps: items + blobs REST, authorized with an Entra bearer token
 * (the signed-in user) or a PAT via Basic.
 */

import { parseAgentSourceLink } from "./repo-links.js";

/** The upload envelope the portal accepts (server enforces the same). */
export const IMPORT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

const SKIP_SEGMENTS = new Set(["node_modules", ".git"]);

function bytesToBase64(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== "undefined") return Buffer.from(view).toString("base64");
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < view.length; index += chunk) {
        binary += String.fromCharCode.apply(null, view.subarray(index, index + chunk));
    }
    return btoa(binary);
}

function base64ToBytes(content) {
    const compact = String(content || "").replace(/\s+/gu, "");
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(compact, "base64"));
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function isSkippedPath(relativePath) {
    return relativePath.split("/").some((segment) => SKIP_SEGMENTS.has(segment));
}

/** Normalize a link's path into the package root (dir holding plugin.json). */
function packageRootFromLinkPath(linkPath) {
    const trimmed = String(linkPath || "").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!trimmed) return "";
    return trimmed.endsWith("/plugin.json")
        ? trimmed.slice(0, -"/plugin.json".length)
        : (trimmed === "plugin.json" ? "" : trimmed);
}

function joinRoot(root, relative) {
    return root ? `${root}/${relative}` : relative;
}

/**
 * A network-level failure in the browser is opaque by design (CORS, DNS,
 * blocked). Say what it most likely is instead of "Failed to fetch".
 */
function describeNetworkFailure(host, error) {
    const detail = String(error?.message || error || "");
    return new Error(
        `could not reach ${host} from the browser (${detail || "network error"}) — `
        + "the host may block cross-origin reads from this portal; use Upload folder instead",
    );
}

async function fetchJson(fetchImpl, url, headers, host) {
    let response;
    try {
        response = await fetchImpl(url, { headers: { accept: "application/json", ...headers } });
    } catch (error) {
        throw describeNetworkFailure(host, error);
    }
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${host} returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    return response.json();
}

async function fetchBytes(fetchImpl, url, headers, host) {
    let response;
    try {
        response = await fetchImpl(url, { headers });
    } catch (error) {
        throw describeNetworkFailure(host, error);
    }
    if (!response.ok) {
        throw new Error(`${host} returned HTTP ${response.status} for ${url}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
}

// ─── GitHub ──────────────────────────────────────────────────────

function parseGitHubRepo(repoUrl) {
    const segments = new URL(repoUrl).pathname.split("/").filter(Boolean);
    if (segments.length < 2) throw new Error(`not a GitHub repository URL: ${repoUrl}`);
    return { owner: segments[0], repo: segments[1].replace(/\.git$/u, "") };
}

async function collectGitHubFiles({ repoUrl, ref, path: linkPath }, { fetchImpl, token, onProgress }) {
    const { owner, repo } = parseGitHubRepo(repoUrl);
    const api = "https://api.github.com";
    const headers = {
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
    };

    let branch = ref;
    if (!branch) {
        onProgress("resolving the default branch…");
        const meta = await fetchJson(fetchImpl, `${api}/repos/${owner}/${repo}`, headers, "api.github.com");
        branch = meta?.default_branch || "main";
    }

    onProgress(`reading the file tree of ${owner}/${repo}@${branch}…`);
    const tree = await fetchJson(
        fetchImpl,
        `${api}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        headers,
        "api.github.com",
    );
    if (tree?.truncated) {
        throw new Error("this repository's file tree is too large for the API listing — point the link at the package folder");
    }
    const entries = Array.isArray(tree?.tree) ? tree.tree : [];
    const root = packageRootFromLinkPath(linkPath);
    const manifestPath = joinRoot(root, "plugin.json");
    if (!entries.some((entry) => entry.type === "blob" && entry.path === manifestPath)) {
        throw new Error(`no plugin.json at ${manifestPath || "the repository root"} on ${branch} — link to the folder that contains the manifest`);
    }

    const prefix = root ? `${root}/` : "";
    const wanted = entries.filter((entry) =>
        entry.type === "blob"
        && (!prefix || entry.path.startsWith(prefix))
        && !isSkippedPath(entry.path.slice(prefix.length)));

    const files = [];
    let total = 0;
    let index = 0;
    for (const entry of wanted) {
        index += 1;
        const relative = entry.path.slice(prefix.length);
        onProgress(`fetching ${index}/${wanted.length}: ${relative}`);
        const bytes = token
            ? await fetchGitHubBlobViaApi(fetchImpl, api, owner, repo, entry.sha, headers)
            : await fetchBytes(
                fetchImpl,
                `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${entry.path.split("/").map(encodeURIComponent).join("/")}`,
                {},
                "raw.githubusercontent.com",
            );
        total += bytes.length;
        if (total > IMPORT_MAX_TOTAL_BYTES) {
            throw new Error(`package exceeds the ${Math.round(IMPORT_MAX_TOTAL_BYTES / 1024)} KB upload limit at ${relative}`);
        }
        files.push({ path: relative, contentBase64: bytesToBase64(bytes) });
    }
    return files;
}

async function fetchGitHubBlobViaApi(fetchImpl, api, owner, repo, sha, headers) {
    const blob = await fetchJson(fetchImpl, `${api}/repos/${owner}/${repo}/git/blobs/${sha}`, headers, "api.github.com");
    const content = String(blob?.content || "").replace(/\s+/gu, "");
    if (blob?.encoding && blob.encoding !== "base64") {
        throw new Error(`unexpected blob encoding "${blob.encoding}" from api.github.com`);
    }
    return base64ToBytes(content);
}

// ─── Azure DevOps ────────────────────────────────────────────────

export function parseAdoRepoUrl(repoUrl) {
    const url = new URL(repoUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const gitIndex = segments.indexOf("_git");
    if (gitIndex < 0 || gitIndex === segments.length - 1) {
        throw new Error(`not an Azure DevOps repository URL: ${repoUrl}`);
    }
    const repo = decodeURIComponent(segments[gitIndex + 1]);
    const before = segments.slice(0, gitIndex).map(decodeURIComponent);
    const host = url.hostname.toLowerCase();
    // dev.azure.com/{org}/{project}/_git/{repo} vs {org}.visualstudio.com/{project}/_git/{repo}
    const org = host.endsWith(".visualstudio.com") ? host.split(".")[0] : before[0];
    const project = host.endsWith(".visualstudio.com") ? before[0] : before[1];
    if (!org || !project) throw new Error(`could not read org/project from ${repoUrl}`);
    return { org, project, repo };
}

async function collectAdoFiles({ repoUrl, ref, path: linkPath }, { fetchImpl, token, tokenKind, onProgress }) {
    if (!token) {
        throw new Error("Azure DevOps needs a credential — sign-in did not yield a token; paste a PAT with Code (read)");
    }
    const { org, project, repo } = parseAdoRepoUrl(repoUrl);
    const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
    const authorization = tokenKind === "pat"
        ? `Basic ${bytesToBase64(new TextEncoder().encode(`:${token}`))}`
        : `Bearer ${token}`;
    const headers = { authorization };
    const root = packageRootFromLinkPath(linkPath);
    const scopePath = `/${root}`;
    const version = ref ? `&versionDescriptor.version=${encodeURIComponent(ref)}&versionDescriptor.versionType=branch` : "";

    onProgress(`reading ${repo}${root ? `/${root}` : ""}…`);
    const listing = await fetchJson(
        fetchImpl,
        `${base}/items?scopePath=${encodeURIComponent(scopePath)}&recursionLevel=Full${version}&api-version=7.1`,
        headers,
        "dev.azure.com",
    );
    const items = Array.isArray(listing?.value) ? listing.value : [];
    const blobs = items.filter((item) => item?.gitObjectType === "blob" && !item?.isFolder);
    const prefix = root ? `/${root}/` : "/";
    const manifest = blobs.find((item) => item.path === `${prefix}plugin.json`.replace("//", "/"));
    if (!manifest) {
        throw new Error(`no plugin.json under ${scopePath} — link to the folder that contains the manifest`);
    }

    const files = [];
    let total = 0;
    let index = 0;
    for (const item of blobs) {
        const relative = String(item.path || "").slice(prefix.length);
        if (!relative || isSkippedPath(relative)) continue;
        index += 1;
        onProgress(`fetching ${index}/${blobs.length}: ${relative}`);
        const bytes = await fetchBytes(
            fetchImpl,
            `${base}/blobs/${encodeURIComponent(item.objectId)}?api-version=7.1&$format=octetStream`,
            { ...headers, accept: "application/octet-stream" },
            "dev.azure.com",
        );
        total += bytes.length;
        if (total > IMPORT_MAX_TOTAL_BYTES) {
            throw new Error(`package exceeds the ${Math.round(IMPORT_MAX_TOTAL_BYTES / 1024)} KB upload limit at ${relative}`);
        }
        files.push({ path: relative, contentBase64: bytesToBase64(bytes) });
    }
    return files;
}

// ─── entry point ─────────────────────────────────────────────────

/**
 * Read a package from a pasted repo link, in the browser, as the viewer.
 * Returns upload-ready files ([{path, contentBase64}]) relative to the
 * package root (the directory holding plugin.json).
 */
export async function importPackageFilesFromLink(link, {
    fetchImpl = (typeof fetch === "function" ? fetch : null),
    token = null,
    tokenKind = "bearer",
    onProgress = () => {},
} = {}) {
    if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available");
    const parsed = parseAgentSourceLink(link);
    if (parsed.error) throw new Error(parsed.error);
    const options = { fetchImpl, token, tokenKind, onProgress };
    const files = parsed.kind === "github"
        ? await collectGitHubFiles(parsed, options)
        : await collectAdoFiles(parsed, options);
    if (files.length === 0) throw new Error("the package folder is empty");
    return { kind: parsed.kind, files };
}

/**
 * The package name from an imported file set's manifest, or null when the
 * manifest is missing or unreadable. A package's IDENTITY is its manifest
 * name, so "update this package" has to check it: pointing the update dialog
 * at a folder that builds something else would otherwise publish a second
 * package under a different name and report success.
 */
export function readImportedPackageName(files = []) {
    const manifest = (Array.isArray(files) ? files : []).find((file) => file?.path === "plugin.json");
    if (!manifest?.contentBase64) return null;
    try {
        const bytes = base64ToBytes(manifest.contentBase64);
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        const name = String(parsed?.name || "").trim();
        return name || null;
    } catch {
        // Unreadable here is not the update path's problem to report: the
        // server validates the manifest and says so precisely.
        return null;
    }
}
