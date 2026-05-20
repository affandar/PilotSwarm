import { dirname, resolve } from "node:path";
import { effectiveMaxCells, effectiveTrials } from "./effective-config.js";
import { discoverScenarios } from "./discover.js";
import type { RunConfig, Scenario } from "../types.js";

type AblationAxisName = "model" | "toolSet";

type AblationCell = {
  axes: Partial<Record<AblationAxisName, string | string[]>>;
};

export async function expandExecutionScenarios(
  scenarios: Scenario[],
  config: Partial<RunConfig>,
): Promise<Scenario[]> {
  const expanded: Scenario[] = [];
  for (const scenario of scenarios) {
    if (scenario.kind === "ablation") {
      expanded.push(...await expandAblationScenario(scenario, config));
    } else if (scenario.kind === "prompt-variant") {
      expanded.push(...await expandPromptVariantScenario(scenario, config));
    } else {
      expanded.push(scenario);
    }
  }
  return expanded;
}

async function expandPromptVariantScenario(
  scenario: Extract<Scenario, { kind: "prompt-variant" }>,
  config: Partial<RunConfig>,
): Promise<Scenario[]> {
  const baseScenarios = await loadPromptVariantBaseScenarios(scenario);
  const trials = effectiveTrials(scenario, config);
  const maxCells = effectiveMaxCells(scenario, config);
  const models = scenario.models?.length ? scenario.models : [undefined];
  const totalCells = baseScenarios.length * scenario.variants.length * models.length * trials;
  if (totalCells > maxCells) {
    throw new Error(`Scenario ${scenario.id}: prompt variants expand to ${totalCells} cells, exceeding maxCells=${maxCells}.`);
  }

  const expanded: Scenario[] = [];
  for (const base of baseScenarios) {
    for (const variant of scenario.variants) {
      for (const model of models) {
        for (let trial = 1; trial <= trials; trial += 1) {
          expanded.push(promptVariantCellScenario(scenario, base, variant, trial, model));
        }
      }
    }
  }
  return expanded;
}

async function loadPromptVariantBaseScenarios(scenario: Extract<Scenario, { kind: "prompt-variant" }>): Promise<Scenario[]> {
  const baseDir = scenario.filePath ? dirname(scenario.filePath) : process.cwd();
  const baseScenarios = await discoverScenarios({
    scenarioPaths: [resolve(baseDir, scenario.appliesTo)],
  });
  if (baseScenarios.length === 0) {
    throw new Error(`Scenario ${scenario.id}: appliesTo did not match any scenarios.`);
  }
  const metaMatches = baseScenarios.filter((base) => base.kind === "ablation" || base.kind === "prompt-variant");
  if (metaMatches.length > 0) {
    throw new Error(`Scenario ${scenario.id}: appliesTo cannot include meta-scenarios (${metaMatches.map((base) => base.id).join(", ")}).`);
  }
  return baseScenarios;
}

function promptVariantCellScenario(
  meta: Extract<Scenario, { kind: "prompt-variant" }>,
  base: Scenario,
  variant: Extract<Scenario, { kind: "prompt-variant" }>["variants"][number],
  trial: number,
  model?: string,
): Scenario {
  const baselineVariantId = meta.baselineVariantId ?? meta.variants[0]!.id;
  const cellMetadata = {
    metaScenarioId: meta.id,
    baseScenarioId: base.id,
    variantId: variant.id,
    baselineVariantId,
    trial,
    ...(model ? { model } : {}),
  };

  return {
    ...base,
    id: promptVariantCellScenarioId(meta.id, base.id, variant.id, trial, model),
    description: `${meta.description} (${base.id}, variant ${variant.id}${model ? `, model ${model}` : ""}, trial ${trial})`,
    tags: [...new Set([...(base.tags ?? []), ...(meta.tags ?? []), "prompt-variant-cell"])],
    runs: mergeRuns(base.runs, meta.runs),
    requirements: mergeRequirements(base.requirements, meta.requirements, { isolation: "fresh-worker" }),
    promptOverrides: mergePromptOverrides(base.promptOverrides, variant.promptOverrides),
    metadata: {
      ...(base.metadata ?? {}),
      evalCell: cellMetadata,
    },
  } as Scenario;
}

async function expandAblationScenario(scenario: Extract<Scenario, { kind: "ablation" }>, config: Partial<RunConfig>): Promise<Scenario[]> {
  if (scenario.axes.prompt?.length) {
    throw new Error(`Scenario ${scenario.id}: axes.prompt execution is not supported yet; use prompt-variant scenarios directly.`);
  }
  if (scenario.axes.workerConfig?.length) {
    throw new Error(`Scenario ${scenario.id}: axes.workerConfig execution is not supported yet.`);
  }

  const base = await loadAblationBaseScenario(scenario);
  const cells = ablationCells(scenario);
  const trials = effectiveTrials(scenario, config);
  const maxCells = effectiveMaxCells(scenario, config);
  const totalCells = cells.length * trials;
  if (totalCells > maxCells) {
    throw new Error(`Scenario ${scenario.id}: ablation expands to ${totalCells} cells, exceeding maxCells=${maxCells}.`);
  }

  const expanded: Scenario[] = [];
  for (const cell of cells) {
    for (let trial = 1; trial <= trials; trial += 1) {
      expanded.push(ablationCellScenario(scenario, base, cell, trial));
    }
  }
  return expanded;
}

async function loadAblationBaseScenario(scenario: Extract<Scenario, { kind: "ablation" }>): Promise<Scenario> {
  const baseDir = scenario.filePath ? dirname(scenario.filePath) : process.cwd();
  const baseScenarios = await discoverScenarios({
    scenarioPaths: [resolve(baseDir, scenario.baseScenario)],
  });
  if (baseScenarios.length !== 1) {
    throw new Error(`Scenario ${scenario.id}: baseScenario must resolve to exactly one scenario, got ${baseScenarios.length}.`);
  }
  const base = baseScenarios[0]!;
  if (base.kind === "ablation" || base.kind === "prompt-variant") {
    throw new Error(`Scenario ${scenario.id}: baseScenario cannot be another meta-scenario.`);
  }
  return base;
}

function ablationCells(scenario: Extract<Scenario, { kind: "ablation" }>): AblationCell[] {
  let cells: AblationCell[] = [{ axes: {} }];
  if (scenario.axes.model?.length) {
    cells = crossProductAxis(cells, "model", scenario.axes.model);
  }
  if (scenario.axes.toolSet?.length) {
    cells = crossProductAxis(cells, "toolSet", scenario.axes.toolSet);
  }
  return cells;
}

function crossProductAxis(
  cells: AblationCell[],
  axisName: AblationAxisName,
  values: Array<string | string[]>,
): AblationCell[] {
  return cells.flatMap((cell) => values.map((value) => ({
    axes: {
      ...cell.axes,
      [axisName]: value,
    },
  })));
}

function ablationCellScenario(
  meta: Extract<Scenario, { kind: "ablation" }>,
  base: Scenario,
  cell: AblationCell,
  trial: number,
): Scenario {
  const model = typeof cell.axes.model === "string" ? cell.axes.model : undefined;
  const toolSet = Array.isArray(cell.axes.toolSet) ? cell.axes.toolSet : undefined;
  const cellMetadata = {
    metaScenarioId: meta.id,
    baseScenarioId: base.id,
    trial,
    axes: cell.axes,
    ...(model ? { model } : {}),
    ...(toolSet ? { toolSet } : {}),
  };

  return {
    ...base,
    id: cellScenarioId(meta.id, cell, trial),
    description: `${meta.description} (${cellLabel(cell)}, trial ${trial})`,
    tags: [...new Set([...(base.tags ?? []), ...(meta.tags ?? []), "ablation-cell"])],
    tools: toolSet ?? base.tools,
    runs: mergeRuns(base.runs, meta.runs),
    requirements: mergeRequirements(base.requirements, meta.requirements),
    metadata: {
      ...(base.metadata ?? {}),
      evalCell: cellMetadata,
    },
  } as Scenario;
}

function cellScenarioId(metaId: string, cell: AblationCell, trial: number): string {
  const parts = Object.entries(cell.axes).map(([axisName, value]) => {
    if (Array.isArray(value)) return `${axisName}=${value.map(cellValueSegment).join("+")}`;
    return `${axisName}=${cellValueSegment(value)}`;
  });
  return `${metaId}::${parts.join("::")}::trial=${trial}`;
}

function promptVariantCellScenarioId(metaId: string, baseId: string, variantId: string, trial: number, model?: string): string {
  return [
    `${metaId}::scenario=${cellValueSegment(baseId)}`,
    `variant=${cellValueSegment(variantId)}`,
    ...(model ? [`model=${cellValueSegment(model)}`] : []),
    `trial=${trial}`,
  ].join("::");
}

function cellLabel(cell: AblationCell): string {
  return Object.entries(cell.axes).map(([axisName, value]) => {
    if (Array.isArray(value)) return `${axisName}=[${value.join(", ")}]`;
    return `${axisName}=${value}`;
  }).join(", ");
}

function cellValueSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9.-]+/g, "_");
}

function mergeRuns(base?: Scenario["runs"], meta?: Scenario["runs"]): Scenario["runs"] {
  const merged = {
    ...(base?.timeoutMs != null ? { timeoutMs: base.timeoutMs } : {}),
    ...(base?.maxCells != null ? { maxCells: base.maxCells } : {}),
    ...(meta?.timeoutMs != null ? { timeoutMs: meta.timeoutMs } : {}),
    ...(meta?.maxCells != null ? { maxCells: meta.maxCells } : {}),
  };
  return Object.keys(merged).length ? merged : undefined;
}

function mergeRequirements(
  base?: Scenario["requirements"],
  meta?: Scenario["requirements"],
  enforced?: Scenario["requirements"],
): Scenario["requirements"] {
  return {
    ...(base ?? {}),
    ...(meta ?? {}),
    ...(enforced ?? {}),
  };
}

function mergePromptOverrides(
  base?: Scenario["promptOverrides"],
  variant?: Scenario["promptOverrides"],
): Scenario["promptOverrides"] {
  const merged = {
    ...(base ?? {}),
    ...(variant ?? {}),
  };
  return Object.keys(merged).length ? merged : undefined;
}
