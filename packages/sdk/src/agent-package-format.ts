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
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import * as crypto from "crypto";
import { spawn } from "child_process";
import { loadAgentFiles, type AgentConfig } from "./agent-loader.js";
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
    description?: string;
    agents: Array<{
        name: string;
        title?: string;
        description?: string;
        tools?: string[];
        skills?: string[];
        mcpServers?: string[];
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
    /** Skip `node --check` (used by pure-parse test paths). */
    skipSyntaxCheck?: boolean;
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
        agents = loadAgentFiles(agentsDir);
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
                if (schemaMatch && !["1", "2"].includes(schemaMatch[1])) {
                    err(errors, "unsupported_agent_schema_version",
                        `agents/${f}: schemaVersion ${schemaMatch[1]} is not supported (use 1 or 2)`, `agents/${f}`);
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
    const mcpJsonPath = path.join(rootDir, ".mcp.json");
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
                    mcpServerNames.push(serverName);
                }
            }
        } catch (e: any) {
            err(errors, "invalid_mcp_json", `.mcp.json is not valid JSON: ${e?.message ?? e}`, ".mcp.json");
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
            description: typeof pluginJson.description === "string" ? pluginJson.description : undefined,
            agents: agents.map((a) => ({
                name: a.name,
                title: a.title,
                description: a.description,
                tools: a.tools ?? undefined,
                skills: a.skills,
                mcpServers: a.mcpServers,
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
