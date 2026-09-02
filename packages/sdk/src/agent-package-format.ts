/**
 * Agent package format — canonical packing, validation, and identity.
 *
 * An agent package is a plugin directory (plugin.json + agents/ + skills/ +
 * .mcp.json) plus, uniquely, code: tools/worker-module.js and mcp-servers/**.
 * Every source kind (github/ado/url/upload) normalizes through this module:
 * validate → canonical tar.gz → sha256. The tarball is canonical — packing
 * the same content always yields byte-identical output — because the sha256
 * carries no-op elision at publish time and download verification on workers.
 *
 * The tar writer/reader here is deliberately hand-rolled ustar rather than a
 * spawn of system tar: GNU and bsdtar disagree on ordering, mtime, and header
 * details, and canonical bytes are a correctness property, not a convenience.
 * See docs/proposals/agent-packages.md.
 *
 * plugin.json IS the package manifest. Identity (name/version/description)
 * is required; a package may ADDITIONALLY declare its artifact layout —
 * agents/skills/mcpConfig/mcpServers/tools/include, every path relative to
 * the manifest — and lay files out however it likes. Publishing stages the
 * declared artifacts into the canonical layout (agents/, skills/, .mcp.json,
 * mcp-servers/, tools/worker-module.js) and rewrites plugin.json with the
 * canonicalized paths, so the runtime and every downstream consumer see one
 * layout. Packages without layout fields keep today's convention scan,
 * byte-for-byte (no silent sha changes for existing packages).
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import * as os from "os";
import * as crypto from "crypto";
import { spawn } from "child_process";
import { loadAgentFiles, validateAgentDefinition, type AgentConfig } from "./agent-loader.js";
import { loadSkillsSync, type Skill } from "./skills.js";

// ─── Reserved artifact identity ──────────────────────────────────

/**
 * Deterministic UUID reserving the artifact-store "session" that holds every
 * agent-package tarball. Same derivation shape as systemAgentUUID, distinct
 * prefix so the namespaces can never collide.
 */
export function agentPackagesArtifactSessionId(): string {
    const hash = crypto.createHash("sha256")
        .update("pilotswarm-agent-packages:artifacts")
        .digest("hex");
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        hash.slice(12, 16),
        hash.slice(16, 20),
        hash.slice(20, 32),
    ].join("-");
}

/**
 * Canonical artifact filename for a published package version. The sha12
 * suffix makes the blob content-addressed: a publish that loses the
 * same-semver race wrote a DIFFERENT blob than the winner, so its cleanup
 * can never clobber the winning version's bytes.
 */
export function agentPackageArtifactFilename(name: string, semver: string, sha256: string): string {
    return `${name}@${semver}.${sha256.slice(0, 12)}.tar.gz`;
}

// ─── Agent-name normalization (mirror of resolveAgentConfig) ─────

/**
 * The runtime resolver matches agents case/punctuation-insensitively and
 * also tries a trailing-"agent"-stripped variant (session-proxy.ts
 * resolveAgentConfig). Collision guards MUST use the same normalization or
 * "Swee-per" shadows "sweeper" at runtime while validating clean.
 */
export function normalizeAgentName(value: string | undefined): string {
    return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function agentNameVariants(value: string | undefined): string[] {
    const normalized = normalizeAgentName(value);
    const stripped = normalized.replace(/agent$/, "");
    return stripped && stripped !== normalized ? [normalized, stripped] : [normalized];
}

// ─── Minimal semver (concrete versions only, full precedence) ────

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidSemver(version: string): boolean {
    return typeof version === "string" && SEMVER_RE.test(version);
}

/** Standard semver precedence: -1 / 0 / 1. Build metadata ignored. */
export function compareSemver(a: string, b: string): number {
    const ma = SEMVER_RE.exec(a);
    const mb = SEMVER_RE.exec(b);
    if (!ma || !mb) throw new Error(`compareSemver: invalid semver (${a}, ${b})`);
    for (let i = 1; i <= 3; i++) {
        const na = Number(ma[i]);
        const nb = Number(mb[i]);
        if (na !== nb) return na < nb ? -1 : 1;
    }
    const pa = ma[4];
    const pb = mb[4];
    if (pa === undefined && pb === undefined) return 0;
    if (pa === undefined) return 1;   // release > prerelease
    if (pb === undefined) return -1;
    const ia = pa.split(".");
    const ib = pb.split(".");
    for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
        const xa = ia[i];
        const xb = ib[i];
        if (xa === undefined) return -1; // shorter prerelease sorts lower
        if (xb === undefined) return 1;
        const nxa = /^\d+$/.test(xa);
        const nxb = /^\d+$/.test(xb);
        if (nxa && nxb) {
            const da = Number(xa);
            const db = Number(xb);
            if (da !== db) return da < db ? -1 : 1;
        } else if (nxa !== nxb) {
            return nxa ? -1 : 1;      // numeric identifiers sort below alphanumeric
        } else if (xa !== xb) {
            return xa < xb ? -1 : 1;
        }
    }
    return 0;
}

// ─── Deterministic ustar ─────────────────────────────────────────

interface TarEntry {
    /** POSIX relative path; directories end with "/". */
    name: string;
    /** Regular file body; undefined for directories. */
    body?: Buffer;
    mode: number;
}

const TAR_BLOCK = 512;

function tarHeaderChecksum(header: Buffer): number {
    let sum = 0;
    for (let i = 0; i < TAR_BLOCK; i++) {
        sum += (i >= 148 && i < 156) ? 0x20 : header[i];
    }
    return sum;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
    const text = value.toString(8).padStart(length - 1, "0");
    if (text.length > length - 1) {
        throw new Error(`tar field overflow: ${value} does not fit ${length - 1} octal digits`);
    }
    header.write(text, offset, "ascii");
    header[offset + length - 1] = 0;
}

/** Split a path into ustar (prefix, name) fields; throws when unsplittable. */
function splitUstarName(name: string): { prefix: string; name: string } {
    if (Buffer.byteLength(name) <= 100) return { prefix: "", name };
    // Split at a "/" so name ≤ 100 and prefix ≤ 155.
    for (let i = name.length - 1; i > 0; i--) {
        if (name[i] !== "/") continue;
        const prefix = name.slice(0, i);
        const rest = name.slice(i + 1);
        if (Buffer.byteLength(rest) <= 100 && Buffer.byteLength(prefix) <= 155) {
            return { prefix, name: rest };
        }
    }
    throw new Error(`path too long for ustar: ${name}`);
}

function tarHeader(entry: TarEntry): Buffer {
    const header = Buffer.alloc(TAR_BLOCK);
    const isDir = entry.name.endsWith("/");
    const { prefix, name } = splitUstarName(entry.name);
    header.write(name, 0, "ascii");
    writeOctal(header, 100, 8, entry.mode);          // mode
    writeOctal(header, 108, 8, 0);                   // uid
    writeOctal(header, 116, 8, 0);                   // gid
    writeOctal(header, 124, 12, entry.body?.length ?? 0);
    writeOctal(header, 136, 12, 0);                  // mtime — canonical zero
    header.write(isDir ? "5" : "0", 156, "ascii");   // typeflag
    header.write("ustar", 257, "ascii");             // magic
    header[262] = 0;
    header.write("00", 263, "ascii");                // version
    // uname/gname left empty for determinism.
    if (prefix) header.write(prefix, 345, "ascii");
    const checksum = tarHeaderChecksum(header);
    header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    return header;
}

function buildTar(entries: TarEntry[]): Buffer {
    const chunks: Buffer[] = [];
    for (const entry of entries) {
        chunks.push(tarHeader(entry));
        if (entry.body && entry.body.length > 0) {
            chunks.push(entry.body);
            const pad = entry.body.length % TAR_BLOCK;
            if (pad !== 0) chunks.push(Buffer.alloc(TAR_BLOCK - pad));
        }
    }
    chunks.push(Buffer.alloc(TAR_BLOCK * 2)); // end-of-archive
    return Buffer.concat(chunks);
}

export interface ExtractedTarEntry {
    name: string;
    body: Buffer;
}

/**
 * Read a canonical package tar.gz. Strict by design: only regular files and
 * directories, no links of any kind, no absolute paths, no "..", no pax
 * extensions — canonical tars are produced exclusively by packAgentPackage.
 */
export function readAgentPackageTarGz(targz: Buffer): ExtractedTarEntry[] {
    // Bounded decompression: a 16 MB gz of zeros must not OOM the process.
    const tar = zlib.gunzipSync(targz, { maxOutputLength: AGENT_PACKAGE_MAX_RAW_BYTES + 64 * 1024 * 1024 });
    const files: ExtractedTarEntry[] = [];
    let offset = 0;
    while (offset + TAR_BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + TAR_BLOCK);
        if (header.every((b) => b === 0)) break; // end-of-archive
        const rawName = header.subarray(0, 100).toString("ascii").replace(/\0.*$/, "");
        const prefix = header.subarray(345, 500).toString("ascii").replace(/\0.*$/, "");
        const name = prefix ? `${prefix}/${rawName}` : rawName;
        const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
        const typeflag = String.fromCharCode(header[156]);
        const expected = tarHeaderChecksum(header);
        const recorded = parseInt(header.subarray(148, 156).toString("ascii").replace(/[\0 ]*$/, ""), 8);
        if (recorded !== expected) throw new Error(`tar checksum mismatch at ${name || offset}`);
        if (!Number.isFinite(size) || size < 0) throw new Error(`tar invalid size at ${name}`);
        if (typeflag !== "0" && typeflag !== "5") {
            throw new Error(`tar entry type not allowed in a package (${name})`);
        }
        if (typeflag === "5" && size !== 0) {
            throw new Error(`tar directory entry with nonzero size at ${name}`);
        }
        assertSafeRelativePath(name);
        offset += TAR_BLOCK;
        if (typeflag !== "5") {
            if (offset + size > tar.length) {
                throw new Error(`tar entry body truncated at ${name} (declares ${size} bytes)`);
            }
            files.push({ name, body: Buffer.from(tar.subarray(offset, offset + size)) });
            offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
        }
    }
    return files;
}

function assertSafeRelativePath(name: string): void {
    if (!name || name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name)) {
        throw new Error(`tar entry has non-relative path: ${name}`);
    }
    const parts = name.split("/");
    if (parts.some((p) => p === "..")) throw new Error(`tar entry escapes package root: ${name}`);
    if (parts.some((p) => p === "" && name.replace(/\/$/, "").split("/").includes(""))) {
        throw new Error(`tar entry has empty path segment: ${name}`);
    }
}

/** Extract a canonical package tar.gz under destDir (created if needed). */
export function extractAgentPackageTarGz(targz: Buffer, destDir: string): void {
    const entries = readAgentPackageTarGz(targz);
    const root = path.resolve(destDir);
    for (const entry of entries) {
        const target = path.resolve(root, entry.name);
        if (target !== root && !target.startsWith(root + path.sep)) {
            throw new Error(`tar entry escapes destination: ${entry.name}`);
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.body);
    }
}

// ─── Canonical packing ───────────────────────────────────────────

/** Fixed ignore list — never packed, never validated. */
const PACK_IGNORES = new Set([".git", ".DS_Store", ".pilotswarm-meta.json"]);

export const AGENT_PACKAGE_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const AGENT_PACKAGE_MAX_RAW_BYTES = 128 * 1024 * 1024;
const VENDORED_WARN_BYTES = 2 * 1024 * 1024;

interface WalkedFile {
    rel: string;         // POSIX relative path
    abs: string;
    isDir: boolean;
    size: number;
}

/** Sorted, symlink-rejecting walk. Returns POSIX-relative entries. */
function walkPackageDir(rootDir: string): { files: WalkedFile[]; symlinks: string[]; nonAscii: string[] } {
    const files: WalkedFile[] = [];
    const symlinks: string[] = [];
    const nonAscii: string[] = [];
    const visit = (dirAbs: string, dirRel: string) => {
        const names = fs.readdirSync(dirAbs).filter((n) => !PACK_IGNORES.has(n)).sort();
        for (const name of names) {
            const abs = path.join(dirAbs, name);
            const rel = dirRel ? `${dirRel}/${name}` : name;
            // The ustar name field is written byte-per-char; non-ASCII names
            // silently corrupt and can COLLIDE after 7-bit masking. Reject
            // loudly instead of certifying garbage with a sha.
            if (/[^\x20-\x7e]/.test(rel)) nonAscii.push(rel);
            const st = fs.lstatSync(abs);
            if (st.isSymbolicLink()) {
                symlinks.push(rel);
                continue;
            }
            if (st.isDirectory()) {
                files.push({ rel: `${rel}/`, abs, isDir: true, size: 0 });
                visit(abs, rel);
            } else if (st.isFile()) {
                files.push({ rel, abs, isDir: false, size: st.size });
            }
            // Sockets/fifos/devices are silently impossible in git checkouts;
            // anything else is skipped by construction.
        }
    };
    visit(rootDir, "");
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return { files, symlinks, nonAscii };
}

export interface PackedAgentPackage {
    targz: Buffer;
    /**
     * Identity hash — sha256 of the UNCOMPRESSED canonical tar, NOT the gz
     * bytes. The deflate stream varies across zlib builds, so hashing the
     * gz would make byte-identical content hash differently after a Node
     * upgrade and trip the immutability check. The tar bytes are fully
     * deterministic by construction.
     */
    sha256: string;
    rawBytes: number;
    fileCount: number;
}

/**
 * Pack a validated package directory into the canonical tar.gz.
 * Deterministic: sorted entries, zeroed mtime/uid/gid, normalized modes
 * (0755 dirs, 0644 files), gzip level 9 with a normalized gzip header.
 */
export function packAgentPackage(rootDir: string): PackedAgentPackage {
    const { files, symlinks, nonAscii } = walkPackageDir(rootDir);
    if (symlinks.length > 0) {
        throw new Error(`symlinks are not allowed in agent packages: ${symlinks.join(", ")}`);
    }
    if (nonAscii.length > 0) {
        throw new Error(`non-ASCII paths are not allowed in agent packages (rename to ASCII): ${nonAscii.join(", ")}`);
    }
    let rawBytes = 0;
    const entries: TarEntry[] = files.map((f) => {
        rawBytes += f.size;
        if (rawBytes > AGENT_PACKAGE_MAX_RAW_BYTES) {
            throw new Error(`package exceeds raw size limit (${AGENT_PACKAGE_MAX_RAW_BYTES} bytes)`);
        }
        return {
            name: f.rel,
            body: f.isDir ? undefined : fs.readFileSync(f.abs),
            mode: f.isDir ? 0o755 : 0o644,
        };
    });
    const tar = buildTar(entries);
    const targz = zlib.gzipSync(tar, { level: 9 });
    // Normalize the gzip header so identical content is identical bytes on
    // every platform: zero MTIME (bytes 4-7), fix OS (byte 9) to 0x03 (Unix).
    targz[4] = 0; targz[5] = 0; targz[6] = 0; targz[7] = 0;
    targz[9] = 0x03;
    if (targz.length > AGENT_PACKAGE_MAX_COMPRESSED_BYTES) {
        throw new Error(
            `package exceeds compressed size limit: ${targz.length} > ${AGENT_PACKAGE_MAX_COMPRESSED_BYTES} bytes`,
        );
    }
    const sha256 = crypto.createHash("sha256").update(tar).digest("hex");
    return { targz, sha256, rawBytes, fileCount: files.filter((f) => !f.isDir).length };
}

/** sha256 of the canonical tar inside a package tar.gz (the identity hash). */
export function agentPackageTarSha256(targz: Buffer): string {
    const tar = zlib.gunzipSync(targz, { maxOutputLength: AGENT_PACKAGE_MAX_RAW_BYTES + 64 * 1024 * 1024 });
    return crypto.createHash("sha256").update(tar).digest("hex");
}

// ─── Manifest layout (plugin.json as THE package manifest) ───────

/** Artifact layout a plugin.json may declare; paths relative to the file. */
export interface AgentPackageLayout {
    /** Paths to .agent.md files. */
    agents: string[];
    /** Paths to skill DIRECTORIES (each must contain SKILL.md). */
    skills: string[];
    /** Path to the MCP servers config JSON (canonical: .mcp.json). */
    mcpConfig: string | null;
    /** Paths to MCP server code files or directories. */
    mcpServers: string[];
    /** Path to the worker tool module (canonical: tools/worker-module.js). */
    tools: string | null;
    /** Extra files/directories shipped verbatim at their relative paths. */
    include: string[];
}

export const AGENT_PACKAGE_LAYOUT_FIELDS = ["agents", "skills", "mcpConfig", "mcpServers", "tools", "include"] as const;

/** The per-package changelog. Always staged when present — see stageAgentPackageDir. */
export const PACKAGE_CHANGELOG_FILE = "CHANGELOG.md";

function normalizeLayoutPath(value: unknown, field: string, issues: AgentPackageIssue[]): string | null {
    if (typeof value !== "string" || value.trim() === "") {
        issues.push({ code: "invalid_layout_path", message: `plugin.json "${field}" entries must be non-empty strings (got ${JSON.stringify(value)})`, file: "plugin.json" });
        return null;
    }
    const raw = value.trim().replace(/\\/g, "/");
    const normalized = path.posix.normalize(raw);
    if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized === ".") {
        issues.push({ code: "invalid_layout_path", message: `plugin.json "${field}": ${JSON.stringify(value)} must be a relative path inside the package (no "..", no absolute paths)`, file: "plugin.json" });
        return null;
    }
    return normalized;
}

/**
 * Parse the optional layout fields from a parsed plugin.json. Returns null
 * (with no issues) when the manifest declares no layout — convention mode.
 */
export function parseAgentPackageLayout(pluginJson: any, issues: AgentPackageIssue[]): AgentPackageLayout | null {
    if (!pluginJson || typeof pluginJson !== "object") return null;
    if (!AGENT_PACKAGE_LAYOUT_FIELDS.some((field) => pluginJson[field] !== undefined)) return null;
    const list = (field: string): string[] => {
        const value = pluginJson[field];
        if (value === undefined) return [];
        if (!Array.isArray(value)) {
            issues.push({ code: "invalid_layout_field", message: `plugin.json "${field}" must be an array of paths`, file: "plugin.json" });
            return [];
        }
        return value.map((entry: unknown) => normalizeLayoutPath(entry, field, issues)).filter((entry): entry is string => entry !== null);
    };
    const single = (field: string): string | null => {
        const value = pluginJson[field];
        if (value === undefined || value === null) return null;
        return normalizeLayoutPath(value, field, issues);
    };
    return {
        agents: list("agents"),
        skills: list("skills"),
        mcpConfig: single("mcpConfig"),
        mcpServers: list("mcpServers"),
        tools: single("tools"),
        include: list("include"),
    };
}

export interface StagedAgentPackage {
    /** Directory to validate + pack: rootDir itself in convention mode. */
    dir: string;
    /** True when a staging copy was produced from a declared layout. */
    staged: boolean;
    /** Layout issues; staging is aborted when any are errors. */
    issues: AgentPackageIssue[];
    /** Remove the staging copy (no-op in convention mode). */
    cleanup: () => void;
}

/** Deterministic manifest serialization for the staged plugin.json. */
function serializeCanonicalPluginJson(pluginJson: any, layout: {
    agents: string[]; skills: string[]; mcpConfig: string | null;
    mcpServers: string[]; tools: string | null; include: string[];
}): string {
    const out: Record<string, unknown> = {};
    out.name = pluginJson.name;
    out.version = pluginJson.version;
    if (pluginJson.description !== undefined) out.description = pluginJson.description;
    const layoutKeys = new Set<string>([...AGENT_PACKAGE_LAYOUT_FIELDS, "name", "version", "description"]);
    for (const key of Object.keys(pluginJson).sort()) {
        if (!layoutKeys.has(key)) out[key] = pluginJson[key];
    }
    if (layout.agents.length) out.agents = [...layout.agents].sort();
    if (layout.skills.length) out.skills = [...layout.skills].sort();
    if (layout.mcpConfig) out.mcpConfig = layout.mcpConfig;
    if (layout.mcpServers.length) out.mcpServers = [...layout.mcpServers].sort();
    if (layout.tools) out.tools = layout.tools;
    if (layout.include.length) out.include = [...layout.include].sort();
    return JSON.stringify(out, null, 2) + "\n";
}

/**
 * Stage a package directory for validation + packing.
 *
 * Convention mode (no layout fields): returns rootDir untouched.
 * Manifest mode: copies exactly the declared artifacts into a temp dir in
 * the CANONICAL layout — agents/<basename>, skills/<dirname>/, .mcp.json,
 * mcp-servers/<basename>, tools/worker-module.js, include verbatim — and
 * writes plugin.json back with canonicalized layout paths. The staged tree
 * is what gets validated, packed, hashed, and unpacked on workers, so the
 * authored layout is a pure authoring convenience with one canonical truth.
 */
export function stageAgentPackageDir(rootDir: string): StagedAgentPackage {
    const issues: AgentPackageIssue[] = [];
    const noop: StagedAgentPackage = { dir: rootDir, staged: false, issues, cleanup: () => {} };
    let pluginJson: any = null;
    try {
        pluginJson = JSON.parse(fs.readFileSync(path.join(rootDir, "plugin.json"), "utf8"));
    } catch {
        return noop; // validation reports missing/invalid plugin.json itself
    }
    const layout = parseAgentPackageLayout(pluginJson, issues);
    if (!layout) return noop;
    if (issues.length > 0) return { ...noop, issues };

    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-agent-pkg-stage-"));
    const cleanup = () => { try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ } };
    const canonical = { agents: [] as string[], skills: [] as string[], mcpConfig: null as string | null, mcpServers: [] as string[], tools: null as string | null, include: [] as string[] };
    const placed = new Set<string>();
    const place = (sourceRel: string, destRel: string, opts: { dir?: boolean; field: string }): boolean => {
        const source = path.resolve(rootDir, sourceRel);
        if (!source.startsWith(path.resolve(rootDir) + path.sep)) {
            issues.push({ code: "invalid_layout_path", message: `plugin.json "${opts.field}": ${sourceRel} escapes the package root`, file: "plugin.json" });
            return false;
        }
        if (!fs.existsSync(source)) {
            issues.push({ code: "layout_file_missing", message: `plugin.json "${opts.field}" lists ${sourceRel}, but it does not exist`, file: sourceRel });
            return false;
        }
        const isDir = fs.statSync(source).isDirectory();
        if (opts.dir === true && !isDir) {
            issues.push({ code: "layout_not_a_directory", message: `plugin.json "${opts.field}" lists ${sourceRel}, which must be a directory`, file: sourceRel });
            return false;
        }
        if (opts.dir === false && isDir) {
            issues.push({ code: "layout_not_a_file", message: `plugin.json "${opts.field}" lists ${sourceRel}, which must be a file`, file: sourceRel });
            return false;
        }
        if (placed.has(destRel)) {
            issues.push({ code: "layout_collision", message: `two manifest entries land on ${destRel} — rename one (canonical paths use basenames)`, file: sourceRel });
            return false;
        }
        placed.add(destRel);
        const dest = path.join(stagingDir, destRel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(source, dest, { recursive: true });
        return true;
    };

    for (const rel of layout.agents) {
        const destRel = path.posix.join("agents", path.posix.basename(rel));
        if (place(rel, destRel, { dir: false, field: "agents" })) canonical.agents.push(destRel);
    }
    for (const rel of layout.skills) {
        const destRel = path.posix.join("skills", path.posix.basename(rel));
        if (place(rel, destRel, { dir: true, field: "skills" })) canonical.skills.push(destRel);
    }
    if (layout.mcpConfig) {
        if (place(layout.mcpConfig, ".mcp.json", { dir: false, field: "mcpConfig" })) canonical.mcpConfig = ".mcp.json";
    }
    for (const rel of layout.mcpServers) {
        const destRel = path.posix.join("mcp-servers", path.posix.basename(rel));
        if (place(rel, destRel, { field: "mcpServers" })) canonical.mcpServers.push(destRel);
    }
    if (layout.tools) {
        if (place(layout.tools, "tools/worker-module.js", { dir: false, field: "tools" })) canonical.tools = "tools/worker-module.js";
    }
    for (const rel of layout.include) {
        if (place(rel, rel, { field: "include" })) canonical.include.push(rel);
    }

    // The changelog ships whether or not the manifest remembered to declare
    // it. Manifest mode is otherwise strict — only declared paths are staged —
    // which silently dropped every CHANGELOG.md not listed in `include`, the
    // one file the portal and TUI render per package and the one the Agent
    // Manager refuses to publish without. Enforcing an entry and then dropping
    // the file is the worst combination: the check passes and the artifact
    // ships without it.
    if (!canonical.include.includes(PACKAGE_CHANGELOG_FILE)
        && fs.existsSync(path.join(rootDir, PACKAGE_CHANGELOG_FILE))) {
        if (place(PACKAGE_CHANGELOG_FILE, PACKAGE_CHANGELOG_FILE, { dir: false, field: "include" })) {
            canonical.include.push(PACKAGE_CHANGELOG_FILE);
        }
    }

    if (issues.some((issue) => issue.code !== "missing_description")) {
        cleanup();
        return { dir: rootDir, staged: false, issues, cleanup: () => {} };
    }
    fs.writeFileSync(path.join(stagingDir, "plugin.json"), serializeCanonicalPluginJson(pluginJson, canonical));
    return { dir: stagingDir, staged: true, issues, cleanup };
}

// ─── Validation ──────────────────────────────────────────────────

const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export interface AgentPackageIssue {
    code: string;
    message: string;
    file?: string;
}

export interface AgentPackageManifest {
    name: string;
    version: string;
    /**
     * Friendly display name from plugin.json. The picker groups agents into a
     * section per package, and a DNS-label package name ("finance-research-lab")
     * is a poor section header — this is what people actually recognise. Falls
     * back to `name` when unset.
     */
    title?: string;
    description?: string;
    agents: Array<{
        name: string;
        title?: string;
        description?: string;
        tools?: string[];
        skills?: string[];
        mcpServers?: string[];
        // Session-presentation fields. They have to ride the MANIFEST because a
        // session is created from the catalog, before the package's agent file
        // is ever read: the picker sends splash/initialPrompt with the create
        // call. Dropping them here is why a package agent could not self-start
        // or show its own splash, while an identical baked agent could.
        splash?: string;
        splashMobile?: string;
        initialPrompt?: string;
        initialRequiredTool?: string;
        // Composition. `startedBy` names the agents that spawn this one, which
        // is what lets the picker nest a package's sub-agents under their entry
        // point instead of listing every agent flat. Both ride the manifest for
        // the same reason splash does: the picker reads the catalog, never the
        // package's agent files.
        startedBy?: string[];
        supportsDirectStart?: boolean;
    }>;
    skills: Array<{ name: string; description?: string }>;
    mcpServers: string[];
    hasTools: boolean;
    fileCount: number;
    rawBytes: number;
}

export interface AgentPackageValidation {
    ok: boolean;
    errors: AgentPackageIssue[];
    warnings: AgentPackageIssue[];
    manifest?: AgentPackageManifest;
}

export interface ValidateAgentPackageOptions {
    /** Baked agent names a package may not shadow. */
    reservedAgentNames?: string[];
    /**
     * MCP server names the deployment catalog defines. A package `.mcp.json`
     * may not define one of these: the catalog is flat, every worker drops
     * the package's definition at load, so reject it up front.
     */
    reservedMcpServerNames?: string[];
    /** Skip `node --check` (used by pure-parse test paths). */
    skipSyntaxCheck?: boolean;
    /** Internal: rootDir is already a staged canonical tree — do not re-stage. */
    preStaged?: boolean;
}

function err(errors: AgentPackageIssue[], code: string, message: string, file?: string): void {
    errors.push({ code, message, file });
}

// `node --check` is CommonJS-only and silently exits 0 on ESM input, so it
// cannot gate module syntax. Instead, compile (never evaluate) the source as
// an ES module via vm.SourceTextModule in a child process — construction
// compiles and throws SyntaxError; evaluation never runs, so hostile code
// cannot execute at validation time.
const SYNTAX_CHECK_SNIPPET =
    'const fs=require("fs");const vm=require("vm");' +
    'let src=fs.readFileSync(process.argv[1],"utf8");' +
    'if(src.startsWith("#!"))src=src.slice(src.indexOf("\\n")+1);' +
    'try{new vm.SourceTextModule(src,{identifier:process.argv[1]});}' +
    'catch(e){console.error(String(e&&e.message||e));process.exit(1)}';

async function nodeSyntaxCheck(file: string): Promise<string | null> {
    return await new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            ["--no-warnings", "--experimental-vm-modules", "-e", SYNTAX_CHECK_SNIPPET, file],
            { stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (d) => { stderr += String(d); });
        child.on("error", (e) => resolve(String(e)));
        child.on("close", (code) => resolve(code === 0 ? null : stderr.trim() || `exit ${code}`));
    });
}

/**
 * Full registration-time validation. Every rejection here is user-facing UX:
 * messages state the rule and the fix, and the CLI `validate` command prints
 * them verbatim — keep them exact and keep the tests asserting them exact.
 */
export async function validateAgentPackageDir(
    rootDir: string,
    opts: ValidateAgentPackageOptions = {},
): Promise<AgentPackageValidation> {
    const errors: AgentPackageIssue[] = [];
    const warnings: AgentPackageIssue[] = [];

    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
        err(errors, "not_a_directory", `package path is not a directory: ${rootDir}`);
        return { ok: false, errors, warnings };
    }

    // A manifest-declared layout validates in its CANONICAL form: stage
    // first, then run every check below against the staged tree — exactly
    // the bytes that will be packed, hashed, and unpacked on workers.
    if (!opts.preStaged) {
        const staged = stageAgentPackageDir(rootDir);
        if (staged.staged) {
            try {
                const result = await validateAgentPackageDir(staged.dir, { ...opts, preStaged: true });
                return { ...result, warnings: [...staged.issues, ...result.warnings] };
            } finally {
                staged.cleanup();
            }
        }
        if (staged.issues.length > 0) {
            return { ok: false, errors: staged.issues, warnings };
        }
    }

    // plugin.json — the manifest anchor.
    const pluginJsonPath = path.join(rootDir, "plugin.json");
    let pluginJson: any = null;
    if (!fs.existsSync(pluginJsonPath)) {
        err(errors, "missing_plugin_json", "plugin.json is required at the package root", "plugin.json");
    } else {
        try {
            pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
        } catch (e: any) {
            err(errors, "invalid_plugin_json", `plugin.json is not valid JSON: ${e?.message ?? e}`, "plugin.json");
        }
    }
    if (pluginJson) {
        if (typeof pluginJson.name !== "string" || !DNS_LABEL_RE.test(pluginJson.name)) {
            err(errors, "invalid_name",
                `plugin.json "name" must be a DNS label (lowercase letters, digits, hyphens; got ${JSON.stringify(pluginJson.name)})`,
                "plugin.json");
        }
        if (typeof pluginJson.version !== "string" || !isValidSemver(pluginJson.version)) {
            err(errors, "invalid_version",
                `plugin.json "version" must be a concrete semver like 1.2.3 or 1.2.3-dev.1 (got ${JSON.stringify(pluginJson.version)})`,
                "plugin.json");
        }
        if (pluginJson.description !== undefined && typeof pluginJson.description !== "string") {
            err(errors, "invalid_description", 'plugin.json "description" must be a string when present', "plugin.json");
        } else if (!pluginJson.description) {
            warnings.push({ code: "missing_description", message: 'plugin.json has no "description" — package listings will be blank', file: "plugin.json" });
        }
    }

    // Symlinks, charset, and forbidden files — walk once.
    let walk: { files: WalkedFile[]; symlinks: string[]; nonAscii: string[] } | null = null;
    try {
        walk = walkPackageDir(rootDir);
        for (const link of walk.symlinks) {
            err(errors, "symlink", `symlinks are not allowed in agent packages: ${link}`, link);
        }
        for (const bad of walk.nonAscii) {
            err(errors, "non_ascii_path",
                `path contains non-ASCII characters: ${bad} — rename to ASCII (tar names are byte-encoded)`, bad);
        }
        if (walk.files.some((f) => f.rel === "session-policy.json")) {
            err(errors, "session_policy_forbidden",
                "session-policy.json is not allowed in packages — session policy belongs to the deployment's baked app, and a package must not override it",
                "session-policy.json");
        }
    } catch (e: any) {
        err(errors, "walk_failed", `could not read package directory: ${e?.message ?? e}`);
    }

    // Agents.
    const agentsDir = path.join(rootDir, "agents");
    let agents: AgentConfig[] = [];
    if (fs.existsSync(agentsDir)) {
        const agentFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".agent.md")).sort();
        agents = loadAgentFiles(agentsDir, { includeInvalid: true });
        if (agents.length < agentFiles.length) {
            // Name the ACTUAL skip reason — these messages are contractual UX
            // and "failed to parse" for an empty body sends users editing the
            // wrong thing.
            const loaded = new Set(agents.map((a) => path.basename(a.sourcePath ?? "")));
            for (const f of agentFiles) {
                if (loaded.has(f)) continue;
                let raw = "";
                try { raw = fs.readFileSync(path.join(agentsDir, f), "utf8"); } catch { /* fallthrough */ }
                const schemaMatch = /(?:^|\n)schemaVersion:\s*(\S+)/.exec(raw);
                const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
                if (schemaMatch && !["1", "2", "3"].includes(schemaMatch[1])) {
                    err(errors, "unsupported_agent_schema_version",
                        `agents/${f}: schemaVersion ${schemaMatch[1]} is not supported (use 1, 2, or 3)`, `agents/${f}`);
                } else if (!body) {
                    err(errors, "empty_agent_body",
                        `agents/${f}: the markdown body is empty — it becomes the agent's prompt and cannot be blank`, `agents/${f}`);
                } else {
                    err(errors, "invalid_agent",
                        `agents/${f} failed to parse (check frontmatter and schemaVersion)`, `agents/${f}`);
                }
            }
        }
        const reserved = new Set((opts.reservedAgentNames ?? []).flatMap((n) => agentNameVariants(n)));
        const seenNames = new Map<string, string>();
        for (const agent of agents) {
            const file = `agents/${path.basename(agent.sourcePath ?? `${agent.name}.agent.md`)}`;
            if (agent.system) {
                err(errors, "system_agent_forbidden",
                    `${file}: "system: true" agents are not allowed in packages — background agents belong to the deployment's baked app`, file);
            }
            if (agent.name === "default") {
                err(errors, "default_agent_forbidden",
                    `${file}: an agent named "default" is a prompt overlay, not a selectable agent, and is not allowed in packages`, file);
            }
            for (const issue of validateAgentDefinition(agent)) {
                err(errors, issue.code, `${file}: ${issue.message}`, file);
            }
            // Collision checks use the RESOLVER's normalization: the runtime
            // matches case/punctuation-insensitively with an "agent"-suffix
            // fallback, so "Swee-per" genuinely shadows "sweeper".
            if (agentNameVariants(agent.name).some((variant) => reserved.has(variant))) {
                err(errors, "reserved_agent_name",
                    `${file}: agent name "${agent.name}" collides with a built-in agent`, file);
            }
            const normalized = normalizeAgentName(agent.name);
            const previous = seenNames.get(normalized);
            if (previous) {
                err(errors, "duplicate_agent_name",
                    `${file}: agent name "${agent.name}" duplicates "${previous}" (names are matched case/punctuation-insensitively) — one of them would be unreachable`, file);
            } else {
                seenNames.set(normalized, agent.name);
            }
        }
    }

    // Skills — every subdirectory must be a real skill (the runtime loader
    // silently skips SKILL.md-less dirs; registration makes that loud).
    const skillsDir = path.join(rootDir, "skills");
    let skills: Skill[] = [];
    if (fs.existsSync(skillsDir)) {
        skills = loadSkillsSync(skillsDir);
        const skillNames = new Set(skills.map((s) => s.name));
        for (const entry of fs.readdirSync(skillsDir).sort()) {
            const skillPath = path.join(skillsDir, entry);
            if (!fs.statSync(skillPath).isDirectory()) continue;
            if (!fs.existsSync(path.join(skillPath, "SKILL.md"))) {
                err(errors, "skill_missing_skill_md",
                    `skills/${entry}/ has no SKILL.md — every skill directory needs one`, `skills/${entry}`);
            } else if (!skillNames.has(entry)) {
                // SKILL.md may declare a name differing from the dir; loader keys by frontmatter name.
                const declared = skills.find((s) => s.dir && path.basename(s.dir) === entry);
                if (!declared) {
                    err(errors, "invalid_skill", `skills/${entry}/SKILL.md failed to parse`, `skills/${entry}/SKILL.md`);
                }
            }
        }
    }

    // .mcp.json — shape only; ${VAR} expansion happens at load, never here.
    // Two deployment-catalog fields are refused outright, because the worker
    // ignores them in packages and an author must not discover that at
    // runtime: "default": true (would join the every-inheriting-agent set)
    // and "allowedAgents" (only a deployment may restrict a server).
    const mcpJsonPath = path.join(rootDir, ".mcp.json");
    const reservedMcp = new Set(opts.reservedMcpServerNames ?? []);
    let mcpServerNames: string[] = [];
    if (fs.existsSync(mcpJsonPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                err(errors, "invalid_mcp_json", ".mcp.json must be an object mapping server names to configs", ".mcp.json");
            } else {
                for (const [serverName, cfg] of Object.entries<any>(parsed)) {
                    const hasCommand = typeof cfg?.command === "string";
                    const hasUrl = typeof cfg?.url === "string";
                    if (!hasCommand && !hasUrl) {
                        err(errors, "invalid_mcp_server",
                            `.mcp.json server "${serverName}" needs either "command" (stdio) or "url" (http/sse)`, ".mcp.json");
                        continue;
                    }
                    if (cfg.default === true) {
                        err(errors, "mcp_default_forbidden",
                            `.mcp.json server "${serverName}": "default": true would add it to every agent that inherits the deployment default set — packages grant servers per agent via mcpServers:`, ".mcp.json");
                    }
                    if ("allowedAgents" in cfg) {
                        err(errors, "mcp_allowed_agents_forbidden",
                            `.mcp.json server "${serverName}": "allowedAgents" is a deployment-catalog field — a package cannot restrict who uses a server (the worker ignores it)`, ".mcp.json");
                    }
                    if (reservedMcp.has(serverName)) {
                        err(errors, "reserved_mcp_server_name",
                            `.mcp.json server "${serverName}" collides with a deployment catalog entry; workers drop a package definition of that name — pick another name`, ".mcp.json");
                    }
                    mcpServerNames.push(serverName);
                }
            }
        } catch (e: any) {
            err(errors, "invalid_mcp_json", `.mcp.json is not valid JSON: ${e?.message ?? e}`, ".mcp.json");
        }
    }

    // Agent ↔ MCP cross-checks. The loader only WARNS on these at runtime,
    // which nobody reads; a publish is the moment the author is listening.
    const packageMcpNames = new Set(mcpServerNames);
    for (const agent of agents) {
        const file = `agents/${path.basename(agent.sourcePath ?? `${agent.name}.agent.md`)}`;
        const declaresMcp = (agent.mcpServers?.length ?? 0) > 0 || agent.inheritDefaultMcpServers === true;
        if (declaresMcp && (agent.schemaVersion ?? 1) < 2) {
            err(errors, "mcp_requires_schema_v2",
                `${file}: declares MCP servers but schemaVersion ${agent.schemaVersion ?? 1} — set "schemaVersion: 2" so older loaders skip the agent instead of silently dropping its MCP configuration`, file);
        }
        for (const ref of agent.mcpServers ?? []) {
            if (packageMcpNames.has(ref)) continue;
            warnings.push({
                code: "unknown_mcp_server",
                message: `${file}: mcpServers names "${ref}", which this package does not define — it must exist in the deployment catalog (and allow this agent) or the reference is dropped at load`,
                file,
            });
        }
    }

    // Tools + MCP server code — syntax-gate the module entry points.
    const toolsDir = path.join(rootDir, "tools");
    const hasToolsDir = fs.existsSync(toolsDir) && fs.statSync(toolsDir).isDirectory();
    const workerModulePath = path.join(toolsDir, "worker-module.js");
    if (hasToolsDir && !fs.existsSync(workerModulePath)) {
        err(errors, "missing_worker_module",
            "tools/ exists but tools/worker-module.js is missing — it is the tool entry point", "tools");
    }
    if (!opts.skipSyntaxCheck && walk) {
        const checkable = walk.files.filter((f) =>
            !f.isDir
            && /\.(mjs|cjs|js)$/.test(f.rel)
            && (f.rel.startsWith("tools/") || f.rel.startsWith("mcp-servers/"))
            && !f.rel.includes("node_modules/"));
        for (const f of checkable) {
            const failure = await nodeSyntaxCheck(f.abs);
            if (failure) {
                err(errors, "syntax_error", `${f.rel} failed syntax check:\n${failure}`, f.rel);
            }
        }
    }

    // Bare-specifier heads-up: package modules load from the unpack cache,
    // which has no node_modules above it — `import ... from "some-pkg"`
    // fails at runtime (quarantining the package) unless deps are vendored.
    // Tool modules should export plain tool objects and import nothing.
    if (walk) {
        const moduleFiles = walk.files.filter((f) =>
            !f.isDir && /\.(mjs|cjs|js)$/.test(f.rel)
            && (f.rel === "tools/worker-module.js" || f.rel.startsWith("mcp-servers/"))
            && !f.rel.includes("node_modules/"));
        const bareRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"'./][^"']*)["']/g;
        for (const f of moduleFiles) {
            let source = "";
            try { source = fs.readFileSync(f.abs, "utf8"); } catch { continue; }
            const bare = new Set<string>();
            for (const match of source.matchAll(bareRe)) {
                if (!match[1].startsWith("node:")) bare.add(match[1]);
            }
            if (bare.size > 0) {
                warnings.push({
                    code: "bare_imports",
                    message: `${f.rel} imports bare specifier(s) ${[...bare].map((b) => `"${b}"`).join(", ")} — these fail to resolve from the install cache unless vendored inside the package; export plain tool objects instead`,
                    file: f.rel,
                });
            }
        }
    }

    // Vendored-dependency heads-up (not an error — trusted system, size-capped).
    if (walk) {
        const vendoredBytes = walk.files
            .filter((f) => !f.isDir && f.rel.includes("node_modules/"))
            .reduce((sum, f) => sum + f.size, 0);
        if (vendoredBytes > VENDORED_WARN_BYTES) {
            warnings.push({
                code: "vendored_dependencies",
                message: `package vendors ${(vendoredBytes / (1024 * 1024)).toFixed(1)} MB of node_modules — keep packages dependency-light`,
            });
        }
    }

    const ok = errors.length === 0;
    const manifest: AgentPackageManifest | undefined = ok && pluginJson
        ? {
            name: pluginJson.name,
            version: pluginJson.version,
            title: typeof pluginJson.title === "string" && pluginJson.title.trim() ? pluginJson.title.trim() : undefined,
            description: typeof pluginJson.description === "string" ? pluginJson.description : undefined,
            agents: agents.map((a) => ({
                name: a.name,
                title: a.title,
                description: a.description,
                tools: a.tools ?? undefined,
                skills: a.skills,
                mcpServers: a.mcpServers,
                splash: a.splash,
                splashMobile: a.splashMobile,
                initialPrompt: a.initialPrompt,
                initialRequiredTool: a.initialRequiredTool,
                startedBy: a.startedBy,
                supportsDirectStart: a.supportsDirectStart,
            })),
            skills: skills.map((s) => ({ name: s.name, description: s.description })),
            mcpServers: mcpServerNames,
            hasTools: hasToolsDir,
            fileCount: walk ? walk.files.filter((f) => !f.isDir).length : 0,
            rawBytes: walk ? walk.files.reduce((sum, f) => sum + f.size, 0) : 0,
        }
        : undefined;

    return { ok, errors, warnings, manifest };
}
