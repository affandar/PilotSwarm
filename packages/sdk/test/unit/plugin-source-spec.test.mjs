import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
    parsePluginSpecs,
    PluginSpecError,
} from "../../dist/plugin-source-spec.js";
import {
    installPluginSpecs,
    PluginInstallError,
} from "../../dist/plugin-installer.js";
import { createGitPluginSourceResolver } from "../../dist/git-plugin-source.js";

function tempDir(t, prefix = "plugin-spec-") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function pluginDir(root, name = "plugin") {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agents", "example.agent.md"), "example");
    return dir;
}

test("parsePluginSpecs accepts strict provider-neutral JSON", () => {
    assert.deepEqual(parsePluginSpecs(JSON.stringify([
        { kind: "local", path: "plugins/local" },
        { kind: "git", repository: "https://example.invalid/plugins.git", path: "./plugins\\demo", ref: "v1.2.3" },
    ])), [
        { kind: "local", path: "plugins/local" },
        { kind: "git", repository: "https://example.invalid/plugins.git", path: "plugins/demo", ref: "v1.2.3" },
    ]);
    assert.deepEqual(parsePluginSpecs("  "), []);
});

test("parsePluginSpecs rejects malformed or ambiguous specifications", () => {
    const invalid = [
        ["{}", /JSON array/],
        [[null], /must be an object/],
        [[{ kind: "archive", path: "x" }], /kind must be/],
        [[{ kind: "local", path: "" }], /path must be/],
        [[{ kind: "local", path: "x", typo: true }], /unknown field: typo/],
        [[{ kind: "git", repository: "http://example.invalid/r", path: "x" }], /https, ssh, or file/],
        [[{ kind: "git", repository: "https://secret@example.invalid/r", path: "x" }], /must not contain credentials/],
        [[{ kind: "git", repository: "https://example.invalid/r?token=value", path: "x" }], /query or fragment/],
        [[{ kind: "git", repository: "git@example.invalid:r", path: "x" }], /scp-like syntax/],
        [[{ kind: "git", repository: "repo", path: "../x" }], /traversal/],
        [[{ kind: "git", repository: "repo", path: "/x" }], /must be relative/],
        [[{ kind: "git", repository: "repo", path: "x", ref: "-upload-pack=x" }], /ref is not a valid/],
        [[{ kind: "git", repository: "repo", path: "x", ref: "refs/heads/a..b" }], /ref is not a valid/],
    ];
    for (const [value, pattern] of invalid) {
        assert.throws(() => parsePluginSpecs(value), pattern);
    }
    assert.throws(
        () => parsePluginSpecs("{"),
        error => error instanceof PluginSpecError
            && error.cause instanceof SyntaxError
            && /valid JSON/.test(error.message),
    );
});

test("duplicate sources are rejected before installation", async () => {
    const destinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-spec-destination-"));
    let checkoutCalls = 0;
    try {
        await assert.rejects(
            installPluginSpecs([
                { kind: "git", repository: "repo", path: "plugins/./demo", ref: "main" },
                { kind: "git", repository: "repo", path: "plugins/demo", ref: "main" },
            ], {
                destinationRoot,
                git: { checkout: async () => { checkoutCalls += 1; } },
            }),
            /duplicates source 0/,
        );
        assert.equal(checkoutCalls, 0);
        assert.deepEqual(fs.readdirSync(destinationRoot), []);
    } finally {
        fs.rmSync(destinationRoot, { recursive: true, force: true });
    }
});

test("local sources resolve to observable absolute plugin directories", async t => {
    const root = tempDir(t);
    const local = pluginDir(root);
    const destinationRoot = path.join(root, "install");

    const [installed] = await installPluginSpecs(
        [{ kind: "local", path: path.relative(root, local) }],
        { cwd: root, destinationRoot },
    );

    assert.equal(installed.spec.kind, "local");
    assert.equal(installed.pluginDir, fs.realpathSync(local));
    assert.equal(installed.destinationDir, null);
});

test("Git resolver receives an exact validated ref without shell interpolation", async t => {
    const calls = [];
    const resolver = createGitPluginSourceResolver({
        run: async (command, args, options) => calls.push({ command, args: [...args], options }),
    });
    await resolver.checkout(
        { kind: "git", repository: "https://example.invalid/repo.git", path: "plugins/demo", ref: "release/v1" },
        tempDir(t),
    );

    assert.equal(calls.length, 4);
    assert.deepEqual(calls[2].args.slice(-2), ["origin", "release/v1"]);
    assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(calls[0].options.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(calls[0].options.env.GIT_CONFIG_COUNT, "0");
    await assert.rejects(
        resolver.checkout(
            { kind: "git", repository: "ssh://git@example.invalid/repo", path: "." },
            tempDir(t),
        ),
        /require an injected GitPluginSourceResolver/,
    );
});

test("partial Git failures are cleaned up and preserve the original cause", async t => {
    const root = tempDir(t);
    const destinationRoot = path.join(root, "install");
    const marker = new Error("synthetic checkout failure");

    await assert.rejects(
        installPluginSpecs(
            [{ kind: "git", repository: "synthetic-repo", path: "plugins/demo" }],
            {
                destinationRoot,
                git: {
                    async checkout(_spec, destination) {
                        fs.mkdirSync(destination, { recursive: true });
                        fs.writeFileSync(path.join(destination, "partial"), "partial");
                        throw marker;
                    },
                },
            },
        ),
        error => error instanceof PluginInstallError
            && error.index === 0
            && error.cause === marker
            && /synthetic checkout failure/.test(error.message),
    );

    assert.deepEqual(fs.readdirSync(destinationRoot), []);
});

test("Git plugin paths cannot escape through a symlink", async t => {
    const root = tempDir(t);
    const outside = pluginDir(root, "outside");
    const destinationRoot = path.join(root, "install");

    await assert.rejects(
        installPluginSpecs(
            [{ kind: "git", repository: "synthetic-repo", path: "plugins/escape" }],
            {
                destinationRoot,
                git: {
                    async checkout(_spec, destination) {
                        const plugins = path.join(destination, "plugins");
                        fs.mkdirSync(plugins, { recursive: true });
                        fs.symlinkSync(outside, path.join(plugins, "escape"), process.platform === "win32" ? "junction" : "dir");
                    },
                },
            },
        ),
        /escapes the Git checkout/,
    );

    assert.deepEqual(fs.readdirSync(destinationRoot), []);
});

test("a failed replacement preserves the last complete checkout", async t => {
    const root = tempDir(t);
    const destinationRoot = path.join(root, "install");
    const spec = { kind: "git", repository: "synthetic-repo", path: "plugin" };
    const [first] = await installPluginSpecs([spec], {
        destinationRoot,
        git: {
            async checkout(_spec, destination) {
                pluginDir(destination);
            },
        },
    });
    const existing = path.join(first.pluginDir, "agents", "example.agent.md");

    await assert.rejects(
        installPluginSpecs([spec], {
            destinationRoot,
            git: {
                async checkout(_spec, destination) {
                    fs.mkdirSync(destination, { recursive: true });
                    throw new Error("replacement failed");
                },
            },
        }),
        /replacement failed/,
    );

    assert.equal(fs.readFileSync(existing, "utf8"), "example");
    assert.deepEqual(
        fs.readdirSync(destinationRoot).filter(name => name.startsWith(".plugin-source-")),
        [],
    );
});

test("a failed final promotion restores the previous complete checkout", async t => {
    const root = tempDir(t);
    const destinationRoot = path.join(root, "install");
    const spec = { kind: "git", repository: "synthetic-repo", path: "plugin" };
    const [first] = await installPluginSpecs([spec], {
        destinationRoot,
        git: {
            async checkout(_spec, destination) {
                pluginDir(destination);
            },
        },
    });
    const existing = path.join(first.pluginDir, "agents", "example.agent.md");
    let promotionFailed = false;
    const fileSystem = {
        mkdir: (candidate, options) => fs.promises.mkdir(candidate, options),
        mkdtemp: (prefix) => fs.promises.mkdtemp(prefix),
        realpath: (candidate) => fs.promises.realpath(candidate),
        async rename(from, to) {
            if (!promotionFailed && from.includes(".plugin-source-") && !from.endsWith(".previous") && to === first.destinationDir) {
                promotionFailed = true;
                const error = new Error("synthetic promotion failure");
                error.code = "EACCES";
                throw error;
            }
            await fs.promises.rename(from, to);
        },
        rm: (candidate, options) => fs.promises.rm(candidate, options),
        stat: (candidate) => fs.promises.stat(candidate),
    };

    await assert.rejects(
        installPluginSpecs([spec], {
            destinationRoot,
            fileSystem,
            git: {
                async checkout(_spec, destination) {
                    const dir = pluginDir(destination);
                    fs.writeFileSync(path.join(dir, "agents", "example.agent.md"), "replacement");
                },
            },
        }),
        /synthetic promotion failure/,
    );

    assert.equal(fs.readFileSync(existing, "utf8"), "example");
    assert.equal(fs.existsSync(first.destinationDir), true);
    assert.deepEqual(
        fs.readdirSync(destinationRoot).filter(name => name.startsWith(".plugin-source-")),
        [],
    );
});

test("default Git resolver installs a requested commit from a synthetic local repository", async t => {
    const root = tempDir(t);
    const repository = path.join(root, "repository");
    const working = path.join(root, "working");
    const destinationRoot = path.join(root, "install");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", "--bare", "--quiet", repository]);
    execFileSync("git", ["clone", "--quiet", repository, working]);
    pluginDir(path.join(working, "plugins"), "demo");
    execFileSync("git", ["-C", working, "add", "."]);
    execFileSync("git", [
        "-C", working,
        "-c", "user.name=Plugin Spec Test",
        "-c", "user.email=plugin-spec@example.invalid",
        "commit", "--quiet", "-m", "fixture",
    ]);
    const commit = execFileSync("git", ["-C", working, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", working, "push", "--quiet", "origin", "HEAD:main"]);

    const [installed] = await installPluginSpecs([
        { kind: "git", repository: "repository", path: "plugins/demo", ref: commit },
    ], { cwd: root, destinationRoot });

    assert.equal(installed.spec.repository, repository);
    assert.equal(installed.spec.ref, commit);
    assert.equal(
        fs.readFileSync(path.join(installed.pluginDir, "agents", "example.agent.md"), "utf8"),
        "example",
    );
    assert.equal(fs.realpathSync(installed.pluginDir).startsWith(fs.realpathSync(destinationRoot) + path.sep), true);
    assert.deepEqual(
        fs.readdirSync(destinationRoot).filter(name => name.startsWith(".plugin-source-")),
        [],
    );
});
