/**
 * The canvas app catalog end to end against a real Postgres + a filesystem
 * artifact store, no LLM turns:
 *
 *   session A draws a canvas with a full manifest → publishCanvasApp
 *     → pinned artifact app-<name>.html on A, shared fact apps/<name>
 *   session B (different owner) → findCanvasApp → the card
 *     → draws it fromArtifact (server-side copy, sha verified)
 *     → drives it from the card alone: seeds the keys the interface names
 *
 * Also: republish replaces the card; a canvas without an interface is
 * refused; facts stats bucket the namespace as `apps` (facts migration 0012).
 *
 * Run: npx vitest run test/local/canvas-app-catalog.test.js
 */

import { describe, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { FilesystemArtifactStore, PgFactStore, publishCanvasApp, findCanvasApp, writeCanvasKv, readCanvasKv } from "../../src/index.ts";
import { extractCanvasAppManifest } from "../../src/canvas-app-manifest.ts";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

const ALICE = { provider: "test", subject: "cat-alice", email: "alice@test", displayName: "Alice" };
const BOB = { provider: "test", subject: "cat-bob", email: "bob@test", displayName: "Bob" };

const MANIFEST = {
    manifestVersion: 1, name: "signoff", version: "1.1.0",
    description: "Use when several approvers sign off a release train together.",
    tags: ["release", "approval"],
    kv: { write: "viewers", shared: ["app/item/*"] },
    responseContract: { actions: { request: { id: "string" } } },
    interface: {
        keys: [
            { key: "app/item/<id>", writer: "both", shape: { title: "Fix login", owner: "sam", decision: null, note: "" }, note: "one row per item; the agent seeds" },
            { key: "cfg/deadline", writer: "agent", shape: "2026-09-01T17:00:00Z" },
        ],
        requests: [{ op: "store", args: {}, result: { artifact: "signoff.md" }, note: "owner presses Store" }],
        events: [{ key: "evt/banner", shape: { text: "" } }],
        notes: "Render everything from app/item/*.",
    },
};
const html = (manifest) => `<!doctype html>\n<!-- CANVAS-APP-MANIFEST ${JSON.stringify(manifest)} -->\n<html><body>shell</body></html>`;

async function drawCanvas(catalog, artifactStore, sessionId, doc, contract) {
    const rev = await catalog.mintCanvasRev(sessionId, 1, 0);
    await artifactStore.uploadArtifact(sessionId, "canvas.html", doc, "text/html", { pinned: true });
    await catalog.recordEvents(sessionId, [{ eventType: "session.canvas_updated", data: { rev, slot: 1, sizeBytes: doc.length, ...(contract ? { responseContract: contract } : {}) } }], "test");
    await catalog.upsertSessionCanvas(sessionId, 1, "app", rev, doc.length);
    const { manifest } = extractCanvasAppManifest(doc);
    await catalog.setCanvasKvManifest(sessionId, 1, manifest?.kv ?? null);
    return rev;
}

describe("canvas app catalog", () => {
    it("publish on A, find + draw + drive from the card on B; republish replaces; no interface is refused", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const factStore = await PgFactStore.create(env.store, env.factsSchema);
        await factStore.initialize();
        const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-catalog-art-"));
        const artifactStore = new FilesystemArtifactStore(artifactDir);
        const a = `cat-a-${env.runId}`;
        const b = `cat-b-${env.runId}`;
        try {
            await catalog.createSession(a, { model: "m", owner: ALICE });
            await catalog.createSession(b, { model: "m", owner: BOB });

            // A draws and publishes.
            const doc = html(MANIFEST);
            await drawCanvas(catalog, artifactStore, a, doc, MANIFEST.responseContract);
            const deps = { artifactStore, catalog, factStore, sessionId: a, agentIdentity: "default", workerNodeId: "t" };
            const bad = await publishCanvasApp(deps, { name: "signoff", description: "Use when several approvers sign off a release train together.", slot: 2, target: a });
            assert(/no canvas has been drawn/.test(bad.error || ""), `slot 2 empty: ${JSON.stringify(bad)}`);
            const pub = await publishCanvasApp(deps, { name: "release-signoff", description: "Use when several approvers sign off a release train together.", tags: ["train"], slot: 1, target: a });
            assertEqual(pub.error, undefined, JSON.stringify(pub));
            assertEqual(pub.key, "apps/release-signoff");
            const sha = createHash("sha256").update(doc, "utf8").digest("hex");
            assertEqual(pub.source.sha256, sha);
            assert(fs.existsSync(path.join(artifactDir, a, "app-release-signoff.html")) || (await artifactStore.downloadArtifactText(a, "app-release-signoff.html")) === doc, "the pinned artifact holds the bytes");

            // B finds it (base store → listing + rank) and reads the full card.
            const found = await findCanvasApp({ factStore }, { query: "sign off a release train" });
            assertEqual(found.error, undefined, JSON.stringify(found));
            assertEqual(found.count, 1);
            assertEqual(found.apps[0].name, "release-signoff");
            assertEqual(found.apps[0].source.sessionId, a);
            assertEqual(found.apps[0].tags.join(","), "train,release,approval");
            const read = await factStore.readFacts({ keyPattern: "apps/release-signoff", scope: "shared" });
            const card = read.facts[0].value;
            assertEqual(card.card.interface.keys[0].key, "app/item/<id>");
            assertEqual(card.card.interface.requests[0].op, "store");
            assertEqual(card.responseContract.actions.request.id, "string", "the armed contract rides the card");
            assertEqual(card.kv.write, "viewers");

            // B draws it from the card's source (what draw_canvas fromArtifact does): a
            // server-side copy verified against the sha, then drives it from the card:
            // seeds the key the interface names, with the interface's example shape.
            const bytes = await artifactStore.downloadArtifactText(card.source.sessionId, card.source.filename);
            assertEqual(createHash("sha256").update(bytes, "utf8").digest("hex"), card.source.sha256, "SHA precondition holds");
            await drawCanvas(catalog, artifactStore, b, bytes, card.responseContract);
            const seedKey = card.card.interface.keys[0].key.replace("<id>", "5502432");
            const seeded = await writeCanvasKv(catalog, b, 1, { kind: "agent", sessionId: b }, [{ op: "put", key: seedKey, value: { ...card.card.interface.keys[0].shape, title: "Fix login redirect" } }]);
            assertEqual(seeded.results[0].ok, true);
            const onB = await readCanvasKv(catalog, b, 1, { kind: "user", provider: BOB.provider, subject: BOB.subject, isAdmin: false }, { prefix: "app/item/" });
            assertEqual(onB.entries[0].v.title, "Fix login redirect");
            assertEqual(onB.manifestKv.write, "viewers", "B's copy carries the manifest switch from the redraw");

            // Republish with a new description replaces the card, not adds a row.
            const again = await publishCanvasApp(deps, { name: "release-signoff", description: "Use when a release train needs approver sign-off, v2.", slot: 1, target: a });
            assertEqual(again.error, undefined);
            const list = await factStore.readFacts({ keyPattern: "apps/*", scope: "shared" });
            assertEqual(list.facts.filter((f) => f.key === "apps/release-signoff").length, 1);
            assert(/v2/.test(list.facts.find((f) => f.key === "apps/release-signoff").value.description));

            // A canvas with a manifest but no interface is refused: it cannot be driven from the card.
            const thin = { manifestVersion: 1, name: "thin", kv: { write: "viewers" } };
            await drawCanvas(catalog, artifactStore, a, html(thin), null);
            const refused = await publishCanvasApp(deps, { name: "thin-app", description: "Use when you want a board with no interface at all.", slot: 1, target: a });
            assert(/no `interface` block/.test(refused.error || ""), JSON.stringify(refused));
            assertEqual((await findCanvasApp({ factStore }, { query: "thin" })).count, 0);

            // Stats bucket the namespace (facts migration 0012).
            const { rows } = await catalog.pool.query(`SELECT "${env.factsSchema}".facts_namespace_for_key('apps/release-signoff') AS ns`);
            assertEqual(rows[0].ns, "apps");
        } finally {
            await factStore.deleteFact({ key: "apps/*", pattern: true, scope: "shared", unrestricted: true }).catch(() => {});
            await factStore.close?.();
            await catalog.close?.();
            fs.rmSync(artifactDir, { recursive: true, force: true });
        }
    });
});
