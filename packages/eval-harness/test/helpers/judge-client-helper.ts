/**
 * Shared helper for live-judge tests — builds a JudgeClient honoring the
 * environment.
 *
 *  1. If `OPENAI_API_KEY` is set, prefer `OpenAIJudgeClient` (talks directly
 *     to the OpenAI public API or an OpenAI-compatible base URL).
 *
 *  2. Else if `GITHUB_TOKEN` is set AND a model providers config is available
 *     (`PS_MODEL_PROVIDERS_PATH` env var, or the harness's vitest config has
 *     pointed it at the SDK test fixture), build a `ModelProviderRegistry`
 *     and route the judge through PilotSwarm's provider matrix via
 *     `PilotSwarmJudgeClient`.
 *
 *  3. Otherwise return `null` so the caller can skip the test cleanly.
 *
 * Tests must still be gated by `LIVE=1 LIVE_JUDGE=1`. This helper only
 * decides *which* client to construct — it does NOT decide whether the
 * judge tests should run.
 *
 * G6 V2: cost rates contract.
 *
 * `LLMJudgeGrader` returns `infraError` when a budget is set and the judge
 * cost is `undefined`, so the registry-routed judge MUST carry costRates
 * to be usable under any budgeted live test. Costs come from one of:
 *
 *  - Explicit env: `LIVE_JUDGE_INPUT_USD_PER_M`, `LIVE_JUDGE_OUTPUT_USD_PER_M`,
 *    `LIVE_JUDGE_CACHED_INPUT_USD_PER_M` (optional, defaults to 0.5×input).
 *  - Fallback defaults: per-model rates baked in for the known fallback
 *    models (`github-copilot:gpt-4.1`, `gpt-4.1`). Other models require the
 *    explicit env vars or the helper returns null with a stderr explainer
 *    so the test fails loudly rather than silently producing infraError.
 *
 * This makes the live-judge fallback usable in the default PilotSwarm dev
 * environment (only `GITHUB_TOKEN` set), which is the whole point of the
 * registry-routed judge.
 */

import fs from "node:fs";
import { ModelProviderRegistry } from "pilotswarm-sdk";
import type { JudgeClient } from "../../src/graders/judge-types.js";
import { OpenAIJudgeClient } from "../../src/graders/openai-judge-client.js";
import {
  PilotSwarmJudgeClient,
  type PilotSwarmJudgeCostRates,
} from "../../src/graders/pilotswarm-judge-client.js";

export interface JudgeClientSelection {
  client: JudgeClient;
  /** Either "openai" (direct API) or "pilotswarm" (registry-routed). */
  kind: "openai" | "pilotswarm";
  /** The model name used by the constructed client. */
  model: string;
}

/**
 * Default cost rates for known fallback models. These are conservative
 * approximations; production deployments can override via env vars.
 * Source: GitHub Copilot pricing for chat completions (subject to change).
 */
const KNOWN_MODEL_COST_RATES: Record<string, PilotSwarmJudgeCostRates> = {
  "github-copilot:gpt-4.1": {
    inputUsdPerMillionTokens: 1.0,
    outputUsdPerMillionTokens: 4.0,
    cachedInputUsdPerMillionTokens: 0.5,
  },
  "github-copilot:gpt-4.1-mini": {
    inputUsdPerMillionTokens: 0.4,
    outputUsdPerMillionTokens: 1.6,
    cachedInputUsdPerMillionTokens: 0.2,
  },
  "github-copilot:gpt-4o": {
    inputUsdPerMillionTokens: 2.5,
    outputUsdPerMillionTokens: 10.0,
    cachedInputUsdPerMillionTokens: 1.25,
  },
  "github-copilot:gpt-4o-mini": {
    inputUsdPerMillionTokens: 0.15,
    outputUsdPerMillionTokens: 0.6,
    cachedInputUsdPerMillionTokens: 0.075,
  },
};

function resolveCostRates(model: string): PilotSwarmJudgeCostRates | null {
  // G6 V3 fix: the env-override contract is now strict.
  //
  // If ANY of the three LIVE_JUDGE_*_USD_PER_M env vars is set, env-override
  // mode is active. In that mode we REQUIRE both input and output to be
  // present and finite, and we VALIDATE cached if present. Partial or
  // invalid env overrides fail LOUD instead of silently falling back to
  // baked defaults — operators must not be surprised by their override
  // being ignored.
  const envInputRaw = process.env.LIVE_JUDGE_INPUT_USD_PER_M;
  const envOutputRaw = process.env.LIVE_JUDGE_OUTPUT_USD_PER_M;
  const envCachedRaw = process.env.LIVE_JUDGE_CACHED_INPUT_USD_PER_M;
  const envOverrideActive =
    envInputRaw !== undefined || envOutputRaw !== undefined || envCachedRaw !== undefined;

  if (envOverrideActive) {
    if (envInputRaw === undefined || envOutputRaw === undefined) {
      throw new Error(
        `makeLiveJudgeClient: partial cost-rate env override detected. ` +
          `When any of LIVE_JUDGE_{INPUT,OUTPUT,CACHED_INPUT}_USD_PER_M is set, ` +
          `BOTH LIVE_JUDGE_INPUT_USD_PER_M and LIVE_JUDGE_OUTPUT_USD_PER_M must be set ` +
          `(got input=${JSON.stringify(envInputRaw)}, output=${JSON.stringify(envOutputRaw)}).`,
      );
    }
    const input = Number(envInputRaw);
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(
        `makeLiveJudgeClient: LIVE_JUDGE_INPUT_USD_PER_M must be a non-negative finite number ` +
          `(got ${JSON.stringify(envInputRaw)}).`,
      );
    }
    const output = Number(envOutputRaw);
    if (!Number.isFinite(output) || output < 0) {
      throw new Error(
        `makeLiveJudgeClient: LIVE_JUDGE_OUTPUT_USD_PER_M must be a non-negative finite number ` +
          `(got ${JSON.stringify(envOutputRaw)}).`,
      );
    }
    const result: PilotSwarmJudgeCostRates = {
      inputUsdPerMillionTokens: input,
      outputUsdPerMillionTokens: output,
    };
    if (envCachedRaw !== undefined) {
      const cached = Number(envCachedRaw);
      if (!Number.isFinite(cached) || cached < 0) {
        throw new Error(
          `makeLiveJudgeClient: LIVE_JUDGE_CACHED_INPUT_USD_PER_M must be a non-negative finite number ` +
            `(got ${JSON.stringify(envCachedRaw)}).`,
        );
      }
      result.cachedInputUsdPerMillionTokens = cached;
    }
    return result;
  }

  // Per-model defaults — qualified-name lookup first, then bare-name fallback.
  if (KNOWN_MODEL_COST_RATES[model]) return KNOWN_MODEL_COST_RATES[model];
  const qualified = `github-copilot:${model}`;
  if (KNOWN_MODEL_COST_RATES[qualified]) return KNOWN_MODEL_COST_RATES[qualified];
  return null;
}

export function makeLiveJudgeClient(): JudgeClientSelection | null {
  const openaiKey = process.env.OPENAI_API_KEY;
  const liveJudgeModel = process.env.LIVE_JUDGE_MODEL;

  if (openaiKey) {
    const model = liveJudgeModel ?? "gpt-4o-mini";
    return {
      client: new OpenAIJudgeClient({
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: openaiKey,
        model,
      }),
      kind: "openai",
      model,
    };
  }

  if (process.env.GITHUB_TOKEN) {
    const path = process.env.PS_MODEL_PROVIDERS_PATH ?? process.env.MODEL_PROVIDERS_PATH;
    if (!path || !fs.existsSync(path)) return null;
    const providersJson = JSON.parse(fs.readFileSync(path, "utf8"));
    const registry = new ModelProviderRegistry(providersJson);

    // Prefer caller-specified model; fall back to a known-good github-copilot
    // model; final fallback is the registry default.
    const candidates = [
      liveJudgeModel,
      "github-copilot:gpt-4.1",
      "gpt-4.1",
      registry.defaultModel,
    ].filter((m): m is string => typeof m === "string" && m.length > 0);
    const chosen = candidates.find((m) => registry.hasModel(m));
    if (!chosen) return null;

    // G6 V2 fix #2: registry-routed judge must carry costRates so budgeted
    // live tests don't trip LLMJudgeGrader's "cost unknown" infraError path.
    const costRates = resolveCostRates(chosen);
    if (!costRates) {
      process.stderr.write(
        `makeLiveJudgeClient: no cost rates available for model "${chosen}". ` +
          `Set LIVE_JUDGE_INPUT_USD_PER_M and LIVE_JUDGE_OUTPUT_USD_PER_M env vars, ` +
          `or use a model with baked-in defaults (github-copilot:gpt-4.1, gpt-4o-mini).\n`,
      );
      return null;
    }

    return {
      client: new PilotSwarmJudgeClient({
        modelProviders: registry,
        model: chosen,
        costRates,
      }),
      kind: "pilotswarm",
      model: chosen,
    };
  }

  return null;
}
