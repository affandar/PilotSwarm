import { z } from "zod";

const BoundsSchema = z.object({
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional()
}).strict();

export const ToolCallCheckSchema = z.object({
  type: z.literal("tool-call"),
  name: z.string().min(1),
  args: z.unknown().optional(),
  match: z.enum(["subset", "exact"]).default("subset"),
  order: z.number().int().nonnegative().optional()
}).strict();

export const CheckSchema = z.union([
  ToolCallCheckSchema,
  z.object({
    type: z.literal("tool-sequence"),
    order: z.enum(["strict", "subsequence", "exactSequence", "unordered"]),
    calls: z.array(z.string().min(1)).min(1)
  }).strict(),
  z.object({
    type: z.literal("forbidden-tools"),
    tools: z.array(z.string().min(1)).min(1)
  }).strict(),
  z.object({
    type: z.literal("tool-call-count"),
    name: z.string().min(1).optional()
  }).merge(BoundsSchema).refine((check) => check.min != null || check.max != null, {
    message: "tool-call-count requires min or max"
  }),
  z.object({
    type: z.literal("response-contains"),
    any: z.array(z.string().min(1)).optional(),
    all: z.array(z.string().min(1)).optional()
  }).strict().refine((check) => (check.any?.length ?? 0) + (check.all?.length ?? 0) > 0, {
    message: "response-contains requires non-empty any or all"
  }),
  z.object({
    type: z.literal("response-not-contains"),
    phrases: z.array(z.string()).min(1)
  }).strict(),
  z.object({
    type: z.literal("cms-state-in"),
    states: z.array(z.string().min(1)).min(1)
  }).strict(),
  z.object({
    type: z.literal("cms-events-contain"),
    events: z.array(z.string().min(1)).min(1)
  }).strict(),
  z.object({
    type: z.literal("cms-events-order"),
    before: z.string().min(1),
    after: z.string().min(1)
  }).strict(),
  z.object({
    type: z.literal("cms-event-count"),
    event: z.string().min(1)
  }).merge(BoundsSchema).refine((check) => check.min != null || check.max != null, {
    message: "cms-event-count requires min or max"
  }),
  z.object({ type: z.literal("no-secret-leak") }).strict(),
  z.object({ type: z.literal("no-pii-leak") }).strict(),
  z.object({
    type: z.literal("llm-judge"),
    rubric: z.string().min(1),
    budgetUsd: z.number().nonnegative().optional(),
    judgeModel: z.string().min(1).optional(),
    maxOutputTokens: z.number().int().positive().optional()
  }).strict(),
  z.object({
    type: z.literal("latency-under"),
    maxMs: z.number().nonnegative()
  }).strict()
]);

export type CheckInput = z.input<typeof CheckSchema>;
