import { z } from "zod";

export const EvalToolCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  match: z.enum(["exact", "subset", "fuzzy", "setEquals"]).default("subset"),
  order: z.number().int().optional(),
});
export type EvalToolCall = z.infer<typeof EvalToolCallSchema>;

export const EvalExpectedSchema = z
  .object({
    toolCalls: z.array(EvalToolCallSchema).optional(),
    toolSequence: z.enum(["strict", "unordered"]).default("unordered"),
    forbiddenTools: z.array(z.string()).optional(),
    minCalls: z.number().int().nonnegative().optional(),
    maxCalls: z.number().int().nonnegative().optional(),
    noToolCall: z.boolean().optional(),
    response: z
      .object({
        containsAny: z.array(z.string()).optional(),
        containsAll: z.array(z.string()).optional(),
      })
      .optional(),
    cms: z
      .object({
        stateIn: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.noToolCall === true && val.toolCalls && val.toolCalls.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "noToolCall=true cannot be combined with non-empty toolCalls",
        path: ["noToolCall"],
      });
    }
    if (
      typeof val.minCalls === "number" &&
      typeof val.maxCalls === "number" &&
      val.minCalls > val.maxCalls
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `minCalls (${val.minCalls}) must be <= maxCalls (${val.maxCalls})`,
        path: ["minCalls"],
      });
    }
  });
export type EvalExpected = z.infer<typeof EvalExpectedSchema>;

export const EvalContextMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

export const EvalSampleInputSchema = z.object({
  prompt: z.string(),
  systemMessage: z.string().optional(),
  context: z.array(EvalContextMessageSchema).optional(),
});

export const EvalSampleSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  input: EvalSampleInputSchema,
  expected: EvalExpectedSchema,
  tools: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().default(120000),
});
export type EvalSample = z.infer<typeof EvalSampleSchema>;

export const EvalTaskSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  passRateFloor: z.number().min(0).max(1).optional(),
  samples: z.array(EvalSampleSchema).min(1),
});
export type EvalTask = z.infer<typeof EvalTaskSchema>;

export const ScoreSchema = z.object({
  name: z.string(),
  value: z.number().min(0).max(1),
  pass: z.boolean(),
  reason: z.string(),
  actual: z.unknown().optional(),
  expected: z.unknown().optional(),
});
export type Score = z.infer<typeof ScoreSchema>;

export const ObservedToolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  timestamp: z.number().optional(),
  order: z.number().int().nonnegative(),
});
export type ObservedToolCall = z.infer<typeof ObservedToolCallSchema>;

export const ObservedResultSchema = z.object({
  toolCalls: z.array(ObservedToolCallSchema),
  finalResponse: z.string(),
  sessionId: z.string(),
  model: z.string().optional(),
  latencyMs: z.number().nonnegative(),
  cmsState: z.string().optional(),
});
export type ObservedResult = z.infer<typeof ObservedResultSchema>;

export const CaseResultSchema = z.object({
  caseId: z.string(),
  pass: z.boolean(),
  scores: z.array(ScoreSchema),
  observed: ObservedResultSchema,
  infraError: z.string().optional(),
  durationMs: z.number().nonnegative(),
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const RunSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errored: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
});

export const RunResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  taskId: z.string(),
  taskVersion: z.string(),
  gitSha: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  summary: RunSummarySchema,
  cases: z.array(CaseResultSchema),
});
export type RunResult = z.infer<typeof RunResultSchema>;
