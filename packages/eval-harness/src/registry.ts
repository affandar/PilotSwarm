import type { z } from "zod";
import { builtInCheckEvaluators } from "./checks/index.js";
import { defaultTools } from "./tools/defaults.js";
import { consoleReporter } from "./reporters/console.js";
import type { ReporterEmitOptions } from "./reporters/output.js";
import {
  DurableTrajectoryScenarioSchema,
  MultiTurnScenarioSchema,
  SafetyScenarioSchema,
  SingleTurnScenarioSchema
} from "./schema/scenario.js";
import type { CheckEvaluator, ObservedResult, RunManifestResult, Scenario } from "./types.js";

export type ScenarioKindRegistration = {
  schema: z.ZodType;
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
  parameters?: Record<string, unknown>;
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

registerScenarioKind("single-turn", { schema: SingleTurnScenarioSchema });
registerScenarioKind("multi-turn", { schema: MultiTurnScenarioSchema });
registerScenarioKind("durable-trajectory", { schema: DurableTrajectoryScenarioSchema });
registerScenarioKind("safety", { schema: SafetyScenarioSchema });

for (const [type, evaluate] of Object.entries(builtInCheckEvaluators)) {
  registerCheckType(type, { evaluate });
}
for (const tool of defaultTools) registerTool(tool);
registerReporter("console", consoleReporter);
