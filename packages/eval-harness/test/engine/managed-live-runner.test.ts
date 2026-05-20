import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runManagedLiveScenarios } from "../../src/engine/managed-live-runner.js";
import type { RunConfig, Scenario } from "../../src/types.js";

describe("managed live runner", () => {
  it("runs shared-worker scenarios through a harness-owned worker pool", async () => {
    const envLabels: string[] = [];
    const workerOptions: Array<Record<string, unknown>> = [];
    const startedWorkers: string[] = [];
    const stoppedWorkers: string[] = [];
    const sessionConfigs = new Map<string, Record<string, any>>();
    const promptsBySession = new Map<string, string[]>();
    let sessionCounter = 0;

    class FakeWorker {
      readonly id: string;

      constructor(options: Record<string, unknown>) {
        this.id = String(options.workerNodeId);
        workerOptions.push(options);
      }

      registerTools(): void {}

      setSessionConfig(sessionId: string, config: Record<string, any>): void {
        sessionConfigs.set(sessionId, config);
      }

      async start(): Promise<void> {
        startedWorkers.push(this.id);
      }

      async stop(): Promise<void> {
        stoppedWorkers.push(this.id);
      }
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}

      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: (prompt: string) => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<Array<{ eventType: string; createdAt: string; data?: Record<string, unknown> }>>;
      }> {
        const sessionId = `session-${++sessionCounter}`;
        promptsBySession.set(sessionId, []);
        return {
          sessionId,
          async sendAndWait(prompt: string) {
            promptsBySession.get(sessionId)?.push(prompt);
            if (prompt.includes("test_add")) {
              const tool = sessionConfigs.get(sessionId)?.tools?.find((candidate: { name: string }) => candidate.name === "test_add");
              const result = await tool.handler({ a: 1, b: 2 });
              return `sum=${result}`;
            }
            return prompt.includes("recall") ? "CODE: blue-17" : "stored";
          },
          async getInfo() {
            return { status: "idle" };
          },
          async getMessages() {
            const prompts = promptsBySession.get(sessionId) ?? [];
            const events: Array<{ eventType: string; createdAt: string; data?: Record<string, unknown> }> = [];
            prompts.forEach((prompt, index) => {
              events.push({ eventType: "session.turn_started", createdAt: `2026-05-18T00:00:0${index}.000Z` });
              if (prompt.includes("test_add")) {
                events.push({
                  eventType: "tool.execution_start",
                  createdAt: `2026-05-18T00:00:0${index}.500Z`,
                  data: { toolName: "test_add", arguments: { a: 1, b: 2 }, toolCallId: `call-${sessionId}` },
                });
              }
              events.push({ eventType: "session.turn_completed", createdAt: `2026-05-18T00:00:0${index}.900Z` });
            });
            return events;
          },
        };
      }
    }

    const config = {
      id: "unit-live",
      defaults: { driver: "live", concurrent: 2, isolation: "shared-worker", timeoutMs: 1000 },
      reporters: [],
    } as unknown as RunConfig;
    const scenarios: Scenario[] = [
      {
        schemaVersion: 1,
        kind: "single-turn",
        id: "live.pool.add",
        description: "Add through a managed worker pool.",
        tools: ["test_add"],
        input: { prompt: "Use test_add to add 1 and 2." },
        checks: [
          { type: "tool-call", name: "test_add", args: { a: 1, b: 2 }, match: "subset" },
          { type: "response-contains", any: ["3"] },
        ],
      },
      {
        schemaVersion: 1,
        kind: "multi-turn",
        id: "live.pool.multi-turn",
        description: "Preserve context across turns.",
        turns: [
          { input: { prompt: "Remember blue-17." }, checks: [] },
          { input: { prompt: "recall it." }, checks: [] },
        ],
        checks: [
          { type: "response-contains", any: ["blue-17"] },
          { type: "cms-event-count", event: "session.turn_started", min: 2 },
        ],
      },
    ];

    const results = await runManagedLiveScenarios(scenarios, config, {
      createEnv(label) {
        envLabels.push(label);
        return {
          store: "postgresql://unit",
          duroxideSchema: `${label}_duro`,
          cmsSchema: `${label}_cms`,
          factsSchema: `${label}_facts`,
          sessionStateDir: `/tmp/${label}`,
          cleanup: async () => {},
        };
      },
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });

    expect(envLabels).toEqual(["eval_live_shared"]);
    expect(workerOptions).toHaveLength(2);
    expect(startedWorkers).toHaveLength(2);
    expect(stoppedWorkers).toHaveLength(2);
    expect(results.map((result) => result.passed)).toEqual([true, true]);
    expect(results.map((result) => result.metadata?.managedWorkerCount)).toEqual([2, 2]);
    expect(results[0]?.observed.toolCalls).toEqual([
      { name: "test_add", args: { a: 1, b: 2 }, result: 3, callId: "call-session-1", turnIndex: 0 },
    ]);
  });

  it("injects supported worker-restart chaos by replacing a managed worker", async () => {
    const workerEvents: string[] = [];
    const sessionConfigs = new Map<string, Record<string, any>>();

    class FakeWorker {
      readonly id: string;

      constructor(options: Record<string, unknown>) {
        this.id = String(options.workerNodeId);
      }

      registerTools(): void {}

      setSessionConfig(sessionId: string, config: Record<string, any>): void {
        sessionConfigs.set(sessionId, config);
      }

      async start(): Promise<void> {
        workerEvents.push(`start:${this.id}`);
      }

      async stop(): Promise<void> {
        workerEvents.push(`stop:${this.id}`);
      }
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: () => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<Array<{ eventType: string; createdAt: string; data?: Record<string, unknown> }>>;
      }> {
        const sessionId = "chaos-session";
        return {
          sessionId,
          async sendAndWait() {
            const tool = sessionConfigs.get(sessionId)?.tools?.find((candidate: { name: string }) => candidate.name === "test_add");
            const result = await tool.handler({ a: 4, b: 5 });
            return `sum=${result}`;
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return [
              { eventType: "session.turn_started", createdAt: "2026-05-18T00:00:00.000Z" },
              { eventType: "session.dehydrated", createdAt: "2026-05-18T00:00:00.200Z" },
              { eventType: "session.hydrated", createdAt: "2026-05-18T00:00:00.300Z" },
              { eventType: "session.turn_completed", createdAt: "2026-05-18T00:00:01.000Z" },
            ];
          },
        };
      }
    }

    const config = {
      id: "unit-live-chaos",
      defaults: { driver: "live", concurrent: 1, isolation: "fresh-worker", timeoutMs: 1000 },
      reporters: [],
    } as unknown as RunConfig;
    const scenarios: Scenario[] = [
      {
        schemaVersion: 1,
        kind: "durable-trajectory",
        id: "chaos.worker-restart",
        description: "Supported worker restart injection.",
        tools: ["test_add"],
        input: { prompt: "Add 4 and 5 with test_add." },
        chaos: { injectAt: "after-tool-call-1", type: "worker-restart", onTargetMissing: "error" },
        checks: [
          { type: "tool-call", name: "test_add", args: { a: 4, b: 5 }, match: "subset" },
          { type: "response-contains", any: ["9"] },
        ],
      },
    ];

    const results = await runManagedLiveScenarios(scenarios, config, {
      createEnv(label) {
        return {
          store: "postgresql://unit",
          duroxideSchema: `${label}_duro`,
          cmsSchema: `${label}_cms`,
          factsSchema: `${label}_facts`,
          sessionStateDir: `/tmp/${label}`,
          cleanup: async () => {},
        };
      },
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });

    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.metadata?.chaos).toMatchObject({ injected: true, type: "worker-restart", action: "replace-worker" });
    expect(workerEvents.filter((event) => event.startsWith("start:"))).toHaveLength(2);
    expect(workerEvents.filter((event) => event.startsWith("stop:"))).toHaveLength(2);
  });

  it("fails hard crash chaos as unsupported instead of simulating it with graceful stop", async () => {
    class FakeWorker {
      constructor(_options: Record<string, unknown>) {}
      registerTools(): void {}
      setSessionConfig(): void {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: () => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<[]>;
      }> {
        return {
          sessionId: "unsupported-chaos",
          async sendAndWait() {
            return "done";
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return [];
          },
        };
      }
    }

    const config = {
      id: "unit-live-unsupported-chaos",
      defaults: { driver: "live", concurrent: 1, isolation: "fresh-worker", timeoutMs: 1000 },
      reporters: [],
    } as unknown as RunConfig;
    const scenarios: Scenario[] = [
      {
        schemaVersion: 1,
        kind: "durable-trajectory",
        id: "chaos.worker-crash",
        description: "Hard crash injection is reserved until a subprocess crash controller exists.",
        input: { prompt: "Say done." },
        chaos: { injectAt: "after-tool-call-1", type: "worker-crash", onTargetMissing: "error" },
        checks: [{ type: "response-contains", any: ["done"] }],
      },
    ];

    const results = await runManagedLiveScenarios(scenarios, config, {
      createEnv(label) {
        return {
          store: "postgresql://unit",
          duroxideSchema: `${label}_duro`,
          cmsSchema: `${label}_cms`,
          factsSchema: `${label}_facts`,
          sessionStateDir: `/tmp/${label}`,
          cleanup: async () => {},
        };
      },
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });

    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.infraError).toBe(true);
    expect(results[0]?.failureMessage).toContain("not supported");
    expect(results[0]?.metadata?.chaos).toMatchObject({ injected: false, type: "worker-crash" });
  });

  it("uses a fresh harness-owned worker for fresh-worker scenarios", async () => {
    const envLabels: string[] = [];
    let workerStarts = 0;

    class FakeWorker {
      constructor(_options: Record<string, unknown>) {}
      registerTools(): void {}
      setSessionConfig(): void {}
      async start(): Promise<void> {
        workerStarts += 1;
      }
      async stop(): Promise<void> {}
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: () => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<[]>;
      }> {
        return {
          sessionId: `fresh-${workerStarts}`,
          async sendAndWait() {
            return "done";
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return [];
          },
        };
      }
    }

    const config = {
      id: "unit-live-fresh",
      defaults: { driver: "live", concurrent: 4, isolation: "shared-worker", timeoutMs: 1000 },
      reporters: [],
    } as unknown as RunConfig;
    const scenarios = [
      {
        schemaVersion: 1,
        kind: "single-turn",
        id: "fresh.one",
        description: "Fresh one.",
        requirements: { isolation: "fresh-worker" },
        input: { prompt: "Say done." },
        checks: [{ type: "response-contains", any: ["done"] }],
      },
      {
        schemaVersion: 1,
        kind: "single-turn",
        id: "fresh.two",
        description: "Fresh two.",
        requirements: { isolation: "fresh-worker" },
        input: { prompt: "Say done." },
        checks: [{ type: "response-contains", any: ["done"] }],
      },
    ] as unknown as Scenario[];

    const results = await runManagedLiveScenarios(scenarios, config, {
      createEnv(label) {
        envLabels.push(label);
        return {
          store: "postgresql://unit",
          duroxideSchema: `${label}_duro`,
          cmsSchema: `${label}_cms`,
          factsSchema: `${label}_facts`,
          sessionStateDir: `/tmp/${label}`,
          cleanup: async () => {},
        };
      },
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });

    expect([...envLabels].sort()).toEqual(["eval_live_fresh_one", "eval_live_fresh_two"]);
    expect(workerStarts).toBe(2);
    expect(results.map((result) => result.metadata?.isolation)).toEqual(["fresh-worker", "fresh-worker"]);
    expect(results.map((result) => result.passed)).toEqual([true, true]);
  });

  it("passes scenario prompt overrides as managed live custom agents", async () => {
    const workerOptions: Array<Record<string, unknown>> = [];
    const createSessionConfigs: Array<Record<string, unknown>> = [];
    const setSessionConfigs: Array<Record<string, any>> = [];

    class FakeWorker {
      constructor(options: Record<string, unknown>) {
        workerOptions.push(options);
      }
      registerTools(): void {}
      setSessionConfig(_sessionId: string, config: Record<string, any>): void {
        setSessionConfigs.push(config);
      }
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(config: Record<string, unknown>): Promise<{
        sessionId: string;
        sendAndWait: () => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<[]>;
      }> {
        createSessionConfigs.push(config);
        return {
          sessionId: "prompt-override-session",
          async sendAndWait() {
            return "ok";
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return [];
          },
        };
      }
    }

    const config = {
      id: "unit-live-prompt-overrides",
      defaults: { driver: "live", concurrent: 2, isolation: "shared-worker", timeoutMs: 1000 },
      worker: {
        customAgents: [
          { name: "incident-conductor", prompt: "Original config prompt.", description: "Config agent" },
          { name: "resource-manager", prompt: "Keep resources tidy." },
        ],
      },
      reporters: [],
    } as unknown as RunConfig;
    const scenarios: Scenario[] = [
      {
        schemaVersion: 1,
        kind: "single-turn",
        id: "prompt.override",
        description: "Prompt override scenario.",
        agent: "incident-conductor",
        input: { prompt: "Say ok." },
        promptOverrides: {
          "incident-conductor": {
            inline: "Scenario override prompt.",
            frontmatter: {
              description: "Scenario override agent",
              tools: ["test_add"],
            },
          },
        },
        checks: [{ type: "response-contains", any: ["ok"] }],
      },
    ];

    const results = await runManagedLiveScenarios(scenarios, config, {
      createEnv(label) {
        return {
          store: "postgresql://unit",
          duroxideSchema: `${label}_duro`,
          cmsSchema: `${label}_cms`,
          factsSchema: `${label}_facts`,
          sessionStateDir: `/tmp/${label}`,
          cleanup: async () => {},
        };
      },
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });

    expect(results[0]?.passed).toBe(true);
    expect(workerOptions).toHaveLength(1);
    expect(workerOptions[0]?.customAgents).toEqual([
      {
        name: "resource-manager",
        prompt: "Keep resources tidy.",
      },
      {
        name: "incident-conductor",
        prompt: "Scenario override prompt.",
        description: "Scenario override agent",
        tools: ["test_add"],
      },
    ]);
    expect(createSessionConfigs[0]).toMatchObject({
      agentId: "incident-conductor",
      boundAgentName: "incident-conductor",
      promptLayering: { kind: "app-agent" },
    });
    expect(setSessionConfigs[0]).toMatchObject({
      agentId: "incident-conductor",
      boundAgentName: "incident-conductor",
      promptLayering: { kind: "app-agent" },
    });
  });

  it("resolves worker plugin and skill directories relative to the run config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-harness-worker-paths-"));
    const configPath = join(dir, "eval", "runs", "smoke", "config.json");
    const workerOptions: Array<Record<string, unknown>> = [];

    class FakeWorker {
      constructor(options: Record<string, unknown>) {
        workerOptions.push(options);
      }
      registerTools(): void {}
      setSessionConfig(): void {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: () => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<[]>;
      }> {
        return {
          sessionId: "worker-paths",
          async sendAndWait() {
            return "ok";
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return [];
          },
        };
      }
    }

    const config = {
      configPath,
      id: "unit-live-worker-paths",
      defaults: { driver: "live", concurrent: 1, isolation: "shared-worker", timeoutMs: 1000 },
      worker: {
        pluginDirs: ["../../agents", "/already/absolute/plugin"],
        skillDirectories: ["../../skills"],
      },
      reporters: [],
    } as unknown as RunConfig;
    const scenarios: Scenario[] = [
      {
        schemaVersion: 1,
        kind: "single-turn",
        id: "worker.paths",
        description: "Worker path resolution.",
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
      },
    ];

    const results = await runManagedLiveScenarios(scenarios, config, {
      createEnv(label) {
        return {
          store: "postgresql://unit",
          duroxideSchema: `${label}_duro`,
          cmsSchema: `${label}_cms`,
          factsSchema: `${label}_facts`,
          sessionStateDir: `/tmp/${label}`,
          cleanup: async () => {},
        };
      },
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });

    expect(results[0]?.passed).toBe(true);
    expect(workerOptions[0]?.pluginDirs).toEqual([
      join(dir, "eval", "agents"),
      "/already/absolute/plugin",
    ]);
    expect(workerOptions[0]?.skillDirectories).toEqual([
      join(dir, "eval", "skills"),
    ]);
  });

  it("respects config default fresh-worker isolation for ablation-expanded cells without scenario requirements", async () => {
    const envLabels: string[] = [];
    let workerStarts = 0;

    class FakeWorker {
      constructor(_options: Record<string, unknown>) {}
      registerTools(): void {}
      setSessionConfig(): void {}
      async start(): Promise<void> {
        workerStarts += 1;
      }
      async stop(): Promise<void> {}
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: () => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<[]>;
      }> {
        return {
          sessionId: "cell-default-fresh",
          async sendAndWait() {
            return "ok";
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return [];
          },
        };
      }
    }

    const config = {
      id: "unit-live-cell-default-fresh",
      defaults: { driver: "live", concurrent: 2, isolation: "fresh-worker", timeoutMs: 1000 },
      reporters: [],
    } as unknown as RunConfig;
    const scenarios: Scenario[] = [
      {
        schemaVersion: 1,
        kind: "single-turn",
        id: "meta.model-sweep::model=github-copilot_gpt-5.4::trial=1",
        description: "Ablation-expanded cell.",
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
        metadata: {
          evalCell: {
            metaScenarioId: "meta.model-sweep",
            baseScenarioId: "base.model-sweep",
            model: "github-copilot:gpt-5.4",
            trial: 1,
          },
        },
      },
    ];

    const results = await runManagedLiveScenarios(scenarios, config, {
      createEnv(label) {
        envLabels.push(label);
        return {
          store: "postgresql://unit",
          duroxideSchema: `${label}_duro`,
          cmsSchema: `${label}_cms`,
          factsSchema: `${label}_facts`,
          sessionStateDir: `/tmp/${label}`,
          cleanup: async () => {},
        };
      },
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });

    expect(envLabels).toHaveLength(1);
    expect(envLabels[0]).not.toBe("eval_live_shared");
    expect(workerStarts).toBe(1);
    expect(results[0]?.metadata?.isolation).toBe("fresh-worker");
    expect(results[0]?.passed).toBe(true);
  });

  it("uses the eval config default timeout when scenario and run config omit one", async () => {
    const timeouts: unknown[] = [];

    class FakeWorker {
      constructor(_options: Record<string, unknown>) {}
      registerTools(): void {}
      setSessionConfig(): void {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: (prompt: string, timeoutMs?: number) => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<[]>;
      }> {
        return {
          sessionId: "default-timeout",
          async sendAndWait(_prompt: string, timeoutMs?: number) {
            timeouts.push(timeoutMs);
            return "ok";
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return [];
          },
        };
      }
    }

    const config = {
      id: "unit-live-default-timeout",
      defaults: { driver: "live", concurrent: 1, isolation: "shared-worker" },
      reporters: [],
    } as unknown as RunConfig;
    const scenarios: Scenario[] = [
      {
        schemaVersion: 1,
        kind: "single-turn",
        id: "timeout.default",
        description: "Default timeout.",
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
      },
    ];

    const results = await runManagedLiveScenarios(scenarios, config, {
      createEnv(label) {
        return {
          store: "postgresql://unit",
          duroxideSchema: `${label}_duro`,
          cmsSchema: `${label}_cms`,
          factsSchema: `${label}_facts`,
          sessionStateDir: `/tmp/${label}`,
          cleanup: async () => {},
        };
      },
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });

    expect(results[0]?.passed).toBe(true);
    expect(timeouts).toEqual([240_000]);
  });

  it("preserves meta-scenario cell metadata on managed live results", async () => {
    class FakeWorker {
      constructor(_options: Record<string, unknown>) {}
      registerTools(): void {}
      setSessionConfig(): void {}
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
    }

    class FakeClient {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async createSession(): Promise<{
        sessionId: string;
        sendAndWait: () => Promise<string>;
        getInfo: () => Promise<{ status: string }>;
        getMessages: () => Promise<[]>;
      }> {
        return {
          sessionId: "cell-metadata",
          async sendAndWait() {
            return "ok";
          },
          async getInfo() {
            return { status: "completed" };
          },
          async getMessages() {
            return [];
          },
        };
      }
    }

    const config = {
      id: "unit-live-cell-metadata",
      defaults: { driver: "live", concurrent: 1, isolation: "shared-worker", timeoutMs: 1000 },
      reporters: [],
    } as unknown as RunConfig;
    const scenarios: Scenario[] = [
      {
        schemaVersion: 1,
        kind: "single-turn",
        id: "meta.model-sweep::model=github-copilot_gpt-5.4::trial=1",
        description: "Model cell.",
        input: { prompt: "Say ok." },
        checks: [{ type: "response-contains", any: ["ok"] }],
        metadata: {
          evalCell: {
            metaScenarioId: "meta.model-sweep",
            baseScenarioId: "base.model-sweep",
            model: "github-copilot:gpt-5.4",
            trial: 1,
          },
        },
      },
    ];

    const results = await runManagedLiveScenarios(scenarios, config, {
      createEnv(label) {
        return {
          store: "postgresql://unit",
          duroxideSchema: `${label}_duro`,
          cmsSchema: `${label}_cms`,
          factsSchema: `${label}_facts`,
          sessionStateDir: `/tmp/${label}`,
          cleanup: async () => {},
        };
      },
      WorkerCtor: FakeWorker,
      ClientCtor: FakeClient,
    });

    expect(results[0]?.metadata).toMatchObject({
      driver: "live",
      metaScenarioId: "meta.model-sweep",
      baseScenarioId: "base.model-sweep",
      model: "github-copilot:gpt-5.4",
      trial: 1,
    });
  });
});
