import { randomUUID } from "node:crypto";
import type {
    ContextTier,
    JobGeneratorDefinitionRow,
    JobGeneratorRow,
    JobRow,
    JobSessionRow,
    PilotSwarmClient,
    ReasoningEffort,
    SessionCatalog,
} from "pilotswarm-sdk";
import type { SourceEvaluator } from "./providers.js";

export type JobGeneratorStore = Pick<
    SessionCatalog,
    | "claimDueJobGenerators"
    | "beginJobGeneratorCycle"
    | "getJobGeneratorDefinition"
    | "completeJobGeneratorCycle"
    | "reconcileJobGeneratorDiscoveries"
    | "listJobsNeedingSession"
    | "reserveJobSession"
    | "attachJobSession"
    | "failJobSession"
    | "listJobSessions"
>;

export interface InitialSessionFactory {
    createInitialSession(input: {
        generator: JobGeneratorRow;
        definition: JobGeneratorDefinitionRow;
        job: JobRow;
        association: JobSessionRow;
    }): Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function reasoningEffortValue(value: unknown): ReasoningEffort | undefined {
    const normalized = stringValue(value);
    if (!normalized) return undefined;
    const allowed: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
    if (!allowed.includes(normalized as ReasoningEffort)) {
        throw new Error(`Unsupported reasoning effort: ${normalized}`);
    }
    return normalized as ReasoningEffort;
}

function contextTierValue(value: unknown): ContextTier | undefined {
    const normalized = stringValue(value);
    if (!normalized) return undefined;
    if (normalized !== "default" && normalized !== "long_context") {
        throw new Error(`Unsupported context tier: ${normalized}`);
    }
    return normalized;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return value;
}

function waitForPoll(intervalMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, intervalMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

function renderPrompt(template: string, job: JobRow): string {
    return template
        .replaceAll("{job.key}", job.jobKey)
        .replaceAll("{job.payload}", JSON.stringify(job.sourcePayload, null, 2))
        .replaceAll("{job.id}", job.jobId);
}

export class PilotSwarmInitialSessionFactory implements InitialSessionFactory {
    constructor(private readonly client: PilotSwarmClient) {}

    async createInitialSession(input: {
        generator: JobGeneratorRow;
        definition: JobGeneratorDefinitionRow;
        job: JobRow;
        association: JobSessionRow;
    }): Promise<void> {
        const lifecycle = object(input.definition.lifecycleDefinition);
        const sessionConfig = object(lifecycle.session);
        const affinities = object(input.definition.affinities);
        const initialPrompt = stringValue(lifecycle.initialPrompt)
            ?? "Process JobGenerator item {job.key}:\n{job.payload}";
        const session = await this.client.createSession({
            sessionId: input.association.sessionId,
            model: stringValue(sessionConfig.model),
            reasoningEffort: reasoningEffortValue(sessionConfig.reasoningEffort),
            contextTier: contextTierValue(sessionConfig.contextTier),
            systemMessage: stringValue(sessionConfig.systemMessage),
            agentId: stringValue(sessionConfig.agentName),
            boundAgentName: stringValue(sessionConfig.agentName),
            promptLayering: stringValue(sessionConfig.agentName) ? { kind: "app-agent" } : undefined,
            repo: stringValue(sessionConfig.repo) ?? stringValue(affinities.repo),
            gitRef: stringValue(sessionConfig.gitRef) ?? stringValue(affinities.gitRef),
            toolNames: Array.isArray(sessionConfig.toolNames)
                ? sessionConfig.toolNames.filter((value): value is string => typeof value === "string")
                : undefined,
            owner: input.generator.owner,
        });
        await session.send(renderPrompt(initialPrompt, input.job), {
            bootstrap: true,
            clientMessageIds: [`job-generator:${input.job.jobId}:initial`],
        });
    }
}

export interface JobGeneratorControllerOptions {
    store: JobGeneratorStore;
    evaluators: Map<string, SourceEvaluator>;
    sessionFactory?: InitialSessionFactory;
    induceSessions?: boolean;
    workerId?: string;
    pollIntervalMs?: number;
    claimLimit?: number;
    leaseSeconds?: number;
    logger?: Pick<Console, "info" | "error" | "warn">;
}

export class JobGeneratorController {
    private readonly store: JobGeneratorStore;
    private readonly evaluators: Map<string, SourceEvaluator>;
    private readonly sessionFactory?: InitialSessionFactory;
    private readonly induceSessions: boolean;
    private readonly workerId: string;
    private readonly pollIntervalMs: number;
    private readonly claimLimit: number;
    private readonly leaseSeconds: number;
    private readonly logger: Pick<Console, "info" | "error" | "warn">;

    constructor(options: JobGeneratorControllerOptions) {
        this.store = options.store;
        this.evaluators = options.evaluators;
        this.sessionFactory = options.sessionFactory;
        this.induceSessions = options.induceSessions ?? true;
        if (this.induceSessions && !this.sessionFactory) {
            throw new Error("sessionFactory is required when session induction is enabled");
        }
        this.workerId = options.workerId ?? `job-generator-${randomUUID()}`;
        this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 15_000, "pollIntervalMs");
        this.claimLimit = positiveInteger(options.claimLimit ?? 10, "claimLimit");
        this.leaseSeconds = positiveInteger(options.leaseSeconds ?? 300, "leaseSeconds");
        this.logger = options.logger ?? console;
    }

    async runOnce(): Promise<number> {
        const generators = await this.store.claimDueJobGenerators(
            this.workerId,
            this.claimLimit,
            this.leaseSeconds,
        );
        this.logger.info(`[job-generator] poll claimed=${generators.length}`);
        for (const generator of generators) {
            try {
                await this.processGenerator(generator);
            } catch (error) {
                this.logger.error(`[job-generator] ${generator.generatorId} failed`, error);
            }
        }
        return generators.length;
    }

    async run(signal?: AbortSignal): Promise<void> {
        while (!signal?.aborted) {
            try {
                await this.runOnce();
            } catch (error) {
                this.logger.error("[job-generator] polling failed", error);
            }
            if (signal?.aborted) break;
            await waitForPoll(this.pollIntervalMs, signal);
        }
    }

    private async processGenerator(generator: JobGeneratorRow): Promise<void> {
        const { cycle, definition } = await this.store.beginJobGeneratorCycle(
            generator.generatorId,
            this.workerId,
        );
        this.logger.info(
            `[job-generator] ${generator.name}: evaluating source=${definition.sourceType} cycle=${cycle.cycleId}`,
        );
        let discoveredCount = 0;
        let createdCount = 0;
        try {
            const evaluator = this.evaluators.get(definition.sourceType);
            if (!evaluator) throw new Error(`No evaluator configured for ${definition.sourceType}`);
            const evaluation = await evaluator.evaluate({
                generator,
                definition,
                watermark: cycle.watermarkBefore,
            });
            discoveredCount = evaluation.discoveries.length;
            const maxItems = Number(definition.guardrails.maxItemsPerCycle ?? 0);
            if (Number.isFinite(maxItems) && maxItems > 0 && discoveredCount > maxItems) {
                throw new Error(`Provider returned ${discoveredCount} items, exceeding maxItemsPerCycle=${maxItems}`);
            }

            const reconciledJobs = await this.store.reconcileJobGeneratorDiscoveries(
                cycle.cycleId,
                evaluation.discoveries,
            );
            createdCount = reconciledJobs.filter((job) => job.created).length;
            const sessionErrors: Error[] = [];
            if (this.induceSessions) {
                const jobs = new Map<string, JobRow>();
                for (const job of reconciledJobs) jobs.set(job.jobId, job);
                for (const job of await this.store.listJobsNeedingSession(generator.generatorId)) {
                    jobs.set(job.jobId, job);
                }
                for (const job of jobs.values()) {
                    const history = await this.store.listJobSessions(job.jobId);
                    const current = history.find((entry) => entry.isCurrent);
                    if (current?.status === "unacked" || current?.status === "active") continue;
                    const association = current ?? await this.store.reserveJobSession(
                        job.jobId,
                        cycle.cycleId,
                        this.workerId,
                    );
                    const jobDefinition = job.definitionId === definition.definitionId
                        ? definition
                        : await this.store.getJobGeneratorDefinition(job.definitionId);
                    try {
                        await this.sessionFactory!.createInitialSession({
                            generator,
                            definition: jobDefinition,
                            job,
                            association,
                        });
                        await this.store.attachJobSession(
                            job.jobId,
                            association.sessionId,
                            cycle.cycleId,
                            this.workerId,
                        );
                    } catch (error) {
                        const failure = error instanceof Error ? error : new Error(String(error));
                        await this.store.failJobSession(
                            job.jobId,
                            association.sessionId,
                            cycle.cycleId,
                            this.workerId,
                            failure.message,
                        );
                        sessionErrors.push(failure);
                    }
                }
            }
            if (sessionErrors.length > 0) {
                throw new AggregateError(sessionErrors, `${sessionErrors.length} initial session(s) failed`);
            }
            await this.store.completeJobGeneratorCycle({
                cycleId: cycle.cycleId,
                workerId: this.workerId,
                status: "succeeded",
                watermark: evaluation.watermark,
                discoveredCount,
                createdCount,
            });
            this.logger.info(
                `[job-generator] ${generator.name}: discovered=${discoveredCount} created=${createdCount}`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.store.completeJobGeneratorCycle({
                cycleId: cycle.cycleId,
                workerId: this.workerId,
                status: "failed",
                discoveredCount,
                createdCount,
                error: message,
            });
            throw error;
        }
    }
}
