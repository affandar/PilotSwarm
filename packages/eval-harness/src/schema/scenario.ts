import { z } from "zod";
import { CheckSchema } from "./check-types.js";

export const SchemaVersion = z.literal(1);

export const ScenarioRunsSchema = z.object({
  timeoutMs: z.number().int().positive().optional()
}).strict();

export const ScenarioRequirementsSchema = z.object({
  isolation: z.enum(["fresh-worker"]).optional()
}).strict().partial();

export const SystemMessageSchema = z.object({
  mode: z.enum(["append", "replace"]),
  content: z.string().min(1)
}).strict();

export const ChaosSchema = z.object({
  injectAt: z.string().min(1),
  type: z.literal("worker-restart"),
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
  chaos: ChaosSchema.optional(),
  runs: ScenarioRunsSchema.optional(),
  requirements: ScenarioRequirementsSchema.default({}),
  llmJudgeRequired: z.boolean().default(false),
  systemMessage: SystemMessageSchema.optional(),
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

export const ScenarioSchema = z.discriminatedUnion("kind", [
  SingleTurnScenarioSchema,
  MultiTurnScenarioSchema,
  DurableTrajectoryScenarioSchema,
  SafetyScenarioSchema
]);

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

  return errors;
}
