import type { z } from "zod";
import { builtInCheckEvaluators } from "./checks/index.js";
import { defaultTools } from "./tools/defaults.js";
import { fakeDriverFactory } from "./drivers/fake.js";
import { scriptedDriverFactory } from "./drivers/scripted.js";
import { liveDriverFactory } from "./drivers/live.js";
import { pilotSwarmDriverFactory } from "./drivers/pilotswarm.js";
import { chaosDriverFactory } from "./drivers/chaos.js";
import { consoleReporter } from "./reporters/console.js";
import { jsonlReporter } from "./reporters/jsonl.js";
import { markdownReporter } from "./reporters/markdown.js";
import type { ReporterEmitOptions } from "./reporters/output.js";
import {
  AblationScenarioSchema,
  BatchScenarioFileSchema,
  DurableTrajectoryScenarioSchema,
  MultiTurnScenarioSchema,
  PromptVariantScenarioSchema,
  SafetyScenarioSchema,
  SingleTurnScenarioSchema
} from "./schema/scenario.js";
import type { CheckEvaluator, ObservedResult, RunManifestResult, Scenario } from "./types.js";

export type ScenarioKindRegistration = {
  schema: z.ZodType;
  plan?: (scenario: Scenario) => unknown[];
  prepareCell?: (cell: unknown) => unknown;
  requiresSchemaVersion: 1;
};

export type Driver = {
  run: (scenario: Scenario, options?: Record<string, unknown>) => Promise<ObservedResult>;
};

export type Reporter = {
  emit: (result: RunManifestResult, options?: ReporterEmitOptions) => Promise<void> | void;
};

export type ToolRegistration = {
  name: string;
  description?: string;
  schema?: z.ZodType;
  handler: (args: unknown) => Promise<unknown> | unknown;
};

export const scenarioKinds = new Map<string, ScenarioKindRegistration>();
export const checkTypes = new Map<string, { schema?: z.ZodType; evaluate: CheckEvaluator<any> }>();
export const tools = new Map<string, ToolRegistration>();
export const drivers = new Map<string, { factory: () => Driver }>();
export const reporters = new Map<string, Reporter>();

export function registerScenarioKind(name: string, registration: ScenarioKindRegistration): void {
  scenarioKinds.set(name, registration);
}

export function registerCheckType(name: string, registration: { schema?: z.ZodType; evaluate: CheckEvaluator<any> }): void {
  checkTypes.set(name, registration);
}

export function registerTool(tool: ToolRegistration): void {
  tools.set(tool.name, tool);
}

export function registerDriver(name: string, registration: { factory: () => Driver }): void {
  drivers.set(name, registration);
}

export function registerReporter(name: string, reporter: Reporter): void {
  reporters.set(name, reporter);
}

registerScenarioKind("single-turn", { schema: SingleTurnScenarioSchema, requiresSchemaVersion: 1 });
registerScenarioKind("multi-turn", { schema: MultiTurnScenarioSchema, requiresSchemaVersion: 1 });
registerScenarioKind("durable-trajectory", { schema: DurableTrajectoryScenarioSchema, requiresSchemaVersion: 1 });
registerScenarioKind("safety", { schema: SafetyScenarioSchema, requiresSchemaVersion: 1 });
registerScenarioKind("prompt-variant", { schema: PromptVariantScenarioSchema, requiresSchemaVersion: 1 });
registerScenarioKind("ablation", { schema: AblationScenarioSchema, requiresSchemaVersion: 1 });
registerScenarioKind("batch", { schema: BatchScenarioFileSchema, requiresSchemaVersion: 1 });

for (const [type, evaluate] of Object.entries(builtInCheckEvaluators)) {
  registerCheckType(type, { evaluate });
}
for (const tool of defaultTools) registerTool(tool);
registerDriver("fake", { factory: fakeDriverFactory });
registerDriver("scripted", { factory: scriptedDriverFactory });
registerDriver("live", { factory: liveDriverFactory });
registerDriver("attach", { factory: pilotSwarmDriverFactory });
registerDriver("pilotswarm", { factory: pilotSwarmDriverFactory });
registerDriver("chaos", { factory: chaosDriverFactory });
registerReporter("console", consoleReporter);
registerReporter("jsonl", jsonlReporter);
registerReporter("markdown", markdownReporter);
