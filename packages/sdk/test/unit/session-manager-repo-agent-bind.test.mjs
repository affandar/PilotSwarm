import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveRepoAgentDefinition } from "../../dist/session-manager.js";

// Characterizes the repo-shipped `.github/agents/<name>.agent.md` binding added
// by the git-worker repo-affinity fix: an agent named in the create that is NOT
// registered with the portal (it ships in the target repo's checkout) is bound
// by parsing the `.agent.md` file into an injected `customAgents` entry. The
// resolver is the filesystem-pure core of SessionManager._resolveRepoAgentDefinition
// (delegated to it), with the worker-plugin guard injected so it needs no class.

// Writes an `.github/agents` tree into a throwaway dir and hands its path to the
// resolver — the same real-fs, real-path surface the hydrated worker runs on.
function withWorkspace(agentFiles, callback) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-agent-bind-"));
    try {
        if (agentFiles) {
            const agentsDir = path.join(dir, ".github", "agents");
            fs.mkdirSync(agentsDir, { recursive: true });
            for (const [file, contents] of Object.entries(agentFiles)) {
                fs.writeFileSync(path.join(agentsDir, file), contents);
            }
        }
        return callback(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test("binds a frontmatter agent by file slug, mapping every declared field", () => {
    withWorkspace(
        {
            "reviewer.agent.md": [
                "---",
                "name: Reviewer",
                "description: Reviews SQL changes",
                "tools:",
                "  - read",
                "  - grep",
                "mcp-servers:",
                "  ado:",
                "    url: https://example/mcp",
                "skills:",
                "  - triage",
                "---",
                "You are the reviewer persona.",
                "Be thorough.",
            ].join("\n"),
        },
        (dir) => {
            const def = resolveRepoAgentDefinition("reviewer", dir);
            assert.ok(def, "expected a definition");
            // frontmatter `name:` wins over the slug for the bound name.
            assert.equal(def.name, "Reviewer");
            assert.equal(def.prompt, "You are the reviewer persona.\nBe thorough.");
            assert.equal(def.description, "Reviews SQL changes");
            assert.deepEqual(def.tools, ["read", "grep"]);
            // hyphenated `mcp-servers` frontmatter key -> camelCase mcpServers.
            assert.deepEqual(def.mcpServers, { ado: { url: "https://example/mcp" } });
            assert.deepEqual(def.skills, ["triage"]);
        },
    );
});

test("matches by frontmatter name when it differs from the file slug (case-insensitive)", () => {
    withWorkspace(
        { "persona.agent.md": "---\nname: SqlExpert\n---\nPersona body." },
        (dir) => {
            // bound name matches frontmatter `name:`, not the "persona" slug.
            const def = resolveRepoAgentDefinition("SQLEXPERT", dir);
            assert.ok(def);
            assert.equal(def.name, "SqlExpert");
            assert.equal(def.prompt, "Persona body.");
        },
    );
});

test("matches by slug case-insensitively", () => {
    withWorkspace(
        { "Helper.agent.md": "---\nname: Helper\n---\nHelp body." },
        (dir) => {
            const def = resolveRepoAgentDefinition("helper", dir);
            assert.ok(def);
            assert.equal(def.name, "Helper");
        },
    );
});

test("accepts a frontmatterless file, using the whole file as the prompt", () => {
    withWorkspace(
        { "raw.agent.md": "Just a persona, no frontmatter.\n" },
        (dir) => {
            const def = resolveRepoAgentDefinition("raw", dir);
            assert.ok(def);
            assert.equal(def.name, "raw");
            assert.equal(def.prompt, "Just a persona, no frontmatter.");
            assert.equal(def.description, undefined);
            assert.equal(def.tools, undefined);
        },
    );
});

test("parses CRLF frontmatter (repo checkouts on Windows are CRLF)", () => {
    withWorkspace(
        { "win.agent.md": "---\r\nname: Win\r\ndescription: crlf\r\n---\r\nCRLF body.\r\n" },
        (dir) => {
            const def = resolveRepoAgentDefinition("win", dir);
            assert.ok(def);
            assert.equal(def.name, "Win");
            assert.equal(def.description, "crlf");
            assert.equal(def.prompt, "CRLF body.");
        },
    );
});

test("accepts a camelCase mcpServers key too", () => {
    withWorkspace(
        { "cc.agent.md": "---\nname: CC\nmcpServers:\n  s:\n    url: u\n---\nbody" },
        (dir) => {
            const def = resolveRepoAgentDefinition("cc", dir);
            assert.deepEqual(def.mcpServers, { s: { url: "u" } });
        },
    );
});

test("falls back to description then name when the body is empty", () => {
    withWorkspace(
        {
            "descOnly.agent.md": "---\nname: DescOnly\ndescription: only a description\n---\n",
            "nameOnly.agent.md": "---\nname: NameOnly\n---\n   \n",
        },
        (dir) => {
            const byDesc = resolveRepoAgentDefinition("descOnly", dir);
            assert.equal(byDesc.prompt, "only a description");
            const byName = resolveRepoAgentDefinition("nameOnly", dir);
            assert.equal(byName.prompt, "NameOnly");
        },
    );
});

test("skips worker-plugin agents so their own binding path is not overridden", () => {
    withWorkspace(
        { "plugin.agent.md": "---\nname: plugin\n---\nrepo copy" },
        (dir) => {
            const isPlugin = (name) => name === "plugin";
            assert.equal(resolveRepoAgentDefinition("plugin", dir, isPlugin), undefined);
            // Without the guard the same file resolves — proving the guard, not
            // a missing file, is what suppressed it.
            assert.ok(resolveRepoAgentDefinition("plugin", dir));
        },
    );
});

test("returns undefined when no agent is bound", () => {
    withWorkspace({ "x.agent.md": "---\nname: x\n---\nb" }, (dir) => {
        assert.equal(resolveRepoAgentDefinition(undefined, dir), undefined);
        assert.equal(resolveRepoAgentDefinition("", dir), undefined);
    });
});

test("returns undefined when there is no working directory", () => {
    assert.equal(resolveRepoAgentDefinition("anything", undefined), undefined);
});

test("returns undefined when the workspace has no .github/agents", () => {
    withWorkspace(null, (dir) => {
        assert.equal(resolveRepoAgentDefinition("anything", dir), undefined);
    });
});

test("returns undefined when nothing matches the bound name", () => {
    withWorkspace(
        { "other.agent.md": "---\nname: other\n---\nb" },
        (dir) => {
            assert.equal(resolveRepoAgentDefinition("missing", dir), undefined);
        },
    );
});

test("ignores files that are not *.agent.md", () => {
    withWorkspace(
        {
            "notes.md": "---\nname: notes\n---\nnot an agent",
            "readme.txt": "name: readme",
        },
        (dir) => {
            assert.equal(resolveRepoAgentDefinition("notes", dir), undefined);
            assert.equal(resolveRepoAgentDefinition("readme", dir), undefined);
        },
    );
});
