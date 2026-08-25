/**
 * The canvas app catalog — interactive-canvas-apps Part F.
 *
 *   publish   canvas bytes → pinned artifact app-<name>.html on the session
 *             manifest + armed contract + source → SHARED fact apps/<name>
 *   find      ranked search over the `apps` namespace (hybrid on an enhanced
 *             store; a listing with a term-overlap rank on a base store)
 *
 * Pure functions over injected stores, so the session bridge, tests and
 * scripts all run the SAME code. The card is derived from the DOCUMENT's
 * manifest, never from a model's memory of it, and an app without an
 * `interface` block is refused: the card is what another agent drives the
 * app from, and a card that only says "a board" cannot be driven.
 */

import { createHash } from "node:crypto";
import type { SessionCatalog } from "./cms.js";
import type { ArtifactStore } from "./session-store.js";
import type { FactStore } from "./facts-store.js";
import { isEnhancedFactStore } from "./facts-store.js";
import {
    extractCanvasAppManifest, normalizeCanvasResponseContract, buildCanvasAppCatalogRecord, CANVAS_APP_NAME_RE,
} from "./canvas-app-manifest.js";
import { canvasArtifactFilename, latestCanvasEventData } from "./canvas-support.js";

export interface CanvasAppCatalogDeps {
    artifactStore: ArtifactStore | null | undefined;
    catalog: SessionCatalog | null | undefined;
    factStore: FactStore | null | undefined;
    /** The publishing session (stamped as publishedBy and the fact's sessionId). */
    sessionId: string;
    agentIdentity?: string | null;
    workerNodeId?: string;
}

export interface PublishCanvasAppArgs {
    name?: string;
    description?: string;
    tags?: string[];
    slot: number;
    /** The session whose canvas is published (self or a resolved ancestor). */
    target: string;
}

export interface CanvasAppHit {
    key: string;
    name: string;
    description: string;
    version: string | null;
    tags: string[];
    kv: unknown;
    source: unknown;
    score?: number;
}

export const CANVAS_APP_DESCRIPTION_MIN = 20;

export async function publishCanvasApp(deps: CanvasAppCatalogDeps, args: PublishCanvasAppArgs): Promise<Record<string, unknown> | { error: string }> {
    const { artifactStore, catalog, factStore } = deps;
    if (!artifactStore) return { error: "this worker has no artifact store" };
    if (!catalog) return { error: "publishing requires the CMS catalog" };
    if (!factStore) return { error: "this worker has no fact store; the catalog is a shared fact" };
    const name = String(args.name ?? "").trim().toLowerCase();
    if (!CANVAS_APP_NAME_RE.test(name)) return { error: "name must be a slug: lowercase letters, digits and dashes, ≤64 chars (e.g. release-signoff)" };
    const description = String(args.description ?? "").trim();
    if (description.length < CANVAS_APP_DESCRIPTION_MIN) {
        return { error: "description is the text the catalog ranks on — say WHEN to use the app, in at least one full sentence (e.g. \"Use when several approvers sign off a release train together\")" };
    }
    const slot = args.slot;
    const target = args.target;
    try {
        const latest = await latestCanvasEventData(catalog, target, slot);
        if (latest.rev === 0) return { error: `no canvas has been drawn on slot ${slot}` };
        const html = await artifactStore.downloadArtifactText(target, canvasArtifactFilename(slot));
        const extraction = extractCanvasAppManifest(html);
        if (extraction.error) return { error: `the canvas's CANVAS-APP-MANIFEST is broken: ${extraction.error}` };
        if (!extraction.manifest) {
            return { error: "the canvas has no CANVAS-APP-MANIFEST. A published app must carry one — with an `interface` block (keys, requests, events) — so another agent can drive it from the card without reading the HTML. Add the manifest, redraw, then publish." };
        }
        if (!extraction.manifest.interface) {
            return { error: "the manifest has no `interface` block. Declare the KV keys the page uses, the req/* ops it queues and what it expects back (see the canvas-apps skill); that is what another agent drives the app from." };
        }
        const sha256 = createHash("sha256").update(html, "utf8").digest("hex");
        // Artifact names are FLAT (the store keeps the basename), so the catalog
        // artifact is `app-<name>.html`, not `apps/<name>.html`.
        const filename = `app-${name}.html`;
        await artifactStore.uploadArtifact(target, filename, html, "text/html", { pinned: true } as any);
        const armed = normalizeCanvasResponseContract(latest.responseContract);
        const record = buildCanvasAppCatalogRecord({
            name,
            description,
            manifest: extraction.manifest,
            responseContract: armed.contract ?? extraction.manifest.responseContract ?? null,
            source: { sessionId: target, filename, sha256 },
            publishedBy: deps.sessionId,
            publishedAt: new Date().toISOString(),
            tags: Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string") : [],
        });
        await factStore.storeFact({
            key: `apps/${name}`,
            value: record,
            shared: true,
            tags: ["canvas-app", ...(record.tags as string[])],
            sessionId: deps.sessionId,
            agentId: deps.agentIdentity ?? null,
        });
        await catalog.recordEvents(target, [{
            eventType: "session.canvas_app_published",
            data: { name, slot, filename, sha256, key: `apps/${name}` },
        }], deps.workerNodeId).catch(() => { /* telemetry */ });
        return {
            published: true,
            key: `apps/${name}`,
            source: record.source,
            card: record.card,
            reminder: "Published deployment-wide: every session can find and draw this app. It must not contain baked data — the shell reads its rows from the KV.",
        };
    } catch (err: any) {
        return { error: err?.message || String(err) };
    }
}

function toHit(key: string, value: unknown, score?: number): CanvasAppHit | null {
    const v: any = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
    if (!v || typeof v !== "object") return null;
    return {
        key,
        name: v.name ?? key.replace(/^apps\//, ""),
        description: v.description ?? "",
        version: v.version ?? null,
        tags: Array.isArray(v.tags) ? v.tags : [],
        kv: v.kv ?? null,
        source: v.source ?? null,
        ...(score !== undefined ? { score } : {}),
    };
}

const NEXT = "Read one app's full card with read_facts(key_pattern=\"<key>\", scope=\"shared\") — its `interface` is how you drive it — then draw_canvas({fromArtifact: card.source}).";

/** Rank catalog hits by how many query terms the name/description/tags contain. Exported for the base-store path and its tests. */
export function rankCanvasAppHits(hits: CanvasAppHit[], query: string, limit: number): CanvasAppHit[] {
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    return hits
        .map((hit) => {
            const hay = `${hit.name} ${hit.description} ${hit.tags.join(" ")}`.toLowerCase();
            const score = terms.length ? terms.filter((t) => hay.includes(t)).length / terms.length : 1;
            return { ...hit, score };
        })
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .slice(0, limit);
}

export async function findCanvasApp(deps: Pick<CanvasAppCatalogDeps, "factStore">, args: { query?: string; limit?: number }): Promise<{ count: number; apps: CanvasAppHit[]; next: string } | { error: string }> {
    const { factStore } = deps;
    if (!factStore) return { error: "this worker has no fact store; the catalog is a shared fact" };
    const query = String(args.query ?? "").trim();
    const limit = Math.max(1, Math.min(20, Math.floor(Number(args.limit) || 8)));
    try {
        if (query && isEnhancedFactStore(factStore) && factStore.capabilities.search) {
            const res = await factStore.searchFacts(query, { mode: "hybrid", namespace: "apps", scope: "shared", limit });
            const apps = res.facts.map((f: any) => toHit(f.key, f.value, f.score)).filter((h): h is CanvasAppHit => h !== null);
            return { count: apps.length, apps, next: NEXT };
        }
        const res = await factStore.readFacts({ keyPattern: "apps/*", scope: "shared", limit: 200 });
        const hits = (res.facts ?? []).map((f: any) => toHit(f.key, f.value)).filter((h): h is CanvasAppHit => h !== null);
        const apps = rankCanvasAppHits(hits, query, limit);
        return { count: apps.length, apps, next: NEXT };
    } catch (err: any) {
        return { error: err?.message || String(err) };
    }
}
