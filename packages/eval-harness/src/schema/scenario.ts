import { z } from "zod";
import { CheckSchema } from "./check-types.js";

export const SchemaVersion = z.literal(1);

export const ScenarioRunsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  maxCells: z.number().int().positive().optional()
}).strict();

export const ScenarioRequirementsSchema = z.object({
  live: z.boolean().default(false),
  isolation: z.enum(["fresh-worker"]).optional()
}).strict().partial();

export const SystemMessageSchema = z.object({
  mode: z.enum(["append", "replace"]),
  content: z.string().min(1)
}).strict();

export const MutationSpecSchema = z.object({
  mutator: z.enum(["minimize", "remove-section"]),
  config: z.record(z.string(), z.unknown()).optional()
}).strict();

export const PromptOverrideEntrySchema = z.object({
  source: z.string().min(1).optional(),
  inline: z.string().min(1).optional(),
  mutation: MutationSpecSchema.optional(),
  frontmatter: z.object({
    description: z.string().optional(),
    tools: z.array(z.string()).optional()
  }).strict().optional()
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.source) === Boolean(value.inline)) {
    ctx.addIssue({ code: "custom", message: "Exactly one of source or inline is required" });
  }
});

export const PromptOverridesSchema = z.record(z.string(), PromptOverrideEntrySchema);

export const PostRunSchema = z.object({
  trajectorySummary: z.object({
    rubric: z.string().min(1)
  }).strict().optional()
}).strict();

export const ChaosSchema = z.object({
  injectAt: z.string().min(1),
  type: z.enum(["worker-restart", "worker-crash", "child-crash", "tool-timeout", "dehydrate-now"]),
  params: z.record(z.string(), z.unknown()).optional(),
  onTargetMissing: z.enum(["error", "skip", "best-effort"]).default("error")
}).strict();

const BaseScenarioSchema = z.object({
  schemaVersion: SchemaVersion,
  kind: z.string(),
  id: z.string().min(1),
  description: z.string().min(1),
  agent: z.string().min(1).default("default"),
  tools: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
  checks: z.array(CheckSchema).default([]),
  postRun: PostRunSchema.optional(),
  chaos: ChaosSchema.optional(),
  runs: ScenarioRunsSchema.optional(),
  requirements: ScenarioRequirementsSchema.default({}),
  llmJudgeRequired: z.boolean().default(false),
  systemMessage: SystemMessageSchema.optional(),
  promptOverrides: PromptOverridesSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const InputPromptSchema = z.object({ prompt: z.string().min(1) }).strict();

export const TurnSchema = z.object({
  input: InputPromptSchema,
  checks: z.array(CheckSchema).default([])
}).strict();

export const SingleTurnScenarioSchema = BaseScenarioSchema.extend({
  kind: z.literal("single-turn"),
  input: InputPromptSchema
}).strict();

export const MultiTurnScenarioSchema = BaseScenarioSchema.extend({
  kind: z.literal("multi-turn"),
  turns: z.array(TurnSchema).min(1)
}).strict();

export const DurableTrajectoryScenarioSchema = BaseScenarioSchema.extend({
  kind: z.literal("durable-trajectory"),
  input: InputPromptSchema
}).strict();

export const SafetyScenarioSchema = BaseScenarioSchema.extend({
  kind: z.literal("safety"),
  input: InputPromptSchema
}).strict();

export const PromptVariantScenarioSchema = BaseScenarioSchema.extend({
  kind: z.literal("prompt-variant"),
  variants: z.array(z.object({
    id: z.string().min(1),
    description: z.string().optional(),
    promptOverrides: PromptOverridesSchema
  }).strict()).min(2),
  baselineVariantId: z.string().min(1).optional(),
  appliesTo: z.string().min(1),
  models: z.array(z.string().min(1)).optional(),
  trials: z.number().int().positive().optional(),
  gate: z.enum(["diagnostic", "baseline-no-regression", "all-cells-pass"]).default("diagnostic"),
  regressionAlpha: z.number().positive().max(1).default(0.05)
}).strict();

export const AblationScenarioSchema = BaseScenarioSchema.extend({
  kind: z.literal("ablation"),
  baseScenario: z.string().min(1),
  axes: z.object({
    model: z.array(z.string().min(1)).optional(),
    prompt: z.array(z.string().min(1)).optional(),
    toolSet: z.array(z.array(z.string().min(1))).optional(),
    workerConfig: z.array(z.record(z.string(), z.unknown())).optional()
  }).strict(),
  trials: z.number().int().positive().optional(),
  gate: z.enum(["diagnostic", "baseline-no-regression", "all-cells-pass"]).default("diagnostic"),
  regressionAlpha: z.number().positive().max(1).default(0.05)
}).strict();

export const ScenarioSchema = z.discriminatedUnion("kind", [
  SingleTurnScenarioSchema,
  MultiTurnScenarioSchema,
  DurableTrajectoryScenarioSchema,
  SafetyScenarioSchema,
  PromptVariantScenarioSchema,
  AblationScenarioSchema
]);

export const BatchScenarioFileSchema = BaseScenarioSchema.extend({
  kind: z.enum(["single-turn", "multi-turn", "durable-trajectory", "safety"]),
  samples: z.array(z.record(z.string(), z.unknown())).min(1)
}).strict();

export type ScenarioInput = z.input<typeof ScenarioSchema>;
export type ScenarioOutput = z.infer<typeof ScenarioSchema>;

export function semanticValidateScenario(scenario: ScenarioOutput): string[] {
  const errors: string[] = [];

  if (scenario.systemMessage?.mode === "replace") {
    errors.push(`Scenario ${scenario.id}: systemMessage.mode=replace is reserved for v1.1 (see §11.6.6).`);
  }
  if (scenario.kind === "safety" && scenario.chaos) {
    errors.push(`Scenario ${scenario.id}: kind=safety is incompatible with chaos block (see §6.5).`);
  }
  if (scenario.chaos && scenario.kind !== "durable-trajectory") {
    errors.push(`Scenario ${scenario.id}: chaos block is only valid for durable-trajectory in v1.`);
  }
  if (scenario.chaos && scenario.chaos.type !== "worker-restart") {
    errors.push(`Scenario ${scenario.id}: chaos.type=${scenario.chaos.type} is reserved until a real crash controller exists.`);
  }
  if (scenario.kind === "prompt-variant") {
    if (scenario.checks.length > 0) {
      errors.push(`Scenario ${scenario.id}: meta-scenario checks are reserved; put executable checks on the base scenarios.`);
    }
    if (scenario.gate !== "diagnostic") {
      errors.push(`Scenario ${scenario.id}: meta-scenario gate "${scenario.gate}" is reserved; only "diagnostic" is supported in v1.`);
    }
    const variantIds = new Set(scenario.variants.map((variant) => variant.id));
    const baseline = scenario.baselineVariantId ?? scenario.variants[0]?.id;
    if (!baseline || !variantIds.has(baseline)) {
      errors.push(`Scenario ${scenario.id}: baselineVariantId must match a variant id.`);
    }
  }
  if (scenario.kind === "ablation") {
    if (scenario.checks.length > 0) {
      errors.push(`Scenario ${scenario.id}: meta-scenario checks are reserved; put executable checks on the base scenario.`);
    }
    if (scenario.gate !== "diagnostic") {
      errors.push(`Scenario ${scenario.id}: meta-scenario gate "${scenario.gate}" is reserved; only "diagnostic" is supported in v1.`);
    }
    const axisEntries = Object.entries(scenario.axes).filter(([, value]) => Array.isArray(value) && value.length > 0);
    if (axisEntries.length === 0) {
      errors.push(`Scenario ${scenario.id}: ablation axes must include at least one non-empty axis.`);
    }
    for (const promptTuple of scenario.axes.prompt ?? []) {
      if (!/^[^.]+(?:\.[^.]+)+$/.test(promptTuple)) {
        errors.push(`Scenario ${scenario.id}: axes.prompt entry "${promptTuple}" must use "<prompt-variant-id>.<variant-id>" format.`);
      }
    }
  }

  for (const [agentName, entry] of Object.entries(scenario.promptOverrides ?? {})) {
    if (entry.frontmatter?.tools?.length) {
      errors.push(`Scenario ${scenario.id}: promptOverrides.${agentName}.frontmatter.tools is warning-only in v1; use axes.toolSet ablation.`);
    }
  }

  return errors;
}
