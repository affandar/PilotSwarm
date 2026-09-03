import test from "node:test";
import assert from "node:assert/strict";

import { parsePluginSpec, adoCloneUrl, PLUGIN_SPEC_SCHEMES } from "../../dist/plugin-spec.js";

// Characterizes the PLUGIN_SPEC grammar parser and the ADO clone-URL builder.
// Grammar (';'-delimited entries):
//   ado-git:<org>/<project>/<repo>:<path>[@<ref>]
//   github:<owner>/<repo>:<path>[@<ref>]
//   local:<path>

test("blank input yields no entries", () => {
    assert.deepEqual(parsePluginSpec(""), []);
    assert.deepEqual(parsePluginSpec(null), []);
    assert.deepEqual(parsePluginSpec(undefined), []);
    assert.deepEqual(parsePluginSpec("   "), []);
});

test("parses a fully-qualified ado-git spec (project may contain spaces)", () => {
    const [e] = parsePluginSpec("ado-git:contoso/Example Project/tools-repo:plugins/example");
    assert.equal(e.scheme, "ado-git");
    assert.equal(e.org, "contoso");
    assert.equal(e.project, "Example Project");
    assert.equal(e.repo, "tools-repo");
    assert.equal(e.path, "plugins/example");
    assert.equal(e.ref, undefined);
});

test("splits an optional git ref off the rightmost '@'", () => {
    const [e] = parsePluginSpec("ado-git:org/proj/repo:path/to/plugin@main");
    assert.equal(e.path, "path/to/plugin");
    assert.equal(e.ref, "main");
});

test("trims a trailing .git from the repo segment", () => {
    const [e] = parsePluginSpec("ado-git:org/proj/repo.git:plugins/x");
    assert.equal(e.repo, "repo");
});

test("treats extra middle segments as part of the project (org=first, repo=last)", () => {
    const [e] = parsePluginSpec("ado-git:org/a/b/repo:plugins/x");
    assert.equal(e.org, "org");
    assert.equal(e.project, "a/b");
    assert.equal(e.repo, "repo");
});

test("parses a github spec with ref and .git trim", () => {
    const [e] = parsePluginSpec("github:owner/repo.git:plugins/x@v1");
    assert.equal(e.scheme, "github");
    assert.equal(e.owner, "owner");
    assert.equal(e.repo, "repo");
    assert.equal(e.path, "plugins/x");
    assert.equal(e.ref, "v1");
});

test("parses a local spec and allows an absolute path", () => {
    const [abs] = parsePluginSpec("local:/opt/plugins/x");
    assert.equal(abs.scheme, "local");
    assert.equal(abs.path, "/opt/plugins/x");

    const [rel] = parsePluginSpec("local:some/dir");
    assert.equal(rel.path, "some/dir");
});

test("parses multiple ';'-delimited entries in order and skips empty chunks", () => {
    const entries = parsePluginSpec("local:a;;;github:o/r:p");
    assert.equal(entries.length, 2);
    assert.equal(entries[0].scheme, "local");
    assert.equal(entries[0].path, "a");
    assert.equal(entries[1].scheme, "github");
});

test("recognizes scheme prefixes case-insensitively", () => {
    const [e] = parsePluginSpec("ADO-GIT:org/proj/repo:plugins/x");
    assert.equal(e.scheme, "ado-git");
});

test("rejects an unrecognized scheme", () => {
    assert.throws(() => parsePluginSpec("unknown:foo"), /unrecognized scheme/);
});

test("rejects an under-qualified ado-git spec", () => {
    assert.throws(() => parsePluginSpec("ado-git:org/repo:plugins/x"), /fully qualified/);
});

test("rejects an ado-git spec missing its ':<path>'", () => {
    assert.throws(() => parsePluginSpec("ado-git:org/proj/repo"), /missing ':<path>'/);
});

test("rejects a plugin path containing traversal", () => {
    assert.throws(() => parsePluginSpec("ado-git:org/proj/repo:../evil"), /traversal/);
});

test("rejects an absolute plugin path for ado-git", () => {
    assert.throws(() => parsePluginSpec("ado-git:org/proj/repo:/abs"), /must be relative/);
});

test("rejects an under-qualified github spec", () => {
    assert.throws(() => parsePluginSpec("github:owner:plugins/x"), /github:<owner>\/<repo>/);
});

test("rejects a local spec with no path", () => {
    assert.throws(() => parsePluginSpec("local:"), /local spec needs a path/);
});

test("adoCloneUrl uses the visualstudio.com host form and URL-encodes project + repo", () => {
    assert.equal(
        adoCloneUrl("contoso", "Example Project", "tools-repo"),
        "https://contoso.visualstudio.com/Example%20Project/_git/tools-repo",
    );
    assert.equal(
        adoCloneUrl("org", "P&D", "re po"),
        "https://org.visualstudio.com/P%26D/_git/re%20po",
    );
});

test("PLUGIN_SPEC_SCHEMES exposes the recognized prefixes", () => {
    assert.equal(PLUGIN_SPEC_SCHEMES.AdoGit, "ado-git:");
    assert.equal(PLUGIN_SPEC_SCHEMES.GitHub, "github:");
    assert.equal(PLUGIN_SPEC_SCHEMES.Local, "local:");
});
