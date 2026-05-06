/**
 * Unit tests for PilotSwarmJudgeClient — uses an injected fake CopilotClient
 * so no network is touched. Covers happy path, fail-closed JSON parsing,
 * timeout, retry policy, cost math, and cache-identity stability.
 */

import { describe, expect, it, vi } from "vitest";
import { ModelProviderRegistry } from "pilotswarm-sdk";
import {
  PilotSwarmJudgeClient,
  type CopilotClientLike,
  type CopilotSessionLike,
} from "../../src/graders/pilotswarm-judge-client.js";
import { LLMJudgeGrader } from "../../src/graders/llm-judge.js";
import type { JudgeRequest } from "../../src/graders/judge-types.js";
import { makeRubric } from "../fixtures/builders.js";

// ---------------------------------------------------------------------------
// Fake CopilotClient that simulates assistant.message_delta + session.idle.
// ---------------------------------------------------------------------------

interface FakeBehavior {
  /** Either a literal response or a function that builds one from the prompt. */
  response?: string | ((prompt: string) => string);
  /** When set, instead of resolving the createSession promise, throw this. */
  createSessionError?: Error;
  /** When set, emit a session.error event after send() instead of completing. */
  sessionError?: string;
  /** When true, never emit session.idle (simulates a hang for timeout tests). */
  hang?: boolean;
  /** When set, emit assistant.message_completed with this usage payload. */
  usage?: Record<string, unknown>;
  /** Delay before idle/error fires (ms). */
  delayMs?: number;
}

function makeFakeCtor(behaviors: FakeBehavior[]): {
  Ctor: new (opts: any) => CopilotClientLike;
  stops: { count: number };
  createCalls: Array<Record<string, unknown>>;
  constructorOpts: Array<Record<string, unknown>>;
} {
  let attemptIndex = 0;
  const stops = { count: 0 };
  const createCalls: Array<Record<string, unknown>> = [];
  const constructorOpts: Array<Record<string, unknown>> = [];

  class FakeClient implements CopilotClientLike {
    constructor(opts: any) {
      constructorOpts.push(opts);
    }
    async createSession(opts: any): Promise<CopilotSessionLike> {
      const i = attemptIndex++;
      const behavior = behaviors[Math.min(i, behaviors.length - 1)] ?? {};
      createCalls.push(opts);
      if (behavior.createSessionError) throw behavior.createSessionError;

      const handlers: Record<string, Array<(evt: any) => void>> = {};
      const session: CopilotSessionLike = {
        on(event, handler) {
          (handlers[event] ??= []).push(handler);
          return undefined;
        },
        send(prompt: string) {
          // Defer event emission so on() registrations complete first.
          const fire = () => {
            if (behavior.sessionError) {
              for (const h of handlers["session.error"] ?? []) {
                h({ message: behavior.sessionError });
              }
              return;
            }
            const text =
              typeof behavior.response === "function"
                ? behavior.response(prompt)
                : (behavior.response ?? '{"reasoning":"ok","rawScore":1,"normalizedScore":1,"pass":true}');
            for (const h of handlers["assistant.message_delta"] ?? []) {
              h({ content: text });
            }
            if (behavior.usage) {
              for (const h of handlers["assistant.message_completed"] ?? []) {
                h({ usage: behavior.usage });
              }
            }
            if (!behavior.hang) {
              for (const h of handlers["session.idle"] ?? []) {
                h({});
              }
            }
          };
          if (behavior.delayMs && behavior.delayMs > 0) {
            setTimeout(fire, behavior.delayMs);
          } else {
            queueMicrotask(fire);
          }
          return undefined;
        },
      };
      return session;
    }
    async stop(): Promise<void> {
      stops.count++;
    }
  }

  return { Ctor: FakeClient, stops, createCalls, constructorOpts };
}

// ---------------------------------------------------------------------------
// Test registry — uses a fake env-backed token so the GitHub provider is
// considered "credentialed" by the registry's loader filter.
// ---------------------------------------------------------------------------

function buildTestRegistry(): ModelProviderRegistry {
  process.env.PS_FAKE_GH_TOKEN = "ghu_test_token";
  return new ModelProviderRegistry({
    providers: [
      {
        id: "github-copilot",
        type: "github",
        githubToken: "env:PS_FAKE_GH_TOKEN",
        models: [
          { name: "gpt-4.1", description: "Fake test model" },
          { name: "claude-sonnet-4.6" },
        ],
      },
    ],
    defaultModel: "github-copilot:gpt-4.1",
  });
}

function judgeRequest(): JudgeRequest {
  const rubric = makeRubric();
  return {
    prompt: "Was the answer correct?",
    response: "yes",
    criterion: rubric.criteria[0]!,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PilotSwarmJudgeClient", () => {
  it("happy path — parses valid judge JSON and stops the client", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      {
        response: '{"reasoning":"good","rawScore":1,"normalizedScore":1,"pass":true}',
      },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
    });

    const resp = await client.judge(judgeRequest());

    expect(resp.cached).toBe(false);
    expect(resp.result.criterionId).toBe("c");
    expect(resp.result.pass).toBe(true);
    expect(resp.result.normalizedScore).toBe(1);
    expect(resp.cost.model).toBe("gpt-4.1");
    expect(fake.stops.count).toBe(1);
    // GitHub provider should pass the resolved token to the constructor.
    expect(fake.constructorOpts[0]?.githubToken).toBe("ghu_test_token");
    // Session creation should NOT include a `provider` for github.
    expect((fake.createCalls[0] as any)?.provider).toBeUndefined();
    expect((fake.createCalls[0] as any)?.model).toBe("gpt-4.1");
  });

  it("invalid JSON response throws (fails closed, never silently passes)", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([{ response: "this is not json at all" }]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 0,
    });

    await expect(client.judge(judgeRequest())).rejects.toThrow(/not valid JSON/i);
    // Even on failure, the client must have been stopped.
    expect(fake.stops.count).toBe(1);
  });

  it("times out when the session never emits session.idle", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([{ response: "{}", hang: true }]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      timeoutMs: 25,
      maxRetries: 0,
    });

    await expect(client.judge(judgeRequest())).rejects.toThrow(/timed out after 25ms/);
    expect(fake.stops.count).toBe(1);
  });

  it("retries transient session.error and succeeds on second attempt", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      { sessionError: "upstream 503" },
      {
        response: '{"reasoning":"ok","rawScore":0.8,"normalizedScore":0.8,"pass":true}',
      },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 2,
      baseRetryDelayMs: 0,
    });

    const resp = await client.judge(judgeRequest());
    expect(resp.result.pass).toBe(true);
    expect(fake.createCalls.length).toBe(2);
    // Both attempts must stop their clients (no resource leaks).
    expect(fake.stops.count).toBe(2);
  });

  it("does NOT retry malformed JSON (fail-closed is sticky)", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      { response: "garbage" },
      { response: '{"reasoning":"ok","rawScore":1,"normalizedScore":1,"pass":true}' },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 3,
      baseRetryDelayMs: 0,
    });

    await expect(client.judge(judgeRequest())).rejects.toThrow(/not valid JSON/i);
    // No retry — only one attempt was issued.
    expect(fake.createCalls.length).toBe(1);
  });

  it("computes cost from emitted usage tokens × cost rates", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      {
        response: '{"reasoning":"r","rawScore":1,"normalizedScore":1,"pass":true}',
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 500_000,
          prompt_tokens_details: { cached_tokens: 200_000 },
        },
      },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      costRates: {
        inputUsdPerMillionTokens: 1.0,
        outputUsdPerMillionTokens: 4.0,
        cachedInputUsdPerMillionTokens: 0.5,
      },
    });

    const resp = await client.judge(judgeRequest());
    // (800_000/1M)*1.0 + (200_000/1M)*0.5 + (500_000/1M)*4.0 = 0.8 + 0.1 + 2.0 = 2.9
    expect(resp.cost.inputTokens).toBe(1_000_000);
    expect(resp.cost.outputTokens).toBe(500_000);
    expect(resp.cost.estimatedCostUsd).toBeCloseTo(2.9, 9);
  });

  it("cacheIdentity is stable across instances with the same config", async () => {
    const registry = buildTestRegistry();
    const a = new PilotSwarmJudgeClient({ modelProviders: registry, model: "gpt-4.1" });
    const b = new PilotSwarmJudgeClient({ modelProviders: registry, model: "gpt-4.1" });
    const c = new PilotSwarmJudgeClient({ modelProviders: registry, model: "claude-sonnet-4.6" });
    // Different reference → same qualified id → same identity.
    const d = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "github-copilot:gpt-4.1",
    });

    expect(a.cacheIdentity()).toBe(b.cacheIdentity());
    expect(a.cacheIdentity()).toBe(d.cacheIdentity());
    expect(a.cacheIdentity()).not.toBe(c.cacheIdentity());
    expect(a.cacheIdentity()).toMatch(/^pilotswarm-judge:[0-9a-f]{64}$/);
  });

  it("rejects unknown models at construction time (loud failure)", () => {
    const registry = buildTestRegistry();
    expect(
      () =>
        new PilotSwarmJudgeClient({
          modelProviders: registry,
          model: "totally-made-up-model",
        }),
    ).toThrow(/not available/i);
  });

  it("respects caller AbortSignal — aborts immediately, does not retry", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([{ response: "{}", hang: true }]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      timeoutMs: 5_000,
      maxRetries: 3,
      baseRetryDelayMs: 0,
    });

    const ctrl = new AbortController();
    const p = client.judge(judgeRequest(), { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await expect(p).rejects.toThrow(/aborted by caller/);
    // Only one createSession (no retry) since caller-abort is non-retryable.
    expect(fake.createCalls.length).toBe(1);
  });

  it("logs retry attempts to stderr only (never stdout)", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      { sessionError: "503 upstream" },
      { response: '{"reasoning":"x","rawScore":1,"normalizedScore":1,"pass":true}' },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 1,
      baseRetryDelayMs: 0,
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // G16: per-attempt retry warning is gated on EVAL_VERBOSE_TEARDOWN=1.
    // This test asserts that under verbose mode the warning lands on
    // stderr (NEVER stdout, which downstream JSON parsers may read).
    // The complementary default-quiet behavior is asserted in the
    // dedicated G16 test below.
    const prevEnv = process.env.EVAL_VERBOSE_TEARDOWN;
    process.env.EVAL_VERBOSE_TEARDOWN = "1";
    try {
      await client.judge(judgeRequest());
      const stderrHits = stderrSpy.mock.calls.filter((c) =>
        String(c[0]).includes("PilotSwarmJudgeClient"),
      );
      const stdoutHits = stdoutSpy.mock.calls.filter((c) =>
        String(c[0]).includes("PilotSwarmJudgeClient"),
      );
      expect(stderrHits.length).toBeGreaterThan(0);
      expect(stdoutHits.length).toBe(0);
    } finally {
      if (prevEnv === undefined) delete process.env.EVAL_VERBOSE_TEARDOWN;
      else process.env.EVAL_VERBOSE_TEARDOWN = prevEnv;
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it("G16: default-quiet — retry warning is suppressed when EVAL_VERBOSE_TEARDOWN is unset", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      { sessionError: "503 upstream" },
      { response: '{"reasoning":"x","rawScore":1,"normalizedScore":1,"pass":true}' },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 1,
      baseRetryDelayMs: 0,
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prevEnv = process.env.EVAL_VERBOSE_TEARDOWN;
    delete process.env.EVAL_VERBOSE_TEARDOWN;
    try {
      // Retries still happen — and the eventual response still resolves —
      // but the per-attempt warning text MUST be suppressed.
      await client.judge(judgeRequest());
      const judgeStderrHits = stderrSpy.mock.calls.filter((c) =>
        String(c[0]).includes("PilotSwarmJudgeClient"),
      );
      const judgeStdoutHits = stdoutSpy.mock.calls.filter((c) =>
        String(c[0]).includes("PilotSwarmJudgeClient"),
      );
      expect(judgeStderrHits.length).toBe(0);
      expect(judgeStdoutHits.length).toBe(0);
    } finally {
      if (prevEnv !== undefined) process.env.EVAL_VERBOSE_TEARDOWN = prevEnv;
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // G6 V2 audit fixes — coverage for blocking findings.
  // ---------------------------------------------------------------------------

  it("V2: timeout fires while createSession hangs — rejects within timeout and stops client", async () => {
    const registry = buildTestRegistry();
    // Build a Ctor whose createSession() never resolves.
    const stops = { count: 0 };
    class HangingClient implements CopilotClientLike {
      constructor(_opts: any) {}
      async createSession(_opts: any): Promise<CopilotSessionLike> {
        return new Promise<CopilotSessionLike>(() => undefined);
      }
      async stop(): Promise<void> {
        stops.count++;
      }
    }
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: HangingClient as new (opts: any) => CopilotClientLike,
      timeoutMs: 25,
      maxRetries: 0,
    });

    const start = Date.now();
    await expect(client.judge(judgeRequest())).rejects.toThrow(/timed out after 25ms/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    // finally must run even though createSession never resolved.
    expect(stops.count).toBe(1);
  });

  it("V2: caller abort during createSession rejects immediately and stops client", async () => {
    const registry = buildTestRegistry();
    const stops = { count: 0 };
    class HangingClient implements CopilotClientLike {
      constructor(_opts: any) {}
      async createSession(_opts: any): Promise<CopilotSessionLike> {
        return new Promise<CopilotSessionLike>(() => undefined);
      }
      async stop(): Promise<void> {
        stops.count++;
      }
    }
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: HangingClient as new (opts: any) => CopilotClientLike,
      timeoutMs: 60_000,
      maxRetries: 3,
    });

    const ctrl = new AbortController();
    const p = client.judge(judgeRequest(), { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 10);
    await expect(p).rejects.toThrow(/aborted by caller/);
    expect(stops.count).toBe(1);
  });

  it("V2: session.send() Promise rejection is caught and classified correctly", async () => {
    const registry = buildTestRegistry();
    const stops = { count: 0 };
    class SendRejectClient implements CopilotClientLike {
      constructor(_opts: any) {}
      async createSession(_opts: any): Promise<CopilotSessionLike> {
        return {
          on: () => undefined,
          send: () => Promise.reject(new Error("network: ECONNRESET")),
        };
      }
      async stop(): Promise<void> {
        stops.count++;
      }
    }
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: SendRejectClient as new (opts: any) => CopilotClientLike,
      timeoutMs: 5_000,
      maxRetries: 0,
    });

    await expect(client.judge(judgeRequest())).rejects.toThrow(/ECONNRESET|network/i);
    expect(stops.count).toBe(1);
  });

  it("V2: retry covers 429 rate-limit errors", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      { sessionError: "429 Too Many Requests — rate limit" },
      { response: '{"reasoning":"x","rawScore":1,"normalizedScore":1,"pass":true}' },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 1,
      baseRetryDelayMs: 0,
    });

    const resp = await client.judge(judgeRequest());
    expect(resp.result.pass).toBe(true);
    expect(fake.createCalls.length).toBe(2);
    expect(fake.stops.count).toBe(2);
  });

  it("V3: session.error carrying schema validation does NOT retry", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      { sessionError: "schema validation failed: rawScore must be a number" },
      { response: '{"reasoning":"x","rawScore":1,"normalizedScore":1,"pass":true}' },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 3,
      baseRetryDelayMs: 0,
    });

    await expect(client.judge(judgeRequest())).rejects.toThrow(/schema validation failed/i);
    // Only ONE attempt — schema-validation flavored session.error is NOT transient.
    expect(fake.createCalls.length).toBe(1);
    expect(fake.stops.count).toBe(1);
  });

  it("V3: session.error carrying generic validation error does NOT retry", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      { sessionError: "validation error: bad request" },
      { response: '{"reasoning":"x","rawScore":1,"normalizedScore":1,"pass":true}' },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 3,
      baseRetryDelayMs: 0,
    });

    await expect(client.judge(judgeRequest())).rejects.toThrow(/validation error/i);
    expect(fake.createCalls.length).toBe(1);
    expect(fake.stops.count).toBe(1);
  });

  it("V3: session.error 'bad request 400' does NOT retry", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      { sessionError: "bad request 400: malformed prompt" },
      { response: '{"reasoning":"x","rawScore":1,"normalizedScore":1,"pass":true}' },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 3,
      baseRetryDelayMs: 0,
    });

    await expect(client.judge(judgeRequest())).rejects.toThrow(/bad request/i);
    expect(fake.createCalls.length).toBe(1);
    expect(fake.stops.count).toBe(1);
  });

  it("V2: stripJsonFences fails CLOSED on embedded fence with surrounding commentary", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      {
        // Leading commentary BEFORE the fence — must NOT be stripped.
        response:
          'Here is the verdict:\n```json\n{"reasoning":"r","rawScore":1,"normalizedScore":1,"pass":true}\n```',
      },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 0,
    });

    await expect(client.judge(judgeRequest())).rejects.toThrow(/not valid JSON/i);
    expect(fake.stops.count).toBe(1);
  });

  it("V2: stripJsonFences fails CLOSED on fence with trailing commentary", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      {
        response:
          '```json\n{"reasoning":"r","rawScore":1,"normalizedScore":1,"pass":true}\n```\nThat\'s my answer.',
      },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 0,
    });

    await expect(client.judge(judgeRequest())).rejects.toThrow(/not valid JSON/i);
    expect(fake.stops.count).toBe(1);
  });

  it("V2: stripJsonFences accepts a clean ```json ... ``` wrapper (whole-text)", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      {
        response:
          '```json\n{"reasoning":"r","rawScore":1,"normalizedScore":1,"pass":true}\n```',
      },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 0,
    });

    const resp = await client.judge(judgeRequest());
    expect(resp.result.pass).toBe(true);
  });

  it("V2: parse-error message does NOT include raw judge output (privacy / log hygiene)", async () => {
    const registry = buildTestRegistry();
    const sensitive = "secret-leaked-token-ABCD-1234-XYZ";
    const fake = makeFakeCtor([{ response: sensitive }]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      maxRetries: 0,
    });

    let caught: Error | undefined;
    try {
      await client.judge(judgeRequest());
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/not valid JSON/i);
    // The sensitive raw output MUST NOT appear in the error message.
    expect(caught!.message).not.toContain(sensitive);
  });

  it("V2: non-github provider passes sdkProvider through to createSession (no githubToken)", async () => {
    // OpenAI provider via env-backed key.
    process.env.PS_FAKE_OPENAI_KEY = "sk-fake";
    const registry = new ModelProviderRegistry({
      providers: [
        {
          id: "openai",
          type: "openai",
          apiKey: "env:PS_FAKE_OPENAI_KEY",
          baseUrl: "https://api.openai.com/v1",
          models: [{ name: "gpt-4o-mini" }],
        },
      ],
      defaultModel: "openai:gpt-4o-mini",
    });
    const fake = makeFakeCtor([
      { response: '{"reasoning":"r","rawScore":1,"normalizedScore":1,"pass":true}' },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "openai:gpt-4o-mini",
      copilotClientCtor: fake.Ctor,
      maxRetries: 0,
    });

    const resp = await client.judge(judgeRequest());
    expect(resp.result.pass).toBe(true);
    // No githubToken should have been passed for non-github providers.
    expect(fake.constructorOpts[0]?.githubToken).toBeUndefined();
    // sdkProvider (resolved from the registry) MUST be passed to createSession.
    const provider = (fake.createCalls[0] as any)?.provider;
    expect(provider).toBeDefined();
    expect(provider?.type ?? provider?.kind ?? provider).toBeTruthy();
    expect((fake.createCalls[0] as any)?.model).toBe("gpt-4o-mini");
  });

  it("V2: estimateCost returns a finite USD estimate when costRates are configured", () => {
    const registry = buildTestRegistry();
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      costRates: {
        inputUsdPerMillionTokens: 1.0,
        outputUsdPerMillionTokens: 4.0,
      },
    });
    const estimate = client.estimateCost(judgeRequest());
    expect(estimate).toBeDefined();
    expect(Number.isFinite(estimate!)).toBe(true);
    expect(estimate!).toBeGreaterThan(0);
  });

  it("V2: estimateCost returns undefined when costRates not configured (matches OpenAIJudgeClient contract)", () => {
    const registry = buildTestRegistry();
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
    });
    const estimate = client.estimateCost(judgeRequest());
    expect(estimate).toBeUndefined();
  });

  it("V2: works through LLMJudgeGrader with budget — returns non-infra scores", async () => {
    const registry = buildTestRegistry();
    const fake = makeFakeCtor([
      {
        response: '{"reasoning":"r","rawScore":0.9,"normalizedScore":0.9,"pass":true}',
        usage: { prompt_tokens: 1000, completion_tokens: 200 },
      },
    ]);
    const client = new PilotSwarmJudgeClient({
      modelProviders: registry,
      model: "gpt-4.1",
      copilotClientCtor: fake.Ctor,
      costRates: {
        inputUsdPerMillionTokens: 1.0,
        outputUsdPerMillionTokens: 4.0,
      },
      maxRetries: 0,
    });

    const grader = new LLMJudgeGrader({
      client,
      rubric: makeRubric(),
      budgetUsd: 1,
    });
    const judged = await grader.grade("ok?", "yes");
    expect(judged.scores.length).toBeGreaterThan(0);
    for (const s of judged.scores) {
      expect(s.infraError === true, `infraError leaked: ${s.reason}`).toBe(false);
    }
    expect(grader.cumulativeCostUsd).toBeGreaterThan(0);
    expect(grader.cumulativeCostUsd).toBeLessThanOrEqual(1 + 1e-9);
  });
});
