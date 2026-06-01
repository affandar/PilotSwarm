import { z } from "zod";
import { DEFAULT_EVAL_DRIVER, DEFAULT_EVAL_TIMEOUT_MS } from "../defaults.js";

export const RunConfigSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  id: z.string().min(1).default("default"),
  description: z.string().optional(),
  scenarios: z.string().min(1).optional(),
  defaults: z.object({
    isolation: z.enum(["shared-worker", "fresh-worker"]).default("shared-worker"),
    concurrent: z.number().int().positive().default(1),
    driver: z.string().min(1).default(DEFAULT_EVAL_DRIVER),
    timeoutMs: z.number().int().positive().default(DEFAULT_EVAL_TIMEOUT_MS)
  }).strict().partial().default({}),
  budgets: z.object({
    maxUsd: z.number().nonnegative().optional()
  }).optional(),
  reporters: z.array(z.string().min(1)).default(["console"]),
  output: z.object({
    reportsDir: z.string().min(1).default(".eval-results")
  }).partial().default({}),
  filters: z.object({
    includeTags: z.array(z.string()).default([]),
    excludeTags: z.array(z.string()).default([])
  }).partial().default({}),
  llmJudge: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(["openai", "copilot", "github", "github-copilot"]).optional(),
    judgeModel: z.string().optional(),
    prompt: z.string().min(1).optional(),
    applyTo: z.enum(["explicit", "all"]).default("explicit"),
    defaultCheck: z.object({
      rubric: z.string().min(1).optional(),
      budgetUsd: z.number().nonnegative().optional(),
      judgeModel: z.string().min(1).optional(),
      maxOutputTokens: z.number().int().positive().optional()
    }).partial().default({}),
    totalBudgetUsd: z.number().nonnegative().optional(),
    onMissingProvider: z.enum(["skip-with-warning", "error"]).default("skip-with-warning")
  }).partial().default({}),
  worker: z.object({
    pluginDirs: z.array(z.string()).optional(),
    customAgents: z.array(z.record(z.string(), z.unknown())).optional(),
    skillDirectories: z.array(z.string()).optional(),
    disableManagementAgents: z.boolean().optional()
  }).optional()
}).strict();
