import { randomUUID } from "node:crypto";
import {
    loadLifecycleStateMarkdown,
    parseLifecycleStateTransitions,
} from "pilotswarm-sdk";
import type {
    ContextTier,
    JobGeneratorDefinitionRow,
    JobGeneratorRow,
    JobJournalEntryRow,
    JobRow,
    JobSessionRow,
    LifecycleStateReader,
    LifecycleStateSource,
    PilotSwarmClient,
    ReasoningEffort,
    SessionCatalog,
} from "pilotswarm-sdk";
import type { SourceEvaluator } from "./providers.js";

export type JobGeneratorStore = Pick<
    SessionCatalog,
    | "claimDueJobGenerators"
    | "beginJobGeneratorCycle"
    | "getJob"
    | "getJobGeneratorDefinition"
    | "completeJobGeneratorCycle"
    | "reconcileJobGeneratorDiscoveries"
    | "listJobsNeedingSession"
    | "reserveJobSession"
    | "attachJobSession"
    | "failJobSession"
    | "listJobSessions"
    | "listJobJournal"
    | "prepareJobStateRun"
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

function lifecycleConfig(definition: JobGeneratorDefinitionRow): Record<string, unknown> {
    const root = object(definition.lifecycleDefinition);
    const nested = object(root.lifecycle);
    return Object.keys(nested).length > 0 ? nested : root;
}

function lifecycleSources(value: unknown): LifecycleStateSource[] {
    if (!Array.isArray(value)) return [];
    return value.map((source) => object(source) as unknown as LifecycleStateSource);
}

function renderJournal(entries: readonly JobJournalEntryRow[]): string {
    if (entries.length === 0) return "No previous state transitions.";
    return entries.map((entry) => {
        const outcome = entry.outcome ? ` via ${entry.outcome}` : "";
        return [
            `${entry.sequence}. ${entry.fromState} -> ${entry.toState}${outcome}`,
            `   Session: ${entry.sessionId}`,
            `   Summary: ${entry.summary}`,
        ].join("\n");
    }).join("\n");
}

function renderLifecyclePrompt(input: {
    job: JobRow;
    markdown: string;
    journal: readonly JobJournalEntryRow[];
    validationGates: readonly unknown[];
    terminal: boolean;
    outcomes: readonly { outcome: string; toState: string }[];
}): string {
    const completion = input.terminal
        ? [
            "When the state work is complete, call complete_state with a non-empty summary and omit outcome.",
            "The summary must preserve the outcome, evidence, durable identifiers or references, and enough detail for later lifecycle work to continue from this Job.",
        ].join("\n")
        : [
            "When the state work is complete, call complete_state exactly once with:",
            "- outcome: one of the possible next states declared in the Markdown below",
            "- summary: a non-empty durable handoff for the next state",
            "The summary must preserve the outcome, evidence, durable identifiers or references, and enough detail for later lifecycle work to continue from this Job.",
            `Allowed outcomes: ${input.outcomes.map((entry) => entry.outcome).join(", ")}`,
        ].join("\n");
    const reachableStates = new Set(
        input.terminal
            ? []
            : input.outcomes.map((entry) => entry.toState),
    );
    const validationGates = input.validationGates.filter((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const gate = value as Record<string, unknown>;
        return gate.type === "external_operation"
            && typeof gate.beforeState === "string"
            && reachableStates.has(gate.beforeState);
    });
    return [
        `Execute Job ${input.job.jobId} in state ${input.job.currentState}.`,
        "",
        "## Job source record",
        `Key: ${input.job.jobKey}`,
        "```json",
        JSON.stringify(input.job.sourcePayload, null, 2),
        "```",
        "",
        "## Durable Job journal",
        renderJournal(input.journal),
        "",
        "Treat the journal summaries as the durable handoff from prior states. "
            + "When a summary is insufficient, follow its Session reference to inspect the prior execution context.",
        "",
        "## Durable execution rules",
        "This state may resume in the same durable session after a wait or worker replacement. "
            + "Start platform-owned work only through start_external_operation. The infrastructure owns the operation ID, "
            + "correlation ID, and signal key; never invent or simulate them. Repeating the same call after resume returns "
            + "the existing operation instead of creating a duplicate.",
        "For a human decision, call ask_user. For a platform-owned external event, call system_wait with the exact signalKey "
            + "returned by start_external_operation. After resume, call get_external_operation and inspect its durable result "
            + "and evidence. Neither kind of wait advances the lifecycle state.",
        "",
        "## Required external-operation gates",
        validationGates.length > 0
            ? JSON.stringify(validationGates, null, 2)
            : "No external-operation gates apply to the reachable next states.",
        "",
        "## Current state instructions",
        input.markdown,
        "",
        "## Completion protocol",
        completion,
    ].join("\n");
}

export class PilotSwarmInitialSessionFactory implements InitialSessionFactory {
    constructor(
        private readonly client: PilotSwarmClient,
        private readonly lifecycle?: {
            store: Pick<SessionCatalog, "listJobJournal" | "prepareJobStateRun">;
            reader: LifecycleStateReader;
        },
    ) {}

    async createInitialSession(input: {
        generator: JobGeneratorRow;
        definition: JobGeneratorDefinitionRow;
        job: JobRow;
        association: JobSessionRow;
    }): Promise<void> {
        const lifecycle = lifecycleConfig(input.definition);
        const sessionConfig = object(lifecycle.session);
        const affinities = object(input.definition.affinities);
        const initialPrompt = stringValue(lifecycle.initialPrompt)
            ?? "Process JobGenerator item {job.key}:\n{job.payload}";
        const sources = lifecycleSources(lifecycle.sources);
        let prompt = renderPrompt(initialPrompt, input.job);
        let lifecycleToolRequired = false;
        if (sources.length > 0) {
            if (!this.lifecycle) {
                throw new Error("Lifecycle state reader and catalog are required for lifecycle sources");
            }
            const loaded = await loadLifecycleStateMarkdown({
                lifecycleName: stringValue(lifecycle.name) ?? input.generator.name,
                state: input.job.currentState,
                sources,
                reader: this.lifecycle.reader,
            });
            const transitions = parseLifecycleStateTransitions(loaded.markdown);
            const journal = await this.lifecycle.store.listJobJournal(input.job.jobId);
            const sourceCommit = loaded.source.resolvedCommit;
            if (!sourceCommit) {
                throw new Error(`Lifecycle source ${loaded.source.sourceId} is not pinned to a commit`);
            }
            await this.lifecycle.store.prepareJobStateRun({
                sessionId: input.association.sessionId,
                expectedState: input.job.currentState,
                expectedRevision: input.job.stateRevision,
                stateOwner: loaded.owner,
                sourceId: loaded.source.sourceId,
                sourcePath: loaded.sourcePath,
                sourceCommit,
                markdownSha256: loaded.sha256,
                allowedOutcomes: transitions.outcomes.map((entry) => ({ ...entry })),
                terminal: transitions.terminal,
            });
            prompt = renderLifecyclePrompt({
                job: input.job,
                markdown: loaded.markdown,
                journal,
                validationGates: input.definition.validationGates,
                terminal: transitions.terminal,
                outcomes: transitions.outcomes,
            });
            lifecycleToolRequired = true;
        }
        const configuredToolNames = Array.isArray(sessionConfig.toolNames)
            ? sessionConfig.toolNames.filter((value): value is string => typeof value === "string")
            : [];
        const toolNames = lifecycleToolRequired
            ? [...new Set([
                ...configuredToolNames,
                "start_external_operation",
                "get_external_operation",
                "complete_state",
            ])]
            : configuredToolNames;
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
            toolNames: toolNames.length > 0 ? toolNames : undefined,
            owner: input.generator.owner,
        });
        await session.send(prompt, {
            bootstrap: true,
            clientMessageIds: [`job-generator:${input.job.jobId}:state:${input.job.stateRevision}`],
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
                    if (job.lifecycleState === "completed" || job.lifecycleState === "cancelled") continue;
                    const history = await this.store.listJobSessions(job.jobId);
                    const current = history.find((entry) => entry.isCurrent);
                    if (current?.status === "unacked" || current?.status === "active") continue;
                    let association: JobSessionRow | undefined;
                    try {
                        association = current ?? await this.store.reserveJobSession(
                            job.jobId,
                            cycle.cycleId,
                            this.workerId,
                        );
                        const currentJob = await this.store.getJob(job.jobId);
                        if (!currentJob) throw new Error(`Job not found after session reservation: ${job.jobId}`);
                        const jobDefinition = currentJob.definitionId === definition.definitionId
                            ? definition
                            : await this.store.getJobGeneratorDefinition(currentJob.definitionId);
                        await this.sessionFactory!.createInitialSession({
                            generator,
                            definition: jobDefinition,
                            job: currentJob,
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
                        if (association) {
                            await this.store.failJobSession(
                                job.jobId,
                                association.sessionId,
                                cycle.cycleId,
                                this.workerId,
                                failure.message,
                            );
                        }
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
