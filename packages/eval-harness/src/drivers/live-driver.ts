import { randomBytes } from "node:crypto";
import type { Driver, DriverOptions } from "./types.js";
import type { EvalSample, ObservedResult, ObservedToolCall } from "../types.js";
import { createEvalToolTracker } from "../fixtures/eval-tools.js";
import { extractObservedCalls } from "../observers/tool-tracker.js";
import { PilotSwarmClient, PilotSwarmWorker } from "pilotswarm-sdk";
// createTestEnv is a test helper from the sdk package that is not part of the
// public API; import it by relative path from the sdk's test helpers. The sdk
// helpers are plain .js with no types, so suppress the declaration lookup.
// @ts-expect-error - no types for sdk test helper
import { createTestEnv } from "../../../sdk/test/helpers/local-env.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtor = new (...args: any[]) => any;

export interface LiveDriverDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createEnv?: (suite: string) => any;
  WorkerCtor?: AnyCtor;
  ClientCtor?: AnyCtor;
}

export class LiveDriver implements Driver {
  private defaultOptions: DriverOptions;
  private deps: LiveDriverDeps;

  constructor(options?: DriverOptions, deps?: LiveDriverDeps) {
    this.defaultOptions = options ?? {};
    this.deps = deps ?? {};
  }

  async run(sample: EvalSample, options?: DriverOptions): Promise<ObservedResult> {
    const opts: DriverOptions = { ...this.defaultOptions, ...(options ?? {}) };

    if (sample.input.context && sample.input.context.length > 0) {
      throw new Error(
        "LiveDriver does not yet support conversation context. Remove context from sample or use FakeDriver.",
      );
    }

    const { tracker, tools } = createEvalToolTracker();
    const toolByName: Record<string, (typeof tools)[keyof typeof tools]> = {
      test_add: tools.add,
      test_multiply: tools.multiply,
      test_weather: tools.weather,
    };

    const requested = sample.tools ?? ["test_add", "test_multiply", "test_weather"];
    const missing = requested.filter((name) => !toolByName[name]);
    if (missing.length > 0) {
      throw new Error(
        `Unknown eval tool(s): ${missing.join(", ")}. Available: ${Object.keys(toolByName).join(", ")}`,
      );
    }
    const selectedTools = requested.map((name) => toolByName[name]);
    const selectedToolNames = requested;

    // Track lifecycle ownership flags so cleanup runs in reverse order regardless of failure point.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let env: any | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let worker: any | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any | undefined;
    let workerStarted = false;
    let clientStarted = false;
    let abortHandler: (() => void) | undefined;

    const startedAt = Date.now();
    let sessionId = "";
    let finalResponse = "";
    let cmsState: string | undefined;

    try {
      const envFactory = this.deps.createEnv ?? createTestEnv;
      env = envFactory(`eval_${sample.id}`);

      const WorkerCtor = (this.deps.WorkerCtor ?? PilotSwarmWorker) as AnyCtor;
      const ClientCtor = (this.deps.ClientCtor ?? PilotSwarmClient) as AnyCtor;

      const workerNodeId = `eval-${randomBytes(4).toString("hex")}`;

      worker = new WorkerCtor({
        store: opts.store ?? env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId,
        disableManagementAgents: true,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
      });
      if (selectedTools.length > 0) worker.registerTools(selectedTools);
      await worker.start();
      workerStarted = true;

      client = new ClientCtor({
        store: opts.store ?? env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
      });
      await client.start();
      clientStarted = true;

      const sessionConfig: {
        systemMessage?: string;
        model?: string;
        toolNames?: string[];
      } = {};
      if (sample.input.systemMessage) sessionConfig.systemMessage = sample.input.systemMessage;
      if (opts.model) sessionConfig.model = opts.model;
      if (selectedToolNames.length > 0) sessionConfig.toolNames = selectedToolNames;

      const session = await client.createSession(sessionConfig);
      sessionId = session.sessionId;
      worker.setSessionConfig(sessionId, { ...sessionConfig, tools: selectedTools });

      // Race the prompt against the AbortSignal so an external abort (e.g. Runner timeout)
      // unblocks us promptly and lets the finally block tear everything down.
      const sendPromise = session.sendAndWait(sample.input.prompt, opts.timeout);
      let abortPromise: Promise<never> | undefined;
      if (opts.signal) {
        if (opts.signal.aborted) {
          throw new Error(`LiveDriver: aborted before send for sample "${sample.id}"`);
        }
        abortPromise = new Promise<never>((_, reject) => {
          abortHandler = () => reject(new Error(`LiveDriver: aborted via signal for sample "${sample.id}"`));
          opts.signal!.addEventListener("abort", abortHandler, { once: true });
        });
      }
      const response = abortPromise
        ? await Promise.race([sendPromise, abortPromise])
        : await sendPromise;
      finalResponse = (response as string | undefined) ?? "";

      const info = await session.getInfo().catch(() => null);
      cmsState = info?.state ?? undefined;
    } finally {
      if (abortHandler && opts.signal) {
        try {
          opts.signal.removeEventListener("abort", abortHandler);
        } catch {
          /* ignore */
        }
      }
      if (clientStarted && client) {
        try {
          await client.stop();
        } catch {
          /* ignore */
        }
      }
      if (workerStarted && worker) {
        try {
          await worker.stop();
        } catch {
          /* ignore */
        }
      }
      if (env) {
        try {
          await env.cleanup();
        } catch {
          /* ignore */
        }
      }
    }

    const latencyMs = Date.now() - startedAt;
    const toolCalls: ObservedToolCall[] = extractObservedCalls(tracker);

    const result: ObservedResult = {
      toolCalls,
      finalResponse,
      sessionId,
      latencyMs,
    };
    if (opts.model) result.model = opts.model;
    if (cmsState) result.cmsState = cmsState;
    return result;
  }

  async dispose(): Promise<void> {
    // No persistent state to clean up — each run() creates its own env.
  }
}
