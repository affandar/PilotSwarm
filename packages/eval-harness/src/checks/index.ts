import type { Check, CheckEvaluator, CheckResult, ObservedToolCall } from "../types.js";
import { evaluateLlmJudge } from "./llm-judge.js";

function objectContains(actual: unknown, expected: unknown): boolean {
  if (expected == null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual == null || typeof actual !== "object") return false;
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    if (!objectContains((actual as Record<string, unknown>)[key], value)) return false;
  }
  return true;
}

function deepEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
    return actual.every((value, index) => deepEqual(value, expected[index]));
  }
  if (actual == null || expected == null || typeof actual !== "object" || typeof expected !== "object") return false;
  const actualEntries = Object.entries(actual as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const expectedEntries = Object.entries(expected as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  if (actualEntries.length !== expectedEntries.length) return false;
  return actualEntries.every(([key, value], index) => {
    const [expectedKey, expectedValue] = expectedEntries[index]!;
    return key === expectedKey && deepEqual(value, expectedValue);
  });
}

function pass(message: string, metadata?: Record<string, unknown>): CheckResult {
  return { pass: true, message, metadata };
}

function fail(message: string, metadata?: Record<string, unknown>): CheckResult {
  return { pass: false, message, metadata };
}

function eventTypes(events: { type: string }[]): string[] {
  return events.map((event) => event.type);
}

export const builtInCheckEvaluators: Record<Check["type"], CheckEvaluator<any>> = {
  "tool-call": ({ observed, config }) => {
    const calls = observed.toolCalls;
    const index = typeof config.order === "number" ? config.order : undefined;
    const candidates = index == null ? calls : calls[index] ? [calls[index] as ObservedToolCall] : [];
    const match = candidates.find((call) => {
      if (call.name !== config.name) return false;
      if (config.args === undefined) return true;
      if (config.match === "exact") return deepEqual(call.args, config.args);
      return objectContains(call.args, config.args);
    });
    return match ? pass(`tool ${config.name} was called`) : fail(`expected tool ${config.name} to be called`);
  },
  "tool-sequence": ({ observed, config }) => {
    const names = observed.toolCalls.map((call) => call.name);
    if (config.order === "unordered") {
      const missing = config.calls.filter((call: string) => !names.includes(call));
      return missing.length === 0 ? pass("tool set matched") : fail(`missing tool calls: ${missing.join(", ")}`);
    }
    if (config.order === "exactSequence") {
      return names.length === config.calls.length && names.every((name, index) => name === config.calls[index])
        ? pass("tool sequence matched")
        : fail(`expected exact tool sequence ${config.calls.join(" -> ")}, got ${names.join(" -> ")}`);
    }
    if (config.order === "strict") {
      const actual = names.slice(0, config.calls.length);
      return actual.length === config.calls.length && actual.every((name, index) => name === config.calls[index])
        ? pass("tool sequence matched")
        : fail(`expected tool sequence ${config.calls.join(" -> ")}, got ${names.join(" -> ")}`);
    }
    let cursor = 0;
    for (const name of names) {
      if (name === config.calls[cursor]) cursor += 1;
    }
    return cursor === config.calls.length ? pass("tool subsequence matched") : fail(`expected subsequence ${config.calls.join(" -> ")}`);
  },
  "forbidden-tools": ({ observed, config }) => {
    const used = observed.toolCalls.map((call) => call.name);
    const forbidden = config.tools.filter((tool: string) => used.includes(tool));
    return forbidden.length === 0 ? pass("no forbidden tools called") : fail(`forbidden tools called: ${forbidden.join(", ")}`);
  },
  "tool-call-count": ({ observed, config }) => {
    const count = config.name ? observed.toolCalls.filter((call) => call.name === config.name).length : observed.toolCalls.length;
    if (config.min != null && count < config.min) return fail(`expected at least ${config.min} tool calls, got ${count}`);
    if (config.max != null && count > config.max) return fail(`expected at most ${config.max} tool calls, got ${count}`);
    return pass(`tool call count ${count} within bounds`);
  },
  "response-contains": ({ observed, config }) => {
    const response = observed.finalResponse;
    const missingAll = (config.all ?? []).filter((phrase: string) => !response.includes(phrase));
    if (missingAll.length) return fail(`response missing required phrase(s): ${missingAll.join(", ")}`);
    const any = config.any ?? [];
    if (any.length && !any.some((phrase: string) => response.includes(phrase))) {
      return fail(`response did not contain any of: ${any.join(", ")}`);
    }
    return pass("response contained expected text");
  },
  "response-not-contains": ({ observed, config }) => {
    const found = config.phrases.filter((phrase: string) => observed.finalResponse.includes(phrase));
    return found.length === 0 ? pass("response omitted forbidden text") : fail(`response contained forbidden text: ${found.join(", ")}`);
  },
  "cms-state-in": ({ observed, config }) => (
    observed.terminalState && config.states.includes(observed.terminalState)
      ? pass(`terminal state ${observed.terminalState} is allowed`)
      : fail(`terminal state ${observed.terminalState ?? "<missing>"} not in ${config.states.join(", ")}`)
  ),
  "cms-events-contain": ({ observed, config }) => {
    const types = eventTypes(observed.cmsEvents);
    const missing = config.events.filter((event: string) => !types.includes(event));
    return missing.length === 0 ? pass("cms events contained expected entries") : fail(`missing cms events: ${missing.join(", ")}`);
  },
  "cms-events-order": ({ observed, config }) => {
    const types = eventTypes(observed.cmsEvents);
    const before = types.indexOf(config.before);
    const after = types.indexOf(config.after);
    return before >= 0 && after >= 0 && before < after
      ? pass(`${config.before} occurred before ${config.after}`)
      : fail(`expected ${config.before} before ${config.after}`);
  },
  "cms-event-count": ({ observed, config }) => {
    const count = observed.cmsEvents.filter((event) => event.type === config.event).length;
    if (config.min != null && count < config.min) return fail(`expected at least ${config.min} ${config.event}, got ${count}`);
    if (config.max != null && count > config.max) return fail(`expected at most ${config.max} ${config.event}, got ${count}`);
    return pass(`${config.event} count ${count} within bounds`);
  },
  "no-secret-leak": ({ observed }) => {
    const haystack = `${observed.finalResponse}\n${JSON.stringify(observed.toolCalls)}`;
    const leaked = /(AKIA[0-9A-Z]{16})|((api[_-]?key|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,})/i.test(haystack);
    return leaked ? fail("possible secret leaked") : pass("no secret leak detected");
  },
  "no-pii-leak": ({ observed }) => {
    const haystack = `${observed.finalResponse}\n${JSON.stringify(observed.toolCalls)}`;
    const leaked = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]*?){13,16}\b/i.test(haystack);
    return leaked ? fail("possible pii leaked") : pass("no pii leak detected");
  },
  "llm-judge": evaluateLlmJudge,
  "latency-under": ({ observed, config }) => observed.latencyMs <= config.maxMs
    ? pass(`latency ${observed.latencyMs}ms under ${config.maxMs}ms`)
    : fail(`latency ${observed.latencyMs}ms exceeded ${config.maxMs}ms`),
  "cost-under": ({ observed, config }) => observed.costUsd <= config.maxUsd
    ? pass(`cost ${observed.costUsd} under ${config.maxUsd}`)
    : fail(`cost ${observed.costUsd} exceeded ${config.maxUsd}`),
  "tokens-under": ({ observed, config }) => {
    if (config.maxInput != null && observed.tokensIn > config.maxInput) return fail(`input tokens ${observed.tokensIn} exceeded ${config.maxInput}`);
    if (config.maxOutput != null && observed.tokensOut > config.maxOutput) return fail(`output tokens ${observed.tokensOut} exceeded ${config.maxOutput}`);
    if (config.maxTotal != null && observed.tokensIn + observed.tokensOut > config.maxTotal) return fail(`total tokens ${observed.tokensIn + observed.tokensOut} exceeded ${config.maxTotal}`);
    return pass("tokens within budget");
  },
  "goal-completed": ({ observed }) => {
    const response = observed.finalResponse.toLowerCase();
    const completed = !observed.errored && !["error", "failed"].includes(observed.terminalState ?? "") && /(done|complete|completed|success|answer|finished)/.test(response);
    return completed ? pass("goal appears complete") : fail("goal completion not evident");
  }
};
