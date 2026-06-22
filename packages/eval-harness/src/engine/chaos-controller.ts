import type { Scenario } from "../types.js";

/**
 * Minimal runtime surface the chaos controller needs. Kept narrow so the
 * controller does not depend on the full managed-live runtime, avoiding a
 * circular import with managed-live-runner.ts.
 */
export type ChaosRuntime = {
  replaceWorker: (
    index: number,
    sessionId: string,
    sessionConfig: Record<string, unknown>,
    sdkTools: unknown[],
  ) => Promise<void>;
};

export type ChaosController = {
  setSessionContext: (
    sessionId: () => string,
    sessionConfig: Record<string, unknown>,
    sdkTools: unknown[],
    readEvents?: () => Promise<unknown[]>,
  ) => void;
  beforeTurn: (prompt: string) => Promise<void>;
  afterTurn: () => Promise<void>;
  flush: () => Promise<void>;
  cancel: () => Promise<void>;
  metadata: () => Record<string, unknown> | undefined;
};

export class ChaosSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChaosSkipError";
  }
}

export function isChaosSkipError(error: unknown): error is ChaosSkipError {
  return error instanceof ChaosSkipError;
}

export function assertSupportedLiveChaos(scenario: Scenario): void {
  if (!scenario.chaos) return;
  if (scenario.chaos.type !== "worker-restart") {
    throw new Error(`Live chaos type "${scenario.chaos.type}" is not supported by the managed eval runner.`);
  }
  const injectAt = scenario.chaos.injectAt;
  const supported = injectAt === "during-wait";
  if (!supported) throw new Error(`Live chaos injection point "${injectAt}" is not supported by the managed eval runner.`);
}

export function createChaosController(scenario: Scenario, runtime: ChaosRuntime): ChaosController {
  const chaos = scenario.chaos;
  let sessionId: (() => string) | undefined;
  let sessionConfig: Record<string, unknown> | undefined;
  let sdkTools: unknown[] | undefined;
  let readEvents: (() => Promise<unknown[]>) | undefined;
  let injected = false;
  let cancelled = false;
  let turnEnded = false;
  const events: Array<Record<string, unknown>> = [];
  const pending: Promise<void>[] = [];
  const pendingErrors: unknown[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const timerResolves = new Map<ReturnType<typeof setTimeout>, () => void>();

  function shouldRequireInjection(): boolean {
    return Boolean(chaos && chaos.onTargetMissing !== "best-effort" && chaos.onTargetMissing !== "skip");
  }

  async function inject(trigger: string): Promise<void> {
    if (!chaos || injected || cancelled) return;
    const id = sessionId?.();
    if (!id || !sessionConfig || !sdkTools) {
      if (chaos.onTargetMissing === "best-effort") {
        events.push({ trigger, action: "target-missing" });
        return;
      }
      if (chaos.onTargetMissing === "skip") {
        throw new ChaosSkipError(`Chaos target missing for ${scenario.id} at ${trigger}.`);
      }
      throw new Error(`Chaos target missing for ${scenario.id} at ${trigger}.`);
    }
    try {
      await runtime.replaceWorker(0, id, sessionConfig, sdkTools);
      injected = true;
      events.push({ trigger, action: "replace-worker" });
    } catch (error) {
      events.push({
        trigger,
        action: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
      if (chaos.onTargetMissing === "best-effort") return;
      if (chaos.onTargetMissing === "skip") {
        throw new ChaosSkipError(`Chaos replacement failed for ${scenario.id} at ${trigger}.`);
      }
      throw error;
    }
  }

  return {
    setSessionContext(getSessionId, nextSessionConfig, nextSdkTools, nextReadEvents) {
      sessionId = getSessionId;
      sessionConfig = nextSessionConfig;
      sdkTools = nextSdkTools;
      readEvents = nextReadEvents;
    },
    async beforeTurn(_prompt) {
      if (!chaos || injected || cancelled) return;
      turnEnded = false;
      if (chaos.injectAt === "during-wait") {
        pending.push(monitorDurableWait().catch((error) => { pendingErrors.push(error); }));
      }
    },
    async afterTurn() {
      turnEnded = true;
    },
    async flush() {
      await Promise.all(pending);
      if (pendingErrors.length > 0) {
        const [firstError] = pendingErrors;
        throw firstError instanceof Error ? firstError : new Error(String(firstError));
      }
      if (chaos && !injected && chaos.onTargetMissing === "skip") {
        throw new ChaosSkipError(`Chaos injection point "${chaos.injectAt}" was not reached for ${scenario.id}.`);
      }
      if (chaos && !injected && shouldRequireInjection()) {
        throw new Error(`Chaos injection point "${chaos.injectAt}" was not reached for ${scenario.id}.`);
      }
    },
    async cancel() {
      cancelled = true;
      for (const handle of timers) {
        clearTimeout(handle);
        timerResolves.get(handle)?.();
      }
      timers.clear();
      timerResolves.clear();
      await Promise.allSettled(pending);
    },
    metadata() {
      if (!chaos) return undefined;
      return {
        injected,
        type: chaos.type,
        injectAt: chaos.injectAt,
        action: "replace-worker",
        events,
      };
    },
  };

  async function monitorDurableWait(): Promise<void> {
    if (!chaos || chaos.injectAt !== "during-wait") return;
    if (!readEvents) return targetMissing("during-wait", "Chaos cannot observe CMS events for during-wait injection.");
    const delayMs = typeof chaos.params?.delayMs === "number" ? chaos.params.delayMs : 0;
    let sawWaitStarted = false;

    while (!cancelled && !injected) {
      const events = await readEvents().catch(() => []);
      const types = events.map(eventType);
      if (types.includes("session.wait_completed") || types.includes("session.turn_completed")) {
        if (!sawWaitStarted) return;
        return targetMissing("during-wait", "Durable wait completed before chaos injection.");
      }
      if (types.includes("session.wait_started")) {
        sawWaitStarted = true;
        if (delayMs > 0) await sleep(delayMs);
        const latestTypes = (await readEvents().catch(() => [])).map(eventType);
        if (latestTypes.includes("session.wait_completed")) {
          return targetMissing("during-wait", "Durable wait completed before chaos injection.");
        }
        await inject("during-wait");
        return;
      }
      if (turnEnded) {
        return targetMissing("during-wait", "Turn completed before durable wait was observed.");
      }
      await sleep(25);
    }
  }

  async function targetMissing(trigger: string, reason: string): Promise<void> {
    if (!chaos) return;
    events.push({ trigger, action: "target-missing", reason });
    if (chaos.onTargetMissing === "best-effort") return;
    if (chaos.onTargetMissing === "skip") throw new ChaosSkipError(reason);
    throw new Error(reason);
  }

  function sleep(ms: number): Promise<void> {
    if (cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      let handle: ReturnType<typeof setTimeout>;
      const finish = () => {
        timers.delete(handle);
        timerResolves.delete(handle);
        resolve();
      };
      handle = setTimeout(finish, ms);
      timers.add(handle);
      timerResolves.set(handle, finish);
    });
  }
}

function eventType(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const record = event as Record<string, unknown>;
  return String(record.type ?? record.eventType ?? "");
}
