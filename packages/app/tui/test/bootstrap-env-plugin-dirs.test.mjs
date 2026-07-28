import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { resolvePluginDirs } from "../src/bootstrap-env.js";

function withEnv(value, fn) {
    const prev = process.env.PLUGIN_DIRS;
    if (value === undefined) delete process.env.PLUGIN_DIRS;
    else process.env.PLUGIN_DIRS = value;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.PLUGIN_DIRS;
        else process.env.PLUGIN_DIRS = prev;
    }
}

test("--plugin with a single dir resolves to one absolute path", () => {
    const dirs = withEnv(undefined, () => resolvePluginDirs({ plugin: "./plugin" }));
    assert.deepEqual(dirs, [path.resolve("./plugin")]);
});

test("--plugin accepts a comma-separated list and preserves order", () => {
    const dirs = withEnv(undefined, () => resolvePluginDirs({ plugin: "./plugin,./overlay" }));
    assert.deepEqual(dirs, [path.resolve("./plugin"), path.resolve("./overlay")]);
});

test("--plugin tolerates whitespace and empty segments", () => {
    const dirs = withEnv(undefined, () => resolvePluginDirs({ plugin: " ./plugin , , ./overlay " }));
    assert.deepEqual(dirs, [path.resolve("./plugin"), path.resolve("./overlay")]);
});

test("PLUGIN_DIRS with multiple entries is no longer truncated to the first", () => {
    const dirs = withEnv("./plugin,./overlay", () => resolvePluginDirs({}));
    assert.equal(dirs.length, 2, "every configured plugin dir must survive");
    assert.deepEqual(dirs, [path.resolve("./plugin"), path.resolve("./overlay")]);
});

test("an explicit --plugin flag still wins over PLUGIN_DIRS", () => {
    const dirs = withEnv("./from-env", () => resolvePluginDirs({ plugin: "./from-flag" }));
    assert.deepEqual(dirs, [path.resolve("./from-flag")]);
});

test("no flag and no env falls back without throwing", () => {
    const dirs = withEnv(undefined, () => resolvePluginDirs({}));
    assert.ok(Array.isArray(dirs), "always returns an array");
});
