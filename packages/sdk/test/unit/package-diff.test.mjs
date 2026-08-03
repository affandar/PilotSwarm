/**
 * Package diffing — normalization, hunks, and the cron no-op signal.
 *
 * The finding this suite protects (§15 A9): a diff computed against a raw
 * source tree instead of a canonically-packed one shows the PACKER's
 * reshuffling on every run. The one changed line is then buried under file
 * moves, and the "did anything actually change?" signal the cron freshness
 * loop depends on becomes worthless.
 *
 * Run: node --test test/unit/package-diff.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packAgentPackage, readAgentPackageTarGz } from "../../dist/agent-package-format.js";

import {
    diffPackageTrees, unifiedDiff, patchArtifacts, entriesToMap, looksBinary,
    DIFF_MAX_FILE_BYTES,
} from "../../dist/agent-package-diff.js";

const e = (path, content) => ({ path, content: Buffer.from(content) });

// ── The no-op signal ──────────────────────────────────────────────

test("identical trees diff EMPTY — the signal cron depends on", () => {
    const tree = [e("agents/a.md", "hello\nworld\n"), e("plugin.json", "{}\n")];
    const diff = diffPackageTrees(tree, tree.map((x) => e(x.path, x.content.toString())));
    assert.equal(diff.identical, true);
    assert.deepEqual(diff.patches, []);
});

test("ordering differences are NOT a change", () => {
    // The packer fixes ordering; a diff that reported reordering as a change
    // would make every cron firing look like a real edit and publish forever.
    const left = [e("a.md", "x"), e("b.md", "y")];
    const right = [e("b.md", "y"), e("a.md", "x")];
    assert.equal(diffPackageTrees(left, right).identical, true);
});

test("a leading ./ is not a different path", () => {
    assert.equal(diffPackageTrees([e("./a.md", "x")], [e("a.md", "x")]).identical, true);
});

test("directory entries are ignored", () => {
    const map = entriesToMap([e("agents/", ""), e("agents/a.md", "x")]);
    assert.deepEqual([...map.keys()], ["agents/a.md"]);
});

// ── Real changes surface, minimally ───────────────────────────────

test("one changed line surfaces as one hunk", () => {
    const left = [e("agents/a.md", "line1\nline2\nline3\nline4\nline5\n")];
    const right = [e("agents/a.md", "line1\nline2\nCHANGED\nline4\nline5\n")];
    const diff = diffPackageTrees(left, right);
    assert.equal(diff.identical, false);
    assert.equal(diff.patches.length, 1);
    const patch = diff.patches[0];
    assert.equal(patch.status, "modified");
    assert.equal((patch.diff.match(/^@@/gm) || []).length, 1, "exactly one hunk");
    assert.match(patch.diff, /^-line3$/m);
    assert.match(patch.diff, /^\+CHANGED$/m);
    assert.ok(!patch.diff.includes("+line1"), "unchanged context is not marked as added");
});

test("adds and removes are classified, not shown as wholesale rewrites", () => {
    const diff = diffPackageTrees(
        [e("keep.md", "same"), e("gone.md", "bye")],
        [e("keep.md", "same"), e("new.md", "hi")],
    );
    const byPath = Object.fromEntries(diff.patches.map((p) => [p.path, p.status]));
    assert.deepEqual(byPath, { "gone.md": "removed", "new.md": "added" });
});

test("patches are ordered deterministically", () => {
    const diff = diffPackageTrees(
        [e("z.md", "1"), e("a.md", "1")],
        [e("z.md", "2"), e("a.md", "2")],
    );
    assert.deepEqual(diff.patches.map((p) => p.path), ["a.md", "z.md"]);
});

// ── Things that must never be inlined ─────────────────────────────

test("binaries are flagged, never inlined", () => {
    const bin = Buffer.from([0x00, 0x01, 0x02, 0x00]);
    assert.equal(looksBinary(bin), true);
    assert.equal(looksBinary(Buffer.from("plain text")), false);

    const diff = diffPackageTrees([{ path: "logo.png", content: bin }], [{ path: "logo.png", content: Buffer.from([0x00, 0x09]) }]);
    assert.equal(diff.patches[0].binary, true);
    assert.equal(diff.patches[0].diff, null);
    assert.match(diff.patches[0].note, /binary/);
});

test("oversize files are summarized, not inlined", () => {
    const big = "x".repeat(DIFF_MAX_FILE_BYTES + 10);
    const diff = diffPackageTrees([e("big.md", big)], [e("big.md", `${big}y`)]);
    assert.equal(diff.patches[0].diff, null);
    assert.match(diff.patches[0].note, /cap/);
});

test("a huge changed-file count is truncated with a marker", () => {
    const left = Array.from({ length: 250 }, (_, i) => e(`f${String(i).padStart(3, "0")}.md`, "a"));
    const right = left.map((x) => e(x.path, "b"));
    const diff = diffPackageTrees(left, right);
    assert.equal(diff.patches.length, 200);
    assert.equal(diff.truncated.omitted, 50);
});

// ── unifiedDiff directly ──────────────────────────────────────────

test("no change yields an empty diff string", () => {
    assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "f.md"), "");
});

test("hunk headers carry plausible line counts", () => {
    const out = unifiedDiff("a\nb\nc\n", "a\nX\nc\n", "f.md");
    assert.match(out, /^--- a\/f\.md$/m);
    assert.match(out, /^\+\+\+ b\/f\.md$/m);
    assert.match(out, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
});

test("an empty file on one side is an add or a remove, not a crash", () => {
    assert.ok(unifiedDiff("", "new\n", "f.md").includes("+new"));
    assert.ok(unifiedDiff("old\n", "", "f.md").includes("-old"));
});

// ── Patch artifacts ───────────────────────────────────────────────

test("patch artifacts are numerically ordered and safely named", () => {
    const diff = diffPackageTrees(
        [e("agents/a.md", "1"), e("skills/x/SKILL.md", "1")],
        [e("agents/a.md", "2"), e("skills/x/SKILL.md", "2")],
    );
    const artifacts = patchArtifacts(diff, { baseSemver: "1.2.0" });
    assert.equal(artifacts.length, 2);
    assert.match(artifacts[0].filename, /^01-/);
    assert.match(artifacts[1].filename, /^02-/);
    // Path separators must not survive into a filename.
    for (const a of artifacts) {
        assert.ok(!a.filename.includes("/"), a.filename);
        assert.match(a.filename, /\.patch$/);
    }
    // The base version is pinned in the patch so a stale-base publish is
    // detectable rather than silently applied to a moved target.
    assert.match(artifacts[0].content, /# base: 1\.2\.0/);
});

test("an empty diff produces no artifacts at all", () => {
    const same = [e("a.md", "x")];
    assert.deepEqual(patchArtifacts(diffPackageTrees(same, same)), []);
});

// ── The producer contract ─────────────────────────────────────────
//
// Everything above builds entries as {path, content} — the shape a STAGED
// edit has. The tar reader emits {name, body}, and for one release these
// tests all passed while every real package read came back empty: the map
// looked for `path`, found undefined, and skipped every entry. So the cases
// below drive the REAL packer/reader rather than a hand-built literal.

test("entries straight from readAgentPackageTarGz map by path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkgdiff-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), '{"name":"probe","version":"1.0.0"}\n');
    writeFileSync(join(dir, "agents/a.agent.md"), "alpha\n");

    const packed = packAgentPackage(dir);
    const entries = readAgentPackageTarGz(packed.targz);
    const map = entriesToMap(entries);

    // The regression: this was 0 for every real package.
    assert.ok(map.size >= 2, `expected the packed files, got ${map.size}`);
    assert.equal(map.get("plugin.json")?.toString(), '{"name":"probe","version":"1.0.0"}\n');
    assert.equal(map.get("agents/a.agent.md")?.toString(), "alpha\n");
    // Directory members never become files.
    for (const k of map.keys()) assert.ok(!k.endsWith("/"), k);
});

test("two different packed versions do NOT diff as identical", () => {
    const build = (body) => {
        const dir = mkdtempSync(join(tmpdir(), "pkgdiff-"));
        mkdirSync(join(dir, "agents"), { recursive: true });
        writeFileSync(join(dir, "plugin.json"), '{"name":"probe","version":"1.0.0"}\n');
        writeFileSync(join(dir, "agents/a.agent.md"), body);
        return readAgentPackageTarGz(packAgentPackage(dir).targz);
    };

    const diff = diffPackageTrees(build("alpha\n"), build("gamma\n"));
    // Reporting "identical" across different content is the exact failure the
    // Agent Manager hit: differing sha256, empty diff, no patch to review.
    assert.equal(diff.identical, false);
    assert.deepEqual(diff.patches.map((p) => [p.path, p.status]), [["agents/a.agent.md", "modified"]]);
});

test("a staged edit still diffs against real packed bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "pkgdiff-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), '{"name":"probe","version":"1.0.0"}\n');
    writeFileSync(join(dir, "agents/a.agent.md"), "alpha\n");
    const base = readAgentPackageTarGz(packAgentPackage(dir).targz);

    // propose_agent_patch compares packed bytes against staged {path, content},
    // so both shapes must resolve through one map.
    const diff = diffPackageTrees(base, [
        e("plugin.json", '{"name":"probe","version":"1.0.0"}\n'),
        e("agents/a.agent.md", "beta\n"),
    ]);
    assert.equal(diff.identical, false);
    assert.deepEqual(diff.patches.map((p) => p.path), ["agents/a.agent.md"]);
});
