import { randomUUID } from "node:crypto";
import type { JobExternalOperationRow, SessionCatalog } from "./cms.js";

export interface JobExternalOperationSignalSender {
    sendSystemSignal(sessionId: string, signalKey: string, payload?: unknown): Promise<void>;
}

export type JobExternalOperationProducerStore = Pick<
    SessionCatalog,
    | "claimDueJobExternalOperations"
    | "completeJobExternalOperation"
    | "claimJobExternalOperationSignals"
    | "markJobExternalOperationSignalDelivered"
    | "markJobExternalOperationSignalFailed"
>;

export interface MockJobExternalOperationProducerOptions {
    store: JobExternalOperationProducerStore;
    signalSender: JobExternalOperationSignalSender;
    workerId?: string;
    pollIntervalMs?: number;
    retryDelayMs?: number;
    claimLimit?: number;
    leaseSeconds?: number;
    logger?: Pick<Console, "info" | "warn" | "error">;
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

function mockCompletion(operation: JobExternalOperationRow): {
    status: "succeeded" | "failed";
    result: unknown;
    evidence: unknown;
    error: string | null;
} {
    const requestedOutcome = operation.request.outcome;
    const outcome = requestedOutcome === undefined || requestedOutcome === "succeeded"
        ? "succeeded"
        : "failed";
    const invalidOutcome = requestedOutcome !== undefined
        && requestedOutcome !== "succeeded"
        && requestedOutcome !== "failed";
    const result = operation.request.result ?? {
        mock: true,
        provider: operation.provider,
        kind: operation.kind,
        correlationId: operation.correlationId,
        outcome,
    };
    const evidence = operation.request.evidence ?? {
        mock: true,
        provider: operation.provider,
        kind: operation.kind,
        correlationId: operation.correlationId,
    };
    return {
        status: outcome,
        result,
        evidence,
        error: outcome === "failed"
            ? String(
                invalidOutcome
                    ? "Mock external operation outcome must be succeeded or failed"
                    : operation.request.error || `Mock ${operation.kind} operation failed`,
            )
            : null,
    };
}

export class MockJobExternalOperationProducer {
    private readonly store: JobExternalOperationProducerStore;
    private readonly signalSender: JobExternalOperationSignalSender;
    private readonly workerId: string;
    private readonly pollIntervalMs: number;
    private readonly retryDelayMs: number;
    private readonly claimLimit: number;
    private readonly leaseSeconds: number;
    private readonly logger: Pick<Console, "info" | "warn" | "error">;

    constructor(options: MockJobExternalOperationProducerOptions) {
        this.store = options.store;
        this.signalSender = options.signalSender;
        this.workerId = options.workerId ?? `mock-external-operation-${randomUUID()}`;
        this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 500, "pollIntervalMs");
        this.retryDelayMs = positiveInteger(options.retryDelayMs ?? 1_000, "retryDelayMs");
        this.claimLimit = positiveInteger(options.claimLimit ?? 25, "claimLimit");
        this.leaseSeconds = positiveInteger(options.leaseSeconds ?? 30, "leaseSeconds");
        this.logger = options.logger ?? console;
    }

    async runOnce(): Promise<{ completed: number; delivered: number; deliveryFailed: number }> {
        let completed = 0;
        let delivered = 0;
        let deliveryFailed = 0;
        const operations = await this.store.claimDueJobExternalOperations(
            "mock",
            this.workerId,
            this.claimLimit,
            this.leaseSeconds,
        );
        for (const operation of operations) {
            try {
                const completion = mockCompletion(operation);
                await this.store.completeJobExternalOperation({
                    operationId: operation.operationId,
                    workerId: this.workerId,
                    ...completion,
                });
                completed += 1;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `[job-external-operation] completion failed operation=${operation.operationId}: ${message}`,
                );
            }
        }

        const signals = await this.store.claimJobExternalOperationSignals(
            this.workerId,
            this.claimLimit,
            this.leaseSeconds,
        );
        for (const operation of signals) {
            try {
                await this.signalSender.sendSystemSignal(
                    operation.sessionId,
                    operation.signalKey,
                    {
                        operationId: operation.operationId,
                        correlationId: operation.correlationId,
                        provider: operation.provider,
                        kind: operation.kind,
                        status: operation.status,
                        result: operation.result,
                        evidence: operation.evidence,
                        error: operation.error,
                    },
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `[job-external-operation] signal delivery failed operation=${operation.operationId}: ${message}`,
                );
                try {
                    await this.store.markJobExternalOperationSignalFailed(
                        operation.operationId,
                        this.workerId,
                        message,
                        new Date(Date.now() + this.retryDelayMs),
                    );
                } catch (markError) {
                    this.logger.warn(
                        `[job-external-operation] signal retry bookkeeping failed operation=${operation.operationId}: `
                        + `${markError instanceof Error ? markError.message : String(markError)}`,
                    );
                }
                deliveryFailed += 1;
                continue;
            }
            try {
                await this.store.markJobExternalOperationSignalDelivered(
                    operation.operationId,
                    this.workerId,
                );
                delivered += 1;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `[job-external-operation] signal delivery bookkeeping failed operation=${operation.operationId}: ${message}`,
                );
            }
        }
        return { completed, delivered, deliveryFailed };
    }

    async run(signal?: AbortSignal): Promise<void> {
        while (!signal?.aborted) {
            try {
                await this.runOnce();
            } catch (error) {
                this.logger.error("[job-external-operation] producer poll failed", error);
            }
            if (signal?.aborted) break;
            await waitForPoll(this.pollIntervalMs, signal);
        }
    }
}
