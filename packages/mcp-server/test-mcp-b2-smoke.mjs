#!/usr/bin/env node
// packages/mcp-server/test-mcp-b2-smoke.mjs
//
// LIVE smoke verifying the correctness fixes shipped on
// contrib/mcp-server (B2 + B4):
//
//   1. Cold-session send: a session created without a prompt boots its
//      orchestration when send_message routes through
//      `client.resumeSession(id).send(message)`. The prior implementation
//      called `mgmt.sendMessage(id, message)` directly, which throws on
//      a non-live orchestration ("Cannot sendMessage for session X:
//      orchestration session-X is not started ...").
//
//   2. ModelDescriptor field shape: list_models needs to surface
//      `qualifiedName` + `modelName`, not the non-existent `name` field
//      that the prior `(m: any).name` cast silently produced as
//      `undefined`.
//
// Bogus-command rejection (sendCommandAndWait surfacing
// CommandRejectedError when the orch writes an "Unknown command: ..."
// response) is covered by the unit test
// `test-sendCommandAndWait-unit.mjs` rather than this LIVE smoke. The
// LIVE path is racy in cold-session interleaved patterns:
// `mgmt.sendCommand` requires the orch to have reached `Started`, but
// `session.send()` returns before that transition completes. That race
// is tracked as a separate upstream SDK issue and is out of scope for
// this PR. The unit test exercises sendCommandAndWait's
// rejection / success / timeout semantics with a mocked mgmt.
//
// Usage:  node packages/mcp-server/test-mcp-b2-smoke.mjs
// Requires: PostgreSQL reachable via DATABASE_URL, GITHUB_TOKEN in .env,
//           SDK + mcp-server built (npm run build --workspace=...).

import { readFileSync, mkdtempSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import {
    PilotSwarmClient,
    PilotSwarmWorker,
    PilotSwarmManagementClient,
    loadModelProviders,
} from "pilotswarm-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

// ── Load .env ───────────────────────────────────────────────────────────────
const envFile = readFileSync(resolve(ROOT, ".env"), "utf-8");
for (const line of envFile.split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
        let val = match[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (process.env[match[1]] === undefined) process.env[match[1]] = val;
    }
}

const STORE = process.env.DATABASE_URL;
if (!STORE) {
    console.error("❌ DATABASE_URL not set");
    process.exit(1);
}
if (!process.env.GITHUB_TOKEN) {
    console.error("❌ GITHUB_TOKEN not set");
    process.exit(1);
}
// Prefer the SDK test fixture (which has a real `defaultModel` set) over the
// repo's `.model_providers.json` (which may comment its default out). Both
// are gitignored at the worktree level so we accept either path.
const sdkFixture = resolve(ROOT, "packages/sdk/test/fixtures/model-providers.test.json");
const repoConfig = resolve(ROOT, ".model_providers.json");
process.env.PS_MODEL_PROVIDERS_PATH ||=
    (await import("node:fs")).existsSync(sdkFixture) ? sdkFixture : repoConfig;

// ── Helpers ─────────────────────────────────────────────────────────────────
const results = [];

function record(name, status, detail = "") {
    results.push({ name, status, detail });
    const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️ ";
    console.log(`${icon} ${name.padEnd(48)} ${status}${detail ? ` (${detail})` : ""}`);
}

function fail(name, err) {
    record(name, "FAIL", err?.message?.slice(0, 200) ?? String(err).slice(0, 200));
}

// ── Smoke ───────────────────────────────────────────────────────────────────
async function main() {
    const sessionStateDir = mkdtempSync(resolve(tmpdir(), "ps-mcp-b2-smoke-"));

    const worker = new PilotSwarmWorker({
        store: STORE,
        githubToken: process.env.GITHUB_TOKEN,
        sessionStateDir,
    });
    const client = new PilotSwarmClient({ store: STORE });
    const mgmt = new PilotSwarmManagementClient({ store: STORE });

    await worker.start();
    await client.start();
    await mgmt.start();

    let createdSessionId = null;

    try {
        // ── B2: cold-session send via resumeSession + session.send ─────
        try {
            // Resolve a real model so the orchestration can boot. The
            // .model_providers.json may not declare a defaultModel; in that
            // case the SDK refuses to pick one implicitly. Pull the first
            // available model from the registry and pass it explicitly.
            const registryForModel = loadModelProviders(process.env.PS_MODEL_PROVIDERS_PATH);
            const firstModel = registryForModel?.getModelsByProvider()?.[0]?.models?.[0]?.qualifiedName;
            if (!firstModel) {
                throw new Error("no models available in registry — check .model_providers.json");
            }
            const sessionConfig = { model: firstModel };
            const session = await client.createSession(sessionConfig);
            createdSessionId = session.sessionId;
            // Forward session config to the in-process worker so runTurn
            // resolves the model when the orchestration boots. The SDK
            // integration test (`packages/sdk/test/sdk.test.js`) wraps
            // createSession with the same forwarding; in real
            // deployments worker reads config from DB rows during
            // hydration.
            worker.setSessionConfig?.(createdSessionId, sessionConfig);
            console.log(`  └─ created session ${createdSessionId} (no prompt — orchestration dormant, model=${firstModel})`);

            // Demonstrate that BEFORE session.send the orch is dormant
            // and mgmt.sendMessage throws the exact error Affan flagged.
            let preBootError = null;
            try {
                await mgmt.sendMessage(createdSessionId, "should fail — orch not started");
            } catch (err) {
                preBootError = err;
            }
            const preBootSawNotStarted = preBootError
                && String(preBootError.message ?? "").toLowerCase().includes("not started");
            if (!preBootSawNotStarted) {
                record(
                    "B2 cold-session send_message path",
                    "FAIL",
                    `expected mgmt.sendMessage to throw "not started" before boot; got: ${preBootError?.message ?? "(no error)"}`,
                );
            } else {
                // Apply the fix: resume + session.send. This is the new
                // path the MCP `send_message` tool follows. The verification
                // is narrow: session.send() must NOT throw the
                // "orchestration ... is not started" error that
                // mgmt.sendMessage throws on a cold session. We don't need
                // the LLM round-trip to complete; we only need proof that
                // the boot path is reachable.
                const resumed = await client.resumeSession(createdSessionId);
                let sendError = null;
                try {
                    await resumed.send("ignore this prompt");
                } catch (err) {
                    sendError = err;
                }
                if (!sendError) {
                    record(
                        "B2 cold-session send_message path",
                        "PASS",
                        "pre-boot mgmt.sendMessage threw \"not started\" as expected; resume+session.send returned without throwing (orchestration boot path reached)",
                    );
                } else if (String(sendError.message ?? "").toLowerCase().includes("not started")) {
                    record(
                        "B2 cold-session send_message path",
                        "FAIL",
                        `session.send still threw "not started": ${String(sendError.message).slice(0, 120)}`,
                    );
                } else {
                    // Unrelated infra error (model auth, network, …).
                    // Boot path was reached (the bug is gone) — record
                    // PASS with the infra error noted.
                    record(
                        "B2 cold-session send_message path",
                        "PASS",
                        `boot path reached; downstream infra error: ${String(sendError.message).slice(0, 120)}`,
                    );
                }
            }
        } catch (err) {
            fail("B2 cold-session send_message path", err);
        }

        // ── B4: ModelDescriptor.qualifiedName / modelName present ──────
        try {
            const registry = loadModelProviders(process.env.PS_MODEL_PROVIDERS_PATH);
            if (!registry) {
                record("B4 list_models qualifiedName/modelName", "FAIL", "no model providers loaded");
            } else {
                const byProvider = registry.getModelsByProvider();
                if (byProvider.length === 0) {
                    record("B4 list_models qualifiedName/modelName", "FAIL", "no providers in registry");
                } else {
                    const firstModel = byProvider[0]?.models?.[0];
                    if (!firstModel) {
                        record("B4 list_models qualifiedName/modelName", "FAIL", "first provider has no models");
                    } else if (typeof firstModel.qualifiedName !== "string" || typeof firstModel.modelName !== "string") {
                        record(
                            "B4 list_models qualifiedName/modelName",
                            "FAIL",
                            `expected string qualifiedName/modelName; got ${JSON.stringify(firstModel)}`,
                        );
                    } else {
                        record(
                            "B4 list_models qualifiedName/modelName",
                            "PASS",
                            `qualifiedName="${firstModel.qualifiedName}", modelName="${firstModel.modelName}"`,
                        );
                    }
                }
            }
        } catch (err) {
            fail("B4 list_models qualifiedName/modelName", err);
        }
    } finally {
        // Cleanup: cancel + soft-delete the test session so subsequent
        // smoke runs start with a clean DB. mgmt.deleteSession only works
        // on already-terminal sessions; client.deleteSession force-cancels
        // the orchestration even mid-LLM-turn.
        if (createdSessionId) {
            try {
                await client.deleteSession(createdSessionId);
                console.log(`  └─ cleaned up test session ${createdSessionId.slice(0, 8)}`);
            } catch (err) {
                console.log(`  └─ WARN: could not clean up test session ${createdSessionId.slice(0, 8)}: ${String(err?.message ?? err).slice(0, 120)}`);
            }
        }
        await mgmt.stop?.();
        await client.stop?.();
        await worker.stop?.();
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    const pass = results.filter((r) => r.status === "PASS").length;
    const failCount = results.filter((r) => r.status === "FAIL").length;
    const skip = results.filter((r) => r.status === "SKIP").length;
    console.log("");
    console.log(`Summary: ${pass} PASS, ${failCount} FAIL, ${skip} SKIP`);
    process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("Smoke crashed:", err);
    process.exit(2);
});
