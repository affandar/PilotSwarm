/**
 * PluginSpec — deployment-configured external plugin sources.
 *
 * A single `PLUGIN_SPEC` deployment env var carries a ';'-delimited list of
 * plugin specs. Each spec names an external repository + subpath that
 * contributes agents/skills. At worker startup we download each source to
 * local pod storage and append the resolved directory to the worker's
 * `pluginDirs`, so the GHCP SDK loads it exactly like any other plugin dir
 * (agents from `<dir>/agents/*.agent.md`, skills from `<dir>/skills/<name>/SKILL.md`).
 *
 * Grammar (one entry, ';'-delimited):
 *
 *   ado-git:<org>/<project>/<repo>:<path/to/plugin>[@<ref>]
 *   github:<owner>/<repo>:<path/to/plugin>[@<ref>]
 *   local:<absolute-or-relative-path>
 *
 * Example:
 *
 *   ado-git:contoso/Example Project/tools-repo:plugins/example
 *
 * The `:` after the repo separates the repo coordinates from the in-repo path;
 * the rightmost `@` in the path portion separates an optional git ref.
 *
 * `ado-git:` is the fully-supported download path today. `github:` is
 * best-effort (token auth) and `local:` is a passthrough for already-present
 * directories; both are recognized so a spec never silently changes meaning.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";
import { createGitPluginSourceResolver, type GitPluginSourceResolver } from "./git-plugin-source.js";
import { installPluginSpecs as installValidatedPluginSpecs } from "./plugin-installer.js";
import {
    caseFoldPluginPath,
    normalizedPluginSpecKey,
    parsePluginSpecs as parseValidatedPluginSpecs,
    type PluginSpec as ValidatedPluginSpec,
} from "./plugin-source-spec.js";

/** Recognized spec scheme prefixes. Adding a scheme is a single-touch change. */
export const PLUGIN_SPEC_SCHEMES = {
    AdoGit: "ado-git:",
    GitHub: "github:",
    Local: "local:",
} as const;

export type PluginSpecScheme = "ado-git" | "github" | "local";

export interface PluginSpecEntry {
    /** The original, untrimmed-of-scheme spec string (for logs/errors). */
    raw: string;
    scheme: PluginSpecScheme;
    /** ADO organization (ado-git only). */
    org?: string;
    /** ADO project — may contain spaces (ado-git only). */
    project?: string;
    /** Repository name (ado-git and github). */
    repo?: string;
    /** GitHub owner (github only). */
    owner?: string;
    /** In-repo path to the plugin directory (ado-git/github), or the local path. */
    path: string;
    /** Optional git ref (branch/tag/commit). Absent → repo default branch. */
    ref?: string;
}

export interface PluginSpecInstallResult {
    /** Parsed entry, or null when the raw entry itself was malformed. */
    entry: PluginSpecEntry | null;
    /** Trimmed deployment entry, retained for diagnostics when parsing fails. */
    raw: string;
    /** Absolute resolved plugin directory (present iff status === "ok"). */
    dir: string | null;
    status: "ok" | "error";
    error?: string;
}

export interface InstallPluginSpecsResult {
    /** Plugin dirs of every OK entry, in spec order — ready to append to pluginDirs. */
    pluginDirs: string[];
    results: PluginSpecInstallResult[];
}

/**
 * Parse a raw `PLUGIN_SPEC` value into structured entries. Malformed entries
 * throw with a message naming the offending spec; callers that want
 * fault-isolation should parse+install one entry at a time, but a malformed
 * deployment value is a hard misconfiguration worth surfacing loudly.
 */
export function parsePluginSpec(raw: string | undefined | null): PluginSpecEntry[] {
    if (!raw || !raw.trim()) return [];
    const entries: PluginSpecEntry[] = [];
    for (const chunk of raw.split(";")) {
        const spec = chunk.trim();
        if (!spec) continue;
        entries.push(parseOne(spec));
    }
    return entries;
}

function parseOne(spec: string): PluginSpecEntry {
    if (startsWithCI(spec, PLUGIN_SPEC_SCHEMES.AdoGit)) {
        const rest = spec.slice(PLUGIN_SPEC_SCHEMES.AdoGit.length);
        const { repoPart, pathPart } = splitRepoAndPath(rest, spec);
        const { path: relPath, ref } = splitRef(pathPart);
        validatePluginPath(relPath, spec);
        const segs = repoPart.split("/").map((s) => s.trim()).filter(Boolean);
        if (segs.length < 3) {
            throw new Error(
                `PluginSpec: ado-git spec must be fully qualified as ` +
                `'ado-git:<org>/<project>/<repo>:<path>' — got '${spec}'`,
            );
        }
        // org and repo are the first and last segments; everything between is
        // the project (ADO projects never contain '/', so this is exactly one
        // segment, but slicing is robust to accidental extra slashes).
        const org = segs[0];
        const repo = trimGitSuffix(segs[segs.length - 1]);
        const project = segs.slice(1, segs.length - 1).join("/");
        return { raw: spec, scheme: "ado-git", org, project, repo, path: relPath, ref };
    }

    if (startsWithCI(spec, PLUGIN_SPEC_SCHEMES.GitHub)) {
        const rest = spec.slice(PLUGIN_SPEC_SCHEMES.GitHub.length);
        const { repoPart, pathPart } = splitRepoAndPath(rest, spec);
        const { path: relPath, ref } = splitRef(pathPart);
        validatePluginPath(relPath, spec);
        const segs = repoPart.split("/").map((s) => s.trim()).filter(Boolean);
        if (segs.length < 2) {
            throw new Error(
                `PluginSpec: github spec must be 'github:<owner>/<repo>:<path>' — got '${spec}'`,
            );
        }
        return { raw: spec, scheme: "github", owner: segs[0], repo: trimGitSuffix(segs[1]), path: relPath, ref };
    }

    if (startsWithCI(spec, PLUGIN_SPEC_SCHEMES.Local)) {
        const rest = spec.slice(PLUGIN_SPEC_SCHEMES.Local.length).trim();
        if (!rest) throw new Error(`PluginSpec: local spec needs a path — got '${spec}'`);
        return { raw: spec, scheme: "local", path: rest };
    }

    throw new Error(
        `PluginSpec: unrecognized scheme in '${spec}' — expected one of ` +
        `'ado-git:', 'github:', or 'local:'`,
    );
}

/**
 * Split `<repo-coords>:<path>` at the FIRST ':'. The repo coordinates never
 * contain ':'; a path might in theory, but ADO/GitHub plugin paths do not, and
 * the first-colon rule keeps the repo coordinates and path unambiguous.
 */
function splitRepoAndPath(rest: string, spec: string): { repoPart: string; pathPart: string } {
    const colon = rest.indexOf(":");
    if (colon < 0) {
        throw new Error(
            `PluginSpec: missing ':<path>' plugin path in '${spec}' — expected ` +
            `'<scheme>:<repo-coords>:<path/to/plugin>'`,
        );
    }
    return { repoPart: rest.slice(0, colon).trim(), pathPart: rest.slice(colon + 1).trim() };
}

/** Split an optional git ref off the path at the RIGHTMOST '@'. */
function splitRef(pathPart: string): { path: string; ref?: string } {
    const at = pathPart.lastIndexOf("@");
    if (at <= 0) return { path: pathPart };
    return { path: pathPart.slice(0, at).trim(), ref: pathPart.slice(at + 1).trim() || undefined };
}

function validatePluginPath(p: string, spec: string): void {
    if (!p) throw new Error(`PluginSpec: empty plugin path in '${spec}'`);
    if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
        throw new Error(`PluginSpec: plugin path must be relative in '${spec}'`);
    }
    const lowered = p.toLowerCase();
    if (p.split(/[\\/]/).includes("..") || lowered.includes("%2e%2e")) {
        throw new Error(`PluginSpec: plugin path must not contain traversal in '${spec}'`);
    }
}

function startsWithCI(value: string, prefix: string): boolean {
    return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

function trimGitSuffix(repo: string): string {
    return repo.toLowerCase().endsWith(".git") ? repo.slice(0, -".git".length) : repo;
}

/**
 * Build the ADO clone URL. Uses the `<org>.visualstudio.com` host form with a
 * URL-encoded project (spaces → %20), matching the git-cache mirror URL shape
 * (e.g. https://<org>.visualstudio.com/Example%20Project/_git/<repo>).
 */
export function adoCloneUrl(org: string, project: string, repo: string): string {
    return `https://${org}.visualstudio.com/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
}

/** GitHub clone URL (https). */
function githubCloneUrl(owner: string, repo: string): string {
    return `https://github.com/${owner}/${repo}`;
}

/**
 * Fetch a secret value from Azure Key Vault using the ambient workload/managed
 * identity — so a private-repo PAT never has to live in a Kubernetes Secret.
 *
 * Uses `@azure/identity` (already an SDK dependency, the same
 * `DefaultAzureCredential` the blob + pg factories use) to mint an AAD token
 * for the Key Vault data plane, then calls the Key Vault REST endpoint over the
 * node `https` builtin — adding NO `@azure/keyvault-secrets` dependency. The
 * caller passes the vault + secret name; the returned value is the raw secret
 * (never logged here).
 */
export async function fetchKeyVaultSecret(opts: {
    vaultName: string;
    secretName: string;
    trace?: (message: string) => void;
}): Promise<string> {
    const { DefaultAzureCredential } = await import("@azure/identity");
    const credential = new DefaultAzureCredential();
    const token = await credential.getToken("https://vault.azure.net/.default");
    if (!token?.token) {
        throw new Error("Key Vault: managed identity returned no AAD token (getToken empty)");
    }
    const url =
        `https://${opts.vaultName}.vault.azure.net/secrets/` +
        `${encodeURIComponent(opts.secretName)}?api-version=7.4`;
    opts.trace?.(
        `[plugin-spec] fetching secret ${opts.vaultName}/${opts.secretName} ` +
        `from Key Vault via managed identity`,
    );
    const { status, body } = await httpsGetJson(url, { Authorization: `Bearer ${token.token}` });
    if (status !== 200) {
        throw new Error(`Key Vault GET ${opts.vaultName}/${opts.secretName} failed: HTTP ${status}`);
    }
    let parsed: { value?: string };
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error(`Key Vault GET ${opts.vaultName}/${opts.secretName} returned non-JSON body`);
    }
    if (!parsed?.value) {
        throw new Error(`Key Vault secret ${opts.vaultName}/${opts.secretName} has no value`);
    }
    return parsed.value;
}

function httpsGetJson(
    url: string,
    headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        });
        req.on("error", reject);
        req.end();
    });
}

/** Mint a Key Vault data-plane AAD token via DefaultAzureCredential (the same
 * credential the blob + pg factories and `fetchKeyVaultSecret` use). */
async function keyVaultAadToken(): Promise<string> {
    const { DefaultAzureCredential } = await import("@azure/identity");
    const credential = new DefaultAzureCredential();
    const token = await credential.getToken("https://vault.azure.net/.default");
    if (!token?.token) {
        throw new Error("Key Vault: managed identity returned no AAD token (getToken empty)");
    }
    return token.token;
}

/** Minimal https request with a method + optional body (GET/PUT/DELETE), used
 * for the Key Vault REST data plane without adding @azure/keyvault-secrets. */
function httpsRequestJson(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request(
            {
                method,
                hostname: u.hostname,
                path: u.pathname + u.search,
                port: u.port || 443,
                headers,
            },
            (res) => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
            },
        );
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

/**
 * Read a Key Vault secret, returning null when it does not exist (HTTP 404)
 * instead of throwing. For optional per-session secrets whose absence is the
 * common case (a session created without a delegated caller credential). Other
 * non-200 statuses still throw. The value is never logged here.
 */
export async function getKeyVaultSecretOptional(opts: {
    vaultName: string;
    secretName: string;
    trace?: (message: string) => void;
}): Promise<string | null> {
    const aad = await keyVaultAadToken();
    const url =
        `https://${opts.vaultName}.vault.azure.net/secrets/` +
        `${encodeURIComponent(opts.secretName)}?api-version=7.4`;
    const { status, body } = await httpsRequestJson("GET", url, {
        Authorization: `Bearer ${aad}`,
        Accept: "application/json",
    });
    if (status === 404) return null;
    if (status !== 200) {
        throw new Error(`Key Vault GET ${opts.vaultName}/${opts.secretName} failed: HTTP ${status}`);
    }
    try {
        const parsed = JSON.parse(body) as { value?: string };
        return parsed?.value ?? null;
    } catch {
        throw new Error(`Key Vault GET ${opts.vaultName}/${opts.secretName} returned non-JSON body`);
    }
}

/**
 * Write (create/update) a Key Vault secret with an optional expiry and tags,
 * via DefaultAzureCredential + the Key Vault REST data plane over node `https`
 * (no @azure/keyvault-secrets dependency). The value is never logged.
 *
 * `expiresUnix` sets the secret's `exp` attribute (Key Vault marks it unusable
 * after that time but does NOT auto-purge — a sweeper must delete expired
 * secrets). `tags` carry non-secret metadata (e.g. owner principal, allowed
 * server ids) for a confused-deputy check and for the sweeper.
 */
export async function putKeyVaultSecret(opts: {
    vaultName: string;
    secretName: string;
    value: string;
    expiresUnix?: number;
    tags?: Record<string, string>;
    trace?: (message: string) => void;
}): Promise<void> {
    const aad = await keyVaultAadToken();
    const url =
        `https://${opts.vaultName}.vault.azure.net/secrets/` +
        `${encodeURIComponent(opts.secretName)}?api-version=7.4`;
    const payload: { value: string; attributes?: { exp: number }; tags?: Record<string, string> } = {
        value: opts.value,
    };
    if (opts.expiresUnix) payload.attributes = { exp: opts.expiresUnix };
    if (opts.tags) payload.tags = opts.tags;
    opts.trace?.(
        `[caller-auth] storing secret ${opts.vaultName}/${opts.secretName} in Key Vault via managed identity`,
    );
    const { status } = await httpsRequestJson(
        "PUT",
        url,
        {
            Authorization: `Bearer ${aad}`,
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        JSON.stringify(payload),
    );
    if (status !== 200) {
        throw new Error(`Key Vault PUT ${opts.vaultName}/${opts.secretName} failed: HTTP ${status}`);
    }
}

/**
 * Materialize every plugin spec in `opts.spec` into `opts.cacheDir` and return
 * the resolved plugin directories. Per-entry failures are quarantined (that
 * entry gets status "error") so one broken source never blocks the others or
 * takes the worker down.
 */
export async function installPluginSpecs(opts: {
    spec: string | undefined;
    cacheDir: string;
    adoPat?: string;
    githubToken?: string;
    trace?: (message: string) => void;
}): Promise<InstallPluginSpecsResult> {
    const trace = opts.trace ?? (() => {});
    const rawEntries = (opts.spec ?? "")
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean);
    if (rawEntries.length === 0) return { pluginDirs: [], results: [] };

    const seen = new Map<string, number>();
    const prepared = rawEntries.map((raw, index): {
        raw: string;
        entry: PluginSpecEntry | null;
        spec?: ValidatedPluginSpec;
        error?: string;
    } => {
        let entry: PluginSpecEntry | null = null;
        try {
            entry = parseOne(raw);
            const [spec] = parseValidatedPluginSpecs([toValidatedPluginSpec(entry)]);
            const key = normalizedLegacyPluginSourceKey(spec);
            const prior = seen.get(key);
            if (prior !== undefined) {
                throw new Error(`Plugin source ${index} duplicates source ${prior}`);
            }
            seen.set(key, index);
            return { raw, entry, spec };
        } catch (error: any) {
            return { raw, entry, error: String(error?.message ?? error) };
        }
    });

    if (prepared.some((item) => item.spec)) {
        fs.mkdirSync(opts.cacheDir, { recursive: true });
    }
    const results: PluginSpecInstallResult[] = [];
    const total = prepared.length;
    const runStartedAt = Date.now();
    trace(`[plugin-spec] processing ${total} plugin spec ${total === 1 ? "entry" : "entries"}`);

    for (let offset = 0; offset < prepared.length; offset++) {
        const index = offset + 1;
        const item = prepared[offset];
        const startedAt = Date.now();
        const result: PluginSpecInstallResult = {
            entry: item.entry,
            raw: item.raw,
            dir: null,
            status: item.error ? "error" : "ok",
            ...(item.error ? { error: item.error } : {}),
        };
        if (item.error || !item.entry || !item.spec) {
            trace(`[plugin-spec] [${index}/${total}] FAILED ${item.raw}: ${result.error} (0ms)`);
            results.push(result);
            continue;
        }

        trace(`[plugin-spec] [${index}/${total}] ${describe(item.entry)} — starting`);
        try {
            result.dir = await materializeEntry(item.entry, item.spec, opts);
            const ms = Date.now() - startedAt;
            const { skills, agents } = countPluginContents(result.dir);
            trace(
                `[plugin-spec] [${index}/${total}] OK ${describe(item.entry)} -> ${result.dir} ` +
                `(${skills} skills, ${agents} agents, ${ms}ms)`,
            );
        } catch (error: any) {
            const ms = Date.now() - startedAt;
            result.status = "error";
            result.error = String(error?.message ?? error);
            trace(`[plugin-spec] [${index}/${total}] FAILED ${describe(item.entry)}: ${result.error} (${ms}ms)`);
        }
        results.push(result);
    }

    const okCount = results.filter((r) => r.status === "ok").length;
    trace(
        `[plugin-spec] done: ${okCount}/${total} resolved, ${total - okCount} failed ` +
        `(${Date.now() - runStartedAt}ms total)`,
    );

    return {
        pluginDirs: results.filter((r) => r.status === "ok" && r.dir).map((r) => r.dir as string),
        results,
    };
}

async function materializeEntry(
    entry: PluginSpecEntry,
    spec: ValidatedPluginSpec,
    opts: { cacheDir: string; adoPat?: string; githubToken?: string; trace?: (m: string) => void },
): Promise<string> {
    if (spec.kind === "git") {
        const cached = resolveCachedPluginDir(spec, opts.cacheDir);
        if (cached) {
            opts.trace?.(`[plugin-spec] reusing validated cached checkout at ${cached}`);
            return cached;
        }
    }

    const [installed] = await installValidatedPluginSpecs([spec], {
        destinationRoot: opts.cacheDir,
        cwd: process.cwd(),
        git: spec.kind === "git" ? createProviderGitResolver(entry, opts) : undefined,
    });
    const hasSkills = fs.existsSync(path.join(installed.pluginDir, "skills"));
    const hasAgents = fs.existsSync(path.join(installed.pluginDir, "agents"));
    if (!hasSkills && !hasAgents) {
        opts.trace?.(`[plugin-spec] WARN ${installed.pluginDir} has no skills/ or agents/ subdir`);
    }
    return installed.pluginDir;
}

function toValidatedPluginSpec(entry: PluginSpecEntry): ValidatedPluginSpec {
    if (entry.scheme === "local") {
        return { kind: "local", path: entry.path };
    }
    return {
        kind: "git",
        repository: entry.scheme === "ado-git"
            ? adoCloneUrl(entry.org!, entry.project!, entry.repo!)
            : githubCloneUrl(entry.owner!, entry.repo!),
        path: entry.path,
        ...(entry.ref ? { ref: entry.ref } : {}),
    };
}

function normalizedLegacyPluginSourceKey(spec: ValidatedPluginSpec): string {
    let key = normalizedPluginSpecKey(spec);
    if (spec.kind === "local") {
        const candidate = path.resolve(spec.path);
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                key = `local:${caseFoldPluginPath(fs.realpathSync(candidate))}`;
            }
        } catch {
            // Filesystem-dependent failures remain per-entry installation
            // errors so one unavailable local source cannot disable peers.
        }
    }
    return key;
}

function resolveCachedPluginDir(spec: Extract<ValidatedPluginSpec, { kind: "git" }>, cacheDir: string): string | null {
    const hash = createHash("sha256").update(normalizedPluginSpecKey(spec)).digest("hex").slice(0, 16);
    const destinationDir = path.join(path.resolve(cacheDir), `git-${hash}`);
    const pluginDir = path.join(destinationDir, "repository", ...spec.path.split("/"));
    if (!fs.existsSync(pluginDir)) return null;
    const destinationRoot = fs.realpathSync(destinationDir);
    const resolvedPluginDir = fs.realpathSync(pluginDir);
    const relative = path.relative(destinationRoot, resolvedPluginDir);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`cached plugin path escapes its checkout: ${spec.path}`);
    }
    if (!fs.statSync(resolvedPluginDir).isDirectory()) {
        throw new Error(`plugin path is not a directory: ${pluginDir}`);
    }
    return resolvedPluginDir;
}

function createProviderGitResolver(
    entry: PluginSpecEntry,
    opts: { adoPat?: string; githubToken?: string },
): GitPluginSourceResolver {
    const authHeader = authHeaderFor(entry, opts);
    return createGitPluginSourceResolver({
        run: async (command, args, options) => {
            const env = {
                ...process.env,
                ...options?.env,
                ...(authHeader
                    ? {
                        GIT_CONFIG_COUNT: "1",
                        GIT_CONFIG_KEY_0: "http.extraHeader",
                        GIT_CONFIG_VALUE_0: authHeader,
                    }
                    : {}),
            };
            execFileSync(command, [...args], {
                cwd: options?.cwd,
                stdio: ["ignore", "pipe", "pipe"],
                encoding: "utf8",
                env,
            });
        },
    });
}

/** Build the redacted Basic/Bearer auth header for a private clone, or null. */
function authHeaderFor(
    entry: PluginSpecEntry,
    opts: { adoPat?: string; githubToken?: string },
): string | null {
    if (entry.scheme === "ado-git") {
        if (!opts.adoPat) return null;
        // PAT -> HTTP Basic ':<PAT>'. Base64 built here so the secret never
        // lands on an argv we might echo; the header value is never logged.
        const b64 = Buffer.from(`:${opts.adoPat}`, "utf8").toString("base64");
        return `AUTHORIZATION: Basic ${b64}`;
    }
    if (entry.scheme === "github" && opts.githubToken) {
        const b64 = Buffer.from(`x-access-token:${opts.githubToken}`, "utf8").toString("base64");
        return `AUTHORIZATION: Basic ${b64}`;
    }
    return null;
}

function describe(entry: PluginSpecEntry): string {
    if (entry.scheme === "local") return `local:${entry.path}`;
    if (entry.scheme === "github") {
        return `github:${entry.owner}/${entry.repo}:${entry.path}${entry.ref ? `@${entry.ref}` : ""}`;
    }
    return `ado-git:${entry.org}/${entry.project}/${entry.repo}:${entry.path}${entry.ref ? `@${entry.ref}` : ""}`;
}

/**
 * Count the loadable skills (`skills/<name>/` subdirs) and agents
 * (`agents/*.agent.md` files) a resolved plugin dir contributes — purely for
 * an informative post-install log line; never throws.
 */
function countPluginContents(dir: string | null): { skills: number; agents: number } {
    let skills = 0;
    let agents = 0;
    if (!dir) return { skills, agents };
    try {
        const skillsDir = path.join(dir, "skills");
        if (fs.existsSync(skillsDir)) {
            skills = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
        }
    } catch { /* best-effort */ }
    try {
        const agentsDir = path.join(dir, "agents");
        if (fs.existsSync(agentsDir)) {
            agents = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".agent.md")).length;
        }
    } catch { /* best-effort */ }
    return { skills, agents };
}
