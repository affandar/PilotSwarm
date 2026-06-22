import type { Check, CheckResult, ObservedResult, RunConfig, Scenario } from "../types.js";
import { refundLlmJudgeBudget, reserveLlmJudgeBudget } from "../engine/cost-budget.js";
import { redactForArtifact } from "../reporters/output.js";

type LlmJudgeCheck = Extract<Check, { type: "llm-judge" }>;
type JudgeVerdict = "PASSED" | "PARTIAL" | "FAILED";
type JudgeConfidence = "HIGH" | "MEDIUM" | "LOW";

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_COPILOT_MODEL = "gpt-5.4";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;
const LAYERING_INSTRUCTION = "Run-level and scenario-level instructions add constraints; they do not replace the fixed PilotSwarm context.";
const MAX_JUDGE_TEXT_CHARS = 4_000;
const MAX_JUDGE_ARRAY_ITEMS = 80;
let warnedNonDefaultOpenAiBaseUrl = false;

export async function evaluateLlmJudge(args: {
  scenario: Scenario;
  observed: ObservedResult;
  config: LlmJudgeCheck;
  runConfig?: Partial<RunConfig>;
}): Promise<CheckResult> {
  const enabled = args.runConfig?.llmJudge?.enabled ?? false;
  const required = args.scenario.llmJudgeRequired;
  if (!enabled) {
    return {
      pass: false,
      errored: true,
      message: `LLM judge check for ${args.scenario.id} requires provider-backed judging, but run config llmJudge.enabled is false.`,
      metadata: { judge: { required, enabled: false } },
    };
  }

  const provider = judgeProvider(args.runConfig);
  if (!provider) {
    const message = "LLM judge requested but no judge provider is configured. Set OPENAI_API_KEY or GITHUB_TOKEN.";
    if (required || args.runConfig?.llmJudge?.onMissingProvider === "error") {
      return { pass: false, errored: true, message };
    }
    return { pass: true, skipped: true, message };
  }

  const budgetError = reserveJudgeBudget(args.config, args.runConfig);
  if (budgetError) return budgetError;

  if (provider === "openai") return withProviderBudgetRefund(args, () => evaluateOpenAiJudge(args));
  if (provider === "copilot" || provider === "github" || provider === "github-copilot") {
    return withProviderBudgetRefund(args, () => evaluateCopilotJudge(args));
  }

  refundReservedJudgeBudget(args.config, args.runConfig);
  return {
    pass: false,
    errored: true,
    message: `Unknown LLM judge provider "${provider}". Use "openai" or "copilot".`,
  };
}

async function withProviderBudgetRefund(args: {
  config: LlmJudgeCheck;
  runConfig?: Partial<RunConfig>;
}, call: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    const result = await call();
    if (result.errored) refundReservedJudgeBudget(args.config, args.runConfig);
    return result;
  } catch (error) {
    refundReservedJudgeBudget(args.config, args.runConfig);
    throw error;
  }
}

function refundReservedJudgeBudget(config: LlmJudgeCheck, runConfig?: Partial<RunConfig>): void {
  refundLlmJudgeBudget(runConfig, config.budgetUsd ?? 0);
}

function reserveJudgeBudget(config: LlmJudgeCheck, runConfig?: Partial<RunConfig>): CheckResult | undefined {
  const budgetUsd = config.budgetUsd;
  const budgetConfigured = runConfig?.budgets?.maxUsd != null || runConfig?.llmJudge?.totalBudgetUsd != null;
  if (budgetConfigured && budgetUsd == null) {
    return {
      pass: false,
      errored: true,
      message: "LLM judge budgetUsd is required when run-level budget guardrails are configured.",
      metadata: {
        judge: {
          budgetRequired: true,
          runBudgetUsd: runConfig?.budgets?.maxUsd,
          llmJudgeBudgetUsd: runConfig?.llmJudge?.totalBudgetUsd,
        },
      },
    };
  }
  const error = reserveLlmJudgeBudget(runConfig, budgetUsd ?? 0);
  if (!error) return undefined;
  return {
    pass: false,
    errored: true,
    message: error,
    metadata: {
      judge: {
        budgetUsd,
        runBudgetUsd: runConfig?.budgets?.maxUsd,
        llmJudgeBudgetUsd: runConfig?.llmJudge?.totalBudgetUsd,
      },
    },
  };
}

async function evaluateOpenAiJudge(args: {
  scenario: Scenario;
  observed: ObservedResult;
  config: LlmJudgeCheck;
  runConfig?: Partial<RunConfig>;
}): Promise<CheckResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { pass: false, errored: true, message: "OPENAI_API_KEY is required for OpenAI LLM judge." };

  const model = judgeModel(args.config, args.runConfig, process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL);
  const baseUrl = (process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  if (baseUrl !== DEFAULT_OPENAI_BASE_URL && !warnedNonDefaultOpenAiBaseUrl) {
    warnedNonDefaultOpenAiBaseUrl = true;
    console.warn(`[eval-harness] OPENAI_BASE_URL is set to "${baseUrl}". OPENAI_API_KEY will be transmitted to this endpoint. Confirm it is a trusted proxy or Azure OpenAI deployment.`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), judgeTimeoutMs());

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "eval_judge_verdict",
            strict: true,
            schema: judgeJsonSchema(),
          },
        },
        messages: judgeMessages(args),
        ...(args.config.maxOutputTokens ? { max_completion_tokens: args.config.maxOutputTokens } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        pass: false,
        errored: true,
        message: `OpenAI LLM judge failed with HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
        metadata: { judgeProvider: "openai", judgeModel: model },
      };
    }

    const json = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    return judgeResponseToCheckResult(json.choices?.[0]?.message?.content, args.config, {
      judgeProvider: "openai",
      judgeModel: model,
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens,
    });
  } catch (error) {
    return {
      pass: false,
      errored: true,
      message: `OpenAI LLM judge failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { judgeProvider: "openai", judgeModel: model },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function evaluateCopilotJudge(args: {
  scenario: Scenario;
  observed: ObservedResult;
  config: LlmJudgeCheck;
  runConfig?: Partial<RunConfig>;
}): Promise<CheckResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { pass: false, errored: true, message: "GITHUB_TOKEN is required for Copilot LLM judge." };

  const model = stripProviderPrefix(judgeModel(args.config, args.runConfig, process.env.PILOTSWARM_EVAL_JUDGE_MODEL ?? DEFAULT_COPILOT_MODEL));
  let client: { start?: () => Promise<void>; stop?: () => Promise<unknown>; createSession: (config?: unknown) => Promise<unknown> } | undefined;
  try {
    const { CopilotClient, approveAll } = await import("@github/copilot-sdk");
    client = new CopilotClient({ gitHubToken: token, logLevel: "error" }) as typeof client;
    await client?.start?.();
    const messages = judgeMessages(args);
    const session = await client!.createSession({
      model,
      onPermissionRequest: approveAll,
      systemMessage: { mode: "replace", content: messages[0]!.content },
    }) as {
      sendAndWait?: (options: unknown, timeout?: number) => Promise<unknown>;
      send?: (options: unknown) => Promise<unknown>;
    };
    let content = "";
    if (typeof session.sendAndWait === "function") {
      const event = await session.sendAndWait({ prompt: messages[1]!.content }, judgeTimeoutMs());
      content = extractText(event);
    } else if (typeof session.send === "function") {
      const result = await session.send({ prompt: messages[1]!.content });
      content = extractText(result);
    } else {
      throw new Error("Copilot SDK session does not expose sendAndWait or send.");
    }
    return judgeResponseToCheckResult(content, args.config, { judgeProvider: "copilot", judgeModel: model });
  } catch (error) {
    return {
      pass: false,
      errored: true,
      message: `Copilot LLM judge failed: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { judgeProvider: "copilot", judgeModel: model },
    };
  } finally {
    await client?.stop?.();
  }
}

function judgeProvider(runConfig?: Partial<RunConfig>): string | undefined {
  const configured = runConfig?.llmJudge?.provider?.trim().toLowerCase();
  if (configured) return configured;
  const explicit = process.env.PILOTSWARM_EVAL_LLM_JUDGE_PROVIDER?.trim().toLowerCase();
  if (explicit) return explicit;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GITHUB_TOKEN) return "copilot";
  return undefined;
}

function judgeModel(config: LlmJudgeCheck, runConfig: Partial<RunConfig> | undefined, fallback: string): string {
  return config.judgeModel ?? runConfig?.llmJudge?.judgeModel ?? process.env.PILOTSWARM_EVAL_JUDGE_MODEL ?? fallback;
}

function judgeTimeoutMs(): number {
  return DEFAULT_JUDGE_TIMEOUT_MS;
}

export function __testBuildJudgePrompts(args: {
  scenario: Scenario;
  observed: ObservedResult;
  config: LlmJudgeCheck;
  runConfig?: Partial<RunConfig>;
}): Array<{ role: "system" | "user"; content: string }> {
  return judgeMessages(args);
}

function judgeMessages(args: {
  scenario: Scenario;
  observed: ObservedResult;
  config: LlmJudgeCheck;
  runConfig?: Partial<RunConfig>;
}): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: judgeSystemPrompt() },
    { role: "user", content: judgeUserPrompt(args) },
  ];
}

function judgeSystemPrompt(): string {
  return [
    "You are the PilotSwarm eval judge for a durable execution runtime.",
    "PilotSwarm separates clients/workers: clients create sessions, send prompts, and observe events; workers execute LLM turns, tools, sub-agents, waits, hydration/dehydration, and recovery.",
    "Use CMS/session events and CMS/session event logs as primary evidence for durable execution behavior, including session lifecycle, tool calls, sub-agent activity, waits, dehydration, hydration, and completion.",
    "A pass means the observed final response and durable evidence satisfy the scenario rubric without contradicting CMS/session events, terminal state, tool results, or run metadata.",
    "Return only JSON matching this evidence-first shape:",
    "{\"reason\": string, \"evidence\": string[], \"issues\": string[], \"verdict\": \"PASSED\" | \"PARTIAL\" | \"FAILED\", \"confidence\": \"HIGH\" | \"MEDIUM\" | \"LOW\"}.",
    "Write reason, evidence, and issues before choosing verdict and confidence.",
    "Use PASSED only when the rubric is fully satisfied, PARTIAL when the result is ambiguous or materially incomplete, and FAILED when it violates or misses the rubric.",
    "PARTIAL fails the production gate. Do not produce numeric scores.",
    "Do not include markdown, prose, or extra keys.",
  ].join(" ");
}

function judgeUserPrompt(args: {
  scenario: Scenario;
  observed: ObservedResult;
  config: LlmJudgeCheck;
  runConfig?: Partial<RunConfig>;
}): string {
  const { scenario, observed, config, runConfig } = args;
  return [
    LAYERING_INSTRUCTION,
    "",
    "Run-level judge policy:",
    runConfig?.llmJudge?.prompt?.trim() || "(none)",
    "",
    "Scenario-level judge rubric:",
    config.rubric,
    "",
    "Observed evidence:",
    JSON.stringify(judgeEvidence({ scenario, observed, runConfig }), null, 2),
    "",
    [
      "Evaluate the observed trace against the fixed PilotSwarm context, run-level policy, and scenario rubric.",
      "First write the evidence-based reason, then concrete evidence, then issues.",
      "Only after that choose verdict and confidence.",
      "Do not emit a numeric score.",
    ].join(" "),
  ].join("\n");
}

function judgeEvidence(args: {
  scenario: Scenario;
  observed: ObservedResult;
  runConfig?: Partial<RunConfig>;
}): Record<string, unknown> {
  const { scenario, observed, runConfig } = args;
  const cmsEventTypes = observed.cmsEvents.map((event) => event.type);
  return sanitizeJudgeEvidence({
    scenario: {
      id: scenario.id,
      kind: scenario.kind,
      description: scenario.description,
      prompts: scenarioPrompts(scenario),
    },
    finalResponse: observed.finalResponse,
    toolCalls: observed.toolCalls,
    terminalState: observed.terminalState,
    cmsEvents: observed.cmsEvents,
    cmsEventTypes,
    cmsEventCounts: eventCounts(cmsEventTypes),
    runMetadata: {
      runId: runConfig?.id,
      runDescription: runConfig?.description,
      observedMetadata: observed.metadata,
      latencyMs: observed.latencyMs,
      costUsd: observed.costUsd ?? "unmeasured",
      tokensIn: observed.tokensIn ?? "unmeasured",
      tokensOut: observed.tokensOut ?? "unmeasured",
      errored: observed.errored,
    },
  }) as Record<string, unknown>;
}

function scenarioPrompts(scenario: Scenario): string[] {
  return "turns" in scenario
    ? scenario.turns.map((turn) => turn.input.prompt)
    : [scenario.input.prompt];
}

function sanitizeJudgeEvidence(value: unknown): unknown {
  return sanitizeJudgeValue(redactForArtifact(value));
}

function sanitizeJudgeValue(value: unknown): unknown {
  if (typeof value === "string") return safeJudgeText(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_JUDGE_ARRAY_ITEMS).map((item) => sanitizeJudgeValue(item));
    return value.length > MAX_JUDGE_ARRAY_ITEMS
      ? [...items, { truncatedItems: value.length - MAX_JUDGE_ARRAY_ITEMS }]
      : items;
  }
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) output[key] = sanitizeJudgeValue(child);
  return output;
}

function safeJudgeText(value: string, maxChars = MAX_JUDGE_TEXT_CHARS): string {
  const text = redactSensitiveText(String(value));
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3))}...` : text;
}

function redactSensitiveText(text: string): string {
  let redacted = text
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted]")
    .replace(/(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,}/gi, "[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]");

  for (const secret of configuredSecretValues()) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function configuredSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => (
      typeof value === "string"
      && value.length >= 8
      && /(token|secret|password|api_?key|credential|connection_?string|database_?url|pgconnstring|postgres_?url|db_?url|dsn)/i.test(key)
    ))
    .map(([, value]) => value!);
}

function eventCounts(types: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of types) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

function judgeJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      reason: {
        type: "string",
        description: "Two to five concise sentences explaining the evaluation using the observed response, tool calls, and CMS events.",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        description: "Concrete observed facts that support the verdict.",
      },
      issues: {
        type: "array",
        items: { type: "string" },
        description: "Concrete missing, ambiguous, or incorrect behavior. Empty when there are no issues.",
      },
      verdict: { type: "string", enum: ["PASSED", "PARTIAL", "FAILED"] },
      confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
    },
    required: ["reason", "evidence", "issues", "verdict", "confidence"],
  };
}

function judgeResponseToCheckResult(content: string | undefined, config: LlmJudgeCheck, metadata: Record<string, unknown>): CheckResult {
  if (!content) {
    return { pass: false, errored: true, message: "LLM judge returned no content.", metadata };
  }
  const parsed = parseJudgeJson(content);
  if (!parsed) {
    return { pass: false, errored: true, message: `LLM judge returned invalid JSON: ${content.slice(0, 300)}`, metadata };
  }
  const reason = typeof parsed.reason === "string" ? parsed.reason : "LLM judge completed.";
  const verdict = normalizeVerdict(parsed.verdict);
  const confidence = normalizeConfidence(parsed.confidence);
  const evidence = stringArray(parsed.evidence);
  const issues = stringArray(parsed.issues);
  if (!verdict) {
    return { pass: false, errored: true, message: `LLM judge returned invalid verdict: ${String(parsed.verdict)}`, metadata };
  }
  if (!confidence) {
    return { pass: false, errored: true, message: `LLM judge returned invalid confidence: ${String(parsed.confidence)}`, metadata };
  }
  return {
    pass: verdict === "PASSED",
    verdict,
    confidence,
    message: judgeMessage(verdict, confidence, reason),
    metadata: {
      ...metadata,
      judge: {
        provider: metadata.judgeProvider,
        model: metadata.judgeModel,
        verdict,
        confidence,
        reason,
        evidence,
        issues,
        promptTokens: metadata.promptTokens,
        completionTokens: metadata.completionTokens,
        totalTokens: metadata.totalTokens,
        ...(typeof config.budgetUsd === "number"
          ? { budgetUsd: config.budgetUsd, reservedCostUsd: config.budgetUsd }
          : {}),
      },
    },
  };
}

function judgeMessage(verdict: JudgeVerdict, confidence: JudgeConfidence, reason: string): string {
  return `LLM judge ${verdict} (${confidence}): ${reason}`;
}

function normalizeVerdict(value: unknown): JudgeVerdict | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "PASSED" || normalized === "PASS") return "PASSED";
  if (normalized === "PARTIAL" || normalized === "PARTIALLY") return "PARTIAL";
  if (normalized === "FAILED" || normalized === "FAIL") return "FAILED";
  return undefined;
}

function normalizeConfidence(value: unknown): JudgeConfidence | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "HIGH" || normalized === "MEDIUM" || normalized === "LOW") return normalized;
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseJudgeJson(content: string): Record<string, unknown> | undefined {
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(withoutFence);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    const match = /\{[\s\S]*\}/.exec(withoutFence);
    if (!match) return undefined;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const data = (value as { data?: { content?: unknown; deltaContent?: unknown }; content?: unknown }).data;
    if (typeof data?.content === "string") return data.content;
    if (typeof data?.deltaContent === "string") return data.deltaContent;
    if (typeof (value as { content?: unknown }).content === "string") return (value as { content: string }).content;
  }
  return String(value ?? "");
}

function stripProviderPrefix(model: string): string {
  return model.includes(":") ? model.split(":").slice(1).join(":") : model;
}
