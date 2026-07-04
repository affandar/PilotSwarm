/**
 * Web API E2E — the supported client path.
 *
 * Boots the real portal server (Express + /api/v1 + /api/v1/ws) against real
 * Postgres with embedded workers, then drives it exclusively through the
 * public web surfaces:
 *   - PilotSwarmClient({ apiUrl })            (SDK web mode)
 *   - PilotSwarmManagementClient({ apiUrl })  (SDK web mode)
 *   - ApiClient / HttpApiTransport            (pilotswarm-sdk/api)
 *
 * No test below touches the database directly — that is the point.
 *
 * Run: npx vitest run test/local/webapi-e2e.test.js
 */

import { describe, it, beforeAll, afterAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { assert, assertEqual, assertIncludes, assertIncludesAny, assertNotNull } from "../helpers/assertions.js";
import { PilotSwarmClient, PilotSwarmManagementClient, createWebFactStore, isEnhancedFactStore } from "pilotswarm-sdk";
import { ApiClient, ApiError, HttpApiTransport } from "pilotswarm-sdk/api";

const TIMEOUT = 180_000;

let env;
let server;
let apiUrl;
let mgmt;

describe("web api e2e", () => {
    beforeAll(async () => {
        await preflightChecks();
        env = createTestEnv("webapi");

        process.env.DATABASE_URL = env.store;
        process.env.PILOTSWARM_DUROXIDE_SCHEMA = env.duroxideSchema;
        process.env.PILOTSWARM_CMS_SCHEMA = env.cmsSchema;
        process.env.PILOTSWARM_FACTS_SCHEMA = env.factsSchema;
        process.env.SESSION_STATE_DIR = env.sessionStateDir;
        process.env.WORKERS = "2";
        process.env.PORTAL_TUI_MODE = "local";

        const { startServer } = await import("pilotswarm/web");
        server = await startServer({ port: 0 });
        apiUrl = `http://localhost:${server.address().port}`;
        console.log(`  [webapi] portal server at ${apiUrl}`);

        mgmt = new PilotSwarmManagementClient({ apiUrl });
        await mgmt.start();
    }, 120_000);

    afterAll(async () => {
        await mgmt?.stop?.();
        if (server?.stopPortal) await server.stopPortal();
        if (env) await env.cleanup();
    }, 120_000);

    it("serves health, auth config, and bootstrap", async () => {
        const api = new ApiClient({ apiUrl });
        const health = await api.health();
        assertEqual(health.ok, true, "health ok");
        assertEqual(health.apiVersion, 1, "api version");

        const authConfig = await api.getAuthConfig();
        assertEqual(authConfig.provider, "none", "no-auth deployment");

        const me = await api.getAuthContext();
        assertEqual(me.principal.provider, "none", "no-auth principal provider");
        assertEqual(me.principal.subject, "unknown", "no-auth principal subject");

        const bootstrap = await api.getBootstrap();
        assertEqual(bootstrap.ok, true, "bootstrap ok");
        assert(Array.isArray(bootstrap.modelsByProvider), "bootstrap carries models");
        assertNotNull(bootstrap.auth, "bootstrap carries auth context");
    });

    it("runs a real model turn through the SDK web client", { timeout: TIMEOUT }, async () => {
        const client = new PilotSwarmClient({ apiUrl });
        await client.start();

        const session = await client.createSession();
        assertNotNull(session.sessionId, "web session id");

        const events = [];
        const unsubscribe = session.on((event) => events.push(event));

        const response = await session.sendAndWait("What is the capital of France? Answer with one word.", TIMEOUT);
        console.log(`  [webapi] turn response: "${response}"`);
        assertIncludesAny(response, ["paris", "Paris"], "capital answer");

        // Events must be observable through the API (WS push + catch-up).
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && !events.some((event) => event.eventType === "assistant.message")) {
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const eventTypes = new Set(events.map((event) => event.eventType));
        assert(eventTypes.has("user.message"), `user.message event seen (got: ${[...eventTypes].join(", ")})`);
        assert(eventTypes.has("assistant.message"), "assistant.message event seen");
        unsubscribe();

        const messages = await session.getMessages(100);
        assert(messages.some((event) => event.eventType === "assistant.message"), "getMessages returns persisted events");

        const info = await session.getInfo();
        assertEqual(info.sessionId, session.sessionId, "getInfo round-trips the session");

        await client.stop();
    });

    it("covers the management surface end to end", { timeout: TIMEOUT }, async () => {
        const created = await mgmt.listSessionsPage({ limit: 5 });
        assert(Array.isArray(created.sessions), "listSessionsPage returns sessions");

        const client = new PilotSwarmClient({ apiUrl });
        await client.start();
        const a = await client.createSession();
        const b = await client.createSession();

        // Rename + read back.
        await mgmt.renameSession(a.sessionId, "webapi-renamed");
        const view = await mgmt.getSession(a.sessionId);
        assertIncludes(view.title || "", "webapi-renamed", "rename persisted");

        // Paging walks every session with a bounded page size.
        const seen = new Set();
        let cursor = null;
        for (let page = 0; page < 20; page += 1) {
            const result = await mgmt.listSessionsPage({ limit: 1, cursor });
            for (const row of result.sessions) seen.add(row.sessionId);
            if (!result.hasMore || !result.nextCursor) break;
            cursor = result.nextCursor;
        }
        assert(seen.has(a.sessionId) && seen.has(b.sessionId), "paging reaches both sessions");

        // Groups lifecycle.
        const group = await mgmt.createSessionGroup({ title: "webapi-group" });
        assertNotNull(group.groupId, "group created");
        await mgmt.updateSessionGroup(group.groupId, { title: "webapi-group-2" });
        await mgmt.assignSessionsToGroup(group.groupId, [a.sessionId]);
        const groups = await mgmt.listSessionGroups();
        const mine = groups.find((row) => row.groupId === group.groupId);
        assertEqual(mine?.title, "webapi-group-2", "group update persisted");
        assert((mine?.memberCount ?? 0) >= 1, "group has the assigned member");
        await mgmt.moveSessionsToGroup(null, [a.sessionId]);
        await mgmt.deleteSessionGroup(group.groupId);

        // Stats surfaces respond with real shapes.
        const fleet = await mgmt.getFleetStats();
        assert(typeof fleet === "object" && fleet !== null, "fleet stats");
        const users = await mgmt.getUserStats();
        assert(typeof users === "object" && users !== null, "user stats");
        const facts = await mgmt.getSharedFactsStats();
        assert(Array.isArray(facts.rows), "shared facts stats rows");
        const events = await mgmt.getSessionEvents(a.sessionId, undefined, 50);
        assert(Array.isArray(events), "session events readable");

        // eventTypes rides the wire as a JSON query param and filters server-side.
        const chatTypes = ["user.message", "assistant.message", "system.message"];
        const filtered = await mgmt.getSessionEvents(a.sessionId, undefined, 50, chatTypes);
        assert(Array.isArray(filtered), "filtered session events readable");
        assert(filtered.every((event) => chatTypes.includes(event.eventType)), "eventTypes filter honored over the wire");
        if (events.length > 0) {
            const lastSeq = Number(events[events.length - 1].seq);
            const olderFiltered = await mgmt.getSessionEventsBefore(a.sessionId, lastSeq + 1, 50, chatTypes);
            assert(olderFiltered.every((event) => chatTypes.includes(event.eventType)), "filtered backward paging honored over the wire");
        }
        const status = await mgmt.getSessionStatus(a.sessionId);
        assert(typeof status.customStatusVersion === "number", "session status readable");

        // Models resolve through the API (async in web mode).
        const models = await mgmt.listModels();
        assert(Array.isArray(models) && models.length > 0, "models listed");
        const defaultModel = await mgmt.getDefaultModel();
        assert(typeof defaultModel === "string" && defaultModel.length > 0, "default model resolved");

        // Profile rides the authenticated (no-auth synthetic) principal.
        const profile = await mgmt.setUserProfileSettings(null, { theme: "webapi-test" });
        assertEqual(profile.profileSettings?.theme, "webapi-test", "profile settings saved");
        const readBack = await mgmt.getUserProfile();
        assertEqual(readBack.profileSettings?.theme, "webapi-test", "profile settings read back");
        assertEqual(readBack.provider, "none", "profile keyed by the no-auth principal");

        // Lifecycle: cancelling a never-started session surfaces the server's
        // clear error through the envelope; deletion always works.
        try {
            await mgmt.cancelSession(b.sessionId);
            assert(false, "cancel should throw for a session with no turns");
        } catch (error) {
            assertIncludes(error.message, "not started", "cancel error names the cause");
        }
        await mgmt.deleteSession(b.sessionId);
        await mgmt.deleteSession(a.sessionId);
        await client.stop();
    });

    it("round-trips artifacts including binary download", { timeout: TIMEOUT }, async () => {
        const client = new PilotSwarmClient({ apiUrl });
        await client.start();
        const session = await client.createSession();

        const transport = new HttpApiTransport({ apiUrl });
        await transport.start();

        const content = Buffer.from("hello artifact \u{1F680}", "utf8");
        await transport.uploadArtifactContent(session.sessionId, "notes.txt", content.toString("base64"), "text/plain", "base64");

        const artifacts = await transport.listArtifacts(session.sessionId);
        assertEqual(artifacts.length, 1, "one artifact listed");
        assertEqual(artifacts[0].filename, "notes.txt", "artifact filename");

        const meta = await transport.getArtifactMetadata(session.sessionId, "notes.txt");
        assertNotNull(meta, "artifact metadata");

        const text = await transport.downloadArtifact(session.sessionId, "notes.txt");
        assertIncludes(text, "hello artifact", "text download");

        const response = await transport.api.downloadArtifactResponse(session.sessionId, "notes.txt");
        const body = Buffer.from(await response.arrayBuffer());
        assertEqual(body.toString("utf8"), content.toString("utf8"), "binary download bytes");
        assertIncludes(response.headers.get("content-disposition") || "", "notes.txt", "attachment disposition");

        await transport.deleteArtifact(session.sessionId, "notes.txt");
        const afterDelete = await transport.listArtifacts(session.sessionId);
        assertEqual(afterDelete.length, 0, "artifact deleted");

        await transport.stop();
        await client.stop();
    });

    it("streams session events over /api/v1/ws through HttpApiTransport", { timeout: TIMEOUT }, async () => {
        const client = new PilotSwarmClient({ apiUrl });
        await client.start();
        const session = await client.createSession();

        const transport = new HttpApiTransport({ apiUrl });
        await transport.start();

        const received = [];
        const unsubscribe = transport.subscribeSession(session.sessionId, (event) => received.push(event));

        await session.send("Reply with the single word pong.");
        const deadline = Date.now() + TIMEOUT;
        while (Date.now() < deadline && !received.some((event) => event?.eventType === "assistant.message")) {
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        assert(received.some((event) => event?.eventType === "user.message"), "ws delivered user.message");
        assert(received.some((event) => event?.eventType === "assistant.message"), "ws delivered assistant.message");

        unsubscribe();
        await transport.stop();
        await session.destroy();
        await client.stop();
    });

    it("resumed sessions do not return the previous turn's answer", { timeout: TIMEOUT }, async () => {
        const client = new PilotSwarmClient({ apiUrl });
        await client.start();
        const session = await client.createSession();

        const first = await session.sendAndWait("Reply with exactly: ALPHA", TIMEOUT);
        assertIncludes(first.toUpperCase(), "ALPHA", "first turn answered");

        // A fresh handle for the same session starts with zeroed cursors; the
        // seed-on-first-send must skip the completed ALPHA turn so the next
        // wait only accepts the BETA turn's result.
        const resumed = await client.resumeSession(session.sessionId);
        const second = await resumed.sendAndWait("Reply with exactly: BETA", TIMEOUT);
        assertIncludes(second.toUpperCase(), "BETA", "resumed turn returns the new answer, not the stale one");
        assert(!second.toUpperCase().includes("ALPHA") || second.toUpperCase().includes("BETA"), "not the stale ALPHA answer");

        await session.destroy();
        await client.stop();
    });

    it("serves the facts data-plane through WebFactStore (round-trip + capabilities)", { timeout: TIMEOUT }, async () => {
        const api = new ApiClient({ apiUrl });

        // Capabilities depend on the deployment's fact store: a plain PgFactStore
        // reports no search/embedder/graph, while an enhanced store (e.g. the
        // HorizonDB provider overlay) reports them. Derive expectations from what
        // the deployment actually advertises instead of hard-coding a base store.
        const caps = await api.call("factsCapabilities");
        const enhanced = Boolean(caps.search);
        const hasGraph = Boolean(caps.graph);

        // The web fact store implements FactStore over the API and is enhanced
        // iff the deployment reports search support (mirrors PgFactStore vs
        // HorizonDBFactStore).
        const facts = await createWebFactStore(api);
        assertEqual(isEnhancedFactStore(facts), enhanced, "web fact store enhancement matches reported search capability");

        const scope = `webapi-e2e-${Date.now()}`;
        await facts.storeFact({ key: `${scope}/alpha`, value: { n: 1 }, shared: true, tags: ["e2e"] });
        await facts.storeFact([
            { key: `${scope}/beta`, value: { n: 2 }, shared: true },
            { key: `${scope}/gamma`, value: { n: 3 }, shared: true },
        ]);

        const read = await facts.readFacts({ keyPattern: `${scope}/%`, scope: "shared", limit: 50 });
        assert(read.count >= 3, `read back stored facts (got ${read.count})`);
        const alpha = read.facts.find((f) => f.key === `${scope}/alpha`);
        assertNotNull(alpha, "alpha fact present");
        assertEqual(alpha.value.n, 1, "fact value round-trips");

        // Pattern delete removes the set.
        const deleted = await facts.deleteFact({ key: `${scope}/%`, pattern: true, scope: "shared" });
        assert(deleted.deleted >= 3, `pattern delete removed the facts (got ${deleted.deleted})`);
        const afterDelete = await facts.readFacts({ keyPattern: `${scope}/%`, scope: "shared" });
        assertEqual(afterDelete.count, 0, "facts gone after delete");

        // Mass-delete escalation is refused: scope="all" is not available on the
        // Tier-1 (non-admin) deleteFact — it would span every session's facts.
        try {
            await api.call("deleteFact", { input: { key: "%", pattern: true, scope: "all", unrestricted: true } });
            assert(false, "scope='all' delete should be rejected over the API");
        } catch (error) {
            assertEqual(error.status, 400, `400 for scope=all delete (got ${error.status})`);
        }

        // Enhanced-only op: dispatches on an enhanced store, 409s cleanly on a base one.
        if (enhanced) {
            // Lexical mode keeps the positive path embedding-free and robust.
            const result = await api.call("searchFacts", { query: "anything", opts: { mode: "lexical" } });
            assertNotNull(result?.facts, "searchFacts dispatches on an enhanced store");
        } else {
            try {
                await api.call("searchFacts", { query: "anything" });
                assert(false, "searchFacts should be unsupported on plain PG");
            } catch (error) {
                assertEqual(error.status, 409, `409 for enhanced-only op (got ${error.status})`);
                assertEqual(error.code, "FACTS_ENHANCED_UNSUPPORTED", "capability error code");
            }
        }

        // No-auth deployment = full access: the admin gate passes regardless of
        // store type. On a base store the op then 409s (no enhanced store); on an
        // enhanced store it starts the durable embedder, so stop it immediately
        // to avoid leaking a loop past the test.
        if (enhanced) {
            await api.call("startFactsEmbedder", {});
            await api.call("stopFactsEmbedder", { reason: "webapi-e2e cleanup" });
        } else {
            try {
                await api.call("startFactsEmbedder", {});
                assert(false, "startFactsEmbedder needs an enhanced store");
            } catch (error) {
                assertEqual(error.status, 409, `admin op passed the gate, 409 for base store (got ${error.status})`);
            }
        }

        // Graph ops: dispatch on a graph-backed deployment, 409 on a graphless one.
        if (hasGraph) {
            const nodes = await api.call("searchGraphNodes", { query: { limit: 1 } });
            assertNotNull(nodes, "searchGraphNodes dispatches on a graph store");
        } else {
            try {
                await api.call("searchGraphNodes", { query: {} });
                assert(false, "graph should be unsupported without a graph store");
            } catch (error) {
                assertEqual(error.status, 409, `409 for graph op (got ${error.status})`);
                assertEqual(error.code, "GRAPH_UNSUPPORTED", "graph capability error code");
            }
        }
    });

    it("returns the structured error envelope", async () => {
        const api = new ApiClient({ apiUrl });

        // Unknown route → NOT_FOUND envelope.
        try {
            await api.request("GET", "/api/v1/definitely-not-a-route");
            assert(false, "unknown route should throw");
        } catch (error) {
            assert(error instanceof ApiError, "ApiError thrown");
            assertEqual(error.status, 404, "404 for unknown route");
            assertEqual(error.code, "NOT_FOUND", "NOT_FOUND code");
        }

        // Malformed cursor → validation error (400).
        try {
            await api.request("GET", "/api/v1/management/sessions?cursor=%7Bnope");
            assert(false, "malformed cursor should throw");
        } catch (error) {
            assertEqual(error.status, 400, `400 for malformed cursor (got ${error.status}: ${error.message})`);
        }

        // Unsupported web-mode method throws locally with a clear code.
        try {
            mgmt.dumpSession("whatever");
            assert(false, "dumpSession should throw in web mode");
        } catch (error) {
            assertEqual(error.code, "WEB_MODE_UNSUPPORTED", "web-mode unsupported code");
        }
    });
});
