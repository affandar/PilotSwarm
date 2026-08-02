/**
 * `pilotswarm agents tree|cat` in direct-store mode, and what `push` uploads
 * in web mode. Pure: a real canonical tarball, stub catalog/artifact store,
 * no database and no network.
 *
 * Both paths shipped broken because only the WEB path was exercised by hand:
 *
 *   - tree/cat read `entry.path` from readAgentPackageTarGz, whose entries are
 *     `{ name, body }`. Every path was `undefined`, so `tree` printed a column
 *     of "undefined" and `cat` matched nothing, for every file, always.
 *   - push validated the STAGED tree but uploaded a walk of the ORIGINAL
 *     directory. For a manifest-mode package those differ: the upload could
 *     carry files the validation never saw (and blow the 2 MB envelope on a
 *     package that is comfortably under it).
 *
 * Run: node --test tui/test/agents-cli-package-reads.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { packAgentPackage, agentPackageTarSha256 } from "pilotswarm-sdk";
import { directTree, directFile, collectUploadFiles, buildUploadPayload } from "../src/agents-cli.js";

/** A minimal convention-mode package: one agent, one extra file. */
function writeConventionPackage(root) {
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({
        name: "cli-read-test",
        version: "0.1.0",
        description: "fixture",
    }, null, 2));
    fs.writeFileSync(path.join(root, "agents", "probe.agent.md"),
        "---\nname: probe\ndescription: fixture agent\n---\n\nBody.\n");
    fs.writeFileSync(path.join(root, "README.md"), "# fixture\n");
    return root;
}

/** ctx stub: the two fields loadDirectPackageEntries touches. */
function directCtxFor(targz, sha256) {
    return {
        catalog: {
            async getAgentPackage() {
                return {
                    name: "cli-read-test",
                    activeVersionId: "v1",
                    versions: [{ versionId: "v1", semver: "0.1.0", sha256, artifactFilename: "pkg.tar.gz" }],
                };
            },
        },
        artifactStore: {
            async downloadArtifact() { return { body: targz }; },
        },
    };
}

function packFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-cli-read-"));
    writeConventionPackage(root);
    const packed = packAgentPackage(root);
    return { root, targz: packed.targz, sha256: packed.sha256 ?? agentPackageTarSha256(packed.targz) };
}

test("tree lists real file names, never undefined", async () => {
    const { targz, sha256 } = packFixture();
    const ctx = directCtxFor(targz, sha256);

    const tree = await directTree(ctx, "cli-read-test", undefined, null, true);

    assert.ok(tree.length > 0, "expected entries");
    for (const entry of tree) {
        assert.equal(typeof entry.path, "string", `entry.path must be a string, got ${entry.path}`);
        assert.notEqual(entry.path, "undefined");
        assert.ok(entry.size > 0, `${entry.path} should have a size`);
    }
    assert.ok(tree.some((e) => e.path === "plugin.json"), `plugin.json missing from ${JSON.stringify(tree.map((e) => e.path))}`);
    assert.ok(tree.some((e) => e.path === "agents/probe.agent.md"));
});

test("cat finds a file that exists and reports its contents", async () => {
    const { targz, sha256 } = packFixture();
    const ctx = directCtxFor(targz, sha256);

    const file = await directFile(ctx, "cli-read-test", undefined, "plugin.json", null, true);

    assert.equal(file.binary, undefined);
    assert.match(file.content, /"name": "cli-read-test"/);
});

test("cat still reports a genuinely missing file as NOT_FOUND", async () => {
    const { targz, sha256 } = packFixture();
    const ctx = directCtxFor(targz, sha256);

    await assert.rejects(
        () => directFile(ctx, "cli-read-test", undefined, "nope.txt", null, true),
        (error) => error?.code === "NOT_FOUND",
    );
});

test("the upload payload comes from the staged tree, not the surrounding directory", async () => {
    // Manifest mode: plugin.json declares its layout, so staging copies only
    // the declared files. Anything else in the folder must NOT be uploaded.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-cli-stage-"));
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.mkdirSync(path.join(root, "scratch"), { recursive: true });
    fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({
        name: "stage-scope-test",
        version: "0.1.0",
        description: "fixture",
        agents: ["agents/probe.agent.md"],
    }, null, 2));
    fs.writeFileSync(path.join(root, "agents", "probe.agent.md"),
        "---\nname: probe\ndescription: fixture agent\n---\n\nBody.\n");
    fs.writeFileSync(path.join(root, "scratch", "huge-unrelated.bin"), Buffer.alloc(64 * 1024, 1));

    // Exercises the real payload builder `push` calls — not a re-derivation
    // of it, so wiring push back to the raw directory fails this test.
    const uploaded = (await buildUploadPayload(root)).map((f) => f.path);

    assert.ok(uploaded.includes("plugin.json"));
    assert.ok(
        !uploaded.some((p) => p.startsWith("scratch/")),
        `upload payload leaked unstaged files: ${JSON.stringify(uploaded)}`,
    );
    // Guards the distinction the bug erased: a raw walk DOES carry them, so
    // this fixture genuinely separates the two behaviours.
    assert.ok(
        collectUploadFiles(root).map((f) => f.path).some((p) => p.startsWith("scratch/")),
        "fixture is not exercising the staged-vs-raw difference",
    );
});
