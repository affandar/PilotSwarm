/**
 * Client-side package import — the browser reads the repo as the viewer and
 * hands files to the standard upload path. `fetch` is injected, so the whole
 * walk (tree listing → per-file bytes → base64) is exercised here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { importPackageFilesFromLink, parseAdoRepoUrl } from "../src/index.js";

const enc = (text) => new TextEncoder().encode(text);

function jsonResponse(body) {
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
function bytesResponse(bytes) {
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}
function errorResponse(status, body = "") {
    return { ok: false, status, json: async () => ({}), text: async () => body };
}

function decode(file) {
    return Buffer.from(file.contentBase64, "base64").toString("utf8");
}

test("public GitHub: tree listing + raw file reads, scoped to the package folder", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url.includes("/git/trees/")) {
            return jsonResponse({
                truncated: false,
                tree: [
                    { path: "README.md", type: "blob", sha: "r1" },
                    { path: "kits/demo/plugin.json", type: "blob", sha: "a1" },
                    { path: "kits/demo/agents", type: "tree", sha: "t1" },
                    { path: "kits/demo/agents/greeter.agent.md", type: "blob", sha: "a2" },
                    { path: "kits/demo/node_modules/dep/index.js", type: "blob", sha: "a3" },
                    { path: "kits/other/plugin.json", type: "blob", sha: "b1" },
                ],
            });
        }
        if (url.startsWith("https://raw.githubusercontent.com/")) {
            return bytesResponse(enc(url.endsWith("plugin.json") ? '{"name":"demo"}' : "# Greeter"));
        }
        throw new Error(`unexpected url ${url}`);
    };

    const { kind, files } = await importPackageFilesFromLink(
        "https://github.com/acme/agents/blob/main/kits/demo/plugin.json",
        { fetchImpl },
    );

    assert.equal(kind, "github");
    assert.deepEqual(files.map((f) => f.path).sort(), ["agents/greeter.agent.md", "plugin.json"],
        "only the package subtree, paths relative to it, node_modules skipped");
    assert.equal(decode(files.find((f) => f.path === "plugin.json")), '{"name":"demo"}');
    assert.equal(calls.some((url) => url.includes("api.github.com/repos/acme/agents/git/trees/main")), true);
    assert.equal(calls.every((url) => !url.includes("/git/blobs/")), true,
        "anonymous reads go to raw.githubusercontent, not the rate-limited blobs API");
});

test("GitHub with a PAT reads through the authorized blobs API", async () => {
    const seen = { auth: [], blobs: 0 };
    const fetchImpl = async (url, init) => {
        seen.auth.push(init?.headers?.authorization || null);
        if (url.includes("/git/trees/")) {
            return jsonResponse({ truncated: false, tree: [{ path: "plugin.json", type: "blob", sha: "s1" }] });
        }
        if (url.includes("/git/blobs/")) {
            seen.blobs += 1;
            return jsonResponse({ encoding: "base64", content: Buffer.from('{"name":"p"}').toString("base64") + "\n" });
        }
        throw new Error(`unexpected url ${url}`);
    };

    const { files } = await importPackageFilesFromLink("https://github.com/acme/private/tree/main", { fetchImpl, token: "ghp_x" });
    assert.equal(seen.blobs, 1);
    assert.equal(decode(files[0]), '{"name":"p"}');
    assert.ok(seen.auth.every((value) => value === "Bearer ghp_x"), "every call carries the PAT");
});

test("GitHub default branch is resolved when the link has no ref", async () => {
    const fetchImpl = async (url) => {
        if (url === "https://api.github.com/repos/acme/agents") return jsonResponse({ default_branch: "trunk" });
        if (url.includes("/git/trees/trunk")) {
            return jsonResponse({ truncated: false, tree: [{ path: "plugin.json", type: "blob", sha: "s" }] });
        }
        if (url.includes("raw.githubusercontent.com/acme/agents/trunk/")) return bytesResponse(enc("{}"));
        throw new Error(`unexpected url ${url}`);
    };
    const { files } = await importPackageFilesFromLink("https://github.com/acme/agents", { fetchImpl });
    assert.deepEqual(files.map((f) => f.path), ["plugin.json"]);
});

test("Azure DevOps: items listing + blob bytes with the viewer's bearer token", async () => {
    const seen = { auth: null, listing: null };
    const fetchImpl = async (url, init) => {
        if (url.includes("/items?")) {
            seen.auth = init?.headers?.authorization || null;
            seen.listing = url;
            return jsonResponse({
                value: [
                    { path: "/kits/demo", gitObjectType: "tree", isFolder: true, objectId: "t" },
                    { path: "/kits/demo/plugin.json", gitObjectType: "blob", objectId: "o1" },
                    { path: "/kits/demo/skills/ops/SKILL.md", gitObjectType: "blob", objectId: "o2" },
                ],
            });
        }
        if (url.includes("/blobs/")) return bytesResponse(enc(url.includes("o1") ? '{"name":"demo"}' : "# Ops"));
        throw new Error(`unexpected url ${url}`);
    };

    const { kind, files } = await importPackageFilesFromLink(
        "https://dev.azure.com/msdata/Database%20Systems/_git/markdowns?path=/kits/demo/plugin.json&version=GBusers/me/branch",
        { fetchImpl, token: "entra.jwt.token", tokenKind: "bearer" },
    );

    assert.equal(kind, "ado");
    assert.equal(seen.auth, "Bearer entra.jwt.token");
    assert.match(seen.listing, /Database%2520Systems|Database%20Systems/);
    assert.match(seen.listing, /versionDescriptor\.version=users%2Fme%2Fbranch/);
    assert.deepEqual(files.map((f) => f.path).sort(), ["plugin.json", "skills/ops/SKILL.md"]);
    assert.equal(decode(files.find((f) => f.path === "plugin.json")), '{"name":"demo"}');
});

test("Azure DevOps with a PAT uses Basic auth", async () => {
    let auth = null;
    const fetchImpl = async (url, init) => {
        if (url.includes("/items?")) {
            auth = init?.headers?.authorization || null;
            return jsonResponse({ value: [{ path: "/plugin.json", gitObjectType: "blob", objectId: "o" }] });
        }
        return bytesResponse(enc("{}"));
    };
    await importPackageFilesFromLink("https://dev.azure.com/org/proj/_git/repo", { fetchImpl, token: "pat123", tokenKind: "pat" });
    assert.equal(auth, `Basic ${Buffer.from(":pat123").toString("base64")}`);
});

test("failures explain themselves: no manifest, no credential, blocked host", async () => {
    const treeOnly = async (url) => (url.includes("/git/trees/")
        ? jsonResponse({ truncated: false, tree: [{ path: "readme.md", type: "blob", sha: "s" }] })
        : bytesResponse(enc("x")));
    await assert.rejects(
        importPackageFilesFromLink("https://github.com/acme/agents/tree/main", { fetchImpl: treeOnly }),
        /no plugin\.json/);

    await assert.rejects(
        importPackageFilesFromLink("https://dev.azure.com/org/proj/_git/repo", { fetchImpl: async () => jsonResponse({}) }),
        /needs a credential/);

    const blocked = async () => { throw new TypeError("Failed to fetch"); };
    await assert.rejects(
        importPackageFilesFromLink("https://github.com/acme/agents/tree/main", { fetchImpl: blocked }),
        /could not reach api\.github\.com.*Upload folder/s);

    const notFound = async () => errorResponse(404, "Not Found");
    await assert.rejects(
        importPackageFilesFromLink("https://github.com/acme/agents/tree/main", { fetchImpl: notFound }),
        /HTTP 404/);
});

test("the upload envelope is enforced during the walk", async () => {
    const big = new Uint8Array(1024 * 1024);
    const fetchImpl = async (url) => (url.includes("/git/trees/")
        ? jsonResponse({
            truncated: false,
            tree: [
                { path: "plugin.json", type: "blob", sha: "a" },
                { path: "big1.bin", type: "blob", sha: "b" },
                { path: "big2.bin", type: "blob", sha: "c" },
                { path: "big3.bin", type: "blob", sha: "d" },
            ],
        })
        : bytesResponse(big));
    await assert.rejects(
        importPackageFilesFromLink("https://github.com/acme/agents/tree/main", { fetchImpl }),
        /exceeds the .* upload limit/);
});

test("ADO org/project/repo parsing covers both host shapes", () => {
    assert.deepEqual(parseAdoRepoUrl("https://dev.azure.com/msdata/Database%20Systems/_git/markdowns"),
        { org: "msdata", project: "Database Systems", repo: "markdowns" });
    assert.deepEqual(parseAdoRepoUrl("https://acme.visualstudio.com/proj/_git/repo"),
        { org: "acme", project: "proj", repo: "repo" });
});
