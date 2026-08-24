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

import {
    directTree, directFile, collectUploadFiles, buildUploadPayload,
    packageFileForCli, reservedAgentNamesForCli,
} from "../src/agents-cli.js";

/** ctx stub: direct reads must route through the management client. */
function directCtxFor() {
    return {
        client: {
            async getAgentPackageTree() {
                return {
                    name: "cli-read-test",
                    files: [
                        { path: "plugin.json", size: 42 },
                        { path: "agents/probe.agent.md", size: 64 },
                    ],
                };
            },
            async getAgentPackageFile(_name, _semver, filePath) {
                if (filePath !== "plugin.json") {
                    throw Object.assign(new Error(`${filePath} not found`), { code: "NOT_FOUND" });
                }
                return { encoding: "utf8", content: '{"name": "cli-read-test"}', size: 25 };
            },
        },
    };
}

test("tree lists real file names, never undefined", async () => {
    const ctx = directCtxFor();

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
    const ctx = directCtxFor();

    const file = await directFile(ctx, "cli-read-test", undefined, "plugin.json", null, true);

    assert.equal(file.binary, undefined);
    assert.match(file.content, /"name": "cli-read-test"/);
});

test("cat still reports a genuinely missing file as NOT_FOUND", async () => {
    const ctx = directCtxFor();

    await assert.rejects(
        () => directFile(ctx, "cli-read-test", undefined, "nope.txt", null, true),
        (error) => error?.code === "NOT_FOUND",
    );
});

test("cat refuses base64 package files instead of printing them as text", () => {
    const formatted = packageFileForCli({ encoding: "base64", content: "AAEC", size: 3 });
    assert.equal(formatted.binary, true);
    assert.equal(formatted.size, 3);
    assert.equal(formatted.text, "");
});

test("direct push reserves bundled system agent names", () => {
    const names = reservedAgentNamesForCli().map((name) => String(name).toLowerCase());
    assert.ok(names.includes("sweeper"));
    assert.ok(names.includes("pilotswarm"));
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
