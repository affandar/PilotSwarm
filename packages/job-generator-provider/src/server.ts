import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";

import {
    normalizeProviderId,
    normalizeProviderResponse,
    parseProviderRequest,
    ProviderValidationError,
    type SourceProvider,
} from "./contracts.js";

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

export interface ProviderHostServerOptions {
    providers: ReadonlyMap<string, SourceProvider>;
    authToken: string;
    previousAuthToken?: string;
    bodyLimitBytes?: number;
    evaluateTimeoutMs?: number;
    logger?: Pick<Console, "info" | "warn" | "error">;
}

interface ProviderHostRuntimeState {
    shuttingDown: boolean;
    evaluationControllers: Set<AbortController>;
    evaluations: Set<Promise<unknown>>;
    requests: Set<Promise<void>>;
}

const runtimeStates = new WeakMap<Server, ProviderHostRuntimeState>();

class HttpRequestError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "HttpRequestError";
    }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
}

function authorized(
    authorization: string | undefined,
    authTokens: readonly string[],
): boolean {
    if (authorization === undefined) return false;
    const actual = Buffer.from(authorization, "utf8");
    let accepted = false;
    for (const token of authTokens) {
        const expected = Buffer.from(`Bearer ${token}`, "utf8");
        accepted = (
            actual.length === expected.length
            && timingSafeEqual(actual, expected)
        ) || accepted;
    }
    return accepted;
}

async function readJson(
    request: IncomingMessage,
    bodyLimitBytes: number,
): Promise<unknown> {
    const contentType = String(request.headers["content-type"] ?? "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
    if (contentType !== "application/json") {
        throw new HttpRequestError(
            415,
            "unsupported_media_type",
            "content-type must be application/json",
        );
    }
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > bodyLimitBytes) {
        throw new HttpRequestError(
            413,
            "request_too_large",
            `request body exceeds ${bodyLimitBytes} bytes`,
        );
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > bodyLimitBytes) {
            throw new HttpRequestError(
                413,
                "request_too_large",
                `request body exceeds ${bodyLimitBytes} bytes`,
            );
        }
        chunks.push(buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpRequestError(
            400,
            "invalid_json",
            "request body must be valid JSON",
        );
    }
}

function errorMessage(error: unknown): string {
    if (error instanceof AggregateError) {
        const details = [...error.errors].map(errorMessage).filter(Boolean);
        return details.length > 0
            ? `${error.message}: ${details.join("; ")}`
            : error.message;
    }
    return error instanceof Error ? error.message : String(error);
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    options: {
        providers: ReadonlyMap<string, SourceProvider>;
        authTokens: readonly string[];
        bodyLimitBytes: number;
        evaluateTimeoutMs: number;
        logger: Pick<Console, "info" | "warn" | "error">;
        runtimeState: ProviderHostRuntimeState;
    },
): Promise<void> {
    const startedAt = Date.now();
    const correlationId = randomUUID();
    let providerId: string | undefined;
    let generatorId: string | undefined;
    try {
        let pathname: string;
        try {
            pathname = new URL(request.url ?? "/", "http://provider.local").pathname;
        } catch {
            throw new HttpRequestError(400, "invalid_request", "invalid request");
        }
        if (request.method === "GET" && pathname === "/healthz") {
            sendJson(response, 200, {
                status: "ok",
                providers: [...options.providers.keys()],
            });
            return;
        }
        const match = /^\/providers\/([^/]+)\/evaluate$/.exec(pathname);
        if (request.method !== "POST" || !match) {
            sendJson(response, 404, {
                error: {
                    code: "not_found",
                    message: "use POST /providers/{id}/evaluate or GET /healthz",
                },
            });
            return;
        }
        if (!authorized(request.headers.authorization, options.authTokens)) {
            sendJson(response, 401, {
                error: {
                    code: "unauthorized",
                    message: "authentication required",
                },
            });
            return;
        }
        try {
            providerId = normalizeProviderId(decodeURIComponent(match[1]));
        } catch {
            throw new HttpRequestError(400, "invalid_request", "invalid provider id");
        }
        const provider = options.providers.get(providerId);
        if (!provider) {
            sendJson(response, 404, {
                error: {
                    code: "provider_not_found",
                    message: `provider '${providerId}' is not registered`,
                },
            });
            return;
        }
        const input = parseProviderRequest(
            await readJson(request, options.bodyLimitBytes),
        );
        generatorId = input.generatorId;
        const evaluationAbort = new AbortController();
        const abortEvaluation = () => evaluationAbort.abort();
        options.runtimeState.evaluationControllers.add(evaluationAbort);
        if (options.runtimeState.shuttingDown) evaluationAbort.abort();
        request.once("aborted", abortEvaluation);
        response.once("close", abortEvaluation);
        let timeout: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
                evaluationAbort.abort();
                reject(new HttpRequestError(
                    504,
                    "provider_timeout",
                    `provider '${providerId}' evaluation timed out`,
                ));
            }, options.evaluateTimeoutMs);
            timeout.unref();
        });
        let output;
        const evaluation = Promise.resolve().then(() => provider.evaluate(
            input,
            { signal: evaluationAbort.signal },
        ));
        options.runtimeState.evaluations.add(evaluation);
        evaluation.then(
            () => options.runtimeState.evaluations.delete(evaluation),
            () => options.runtimeState.evaluations.delete(evaluation),
        );
        try {
            output = normalizeProviderResponse(
                await Promise.race([
                    evaluation,
                    timeoutPromise,
                ]),
                providerId,
            );
            const maxItems = input.limits?.maxItemsPerCycle;
            if (maxItems !== undefined && output.discoveries.length > maxItems) {
                throw new ProviderValidationError(
                    `provider '${providerId}' returned ${output.discoveries.length} `
                    + `discoveries, exceeding maxItemsPerCycle=${maxItems}`,
                );
            }
            JSON.stringify(output);
        } catch (error) {
            if (error instanceof ProviderValidationError) {
                throw new HttpRequestError(
                    502,
                    "invalid_provider_response",
                    error.message,
                );
            }
            throw error;
        } finally {
            if (timeout) clearTimeout(timeout);
            request.off("aborted", abortEvaluation);
            response.off("close", abortEvaluation);
            options.runtimeState.evaluationControllers.delete(evaluationAbort);
        }
        sendJson(response, 200, output);
        options.logger.info(
            JSON.stringify({
                component: "job-generator-provider-host",
                event: "evaluation",
                correlationId,
                providerId,
                generatorId,
                status: "succeeded",
                durationMs: Date.now() - startedAt,
                discoveryCount: output.discoveries.length,
            }),
        );
    } catch (error) {
        if (error instanceof HttpRequestError) {
            sendJson(response, error.status, {
                error: { code: error.code, message: error.message },
            });
            return;
        }
        if (error instanceof ProviderValidationError) {
            sendJson(response, 400, {
                error: { code: "invalid_request", message: error.message },
            });
            return;
        }
        options.logger.error(
            JSON.stringify({
                component: "job-generator-provider-host",
                event: "evaluation",
                correlationId,
                providerId,
                generatorId,
                status: "failed",
                durationMs: Date.now() - startedAt,
                error: errorMessage(error),
            }),
        );
        sendJson(response, 502, {
            error: {
                code: "provider_evaluation_failed",
                message: "provider evaluation failed",
                correlationId,
            },
        });
    }
}

export function createProviderHostServer(
    options: ProviderHostServerOptions,
): Server {
    const authToken = options.authToken?.trim();
    if (!authToken) {
        throw new Error("JOBGEN_PROVIDER_HOST_AUTH_TOKEN is required");
    }
    const previousAuthToken = options.previousAuthToken?.trim() || undefined;
    const authTokens = previousAuthToken
        ? [authToken, previousAuthToken]
        : [authToken];
    const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
    if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes <= 0) {
        throw new Error("bodyLimitBytes must be a positive integer");
    }
    const evaluateTimeoutMs = options.evaluateTimeoutMs ?? 60_000;
    if (!Number.isInteger(evaluateTimeoutMs) || evaluateTimeoutMs <= 0) {
        throw new Error("evaluateTimeoutMs must be a positive integer");
    }
    const logger = options.logger ?? console;
    const runtimeState: ProviderHostRuntimeState = {
        shuttingDown: false,
        evaluationControllers: new Set(),
        evaluations: new Set(),
        requests: new Set(),
    };
    const server = createServer((request, response) => {
        let operation: Promise<void>;
        operation = handleRequest(request, response, {
            providers: options.providers,
            authTokens,
            bodyLimitBytes,
            evaluateTimeoutMs,
            logger,
            runtimeState,
        }).catch(() => {
            if (response.destroyed) return;
            if (response.headersSent) {
                response.destroy();
                return;
            }
            try {
                sendJson(response, 500, {
                    error: {
                        code: "internal_error",
                        message: "internal server error",
                    },
                });
            } catch {
                response.destroy();
            }
        }).finally(() => {
            runtimeState.requests.delete(operation);
        });
        runtimeState.requests.add(operation);
    });
    runtimeStates.set(server, runtimeState);
    return server;
}

export async function beginProviderHostShutdown(server: Server): Promise<void> {
    const state = runtimeStates.get(server);
    if (!state) return;
    state.shuttingDown = true;
    for (const controller of state.evaluationControllers) controller.abort();
    while (state.requests.size > 0 || state.evaluations.size > 0) {
        await Promise.allSettled([
            ...state.requests,
            ...state.evaluations,
        ]);
    }
}
