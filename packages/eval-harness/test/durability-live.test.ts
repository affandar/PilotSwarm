// Live durability tests — gated by LIVE=1. When LIVE infra is not
// present these are skipped.
//
// SCOPE: this file contains REAL durability proof against a live
// PilotSwarm worker fleet. Each test reads CMS-persisted event evidence
// (session.dehydrated, session.hydrated, session.wait_started,
// session.wait_completed, session.turn_completed, workerNodeId) to
// verify the runtime actually performed the durability behavior — not
// synthetic overlay tags from a wrapper Driver. ChaosDriver wrapper
// behavior is covered by unit tests in `durability.test.ts` and is
// intentionally NOT exercised here (its base run() does not crash
// workers or force dehydration; the LIVE wrappers around it provided
// no extra value beyond unit coverage and previously overclaimed
// 'DURABILITY:' proof).

import { describe, expect, it } from "vitest";

describe("LiveDriver durability LIVE", () => {
  const run = process.env.LIVE === "1" ? it : it.skip;

  // -------------------------------------------------------------------------
  // G13: REAL wait-induced dehydrate/hydrate cycle on a single worker.
  //
  // PilotSwarm has TWO independent thresholds, both set on the CLIENT:
  //   * `waitThreshold` (default 30s, client.ts:94 → managed-session.ts:406)
  //     — controls inline (setTimeout) vs durable (orchestration) dispatch
  //     of the wait tool.
  //   * `dehydrateThreshold` (default 29s, client.ts:495 → orchestration.ts:229
  //     → wait-affinity.planWaitHandling) — controls whether the orchestration
  //     writes a session.dehydrated event before the durable timer.
  //
  // We set BOTH to 0 on the client. With waitThreshold=0, any wait > 0s
  // takes the durable path. With dehydrateThreshold=0 and blobEnabled=true
  // (default — FilesystemSessionStore), every durable wait dehydrates the
  // session to the blob/state store before the timer fires.
  //
  // The LLM is given a tightly-scoped systemMessage (mode="replace") that
  // tells it to use the wait tool with 2 seconds — the same pattern the
  // SDK's own durability.test.js uses to prevent the model from defaulting
  // to bash sleep / external delay tools.
  //
  // Observed event sequence on a passing run (verified via real LIVE):
  //   user.message → session.turn_started → assistant.* → session.wait_started
  //   (managed-session pre-dispatch) → session.dehydrated → session.wait_started
  //   (orchestration) → (timer fires) → session.wait_completed → session.hydrated
  //   → assistant.* → session.turn_completed
  //
  // We assert (a) presence of all five canonical durable-wait events
  // (dehydrated, wait_started, wait_completed, hydrated, turn_completed)
  // and (b) the strongest correct partial-order invariants:
  //   * dehydrated precedes wait_completed (the dehydrate fires before the
  //     timer completes)
  //   * dehydrated precedes the FINAL turn_completed (post-dehydrate work
  //     happened — guards against a regression where a session dehydrates
  //     but never resumes)
  //   * dehydrated precedes hydrated (you can't hydrate without dehydrating
  //     first)
  // We deliberately do NOT order wait_started against wait_completed or
  // hydrated; the SDK records wait_started TWICE (managed-session
  // pre-dispatch + orchestration) and CMS event ordering for hydrate
  // vs. wait_completed depends on async activity completion.
  // -------------------------------------------------------------------------
  run("DURABILITY: real wait-induced dehydrate/hydrate cycle on a single worker (CMS event evidence)", async () => {
    // @ts-expect-error - SDK test helpers are private and untyped
    const sdkMod = await import("pilotswarm-sdk");
    // @ts-expect-error - SDK test env helper is private and untyped
    const envHelpers = await import("../../sdk/test/helpers/local-env.js");
    const PilotSwarmWorker = (sdkMod as any).PilotSwarmWorker;
    const PilotSwarmClient = (sdkMod as any).PilotSwarmClient;
    const createTestEnv = (envHelpers as any).createTestEnv as (suite: string) => any;

    const env = createTestEnv("eval_durability_dehydrate");
    let worker: any | undefined;
    let client: any | undefined;
    try {
      worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: "eval-dehydrate",
        disableManagementAgents: true,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
        waitThreshold: 0,
      });
      await worker.start();

      client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        // The PilotSwarm runtime has TWO independent thresholds and BOTH
        // must be zero on the client to force every wait > 0s through
        // the dehydrate path:
        //   waitThreshold (default 30s, plumbed to managed-session.ts:406)
        //     → controls inline (setTimeout) vs durable (orchestration)
        //       dispatch of wait().
        //   dehydrateThreshold (default 29s, plumbed to orchestration
        //     input.dehydrateThreshold and consumed by planWaitHandling)
        //     → controls whether the orchestration writes a
        //       session.dehydrated event before the timer.
        // With both set to 0, ANY wait > 0s fires session.wait_started
        // AND triggers a real dehydrate/hydrate cycle.
        waitThreshold: 0,
        dehydrateThreshold: 0,
      });
      await client.start();

      const session = await client.createSession({
        systemMessage: {
          mode: "replace",
          content: "You have a wait tool. When asked to wait, use it with 2 seconds. After waiting, say 'done'. Be brief.",
        },
      });
      const sessionId: string = session.sessionId;

      const response = await session.sendAndWait("Wait 2 seconds.", 180_000);
      expect(typeof response).toBe("string");
      expect(
        String(response).length,
        `expected non-empty response; got: ${JSON.stringify(response)}`,
      ).toBeGreaterThan(0);

      const events = await session.getMessages(1000);
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      const eventTypes: string[] = events.map((e: any) => e?.eventType ?? "?");
      const has = (t: string) => eventTypes.includes(t);
      const firstIndexOf = (t: string) => eventTypes.indexOf(t);
      const lastIndexOf = (t: string) => eventTypes.lastIndexOf(t);
      const debugMsg = `sessionId=${sessionId} eventTypes=${JSON.stringify(eventTypes)}`;

      // PRESENCE: all five durable-wait flow events must appear.
      expect(has("session.dehydrated"), `expected session.dehydrated; ${debugMsg}`).toBe(true);
      expect(has("session.wait_started"), `expected session.wait_started; ${debugMsg}`).toBe(true);
      expect(has("session.wait_completed"), `expected session.wait_completed; ${debugMsg}`).toBe(true);
      expect(has("session.hydrated"), `expected session.hydrated; ${debugMsg}`).toBe(true);
      expect(has("session.turn_completed"), `expected session.turn_completed; ${debugMsg}`).toBe(true);

      // ORDER: the dehydrate cycle must happen WITHIN the run (not at
      // start-of-stream as a stale leftover) — i.e. dehydrated is
      // followed by a wait_completed and then a final turn_completed.
      // This protects against a regression where a session dehydrates
      // but never resumes / completes.
      expect(
        firstIndexOf("session.dehydrated"),
        `dehydrated must precede wait_completed; ${debugMsg}`,
      ).toBeLessThan(firstIndexOf("session.wait_completed"));
      expect(
        firstIndexOf("session.dehydrated"),
        `dehydrated must precede the final turn_completed (post-dehydrate work happened); ${debugMsg}`,
      ).toBeLessThan(lastIndexOf("session.turn_completed"));
      expect(
        firstIndexOf("session.dehydrated"),
        `dehydrated must precede hydrated; ${debugMsg}`,
      ).toBeLessThan(lastIndexOf("session.hydrated"));
    } finally {
      try {
        if (client) await client.stop();
      } catch (err) {
        if (process.env.EVAL_VERBOSE_TEARDOWN === "1") {
          process.stderr.write(`dehydrate test: client.stop warning: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      try {
        if (worker) await worker.stop();
      } catch (err) {
        if (process.env.EVAL_VERBOSE_TEARDOWN === "1") {
          process.stderr.write(`dehydrate test: worker.stop warning: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      if (process.env.KEEP_DURABILITY_ENV !== "1") {
        try {
          await env.cleanup?.();
        } catch (err) {
          if (process.env.EVAL_VERBOSE_TEARDOWN === "1") {
            process.stderr.write(`dehydrate test: env.cleanup warning: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
      }
    }
  }, 360_000);

  // -------------------------------------------------------------------------
  // G13: REAL cross-worker dehydrate-resumption.
  //
  // Worker A starts as the only active worker. The client sets
  // `waitThreshold: 0` AND `dehydrateThreshold: 0` (see the dehydrate-cycle
  // test above for the rationale on why both are required) so the LLM's
  // wait(20s) goes through the durable orchestration path AND fires a
  // session.dehydrated event before the timer. Once the session has
  // dehydrated (verified via CMS poll), worker A is stopped. Worker B
  // (different workerNodeId, same env/schemas) starts; B's runtime picks
  // up the orchestration timer, hydrates the session, drives the
  // remaining LLM turn, and writes the completion. CMS event log proves
  // the handoff: session.dehydrated from A, session.hydrated + final
  // session.turn_completed from B.
  //
  // This is the canonical 'session survives worker death during a
  // durable wait' proof — substantially stronger than the cross-turn
  // handoff test below because the failure happens MID-TURN (during a
  // dehydrated wait) rather than between turns.
  // -------------------------------------------------------------------------
  run("DURABILITY: REAL cross-worker dehydrate-resumption — worker A dies during dehydrated wait, worker B resumes timer (CMS evidence)", async () => {
    // @ts-expect-error - SDK test helpers are private and untyped
    const sdkMod = await import("pilotswarm-sdk");
    // @ts-expect-error - SDK test env helper is private and untyped
    const envHelpers = await import("../../sdk/test/helpers/local-env.js");
    const PilotSwarmWorker = (sdkMod as any).PilotSwarmWorker;
    const PilotSwarmClient = (sdkMod as any).PilotSwarmClient;
    const createTestEnv = (envHelpers as any).createTestEnv as (suite: string) => any;

    const env = createTestEnv("eval_durability_xworker");
    let workerA: any | undefined;
    let workerB: any | undefined;
    let client: any | undefined;
    try {
      const commonOpts = {
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        disableManagementAgents: true,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
        waitThreshold: 0,
      };
      workerA = new PilotSwarmWorker({ ...commonOpts, workerNodeId: "eval-xworker-a" });
      await workerA.start();

      client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        // Both thresholds set to 0 force every wait > 0s through the
        // durable orchestration path AND trigger a real dehydrate event.
        // See dehydrate-cycle test above for the rationale on why both
        // must be set together.
        waitThreshold: 0,
        dehydrateThreshold: 0,
      });
      await client.start();

      const session = await client.createSession({
        systemMessage: {
          mode: "replace",
          content: "You have a wait tool. When asked to wait, use it with 20 seconds. After waiting, say 'resumed'. Be brief.",
        },
      });
      const sessionId: string = session.sessionId;

      // Send the prompt but DO NOT await — we need to stop workerA
      // mid-flight while the wait is dehydrated. Long timeout: B may
      // take a few seconds to pick up the timer + drive the remaining
      // LLM turn after takeover.
      const sendPromise = session.sendAndWait("Wait 20 seconds.", 300_000);
      // Suppress unhandled-rejection if teardown ends up swallowing a
      // primary failure before the await below.
      sendPromise.catch(() => {});

      // Poll CMS for session.dehydrated. With both client thresholds
      // set to 0, the dehydrate fires within ~1-3s of the wait tool
      // call (which itself follows one LLM turn, ~2-10s). Bound the
      // poll by 90s.
      const dehydrateDeadline = Date.now() + 90_000;
      let dehydrated = false;
      while (Date.now() < dehydrateDeadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const events = await session.getMessages(1000).catch(() => [] as any[]);
        if (Array.isArray(events) && events.some((e: any) => e?.eventType === "session.dehydrated")) {
          dehydrated = true;
          break;
        }
      }
      expect(
        dehydrated,
        "expected session.dehydrated event from worker A within 90s — the wait tool may not have taken the durable path",
      ).toBe(true);

      // Stop workerA. The durable wait timer is now persisted to the
      // store; workerB will resume it on hydration.
      await workerA.stop();
      workerA = undefined;
      workerB = new PilotSwarmWorker({ ...commonOpts, workerNodeId: "eval-xworker-b" });
      await workerB.start();

      const response = await sendPromise;
      expect(typeof response).toBe("string");
      // Response token wording can vary across LLMs/turns. The CANONICAL
      // proof of cross-worker dehydrate-resumption is the CMS event log
      // assertions below (events from worker B post-takeover, including
      // hydrated and turn_completed). Just require a non-empty response
      // here — its presence proves worker B drove the post-wait turn to
      // completion (otherwise sendAndWait would have timed out).
      expect(
        String(response).length,
        `expected non-empty response from worker B; got: ${JSON.stringify(response)}`,
      ).toBeGreaterThan(0);

      const events = await session.getMessages(1000);
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      const aEvents = events.filter((e: any) => e?.workerNodeId === "eval-xworker-a");
      const bEvents = events.filter((e: any) => e?.workerNodeId === "eval-xworker-b");
      const eventTypes: string[] = events.map((e: any) => e?.eventType ?? "?");
      const debugMsg = `sessionId=${sessionId} aEvents=${aEvents.length} bEvents=${bEvents.length} eventTypes=${JSON.stringify(eventTypes)}`;

      expect(aEvents.length, `expected events from worker A before stop; ${debugMsg}`).toBeGreaterThan(0);
      expect(bEvents.length, `expected events from worker B after takeover; ${debugMsg}`).toBeGreaterThan(0);

      const dehydratedFromA = events.some(
        (e: any) => e?.eventType === "session.dehydrated" && e?.workerNodeId === "eval-xworker-a",
      );
      expect(
        dehydratedFromA,
        `expected session.dehydrated from worker A specifically; ${debugMsg}`,
      ).toBe(true);

      const hydratedFromB = events.some(
        (e: any) => e?.eventType === "session.hydrated" && e?.workerNodeId === "eval-xworker-b",
      );
      expect(
        hydratedFromB,
        `expected session.hydrated from worker B (post-takeover); ${debugMsg}`,
      ).toBe(true);

      const turnCompletedFromB = events.some(
        (e: any) => e?.eventType === "session.turn_completed" && e?.workerNodeId === "eval-xworker-b",
      );
      expect(
        turnCompletedFromB,
        `expected session.turn_completed from worker B (final completion); ${debugMsg}`,
      ).toBe(true);
    } finally {
      try {
        if (client) await client.stop();
      } catch (err) {
        if (process.env.EVAL_VERBOSE_TEARDOWN === "1") {
          process.stderr.write(`xworker test: client.stop warning: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      try {
        if (workerB) await workerB.stop();
      } catch (err) {
        if (process.env.EVAL_VERBOSE_TEARDOWN === "1") {
          process.stderr.write(`xworker test: workerB.stop warning: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      try {
        if (workerA) await workerA.stop();
      } catch (err) {
        if (process.env.EVAL_VERBOSE_TEARDOWN === "1") {
          process.stderr.write(`xworker test: workerA.stop warning: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
      if (process.env.KEEP_DURABILITY_ENV !== "1") {
        try {
          await env.cleanup?.();
        } catch (err) {
          if (process.env.EVAL_VERBOSE_TEARDOWN === "1") {
            process.stderr.write(`xworker test: env.cleanup warning: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
      }
    }
  }, 600_000);

  // -------------------------------------------------------------------------
  // G10: REAL multi-worker handoff scenario — replaces the previous synthetic
  // `afterRunHook`-based test. The old test set
  // `observed.durability.workerHandoff = true` from a hook (and even that
  // tag was clobbered by ChaosDriver's post-hook `durability` overlay), so
  // it provided ZERO real evidence of cross-worker session migration.
  //
  // This test:
  //   1. Spins up two real workers (A + B) sharing the same store/schemas/
  //      session-state dir via the SDK's `withTwoWorkers` helper.
  //   2. Creates a session, runs a first turn — some worker handles it.
  //   3. Stops worker A. Worker B remains running.
  //   4. Runs a second turn on the SAME session — worker B MUST handle it
  //      (otherwise the request would hang forever).
  //   5. Reads the persisted CMS event log via `session.getMessages()` and
  //      asserts at least 2 DISTINCT `workerNodeId` values across events.
  //      That is the canonical product-level evidence of a real handoff.
  //
  // No `ChaosDriver`. No `afterRunHook`. No synthetic tags. The assertion
  // reads from real CMS-persisted events written by the real workers.
  //
  // Skipped when LIVE!=1, like every other test in this file.
  // -------------------------------------------------------------------------
  run("DURABILITY: REAL worker handoff — second turn handled by surviving worker (CMS evidence)", async () => {
    // Use the SDK directly rather than `withTwoWorkers` so we can FORCE
    // worker-A-only execution for turn 1 (start A alone, run turn, then
    // stop A and start B for turn 2). With `withTwoWorkers` both workers
    // race to dispatch, so A may never see any work — defeating the point
    // of a handoff test.
    // @ts-expect-error - SDK test helpers are private and untyped
    const sdkMod = await import("pilotswarm-sdk");
    // @ts-expect-error - SDK test env helper is private and untyped
    const envHelpers = await import("../../sdk/test/helpers/local-env.js");
    const PilotSwarmWorker = (sdkMod as any).PilotSwarmWorker;
    const PilotSwarmClient = (sdkMod as any).PilotSwarmClient;
    const createTestEnv = (envHelpers as any).createTestEnv as (suite: string) => any;

    const env = createTestEnv("eval_durability_handoff");
    let workerA: any | undefined;
    let workerB: any | undefined;
    let client: any | undefined;
    try {
      const commonOpts = {
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        disableManagementAgents: true,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
      };
      // Phase 1: only worker A is running. It will handle turn 1.
      workerA = new PilotSwarmWorker({ ...commonOpts, workerNodeId: "eval-handoff-a" });
      await workerA.start();

      client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
      });
      await client.start();

      const session = await client.createSession({});
      const sessionId: string = session.sessionId;

      // Turn 1: worker A is the ONLY active worker, so it must handle this.
      const r1 = await session.sendAndWait("Reply with the single token 'one'.", 120_000);
      expect(typeof r1).toBe("string");

      // Hand off: stop A, start B. Session state was persisted by A; B
      // picks up the next turn via the standard hydrate flow.
      await workerA.stop();
      workerA = undefined;
      workerB = new PilotSwarmWorker({ ...commonOpts, workerNodeId: "eval-handoff-b" });
      await workerB.start();

      // Turn 2: worker B is now the only active worker.
      const r2 = await session.sendAndWait("Reply with the single token 'two'.", 180_000);
      expect(typeof r2).toBe("string");

      // CMS evidence: read the full event log and assert at least two
      // distinct workerNodeIds appear. This is the canonical product-level
      // signal that a real cross-worker handoff happened — not a synthetic
      // tag set by an `afterRunHook`.
      const events = await session.getMessages(1000);
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      const workerNodeIds = new Set<string>(
        events
          .map((e: any) => e?.workerNodeId)
          .filter((id: unknown): id is string => typeof id === "string" && id.length > 0),
      );
      expect(
        workerNodeIds.size,
        `expected events from >=2 workers across the handoff; sessionId=${sessionId} saw: ${JSON.stringify(Array.from(workerNodeIds))}; total events: ${events.length}`,
      ).toBeGreaterThanOrEqual(2);
      expect(workerNodeIds.has("eval-handoff-a")).toBe(true);
      expect(workerNodeIds.has("eval-handoff-b")).toBe(true);

      // Each turn produces a session.turn_completed event. With two turns
      // we expect at least two such events in CMS.
      const turnCompletes = events.filter(
        (e: any) => e?.eventType === "session.turn_completed",
      );
      expect(turnCompletes.length).toBeGreaterThanOrEqual(2);
    } finally {
      // Reverse-order cleanup. Errors here MUST NOT mask a primary failure.
      try {
        if (client) await client.stop();
      } catch (err) {
        process.stderr.write(`handoff test: client.stop warning: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      try {
        if (workerB) await workerB.stop();
      } catch (err) {
        process.stderr.write(`handoff test: workerB.stop warning: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      try {
        if (workerA) await workerA.stop();
      } catch (err) {
        process.stderr.write(`handoff test: workerA.stop warning: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      if (process.env.KEEP_DURABILITY_ENV !== "1") {
        try {
          await env.cleanup?.();
        } catch (err) {
          process.stderr.write(`handoff test: env.cleanup warning: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    }
  }, 600_000);
});
