/**
 * Worker agent-package installation — cold start, hot refresh, quarantine.
 *
 * Proves the install lifecycle against a real worker (no LLM turns):
 * packages published to the registry materialize into the worker's agent
 * catalog at start(), refreshAgentPackages() converges on registry changes
 * without a restart, a broken worker-module quarantines ONLY its package,
 * and agent_worker_state carries the fleet truth.
 *
 * Run: npx vitest run test/local/agent-package-worker-install.test.js
 */

import { describe, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { FilesystemArtifactStore, publishAgentPackageDir } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

const OWNER = { provider: "test", subject: "pkg-worker-owner" };

function writeFixturePackage(dir, {
    name, version, agentName, toolName,
    promptLine = "You are the fixture triager.",
    workerModuleBody = null,
}) {
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skills", "fixture-ops"), { recursive: true });
    fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name, version, description: "worker install fixture",
    }));
    fs.writeFileSync(path.join(dir, "agents", `${agentName}.agent.md`), [
        "---",
        `name: ${agentName}`,
        "description: Fixture agent from a registry package",
        "schemaVersion: 1",
        `version: ${version}`,
        `tools:`,
        `  - ${toolName}`,
        "skills:",
        "  - fixture-ops",
        "---",
        "",
        promptLine,
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "skills", "fixture-ops", "SKILL.md"), [
        "---", "name: fixture-ops", "description: Fixture ops knowledge", "---",
        "", "Always fixture responsibly.",
    ].join("\n"));
    // Plain tool objects — packages must not use bare imports (no
    // node_modules above the cache dir); this is the documented contract.
    fs.writeFileSync(path.join(dir, "tools", "worker-module.js"), workerModuleBody ?? [
        "export default {",
        "    createTools: ({ workerNodeId }) => [{",
        `        name: ${JSON.stringify(toolName)},`,
        "        description: \"Echo fixture tool\",",
        "        parameters: { type: \"object\", properties: {} },",
        "        handler: async () => ({ ok: true, workerNodeId }),",
        "    }],",
        "};",
        "",
    ].join("\n"));
    return dir;
}

describe("agent-package worker install", () => {
    it("cold install, hot refresh, quarantine, fleet truth", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        // The worker derives its artifact store from sessionStateDir — the
        // publisher must write to the exact same filesystem root.
        const artifactStore = new FilesystemArtifactStore(
            path.join(path.dirname(env.sessionStateDir), "artifacts"),
        );
        const ctx = { catalog, artifactStore };
        const cacheDir = path.join(env.baseDir, "agent-packages-cache");
        const fixtures = path.join(env.baseDir, "package-fixtures");
        const modelProvidersPath = path.join(env.baseDir, "model-providers.agent-package.json");

        try {
            // Session creation now stamps an exact runtime provider:model
            // before orchestration starts. This suite never runs an LLM turn,
            // so give it an isolated fake provider instead of depending on an
            // ambient .model_providers.json credential.
            fs.writeFileSync(modelProvidersPath, JSON.stringify({
                providers: [{
                    id: "fixture-openai-type",
                    type: "openai",
                    baseUrl: "https://example.invalid/v1",
                    models: [{ name: "fixture-model" }],
                }],
            }));
            await catalog.providers.createProvider({
                name: "fixture-provider",
                typeId: "fixture-openai-type",
                class: "shared",
                secretRef: { apiKey: "fixture-key" },
            }, null, true);
            await catalog.providers.setClusterDefault({
                provider: "fixture-provider",
                model: "fixture-provider:fixture-model",
                reasoning: null,
                context: null,
            }, true);

            // ── Publish v1.0.0 before the worker exists ──────────────
            const v1 = writeFixturePackage(path.join(fixtures, "v1"), {
                name: "fixture-kit", version: "1.0.0",
                agentName: "fixture-triager", toolName: "fixture_echo",
            });
            await publishAgentPackageDir(ctx, {
                dir: v1, scope: "shared", owner: OWNER, createdBy: "fixture@test", isAdmin: false,
            });

            await withClient(env, {
                workerNodeId: `pkg-worker-${env.runId}`,
                worker: {
                    modelProvidersPath,
                    agentPackages: { cacheDir, refreshIntervalMs: 0 },
                },
                client: { modelProvidersPath },
            }, async (_client, worker) => {
                // ── Cold start installed the package ─────────────────
                const agent = worker.loadedAgents.find((a) => a.name === "fixture-triager");
                assert(agent, "package agent must be in the worker catalog after start()");
                assertEqual(agent.namespace, "fixture-kit", "package name is the agent namespace");
                assert(agent.prompt.includes("You are the fixture triager."), "agent prompt loaded");
                assert(agent.prompt.includes("[PRELOADED SKILL: fixture-ops]"), "declared skill eagerly inlined");
                assert(worker.allowedAgentNames.includes("fixture-triager"), "agent is creatable");

                // Package tool reached the merged registry and executes.
                const merged = worker.sessionManager.toolRegistry;
                const tool = merged?.get?.("fixture_echo");
                assert(tool, "package tool must be in the session tool registry");
                const result = await tool.handler({});
                assertEqual(result.ok, true);
                assertEqual(result.workerNodeId, `pkg-worker-${env.runId}`);

                // ── Hot refresh: new version, no restart ─────────────
                const v11 = writeFixturePackage(path.join(fixtures, "v1.1"), {
                    name: "fixture-kit", version: "1.1.0",
                    agentName: "fixture-triager", toolName: "fixture_echo",
                    promptLine: "You are the UPGRADED fixture triager.",
                });
                await publishAgentPackageDir(ctx, {
                    dir: v11, scope: "shared", owner: OWNER, createdBy: "fixture@test", isAdmin: false,
                });
                await worker.refreshAgentPackages();
                const upgraded = worker.loadedAgents.find((a) => a.name === "fixture-triager");
                assert(upgraded.prompt.includes("UPGRADED"), "refresh swaps the live prompt catalog");

                // REGRESSION (review B, HIGH): the refresh reset+reload must
                // not strand SessionManager's by-reference copies of the
                // framework/app base tool-name arrays — a reassignment during
                // reload once emptied them, silently dropping ALL framework
                // base tools from every cold session.
                const smDefaults = worker.sessionManager.workerDefaults;
                assert(
                    Array.isArray(smDefaults.frameworkBaseToolNames)
                    && smDefaults.frameworkBaseToolNames.includes("wait"),
                    `framework base tools must survive a refresh (got: ${JSON.stringify(smDefaults.frameworkBaseToolNames)})`,
                );

                // Both versions cached; sha-keyed dirs mean no re-downloads.
                const cached = fs.readdirSync(cacheDir).filter((n) => n.startsWith("fixture-kit@"));
                assertEqual(cached.length, 2, "both versions live in the cache");

                // ── Quarantine: a broken worker-module takes out ONLY its package ──
                const bad = writeFixturePackage(path.join(fixtures, "bad"), {
                    name: "broken-kit", version: "1.0.0",
                    agentName: "broken-agent", toolName: "broken_tool",
                    workerModuleBody: "throw new Error(\"boom at import time\");\nexport default {};\n",
                });
                await publishAgentPackageDir(ctx, {
                    dir: bad, scope: "shared", owner: OWNER, createdBy: "fixture@test", isAdmin: false,
                });
                await worker.refreshAgentPackages();
                assert(!worker.loadedAgents.some((a) => a.name === "broken-agent"),
                    "quarantined package contributes NO agents");
                assert(worker.loadedAgents.some((a) => a.name === "fixture-triager"),
                    "healthy package survives its neighbor's quarantine");

                // ── Fleet truth ──────────────────────────────────────
                const states = await catalog.listAgentWorkerState();
                const mine = states.find((s) => s.workerNodeId === `pkg-worker-${env.runId}`);
                assert(mine, "worker reported agent_worker_state");
                assert(mine.epoch > 0, "reported epoch");
                assertEqual(mine.installed["fixture-kit"].status, "ok");
                assertEqual(mine.installed["fixture-kit"].semver, "1.1.0");
                assertEqual(mine.installed["broken-kit"].status, "error");
                assert(String(mine.installed["broken-kit"].error).includes("boom at import time"),
                    "quarantine reason lands in fleet truth");

                // ── Worker registry (0040): the report above IS a heartbeat ──
                const me = (await catalog.listWorkers())
                    .find((w) => w.workerNodeId === `pkg-worker-${env.runId}`);
                assert(me, "worker registered itself in the workers table");
                assertEqual(me.phase, "ready", "post-start beats advertise ready");
                assertEqual(me.pool, "default", "default pool outside kubernetes");
                assert(typeof me.info.sdkVersion === "string" && me.info.sdkVersion.length > 0,
                    "write-once info carries the sdk version");
                assert(me.info.consumes.includes("agent-packages"), "consumed domains advertised");
                assert(Number.isFinite(me.health.uptimeS) && me.health.uptimeS >= 0, "health uptime sane");
                assert(Number.isFinite(me.health.rssBytes) && me.health.rssBytes > 0, "health rss sane");
                assertEqual(me.health.activeSessions, 0, "no live sessions yet");
                assertEqual(me.state["agent-packages"].epoch, mine.epoch,
                    "heartbeat state IS the fleet-truth source (union shim reads it back)");

                // ── Smoke: a real session binds to the package agent ─
                // (no LLM turn — orchestration accepts the create and the
                // CMS row carries the agent id; turn-level behavior is
                // covered by prompt/tool assertions above).
                const session = await _client.createSessionForAgent("fixture-triager", {
                    title: "pkg-smoke",
                });
                assert(session?.sessionId, "createSessionForAgent accepts a package agent");
                const row = await catalog.getSession(session.sessionId);
                assertEqual(row.agentId, "fixture-triager", "CMS row is bound to the package agent");
                assertEqual(row.model, "fixture-provider:fixture-model",
                    "CMS row is stamped without an ambient model credential");

                // ── Disable converges out ────────────────────────────
                await catalog.setAgentPackageEnabled("fixture-kit", false, OWNER, false);
                await worker.refreshAgentPackages();
                assert(!worker.loadedAgents.some((a) => a.name === "fixture-triager"),
                    "disabled package leaves the catalog on the next refresh");
            });
        } finally {
            await catalog.close();
        }
    });
});
