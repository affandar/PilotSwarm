/**
 * Unit tests for `makeLiveJudgeClient()` cost-rate env-override contract.
 *
 * G6 V3 audit fix: partial / invalid cost-rate env overrides MUST fail loud.
 * The helper must not silently ignore an operator's override and fall back
 * to baked-in defaults, because that breaks budget enforcement transparency.
 *
 * These tests do NOT require LIVE credentials — they exercise the env
 * resolution path via the helper's public selector. We snapshot/restore
 * env vars per test so the suite is deterministic regardless of the host
 * environment.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeLiveJudgeClient } from "./judge-client-helper.js";

const ENV_KEYS = [
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "PS_MODEL_PROVIDERS_PATH",
  "MODEL_PROVIDERS_PATH",
  "LIVE_JUDGE_MODEL",
  "LIVE_JUDGE_INPUT_USD_PER_M",
  "LIVE_JUDGE_OUTPUT_USD_PER_M",
  "LIVE_JUDGE_CACHED_INPUT_USD_PER_M",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let providersPath: string | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Always start from a clean slate.
  for (const k of ENV_KEYS) delete process.env[k];

  // Write a real fixture file the helper will load.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "ps-judge-helper-"));
  providersPath = path.join(dir, "model-providers.test.json");
  fs.writeFileSync(
    providersPath,
    JSON.stringify({
      providers: [
        {
          id: "github-copilot",
          type: "github",
          githubToken: "env:PS_FAKE_GH_TOKEN",
          models: [
            { name: "gpt-4.1" },
            { name: "gpt-5-mini" }, // model with NO baked-in cost rate
          ],
        },
      ],
      defaultModel: "github-copilot:gpt-4.1",
    }),
  );
  process.env.PS_FAKE_GH_TOKEN = "ghu_fake";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  delete process.env.PS_FAKE_GH_TOKEN;
  if (providersPath) {
    try {
      fs.rmSync(path.dirname(providersPath), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("makeLiveJudgeClient — cost-rate env contract (G6 V3)", () => {
  it("uses baked default cost rates for github-copilot:gpt-4.1 when no env override", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    process.env.LIVE_JUDGE_MODEL = "github-copilot:gpt-4.1";

    const sel = makeLiveJudgeClient();
    expect(sel).toBeTruthy();
    expect(sel!.kind).toBe("pilotswarm");
    expect(sel!.model).toBe("github-copilot:gpt-4.1");
  });

  it("returns null and writes stderr when chosen model has no defaults and no env override", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    process.env.LIVE_JUDGE_MODEL = "github-copilot:gpt-5-mini";

    let stderrText = "";
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const sel = makeLiveJudgeClient();
      expect(sel).toBeNull();
      expect(stderrText).toMatch(/no cost rates available/i);
      expect(stderrText).toContain("LIVE_JUDGE_INPUT_USD_PER_M");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("accepts a complete env override (input + output) and validates rates", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    process.env.LIVE_JUDGE_MODEL = "github-copilot:gpt-5-mini";
    process.env.LIVE_JUDGE_INPUT_USD_PER_M = "2.5";
    process.env.LIVE_JUDGE_OUTPUT_USD_PER_M = "10.0";

    const sel = makeLiveJudgeClient();
    expect(sel).toBeTruthy();
    expect(sel!.kind).toBe("pilotswarm");
  });

  it("accepts a complete env override with cached", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    process.env.LIVE_JUDGE_MODEL = "github-copilot:gpt-5-mini";
    process.env.LIVE_JUDGE_INPUT_USD_PER_M = "1.0";
    process.env.LIVE_JUDGE_OUTPUT_USD_PER_M = "4.0";
    process.env.LIVE_JUDGE_CACHED_INPUT_USD_PER_M = "0.25";

    const sel = makeLiveJudgeClient();
    expect(sel).toBeTruthy();
  });

  it("FAILS LOUD on partial env override — output missing", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    process.env.LIVE_JUDGE_INPUT_USD_PER_M = "1.0";

    expect(() => makeLiveJudgeClient()).toThrow(/partial cost-rate env override/i);
  });

  it("FAILS LOUD on partial env override — input missing", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    process.env.LIVE_JUDGE_OUTPUT_USD_PER_M = "4.0";

    expect(() => makeLiveJudgeClient()).toThrow(/partial cost-rate env override/i);
  });

  it("FAILS LOUD on partial env override — only cached set", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    process.env.LIVE_JUDGE_CACHED_INPUT_USD_PER_M = "0.5";

    expect(() => makeLiveJudgeClient()).toThrow(/partial cost-rate env override/i);
  });

  it("FAILS LOUD on invalid input rate (NaN)", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    process.env.LIVE_JUDGE_INPUT_USD_PER_M = "not-a-number";
    process.env.LIVE_JUDGE_OUTPUT_USD_PER_M = "4.0";

    expect(() => makeLiveJudgeClient()).toThrow(
      /LIVE_JUDGE_INPUT_USD_PER_M must be a non-negative finite number/i,
    );
  });

  it("FAILS LOUD on negative output rate", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    process.env.LIVE_JUDGE_INPUT_USD_PER_M = "1.0";
    process.env.LIVE_JUDGE_OUTPUT_USD_PER_M = "-2.0";

    expect(() => makeLiveJudgeClient()).toThrow(
      /LIVE_JUDGE_OUTPUT_USD_PER_M must be a non-negative finite number/i,
    );
  });

  it("FAILS LOUD on invalid cached rate (rejects, does NOT silently drop)", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    process.env.LIVE_JUDGE_INPUT_USD_PER_M = "1.0";
    process.env.LIVE_JUDGE_OUTPUT_USD_PER_M = "4.0";
    process.env.LIVE_JUDGE_CACHED_INPUT_USD_PER_M = "garbage";

    expect(() => makeLiveJudgeClient()).toThrow(
      /LIVE_JUDGE_CACHED_INPUT_USD_PER_M must be a non-negative finite number/i,
    );
  });

  it("env override takes priority even when chosen model has baked defaults", () => {
    // gpt-4.1 has baked defaults; env override should still win.
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;
    process.env.LIVE_JUDGE_MODEL = "github-copilot:gpt-4.1";
    process.env.LIVE_JUDGE_INPUT_USD_PER_M = "99.0";
    process.env.LIVE_JUDGE_OUTPUT_USD_PER_M = "199.0";

    const sel = makeLiveJudgeClient();
    expect(sel).toBeTruthy();
    expect(sel!.kind).toBe("pilotswarm");
  });

  it("returns null when no credentials available", () => {
    // Neither OPENAI_API_KEY nor GITHUB_TOKEN.
    const sel = makeLiveJudgeClient();
    expect(sel).toBeNull();
  });

  it("returns null when GITHUB_TOKEN set but no providers path", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    // No PS_MODEL_PROVIDERS_PATH.
    const sel = makeLiveJudgeClient();
    expect(sel).toBeNull();
  });

  it("returns null when GITHUB_TOKEN set but providers path doesn't exist", () => {
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = "/nonexistent/path/to/providers.json";
    const sel = makeLiveJudgeClient();
    expect(sel).toBeNull();
  });

  it("OPENAI_API_KEY takes precedence over GITHUB_TOKEN (strict, no fallback)", () => {
    process.env.OPENAI_API_KEY = "sk-fake";
    process.env.GITHUB_TOKEN = "ghu_fake";
    process.env.PS_MODEL_PROVIDERS_PATH = providersPath;

    const sel = makeLiveJudgeClient();
    expect(sel).toBeTruthy();
    expect(sel!.kind).toBe("openai");
  });
});
