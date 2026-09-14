import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    SessionManager,
    SessionWorkspaceManager,
    discoverRepositoryConfiguration,
} from "../../dist/index.js";

function temporaryRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-session-workspace-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test("managed workspaces are confined, reusable, and platform-owned", (t) => {
    const root = temporaryRoot(t);
    const manager = new SessionWorkspaceManager(path.join(root, "workspaces"));
    const first = manager.resolve("session-123");
    const second = manager.resolve("session-123");

    assert.deepEqual(first, second);
    assert.equal(first.ownership, "platform");
    assert.equal(path.dirname(first.path), manager.rootDir);
    assert.equal(fs.statSync(first.path).isDirectory(), true);
    assert.equal(manager.remove("session-123"), true);
    assert.equal(fs.existsSync(first.path), false);
    assert.equal(manager.remove("session-123"), false);
});

test("caller override wins and is never owned or removed by the manager", (t) => {
    const root = temporaryRoot(t);
    const override = path.join(root, "caller", "repo");
    const manager = new SessionWorkspaceManager(path.join(root, "managed"));
    const resolved = manager.resolve("session-123", override);

    assert.deepEqual(resolved, {
        path: path.resolve(override),
        ownership: "caller",
    });
    assert.equal(fs.existsSync(override), false, "caller path is not created");
    assert.equal(manager.remove("session-123"), false, "managed cleanup cannot touch the override");
});

test("SessionManager passes the managed path to the Copilot boundary and disables implicit discovery", async (t) => {
    const root = temporaryRoot(t);
    const stateRoot = path.join(root, "state");
    const workspaceManager = new SessionWorkspaceManager(path.join(root, "workspaces"));
    const manager = new SessionManager(undefined, null, {
        sessionWorkspaceManager: workspaceManager,
    }, stateRoot);
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    const configs = [];
    manager.ensureClient = async () => ({
        createSession: async (config) => {
            configs.push(config);
            fs.mkdirSync(path.join(stateRoot, config.sessionId), { recursive: true });
            return { disconnect: async () => {} };
        },
        resumeSession: async (_id, config) => {
            configs.push(config);
            return { disconnect: async () => {} };
        },
        deleteSession: async () => {},
    });
    t.after(async () => manager.shutdown());

    await manager.getOrCreate("managed-session", {}, { turnIndex: 0 });
    assert.equal(
        configs[0].workingDirectory,
        path.join(workspaceManager.rootDir, "managed-session"),
    );
    assert.equal(configs[0].enableConfigDiscovery, false);
    assert.equal(configs[0].enableSkills, false);

    const override = path.join(root, "caller-repository");
    await manager.getOrCreate("caller-session", { workingDirectory: override }, { turnIndex: 0 });
    assert.equal(configs[1].workingDirectory, path.resolve(override));
    assert.equal(configs[1].enableConfigDiscovery, true);
    assert.equal(configs[1].enableSkills, true);
    assert.equal(fs.existsSync(override), false, "caller retains creation and cleanup ownership");
});

test("SessionManager preserves historical discovery without a workspace manager", async (t) => {
    const root = temporaryRoot(t);
    const manager = new SessionManager(undefined, null, {}, path.join(root, "state"));
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    let captured;
    manager.ensureClient = async () => ({
        createSession: async (config) => {
            captured = config;
            return { disconnect: async () => {} };
        },
        resumeSession: async () => {
            throw new Error("unexpected resume");
        },
        deleteSession: async () => {},
    });
    t.after(async () => manager.shutdown());

    await manager.getOrCreate("legacy-session", {}, { turnIndex: 0 });
    assert.equal(captured.workingDirectory, undefined);
    assert.equal(captured.enableConfigDiscovery, true);
    assert.equal(captured.enableSkills, true);
});

test("session ids reject traversal and non-portable Windows names", (t) => {
    const root = temporaryRoot(t);
    const manager = new SessionWorkspaceManager(path.join(root, "managed"));
    for (const sessionId of ["../outside", "a/b", "a\\b", "CON", "name:", ".", ".."]) {
        assert.throws(() => manager.resolve(sessionId), /Invalid session workspace id/);
    }
    assert.equal(fs.existsSync(path.join(root, "outside")), false);
});

test("managed workspaces reject symlink and junction escapes", (t) => {
    const root = temporaryRoot(t);
    const outside = path.join(root, "outside");
    const managed = path.join(root, "managed");
    fs.mkdirSync(outside);
    fs.mkdirSync(managed);
    try {
        fs.symlinkSync(outside, path.join(managed, "session-link"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (error?.code === "EPERM" || error?.code === "EACCES") {
            t.skip("creating symlinks is not permitted on this host");
            return;
        }
        throw error;
    }

    const manager = new SessionWorkspaceManager(managed);
    assert.throws(() => manager.resolve("session-link"), /Symbolic links are not allowed/);
    assert.equal(fs.existsSync(outside), true);
});

test("repository configuration is denied by default and discovered per trusted category", (t) => {
    const root = temporaryRoot(t);
    fs.mkdirSync(path.join(root, ".github", "agents"), { recursive: true });
    fs.mkdirSync(path.join(root, ".github", "skills", "review"), { recursive: true });
    fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
    fs.writeFileSync(path.join(root, ".github", "agents", "review.agent.md"), "agent");
    fs.writeFileSync(path.join(root, ".github", "skills", "review", "SKILL.md"), "skill");
    fs.writeFileSync(path.join(root, ".vscode", "mcp.json"), "{}");
    fs.writeFileSync(path.join(root, ".mcp.json"), "{}");

    assert.deepEqual(discoverRepositoryConfiguration({ repositoryRoot: root }), {
        repositoryRoot: fs.realpathSync.native(root),
        agentFiles: [],
        skillDirectories: [],
        mcpFiles: [],
    });

    const agentsOnly = discoverRepositoryConfiguration({
        repositoryRoot: root,
        trust: { agents: true },
    });
    assert.deepEqual(agentsOnly.agentFiles, [
        path.join(fs.realpathSync.native(root), ".github", "agents", "review.agent.md"),
    ]);
    assert.deepEqual(agentsOnly.skillDirectories, []);
    assert.deepEqual(agentsOnly.mcpFiles, []);

    const all = discoverRepositoryConfiguration({
        repositoryRoot: root,
        trust: { agents: true, skills: true, mcp: true },
    });
    assert.equal(all.agentFiles.length, 1);
    assert.deepEqual(all.skillDirectories, [
        path.join(fs.realpathSync.native(root), ".github", "skills", "review"),
    ]);
    assert.deepEqual(new Set(all.mcpFiles), new Set([
        path.join(fs.realpathSync.native(root), ".mcp.json"),
        path.join(fs.realpathSync.native(root), ".vscode", "mcp.json"),
    ]));
});

test("trusted repository configuration rejects symlinked content", (t) => {
    const root = temporaryRoot(t);
    const outside = path.join(root, "outside.agent.md");
    const agents = path.join(root, ".github", "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(outside, "outside");
    try {
        fs.symlinkSync(outside, path.join(agents, "linked.agent.md"), "file");
    } catch (error) {
        if (error?.code === "EPERM" || error?.code === "EACCES") {
            t.skip("creating symlinks is not permitted on this host");
            return;
        }
        throw error;
    }

    assert.throws(
        () => discoverRepositoryConfiguration({
            repositoryRoot: root,
            trust: { agents: true },
        }),
        /Symbolic links are not allowed/,
    );
});
