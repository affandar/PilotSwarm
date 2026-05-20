import { builtInCheckEvaluators } from "../checks/index.js";
import { checkTypes } from "../registry.js";
import { CheckSchema } from "../schema/check-types.js";
import type { Scenario } from "../types.js";

type RecordValue = Record<string, unknown>;

const builtInCheckTypes = new Set(Object.keys(builtInCheckEvaluators));

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function checkTypeOf(check: unknown): string | undefined {
  if (!isRecord(check)) return undefined;
  return typeof check.type === "string" ? check.type : undefined;
}

function isBuiltInCheck(check: unknown): boolean {
  return CheckSchema.safeParse(check).success;
}

function isKnownCheck(check: unknown): boolean {
  if (isBuiltInCheck(check)) return true;

  const type = checkTypeOf(check);
  if (!type || builtInCheckTypes.has(type)) return false;

  const registration = checkTypes.get(type);
  if (!registration) return false;
  return registration.schema ? registration.schema.safeParse(check).success : true;
}

function sanitizedChecks(checks: unknown): unknown[] | undefined {
  if (!Array.isArray(checks)) return undefined;
  if (!checks.every(isKnownCheck)) return undefined;
  return checks.filter(isBuiltInCheck);
}

export function sanitizeTopLevelChecks(raw: RecordValue): RecordValue | undefined {
  if (!("checks" in raw)) return raw;
  const checks = sanitizedChecks(raw.checks);
  if (!checks) return undefined;
  return { ...raw, checks };
}

export function sanitizeScenarioChecks(raw: RecordValue): RecordValue | undefined {
  let sanitized: RecordValue = { ...raw };
  if ("checks" in raw) {
    const checks = sanitizedChecks(raw.checks);
    if (!checks) return undefined;
    sanitized = { ...sanitized, checks };
  }

  if (Array.isArray(raw.turns)) {
    const turns: unknown[] = [];
    for (const turn of raw.turns) {
      if (!isRecord(turn) || !("checks" in turn)) {
        turns.push(turn);
        continue;
      }
      const checks = sanitizedChecks(turn.checks);
      if (!checks) return undefined;
      turns.push({ ...turn, checks });
    }
    sanitized = { ...sanitized, turns };
  }

  return sanitized;
}

export function restoreScenarioChecks<TScenario extends Scenario>(
  scenario: TScenario,
  raw: RecordValue,
): TScenario {
  let restored: Scenario = scenario;

  if (Array.isArray(raw.checks)) {
    restored = { ...restored, checks: raw.checks as Scenario["checks"] };
  }

  if ("turns" in restored && Array.isArray(raw.turns)) {
    const rawTurns = raw.turns;
    restored = {
      ...restored,
      turns: restored.turns.map((turn, index) => {
        const rawTurn = rawTurns[index];
        if (!isRecord(rawTurn) || !Array.isArray(rawTurn.checks)) return turn;
        return {
          ...turn,
          checks: rawTurn.checks as typeof turn.checks,
        };
      }),
    };
  }

  return restored as TScenario;
}
