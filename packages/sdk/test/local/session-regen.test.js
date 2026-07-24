/**
 * Session regeneration e2e (proposal §15.5): the full loop against a real
 * worker + LLM + Postgres — command gates, archive/distill pipeline, the
 * two-event flip/rebirth contract, epoch continuity, and the footprint's
 * epoch-boundary path.
 *
 * Run: npx vitest run test/local/session-regen.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual, assertNotNull } from "../helpers/assertions.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 600_000;
const TURN_TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

async function pollEvents(mgmt, sessionId, types, deadlineMs) {
    const want = new Set(types);
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        // Unfiltered read + client-side filter: robust to the server-side
        // event-type filter proc for newly added event types.
        const all = await mgmt.getSessionEvents(sessionId, undefined, 1000);
        const hits = all.filter((e) => want.has(e.eventType));
        if (hits.length > 0) return hits;
        await new Promise((r) => setTimeout(r, 1_000));
    }
    return [];
}

describe("session regeneration", () => {
    beforeAll(async () => {
        await preflightChecks();
    }, TIMEOUT);

    it("regenerates in place: gates, pipeline, two-event contract, continuity", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const mgmt = await createManagementClient(env);
        const catalog = await createCatalog(env);
        try {
            await withClient(env, async (client) => {
                const session = await client.createSession(ONEWORD_CONFIG);
                const sessionId = session.sessionId;

                // Min-age gate: an infant session is refused.
                await session.sendAndWait("Reply with exactly: OK", TURN_TIMEOUT);
                const early = await mgmt.regenerateSession(sessionId);
                // The command response is the deterministic outcome channel.
                let earlyResp = null;
                const respDeadline = Date.now() + 60_000;
                while (Date.now() < respDeadline && !earlyResp) {
                    earlyResp = await mgmt.getCommandResponse(sessionId, early.attemptId);
                    if (!earlyResp) await new Promise((r) => setTimeout(r, 500));
                }
                if (!earlyResp) {
                    const all = await mgmt.getSessionEvents(sessionId, undefined, 200);
                    console.log("  [debug] events:", all.map((e) => e.eventType).join(", "));
                }
                assertNotNull(earlyResp, "regenerate command must be answered");
                assertEqual(earlyResp.error, "too_young", "an infant session is refused too_young");
                const refused = await pollEvents(mgmt, sessionId, ["session.regenerate_refused"], 15_000);
                assert(refused.length > 0, "the refusal is a durable event");

                // Age the session past the gate (>= 5 iterations).
                for (let i = 0; i < 4; i++) {
                    await session.sendAndWait(`Turn ${i + 2}: reply with exactly OK`, TURN_TIMEOUT);
                }

                // Regenerate.
                const t0 = Date.now();
                const { attemptId } = await mgmt.regenerateSession(sessionId, {
                    handoff: "Mission: reply tersely with OK. Nothing is in flight.",
                });
                assertNotNull(attemptId, "regenerate returns the attempt id");

                // Two-event contract: epoch_committed (the flip) then, after
                // the grounding turn's snapshot commit, regenerated (proven).
                const outcome = await pollEvents(
                    mgmt, sessionId,
                    ["session.epoch_committed", "session.regenerate_failed"],
                    120_000,
                );
                const failedEvt = outcome.find((e) => e.eventType === "session.regenerate_failed");
                console.log(`  [debug] outcome after ${((Date.now()-t0)/1000).toFixed(1)}s: ${outcome.map(e=>e.eventType).join(",") || "NONE"}`);
                if (failedEvt) {
                    console.log("  [debug] regenerate_failed:", JSON.stringify(failedEvt.data));
                }
                if (outcome.length === 0) {
                    const all = await mgmt.getSessionEvents(sessionId, undefined, 300);
                    console.log("  [debug] events:", all.map((e) => e.eventType).join(", "));
                }
                assert(!failedEvt, `pipeline failed: ${JSON.stringify(failedEvt?.data ?? {})}`);
                const committed = outcome.filter((e) => e.eventType === "session.epoch_committed");
                assert(committed.length > 0, "session.epoch_committed must be emitted by the new execution");
                assertEqual(Number(committed[0].data?.toEpoch), 1);
                assertEqual(committed[0].data?.attemptId, attemptId);

                const regenerated = await pollEvents(mgmt, sessionId, ["session.regenerated"], 180_000);
                if (regenerated.length === 0) {
                    const all = await mgmt.getSessionEvents(sessionId, undefined, 400);
                    console.log("  [debug] post-flip events:", all.slice(-40).map((e) => e.eventType).join(", "));
                }
                assert(regenerated.length > 0, "session.regenerated must fire after the grounding commit");
                assert(
                    Number(regenerated[0].seq) > Number(committed[0].seq),
                    "regenerated (proven) sorts after the boundary event",
                );

                // CMS truth: epoch column + regen counter advanced atomically.
                const row = await catalog.getSession(sessionId);
                assertEqual(row.transcriptEpoch, 1, "sessions.transcript_epoch flipped");
                assertNotNull(row.lastRegeneratedAt, "last_regenerated_at stamped");
                const summary = await catalog.getSessionMetricSummary(sessionId);
                assertEqual(summary?.regenCount, 1, "regen_count incremented exactly once");

                // Artifacts of record exist (attempt-scoped names).
                const events = await mgmt.getSessionEvents(sessionId, undefined, 1000);
                const boundary = events.find((e) => e.eventType === "session.epoch_committed");
                assert(
                    String(boundary?.data?.archiveArtifactId ?? "").includes(attemptId),
                    "archive artifact is attempt-scoped",
                );
                assert(
                    String(boundary?.data?.packageArtifactId ?? "").includes(attemptId),
                    "package artifact is attempt-scoped",
                );

                // Continuity: the reborn session answers normally.
                const reply = await session.sendAndWait("Reply with exactly: OK", TURN_TIMEOUT);
                assertNotNull(reply, "the reborn session serves turns");

                // Footprint epoch path: boundary seq resolves; assessment is
                // computed from EPOCH counters (no dead-epoch inheritance).
                const fp = await mgmt.getSessionFootprint(sessionId, { bypassCache: true });
                assertEqual(fp.transcriptEpoch, 1);
                assert(fp.events.sinceEpochStart < fp.events.count, "epoch axes scope to the boundary");
                assert(["ok", "elevated"].includes(fp.assessment.level), "fresh epoch must not read degraded");

            });
        } finally {
            await mgmt.stop();
        }
    });
});
