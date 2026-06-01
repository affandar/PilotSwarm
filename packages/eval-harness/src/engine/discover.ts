import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ScenarioSchema, semanticValidateScenario } from "../schema/scenario.js";
import { RunConfigSchema } from "../schema/config.js";
import { parseManifestJsonl, type ManifestDirective } from "../schema/manifest.js";
import { scenarioKinds, tools } from "../registry.js";
import { restoreScenarioChecks, sanitizeScenarioChecks } from "./custom-checks.js";
import type { Scenario } from "../types.js";

export type DiscoverOptions = {
  configPath?: string;
  manifestPath?: string;
  scenariosPath?: string;
  scenarioPaths?: string[];
  includeTags?: string[];
  excludeTags?: string[];
};

type ScenarioPathEntry = {
  path: string;
  overrides?: Record<string, unknown>;
};

function resolveFrom(baseDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\*\*\//g, "{GLOBSTAR_SLASH}");
  const regex = normalized.split(/(\{GLOBSTAR_SLASH\}|\*\*|\*)/g).map((part) => {
    if (part === "{GLOBSTAR_SLASH}") return "(?:.*/)?";
    if (part === "**") return ".*";
    if (part === "*") return "[^/]*";
    return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return new RegExp(`^${regex}$`);
}

async function expandPattern(baseDir: string, pattern: string): Promise<string[]> {
  const absolute = resolveFrom(baseDir, pattern);
  if (!pattern.includes("*")) return [absolute];
  const root = absolute.slice(0, absolute.indexOf("*")).replace(/\/[^/]*$/, "") || baseDir;
  const rootDir = await exists(root) ? root : baseDir;
  const matcher = globToRegExp(absolute);
  return (await walk(rootDir)).filter((file) => matcher.test(file));
}

function mergeUnique(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

function parseBuiltInOrCustomScenario(raw: Record<string, unknown>, filePath: string): Scenario {
  const builtIn = ScenarioSchema.safeParse(raw);
  if (builtIn.success) return { ...(builtIn.data as Scenario), filePath };

  const sanitized = sanitizeScenarioChecks(raw);
  if (sanitized) {
    const sanitizedParse = ScenarioSchema.safeParse(sanitized);
    if (sanitizedParse.success) {
      return { ...restoreScenarioChecks(sanitizedParse.data as Scenario, raw), filePath };
    }
  }

  const kind = typeof raw.kind === "string" ? raw.kind : "";
  const registered = scenarioKinds.get(kind);
  if (!registered) throw builtIn.error;
  return { ...(registered.schema.parse(raw) as Scenario), filePath };
}

function parseScenario(raw: Record<string, unknown>, filePath: string): Scenario {
  return parseBuiltInOrCustomScenario(raw, filePath);
}

function applyOverrides(scenario: Scenario, overrides?: Record<string, unknown>): Scenario {
  if (!overrides) return scenario;
  const { tags, ...unsupported } = overrides as { tags?: string[] } & Record<string, unknown>;
  if (Object.keys(unsupported).length > 0) {
    throw new Error("Manifest overrides may only set tags.");
  }
  const selectionTags = Array.isArray(tags) ? tags : [];
  return {
    ...scenario,
    ...(selectionTags.length ? { tags: mergeUnique(scenario.tags ?? [], selectionTags) } : {}),
    metadata: {
      ...(scenario.metadata ?? {}),
      ...(selectionTags.length ? { selectionTags } : {})
    }
  };
}

async function loadScenarioFile(filePath: string, overrides?: Record<string, unknown>): Promise<Scenario[]> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  const scenarios = [parseScenario(raw, filePath)];
  const overridden = scenarios.map((scenario) => applyOverrides(scenario, overrides));
  for (const scenario of overridden) {
    const semanticErrors = semanticValidateScenario(scenario);
    if (semanticErrors.length) throw new Error(semanticErrors.join("; "));
    for (const toolName of scenario.tools) {
      if (!tools.has(toolName)) throw new Error(`Scenario ${scenario.id} references unknown tool "${toolName}".`);
    }
  }
  return overridden;
}

async function manifestScenarioEntries(manifestPath: string, stack: string[] = []): Promise<ScenarioPathEntry[]> {
  const abs = resolve(manifestPath);
  if (stack.includes(abs)) throw new Error(`Manifest include cycle detected: ${[...stack, abs].join(" -> ")}`);
  const baseDir = dirname(abs);
  const directives = parseManifestJsonl(await readFile(abs, "utf8"));
  const includes = new Map<string, ScenarioPathEntry>();
  const excludes: string[] = [];

  const includePath = (path: string, overrides?: Record<string, unknown>) => {
    const resolved = resolve(path);
    const existing = includes.get(resolved);
    includes.set(resolved, {
      path: resolved,
      overrides: overrides ?? existing?.overrides
    });
  };

  for (const directive of directives.slice(1) as ManifestDirective[]) {
    if ("path" in directive) includePath(resolveFrom(baseDir, directive.path), directive.overrides as Record<string, unknown> | undefined);
    if ("include" in directive) {
      for (const path of await expandPattern(baseDir, directive.include)) includePath(path);
    }
    if ("exclude" in directive) excludes.push(...await expandPattern(baseDir, directive.exclude));
    if ("include-manifest" in directive) {
      for (const entry of await manifestScenarioEntries(resolveFrom(baseDir, directive["include-manifest"]), [...stack, abs])) {
        includePath(entry.path, entry.overrides);
      }
    }
  }

  const excluded = new Set(excludes.map((path) => resolve(path)));
  return [...includes.values()].filter((entry) => !excluded.has(entry.path));
}

function applyTagFilters(scenarios: Scenario[], includeTags: string[], excludeTags: string[]): Scenario[] {
  return scenarios.filter((scenario) => {
    if (includeTags.length && !scenario.tags.some((tag) => includeTags.includes(tag))) return false;
    if (excludeTags.length && scenario.tags.some((tag) => excludeTags.includes(tag))) return false;
    return true;
  });
}

export async function discoverScenarios(options: DiscoverOptions = {}): Promise<Scenario[]> {
  let scenarioEntries: ScenarioPathEntry[] = [];
  let includeTags = options.includeTags ?? [];
  let excludeTags = options.excludeTags ?? [];

  if (options.configPath) {
    const configPath = resolve(options.configPath);
    const config = RunConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
    includeTags = includeTags.length ? includeTags : config.filters?.includeTags ?? [];
    excludeTags = excludeTags.length ? excludeTags : config.filters?.excludeTags ?? [];
    if (!config.scenarios) throw new Error(`Config ${configPath} does not declare scenarios.`);
    scenarioEntries = await manifestScenarioEntries(resolveFrom(dirname(configPath), config.scenarios));
  } else if (options.manifestPath) {
    scenarioEntries = await manifestScenarioEntries(options.manifestPath);
  } else if (options.scenarioPaths?.length) {
    scenarioEntries = (await Promise.all(options.scenarioPaths.map((path) => expandPattern(process.cwd(), path))))
      .flat()
      .map((path) => ({ path: resolve(path) }));
  } else if (options.scenariosPath) {
    scenarioEntries = (await expandPattern(process.cwd(), options.scenariosPath)).map((path) => ({ path: resolve(path) }));
  } else {
    throw new Error("No configPath, manifestPath, or scenariosPath provided.");
  }

  const loaded = (await Promise.all(scenarioEntries.map((entry) => loadScenarioFile(entry.path, entry.overrides)))).flat();
  const ids = new Set<string>();
  for (const scenario of loaded) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id "${scenario.id}".`);
    ids.add(scenario.id);
  }
  return applyTagFilters(loaded, includeTags, excludeTags);
}
