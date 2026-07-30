import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import {
    agentPackagesArtifactSessionId,
    agentPackageArtifactFilename,
    agentPackageTarSha256,
    isValidSemver,
    compareSemver,
    normalizeAgentName,
    packAgentPackage,
    readAgentPackageTarGz,
    extractAgentPackageTarGz,
    validateAgentPackageDir,
} from "../../dist/agent-package-format.js";

// ─── fixtures ────────────────────────────────────────────────────

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-pkg-test-"));
}

/** Minimal valid package directory; mutate from here per case. */
function writeValidPackage(dir, { name = "acme-kit", version = "1.2.3" } = {}) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills", "ops"), { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name, version, description: "Test package",
    }));
    fs.writeFileSync(path.join(dir, "agents", "triager.agent.md"), [
        "---",
        "name: triager",
        "description: Triage agent",
        "schemaVersion: 1",
        "version: 1.0.0",
        "---",
        "",
        "You triage things.",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "skills", "ops", "SKILL.md"), [
        "---",
        "name: ops",
        "description: Ops knowledge",
        "---",
        "",
        "Do ops well.",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
        "ticket-api": { command: "node", args: ["./mcp-servers/ticket.js"], tools: ["*"] },
    }));
    return dir;
}

function errorCodes(validation) {
    return validation.errors.map((e) => e.code).sort();
}

// ─── identity ────────────────────────────────────────────────────

test("reserved artifact session id is a stable UUID", () => {
    const id = agentPackagesArtifactSessionId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(id, agentPackagesArtifactSessionId());
});

test("artifact filename embeds name, semver, and sha12", () => {
    const sha = "abcdef0123456789".repeat(4);
    assert.equal(
        agentPackageArtifactFilename("acme-kit", "1.2.3", sha),
        `acme-kit@1.2.3.${sha.slice(0, 12)}.tar.gz`,
    );
});

// ─── semver ──────────────────────────────────────────────────────

test("semver validity: concrete versions only", () => {
    for (const good of ["0.0.1", "1.2.3", "10.20.30", "1.2.3-dev.1", "1.2.3-rc.1+build.5"]) {
        assert.ok(isValidSemver(good), good);
    }
    for (const bad of ["1.2", "v1.2.3", "^1.2.3", "1.2.3 ", "1.02.3", "latest", "", null, undefined]) {
        assert.ok(!isValidSemver(bad), String(bad));
    }
});

test("semver precedence follows the spec", () => {
    assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
    assert.equal(compareSemver("1.2.3", "1.2.4"), -1);
    assert.equal(compareSemver("2.0.0", "1.9.9"), 1);
    // release > prerelease
    assert.equal(compareSemver("1.0.0", "1.0.0-rc.1"), 1);
    // numeric prerelease ids compare numerically, and below alphanumeric
    assert.equal(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
    assert.equal(compareSemver("1.0.0-1", "1.0.0-alpha"), -1);
    // shorter prerelease sorts lower
    assert.equal(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"), -1);
    // build metadata ignored
    assert.equal(compareSemver("1.0.0+a", "1.0.0+b"), 0);
});

// ─── canonical packing ───────────────────────────────────────────

test("packing is deterministic across mtimes and re-runs", () => {
    const a = writeValidPackage(tmpdir());
    const first = packAgentPackage(a);

    // Scramble every mtime; determinism must not care.
    const scramble = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            fs.utimesSync(p, new Date(946684800000), new Date(1234567890000));
            if (entry.isDirectory()) scramble(p);
        }
    };
    scramble(a);
    const second = packAgentPackage(a);
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(first.targz, second.targz);

    // An identical tree in a different directory packs to identical bytes.
    const b = writeValidPackage(tmpdir());
    const third = packAgentPackage(b);
    assert.equal(first.sha256, third.sha256);

    // Content change → different bytes.
    fs.appendFileSync(path.join(b, "agents", "triager.agent.md"), "\nMore.");
    const fourth = packAgentPackage(b);
    assert.notEqual(first.sha256, fourth.sha256);
});

test("pack → read roundtrip preserves files, ignores cruft", () => {
    const dir = writeValidPackage(tmpdir());
    fs.writeFileSync(path.join(dir, ".DS_Store"), "junk");
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: junk");

    const { targz, fileCount } = packAgentPackage(dir);
    const entries = readAgentPackageTarGz(targz);
    const names = entries.map((e) => e.name).sort();
    assert.equal(fileCount, 4);
    assert.deepEqual(names, [
        ".mcp.json",
        "agents/triager.agent.md",
        "plugin.json",
        "skills/ops/SKILL.md",
    ]);
    const plugin = entries.find((e) => e.name === "plugin.json");
    assert.equal(JSON.parse(plugin.body.toString()).name, "acme-kit");

    const dest = tmpdir();
    extractAgentPackageTarGz(targz, dest);
    assert.ok(fs.existsSync(path.join(dest, "skills", "ops", "SKILL.md")));
});

test("identity sha is over the uncompressed tar, not the gzip bytes", () => {
    const dir = writeValidPackage(tmpdir());
    const packed = packAgentPackage(dir);
    const tar = zlib.gunzipSync(packed.targz);
    const tarSha = crypto.createHash("sha256").update(tar).digest("hex");
    assert.equal(packed.sha256, tarSha, "sha256 must equal hash(gunzip(targz))");
    assert.notEqual(packed.sha256, crypto.createHash("sha256").update(packed.targz).digest("hex"),
        "and must NOT be the gz-byte hash (zlib output is not version-stable)");
    assert.equal(agentPackageTarSha256(packed.targz), packed.sha256);
});

test("packing rejects non-ASCII paths loudly (ustar names are byte-encoded)", () => {
    const dir = writeValidPackage(tmpdir());
    fs.writeFileSync(path.join(dir, "agents", "café-triager.agent.md"), "---\nname: cafe\nschemaVersion: 1\nversion: 1.0.0\n---\nx");
    assert.throws(() => packAgentPackage(dir), /non-ASCII paths are not allowed/);
});

test("packing rejects symlinks", () => {
    const dir = writeValidPackage(tmpdir());
    fs.symlinkSync("/etc/hosts", path.join(dir, "evil-link"));
    assert.throws(() => packAgentPackage(dir), /symlinks are not allowed/);
});

// ─── tar reader safety ───────────────────────────────────────────

const TAR_BLOCK = 512;

function rawTarHeader({ name, size = 0, typeflag = "0" }) {
    const header = Buffer.alloc(TAR_BLOCK);
    header.write(name, 0, "ascii");
    const writeOctal = (offset, length, value) => {
        header.write(value.toString(8).padStart(length - 1, "0"), offset, "ascii");
        header[offset + length - 1] = 0;
    };
    writeOctal(100, 8, 0o644);
    writeOctal(108, 8, 0);
    writeOctal(116, 8, 0);
    writeOctal(124, 12, size);
    writeOctal(136, 12, 0);
    header.write(typeflag, 156, "ascii");
    header.write("ustar", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (let i = 0; i < TAR_BLOCK; i++) sum += (i >= 148 && i < 156) ? 0x20 : header[i];
    header.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    return header;
}

function evilTarGz(headerOpts, body = Buffer.alloc(0)) {
    const chunks = [rawTarHeader({ ...headerOpts, size: body.length })];
    if (body.length > 0) {
        chunks.push(body);
        const pad = body.length % TAR_BLOCK;
        if (pad !== 0) chunks.push(Buffer.alloc(TAR_BLOCK - pad));
    }
    chunks.push(Buffer.alloc(TAR_BLOCK * 2));
    return zlib.gzipSync(Buffer.concat(chunks));
}

test("tar reader rejects traversal, absolute paths, and links", () => {
    assert.throws(
        () => readAgentPackageTarGz(evilTarGz({ name: "../evil.txt" }, Buffer.from("x"))),
        /escapes package root/,
    );
    assert.throws(
        () => readAgentPackageTarGz(evilTarGz({ name: "/etc/passwd" }, Buffer.from("x"))),
        /non-relative path/,
    );
    assert.throws(
        () => readAgentPackageTarGz(evilTarGz({ name: "link", typeflag: "2" })),
        /not allowed in a package/,
    );
    assert.throws(
        () => readAgentPackageTarGz(evilTarGz({ name: "hard", typeflag: "1" })),
        /not allowed in a package/,
    );
});

test("extract refuses entries that escape the destination", () => {
    const nested = evilTarGz({ name: "a/../../evil" }, Buffer.from("x"));
    assert.throws(() => extractAgentPackageTarGz(nested, tmpdir()), /escapes package root/);
});

test("reader rejects truncated bodies, dir-with-size desync, and old-style typeflags", () => {
    // Header declares 9999 bytes but the archive ends — must throw, not
    // silently write a truncated file.
    const truncated = (() => {
        const header = rawTarHeader({ name: "big.txt", size: 9999 });
        return zlib.gzipSync(Buffer.concat([header, Buffer.from("xx"), Buffer.alloc(TAR_BLOCK * 2)]));
    })();
    assert.throws(() => readAgentPackageTarGz(truncated), /truncated/);

    // A directory entry declaring a body would desync the parser.
    assert.throws(
        () => readAgentPackageTarGz(evilTarGz({ name: "dir/", typeflag: "5", size: 100 }, Buffer.alloc(100))),
        /directory entry with nonzero size/,
    );

    // Old-style "\0" typeflag is outside the canonical contract.
    assert.throws(
        () => readAgentPackageTarGz(evilTarGz({ name: "old.txt", typeflag: "\0" }, Buffer.from("x"))),
        /not allowed in a package/,
    );
});

// ─── validation matrix ───────────────────────────────────────────
// Every case asserts the exact user-facing behavior: the error code AND that
// the message names the rule. The CLI prints these verbatim.

test("valid package produces a manifest and no errors", async () => {
    const dir = writeValidPackage(tmpdir());
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(result.errors, []);
    assert.ok(result.ok);
    assert.equal(result.manifest.name, "acme-kit");
    assert.equal(result.manifest.version, "1.2.3");
    assert.deepEqual(result.manifest.agents.map((a) => a.name), ["triager"]);
    assert.deepEqual(result.manifest.skills.map((s) => s.name), ["ops"]);
    assert.deepEqual(result.manifest.mcpServers, ["ticket-api"]);
    assert.equal(result.manifest.hasTools, false);
});

test("missing plugin.json", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.rmSync(path.join(dir, "plugin.json"));
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["missing_plugin_json"]);
    assert.match(result.errors[0].message, /plugin\.json is required/);
});

test("invalid plugin.json JSON", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.writeFileSync(path.join(dir, "plugin.json"), "{nope");
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.ok(errorCodes(result).includes("invalid_plugin_json"));
});

test("bad name and ranged version are rejected with fix-forward messages", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name: "Not_A_Label", version: "^1.2.3",
    }));
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["invalid_name", "invalid_version"]);
    assert.match(result.errors.find((e) => e.code === "invalid_name").message, /DNS label/);
    assert.match(result.errors.find((e) => e.code === "invalid_version").message, /concrete semver/);
});

test("system: true agents are rejected", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.writeFileSync(path.join(dir, "agents", "bg.agent.md"), [
        "---", "name: bg", "description: background", "schemaVersion: 1",
        "version: 1.0.0", "system: true", "id: bg", "---", "", "Background.",
    ].join("\n"));
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["system_agent_forbidden"]);
    assert.match(result.errors[0].message, /baked app/);
});

test("an agent named default is rejected", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.writeFileSync(path.join(dir, "agents", "default.agent.md"), [
        "---", "name: default", "description: overlay", "schemaVersion: 1",
        "version: 1.0.0", "---", "", "Overlay.",
    ].join("\n"));
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["default_agent_forbidden"]);
});

test("baked-name collisions are rejected — including the resolver's fuzzy variants", async () => {
    const dir = writeValidPackage(tmpdir());
    const exact = await validateAgentPackageDir(dir, {
        skipSyntaxCheck: true,
        reservedAgentNames: ["triager"],
    });
    assert.deepEqual(errorCodes(exact), ["reserved_agent_name"]);
    assert.match(exact.errors[0].message, /built-in agent/);

    // The runtime matches case/punctuation-insensitively with an "agent"
    // suffix fallback — every spelling variant must be caught too.
    for (const alias of ["Swee-per", "SWEEPER", "sweeper-agent", "swee_per"]) {
        const aliased = writeValidPackage(tmpdir());
        fs.writeFileSync(path.join(aliased, "agents", "alias.agent.md"), [
            "---", `name: ${alias}`, "description: alias", "schemaVersion: 1",
            "version: 1.0.0", "---", "", "Alias body.",
        ].join("\n"));
        const result = await validateAgentPackageDir(aliased, {
            skipSyntaxCheck: true,
            reservedAgentNames: ["sweeper"],
        });
        assert.ok(
            result.errors.some((e) => e.code === "reserved_agent_name"),
            `variant ${alias} must be rejected (normalize: ${normalizeAgentName(alias)})`,
        );
    }
});

test("duplicate agent names within a package are rejected (normalized)", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.writeFileSync(path.join(dir, "agents", "dup.agent.md"), [
        "---", "name: Tri-Ager", "description: dup", "schemaVersion: 1",
        "version: 1.0.0", "---", "", "Dup body.",
    ].join("\n"));
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["duplicate_agent_name"]);
    assert.match(result.errors[0].message, /unreachable/);
});

test("agent skip reasons are named honestly", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.writeFileSync(path.join(dir, "agents", "empty.agent.md"), [
        "---", "name: empty", "description: no body", "schemaVersion: 1", "version: 1.0.0", "---", "",
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "agents", "future.agent.md"), [
        "---", "name: future", "description: v3", "schemaVersion: 3", "version: 1.0.0", "---", "", "Body.",
    ].join("\n"));
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["empty_agent_body", "unsupported_agent_schema_version"]);
    assert.match(result.errors.find((e) => e.code === "empty_agent_body").message, /cannot be blank/);
    assert.match(result.errors.find((e) => e.code === "unsupported_agent_schema_version").message, /use 1 or 2/);
});

test("session-policy.json is forbidden in packages", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.writeFileSync(path.join(dir, "session-policy.json"), JSON.stringify({ version: 1, creation: { mode: "open" } }));
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["session_policy_forbidden"]);
    assert.match(result.errors[0].message, /must not override/);
});

test("non-ASCII paths are a validation error", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.writeFileSync(path.join(dir, "skills", "ops", "café.md"), "notes");
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["non_ascii_path"]);
    assert.match(result.errors[0].message, /rename to ASCII/);
});

test("skill directory without SKILL.md is loud", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.mkdirSync(path.join(dir, "skills", "empty-skill"));
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["skill_missing_skill_md"]);
});

test("malformed .mcp.json shapes are rejected", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({
        "broken": { tools: ["*"] },
    }));
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["invalid_mcp_server"]);
    assert.match(result.errors[0].message, /"command" \(stdio\) or "url"/);
});

test("tools/ without worker-module.js is rejected", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.mkdirSync(path.join(dir, "tools"));
    fs.writeFileSync(path.join(dir, "tools", "helper.js"), "export const x = 1;");
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["missing_worker_module"]);
});

test("worker-module syntax errors are caught by the compile-only check", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.mkdirSync(path.join(dir, "tools"));
    fs.writeFileSync(path.join(dir, "tools", "worker-module.js"), "export default {{{");
    const result = await validateAgentPackageDir(dir);
    assert.deepEqual(errorCodes(result), ["syntax_error"]);
    assert.match(result.errors[0].message, /worker-module\.js failed syntax check/);

    // And a healthy module (with imports, never executed) passes.
    fs.writeFileSync(
        path.join(dir, "tools", "worker-module.js"),
        'import { defineTool } from "pilotswarm-sdk";\nexport default { createTools: () => [] };\n',
    );
    const ok = await validateAgentPackageDir(dir);
    assert.deepEqual(ok.errors, []);

    // Helpers under tools/ are gated too — a broken import target must not
    // slip through to fail at worker import time.
    fs.writeFileSync(path.join(dir, "tools", "helper.js"), "const oops = {{{");
    const helperBroken = await validateAgentPackageDir(dir);
    assert.deepEqual(errorCodes(helperBroken), ["syntax_error"]);
    assert.match(helperBroken.errors[0].message, /helper\.js/);
});

test("symlinks are a validation error too", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.symlinkSync("/etc/hosts", path.join(dir, "sneaky"));
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.deepEqual(errorCodes(result), ["symlink"]);
});

test("bare imports in tool modules warn about cache-dir resolution", async () => {
    const dir = writeValidPackage(tmpdir());
    fs.mkdirSync(path.join(dir, "tools"));
    fs.writeFileSync(
        path.join(dir, "tools", "worker-module.js"),
        'import { defineTool } from "pilotswarm-sdk";\nimport * as fs from "node:fs";\nimport { x } from "./local.js";\nexport default { tools: [] };\n',
    );
    fs.writeFileSync(path.join(dir, "tools", "local.js"), "export const x = 1;");
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.ok(result.ok);
    const warning = result.warnings.find((w) => w.code === "bare_imports");
    assert.ok(warning, "bare import must warn");
    assert.match(warning.message, /"pilotswarm-sdk"/);
    assert.ok(!warning.message.includes("node:fs"), "node: builtins are fine");
    assert.ok(!warning.message.includes("./local.js"), "relative imports are fine");
});

test("vendored node_modules over the threshold warns, does not fail", async () => {
    const dir = writeValidPackage(tmpdir());
    const vendored = path.join(dir, "tools", "node_modules", "dep");
    fs.mkdirSync(vendored, { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", "worker-module.js"), "export default { tools: [] };");
    fs.writeFileSync(path.join(vendored, "big.js"), Buffer.alloc(3 * 1024 * 1024, 0x20));
    const result = await validateAgentPackageDir(dir, { skipSyntaxCheck: true });
    assert.ok(result.ok, JSON.stringify(result.errors));
    assert.ok(result.warnings.some((w) => w.code === "vendored_dependencies"));
    assert.equal(result.manifest.hasTools, true);
});
