import { describe, it, expect } from "vitest";
import { OpenAIJudgeClient } from "../src/graders/openai-judge-client.js";
import type { JudgeRequest } from "../src/graders/judge-types.js";

type OpenAIJudgeClientOptionsFetch = NonNullable<
  ConstructorParameters<typeof OpenAIJudgeClient>[0]["fetch"]
>;

const baseOptions = {
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
  model: "judge-model",
  fetch: (async () => {
    throw new Error("not used");
  }) as unknown as OpenAIJudgeClientOptionsFetch,
};

describe("F12 — OpenAIJudgeClient costRates validation", () => {
  it("rejects negative input/output/cached rates and non-finite values", () => {
    expect(
      () => new OpenAIJudgeClient({ ...baseOptions, costRates: { inputUsdPerMillionTokens: -10, outputUsdPerMillionTokens: 5 } }),
    ).toThrow(/inputUsdPerMillionTokens/);
    expect(
      () => new OpenAIJudgeClient({ ...baseOptions, costRates: { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: -1 } }),
    ).toThrow(/outputUsdPerMillionTokens/);
    expect(
      () => new OpenAIJudgeClient({ ...baseOptions, costRates: { inputUsdPerMillionTokens: NaN, outputUsdPerMillionTokens: 5 } }),
    ).toThrow(/inputUsdPerMillionTokens/);
    expect(
      () =>
        new OpenAIJudgeClient({
          ...baseOptions,
          costRates: { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: Number.POSITIVE_INFINITY },
        }),
    ).toThrow(/outputUsdPerMillionTokens/);
    expect(
      () =>
        new OpenAIJudgeClient({
          ...baseOptions,
          costRates: { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 10, cachedInputUsdPerMillionTokens: -1 },
        }),
    ).toThrow(/cachedInputUsdPerMillionTokens/);
  });

  it("accepts valid non-negative finite rates and produces non-negative cost estimates", () => {
    const client = new OpenAIJudgeClient({
      ...baseOptions,
      costRates: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
    });
    const req: JudgeRequest = {
      prompt: "hello",
      response: "world",
      criterion: { id: "c", description: "d", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
    };
    const cost = client.estimateCost(req, { completionTokens: 100 });
    expect(cost).toBeDefined();
    expect(cost!).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(cost!)).toBe(true);
  });

  it("accepts zero rates (free tier) without throwing", () => {
    expect(
      () =>
        new OpenAIJudgeClient({
          ...baseOptions,
          costRates: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
        }),
    ).not.toThrow();
  });
});

describe("F12 — Retry-After negative header is ignored (regression lock)", () => {
  it("falls back to exponential backoff when Retry-After is negative", async () => {
    let attempts = 0;
    const sleepSpyDelays: number[] = [];

    const fakeFetch = (async (_url: string, _init: RequestInit) => {
      attempts++;
      if (attempts === 1) {
        return {
          ok: false,
          status: 429,
          headers: {
            get(name: string) {
              if (name.toLowerCase() === "retry-after") return "-5";
              return null;
            },
          },
          text: async () => "rate limited",
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "",
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  reasoning: "ok",
                  rawScore: 5,
                  normalizedScore: 1,
                  pass: true,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    }) as unknown as OpenAIJudgeClientOptionsFetch;

    const client = new OpenAIJudgeClient({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      fetch: fakeFetch,
      maxRetries: 2,
      baseRetryDelayMs: 1,
      retryDelayMaxMs: 50,
      timeoutMs: 1_000,
    });

    const proto = Object.getPrototypeOf(client) as {
      abortableSleep: (this: unknown, ms: number, signal?: AbortSignal) => Promise<void>;
    };
    const originalSleep = proto.abortableSleep;
    proto.abortableSleep = function patched(this: unknown, ms: number, signal?: AbortSignal): Promise<void> {
      sleepSpyDelays.push(ms);
      return originalSleep.call(this, 0, signal) as Promise<void>;
    };
    try {
      const resp = await client.judge({
        prompt: "p",
        response: "r",
        criterion: { id: "c", description: "d", scale: { min: 1, max: 5 }, passThreshold: 0.5 },
      });
      expect(resp.result.normalizedScore).toBe(1);
    } finally {
      proto.abortableSleep = originalSleep;
    }

    expect(attempts).toBe(2);
    expect(sleepSpyDelays.length).toBe(1);
    expect(sleepSpyDelays[0]).toBeGreaterThanOrEqual(0);
    expect(sleepSpyDelays[0]).toBeLessThanOrEqual(50);
  });
});
