/**
 * DevOps Command Center — Mock Tools
 *
 * All tools return realistic mock data. No real cloud APIs.
 * Register on the worker with: worker.registerTools(devopsTools)
 */

import os from "node:os";
import { defineTool } from "pilotswarm-sdk";

// ─── Mock Data ───────────────────────────────────────────────────

const SERVICES = ["payment-service", "user-service", "order-service", "gateway"];

/** Seeded random that drifts slightly per call for realism. */
let _seed = 42;
function rand(min, max) {
    _seed = (_seed * 16807 + 11) % 2147483647;
    return min + (_seed % (max - min + 1));
}

function pickServiceMetrics(service) {
    // payment-service runs hot to make investigations interesting
    const isPayment = service === "payment-service";
    return {
        service,
        timestamp: new Date().toISOString(),
        cpu_percent: isPayment ? rand(72, 94) : rand(15, 55),
        memory_percent: isPayment ? rand(65, 82) : rand(30, 60),
        error_rate_percent: isPayment ? rand(0, 12) / 10 : rand(0, 3) / 10,
        requests_per_second: rand(80, 500),
        p99_latency_ms: isPayment ? rand(180, 950) : rand(20, 120),
    };
}

const LOG_TEMPLATES = {
    "payment-service": [
        { level: "ERROR", message: "Connection timeout to downstream payment-gateway after 5000ms", count: 12 },
        { level: "WARN",  message: "Retry attempt 3/3 for transaction processing", count: 8 },
        { level: "ERROR", message: "Circuit breaker OPEN for payment-gateway — 15 failures in 30s", count: 3 },
        { level: "INFO",  message: "Transaction processed successfully", count: 245 },
        { level: "WARN",  message: "Slow query detected: SELECT * FROM transactions WHERE ... (2340ms)", count: 5 },
    ],
    "user-service": [
        { level: "INFO",  message: "User login successful", count: 180 },
        { level: "WARN",  message: "Rate limit approaching for IP 10.0.3.42 (85/100)", count: 2 },
        { level: "INFO",  message: "Cache hit for user profile lookup", count: 420 },
    ],
    "order-service": [
        { level: "INFO",  message: "Order created: ORD-29841", count: 95 },
        { level: "WARN",  message: "Inventory check slow response (800ms)", count: 4 },
        { level: "ERROR", message: "Failed to process order: upstream payment-service timeout", count: 6 },
    ],
    "gateway": [
        { level: "INFO",  message: "Request routed to payment-service", count: 310 },
        { level: "INFO",  message: "Request routed to user-service", count: 280 },
        { level: "WARN",  message: "Upstream payment-service responding slowly (p95 > 500ms)", count: 7 },
    ],
};

let _deployCounter = 1000;
let _buildCounter = 2000;
const DEFAULT_WORKER_LOCAL_BUILDS = new Map();
const DEFAULT_BUILD_DURATION_SECONDS = 180;
const DEFAULT_BUILD_POLL_SECONDS = 40;
const DEPLOYMENTS = [
    { id: "deploy-1001", service: "payment-service", version: "2.4.1", status: "active",      deployed_at: "2026-03-16T08:30:00Z", deployed_by: "ci-pipeline" },
    { id: "deploy-1002", service: "user-service",    version: "3.1.0", status: "active",      deployed_at: "2026-03-15T14:20:00Z", deployed_by: "ci-pipeline" },
    { id: "deploy-1003", service: "order-service",   version: "1.9.2", status: "active",      deployed_at: "2026-03-14T10:00:00Z", deployed_by: "ci-pipeline" },
    { id: "deploy-1004", service: "gateway",          version: "5.0.3", status: "active",      deployed_at: "2026-03-13T09:15:00Z", deployed_by: "ci-pipeline" },
    { id: "deploy-0998", service: "payment-service", version: "2.3.9", status: "rolled_back", deployed_at: "2026-03-12T16:45:00Z", deployed_by: "ci-pipeline" },
    { id: "deploy-0995", service: "order-service",   version: "1.9.0", status: "failed",      deployed_at: "2026-03-11T11:30:00Z", deployed_by: "ci-pipeline" },
];

function resolveBuildDurationSeconds(durationSeconds) {
    if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0) {
        return Math.round(durationSeconds);
    }
    return DEFAULT_BUILD_DURATION_SECONDS;
}

function nextBuildId(prefix, startedAtMs) {
    _buildCounter += 1;
    return `${prefix}-${startedAtMs}-${_buildCounter}`;
}

function nextRemoteBuildId(startedAtMs, durationSeconds) {
    _buildCounter += 1;
    return `remote-build-${startedAtMs}-${durationSeconds}-${_buildCounter}`;
}

function buildWorkerMarker(override) {
    return override || `${os.hostname()}:${process.pid}`;
}

function formatBuildStatus(state, opts = {}) {
    const now = opts.now ?? Date.now();
    const elapsedSeconds = Math.max(0, Math.floor((now - state.startedAtMs) / 1000));
    const remainingSeconds = Math.max(0, state.durationSeconds - elapsedSeconds);
    const status = remainingSeconds === 0 ? "done" : "running";
    const preserveWorkerAffinity = Boolean(opts.local && status !== "done");
    const pollIntervalSeconds = status === "done"
        ? 0
        : Math.min(DEFAULT_BUILD_POLL_SECONDS, Math.max(1, remainingSeconds));
    const reason = opts.local
        ? "Waiting before next poll of worker-local build (preserving worker affinity)"
        : "Waiting before next poll of remote build";

    return {
        build_id: state.buildId,
        repo: state.repo,
        branch: state.branch,
        target: state.target,
        build_scope: opts.local ? "worker_local" : "remote",
        status,
        elapsed_seconds: elapsedSeconds,
        remaining_seconds: remainingSeconds,
        poll_interval_seconds: pollIntervalSeconds,
        preserve_worker_affinity: preserveWorkerAffinity,
        affinity_guidance: preserveWorkerAffinity
            ? "This build is tied to worker-local mock state. Keep preserveWorkerAffinity=true on each durable wait until status becomes done."
            : "This build no longer requires worker affinity. Use ordinary waits without preserveWorkerAffinity.",
        recommended_wait: status === "done"
            ? null
            : {
                seconds: pollIntervalSeconds,
                reason,
                preserveWorkerAffinity,
            },
        worker_marker: state.workerMarker,
        summary: status === "done"
            ? `${state.repo} build finished successfully on ${state.target}.`
            : `${state.repo} build is still running on ${state.target}.`,
    };
}

function parseRemoteBuildId(buildId) {
    const match = /^remote-build-(\d+)-(\d+)-(\d+)$/.exec(buildId);
    if (!match) return null;
    return {
        startedAtMs: Number(match[1]),
        durationSeconds: Number(match[2]),
        counter: Number(match[3]),
    };
}

export function resetMockBuildState() {
    DEFAULT_WORKER_LOCAL_BUILDS.clear();
}

// ─── Tool Definitions ────────────────────────────────────────────

const queryMetrics = defineTool("query_metrics", {
    description:
        "Get current metrics for a service: CPU, memory, error rate, " +
        "request throughput, and p99 latency. Returns a point-in-time snapshot.",
    parameters: {
        type: "object",
        properties: {
            service: {
                type: "string",
                description: `Service name. Available: ${SERVICES.join(", ")}`,
            },
        },
        required: ["service"],
    },
    handler: async ({ service }) => {
        if (!SERVICES.includes(service)) {
            return { error: `Unknown service: ${service}. Available: ${SERVICES.join(", ")}` };
        }
        return pickServiceMetrics(service);
    },
});

const queryLogs = defineTool("query_logs", {
    description:
        "Search recent logs for a service. Returns log entries matching " +
        "the filter criteria (severity, keyword). Limited to last 15 minutes.",
    parameters: {
        type: "object",
        properties: {
            service: {
                type: "string",
                description: `Service name. Available: ${SERVICES.join(", ")}`,
            },
            severity: {
                type: "string",
                enum: ["ERROR", "WARN", "INFO", "ALL"],
                description: "Filter by log severity. Default: ALL",
            },
            keyword: {
                type: "string",
                description: "Optional keyword to filter log messages.",
            },
        },
        required: ["service"],
    },
    handler: async ({ service, severity, keyword }) => {
        if (!SERVICES.includes(service)) {
            return { error: `Unknown service: ${service}. Available: ${SERVICES.join(", ")}` };
        }
        let logs = LOG_TEMPLATES[service] || [];
        if (severity && severity !== "ALL") {
            logs = logs.filter(l => l.level === severity);
        }
        if (keyword) {
            const kw = keyword.toLowerCase();
            logs = logs.filter(l => l.message.toLowerCase().includes(kw));
        }
        return {
            service,
            time_range: "last 15 minutes",
            entries: logs.map(l => ({
                timestamp: new Date(Date.now() - rand(0, 900) * 1000).toISOString(),
                level: l.level,
                message: l.message,
                count: l.count,
            })),
            total_entries: logs.reduce((s, l) => s + l.count, 0),
        };
    },
});

const listDeployments = defineTool("list_deployments", {
    description:
        "List all deployments across services. Shows active, failed, " +
        "and rolled-back deployments with their versions and timestamps.",
    parameters: {
        type: "object",
        properties: {
            service: {
                type: "string",
                description: "Optional: filter by service name.",
            },
            status: {
                type: "string",
                enum: ["active", "failed", "rolled_back", "deploying", "all"],
                description: "Optional: filter by deployment status. Default: all",
            },
        },
    },
    handler: async ({ service, status }) => {
        let deps = [...DEPLOYMENTS];
        if (service) deps = deps.filter(d => d.service === service);
        if (status && status !== "all") deps = deps.filter(d => d.status === status);
        return { deployments: deps, total: deps.length };
    },
});

const deployService = defineTool("deploy_service", {
    description:
        "Deploy a new version of a service. Returns a deployment ID " +
        "and initial status. Monitor with get_service_health after deploying.",
    parameters: {
        type: "object",
        properties: {
            service: {
                type: "string",
                description: `Service to deploy. Available: ${SERVICES.join(", ")}`,
            },
            version: {
                type: "string",
                description: "Version to deploy (e.g. '2.5.0')",
            },
        },
        required: ["service", "version"],
    },
    handler: async ({ service, version }) => {
        if (!SERVICES.includes(service)) {
            return { error: `Unknown service: ${service}` };
        }
        const id = `deploy-${++_deployCounter}`;
        const deployment = {
            id,
            service,
            version,
            status: "active",
            deployed_at: new Date().toISOString(),
            deployed_by: "devops-agent",
        };
        DEPLOYMENTS.unshift(deployment);
        return {
            success: true,
            deployment_id: id,
            message: `Deployed ${service} v${version}. Monitor with get_service_health.`,
        };
    },
});

const rollbackService = defineTool("rollback_service", {
    description:
        "Roll back a deployment to the previous version. " +
        "Requires the deployment ID from deploy_service or list_deployments.",
    parameters: {
        type: "object",
        properties: {
            deployment_id: {
                type: "string",
                description: "The deployment ID to roll back (e.g. 'deploy-1001')",
            },
        },
        required: ["deployment_id"],
    },
    handler: async ({ deployment_id }) => {
        const dep = DEPLOYMENTS.find(d => d.id === deployment_id);
        if (!dep) return { error: `Deployment ${deployment_id} not found` };
        if (dep.status !== "active") return { error: `Cannot rollback — deployment is ${dep.status}` };
        dep.status = "rolled_back";
        return {
            success: true,
            message: `Rolled back ${dep.service} v${dep.version}. Previous version restored.`,
            service: dep.service,
            rolled_back_version: dep.version,
        };
    },
});

const getServiceHealth = defineTool("get_service_health", {
    description:
        "Run health checks for a service. Returns the status of each " +
        "health check endpoint (database, cache, dependencies).",
    parameters: {
        type: "object",
        properties: {
            service: {
                type: "string",
                description: `Service name. Available: ${SERVICES.join(", ")}`,
            },
        },
        required: ["service"],
    },
    handler: async ({ service }) => {
        if (!SERVICES.includes(service)) {
            return { error: `Unknown service: ${service}` };
        }
        const isPayment = service === "payment-service";
        return {
            service,
            overall: isPayment && rand(0, 10) > 7 ? "degraded" : "healthy",
            checks: [
                { name: "database",     status: "healthy",   latency_ms: rand(1, 15) },
                { name: "cache",        status: "healthy",   latency_ms: rand(0, 3) },
                { name: "dependencies", status: isPayment && rand(0, 10) > 6 ? "degraded" : "healthy", latency_ms: isPayment ? rand(50, 800) : rand(5, 30) },
            ],
            timestamp: new Date().toISOString(),
        };
    },
});

function createBuildTools(workerMarker = buildWorkerMarker(), localBuilds = DEFAULT_WORKER_LOCAL_BUILDS) {
    const startLocalBuild = defineTool("start_local_build", {
        description:
            "Start a mock DevOps repo build on this worker. The build state is stored in worker-local memory, " +
            "so monitoring should preserve worker affinity until the build completes.",
        parameters: {
            type: "object",
            properties: {
                repo: {
                    type: "string",
                    description: "Repository or project name. Default: devops-command-center",
                },
                branch: {
                    type: "string",
                    description: "Branch to build. Default: main",
                },
                target: {
                    type: "string",
                    description: "Build target or pipeline name. Default: ci",
                },
                duration_seconds: {
                    type: "number",
                    description: "Optional override for the mock build duration. Default: 180 seconds.",
                },
            },
        },
        handler: async ({ repo, branch, target, duration_seconds }) => {
            const startedAtMs = Date.now();
            const state = {
                buildId: nextBuildId("local-build", startedAtMs),
                repo: repo || "devops-command-center",
                branch: branch || "main",
                target: target || "ci",
                durationSeconds: resolveBuildDurationSeconds(duration_seconds),
                startedAtMs,
                workerMarker,
            };
            localBuilds.set(state.buildId, state);
            return {
                ...formatBuildStatus(state, { local: true, now: startedAtMs }),
                started: true,
                note: "This mock build lives in worker-local memory. Preserve worker affinity while polling it.",
            };
        },
    });

    const getLocalBuildStatus = defineTool("get_local_build_status", {
        description:
            "Check the status of a mock worker-local build started with start_local_build.",
        parameters: {
            type: "object",
            properties: {
                build_id: {
                    type: "string",
                    description: "The local build ID returned by start_local_build.",
                },
            },
            required: ["build_id"],
        },
        handler: async ({ build_id }) => {
            const state = localBuilds.get(build_id);
            if (!state) {
                return {
                    build_id,
                    build_scope: "worker_local",
                    status: "not_found_on_this_worker",
                    preserve_worker_affinity: false,
                    recommended_wait: null,
                    worker_marker: workerMarker,
                    error:
                        "This mock build was not found in the current worker-local store. " +
                        "If you were monitoring a worker-local build, resume on the same worker or start a new local build.",
                };
            }
            return formatBuildStatus(state, { local: true });
        },
    });

    const startRemoteBuild = defineTool("start_remote_build", {
        description:
            "Start a mock remote build. Status is derived from the build ID itself, so monitoring does not require worker affinity.",
        parameters: {
            type: "object",
            properties: {
                repo: {
                    type: "string",
                    description: "Repository or project name. Default: devops-command-center",
                },
                branch: {
                    type: "string",
                    description: "Branch to build. Default: main",
                },
                target: {
                    type: "string",
                    description: "Remote build target or pipeline name. Default: ci",
                },
                duration_seconds: {
                    type: "number",
                    description: "Optional override for the mock build duration. Default: 180 seconds.",
                },
            },
        },
        handler: async ({ repo, branch, target, duration_seconds }) => {
            const startedAtMs = Date.now();
            const durationSeconds = resolveBuildDurationSeconds(duration_seconds);
            const state = {
                buildId: nextRemoteBuildId(startedAtMs, durationSeconds),
                repo: repo || "devops-command-center",
                branch: branch || "main",
                target: target || "ci",
                durationSeconds,
                startedAtMs,
                workerMarker: "remote-controller",
            };
            return {
                ...formatBuildStatus(state, { local: false, now: startedAtMs }),
                started: true,
                note: "This mock build is remote. Poll it with ordinary durable waits and do not preserve worker affinity.",
            };
        },
    });

    const getRemoteBuildStatus = defineTool("get_remote_build_status", {
        description:
            "Check the status of a mock remote build. Any worker can monitor it without preserving worker affinity.",
        parameters: {
            type: "object",
            properties: {
                build_id: {
                    type: "string",
                    description: "The remote build ID returned by start_remote_build.",
                },
                repo: {
                    type: "string",
                    description: "Optional repo name for nicer status text when monitoring an existing build ID.",
                },
                branch: {
                    type: "string",
                    description: "Optional branch name for nicer status text when monitoring an existing build ID.",
                },
                target: {
                    type: "string",
                    description: "Optional target name for nicer status text when monitoring an existing build ID.",
                },
            },
            required: ["build_id"],
        },
        handler: async ({ build_id, repo, branch, target }) => {
            const parsed = parseRemoteBuildId(build_id);
            if (!parsed) {
                return {
                    build_id,
                    build_scope: "remote",
                    status: "invalid_build_id",
                    preserve_worker_affinity: false,
                    recommended_wait: null,
                    error: "Remote build IDs must come from start_remote_build in this mock sample.",
                };
            }
            const state = {
                buildId: build_id,
                repo: repo || "devops-command-center",
                branch: branch || "main",
                target: target || "ci",
                durationSeconds: parsed.durationSeconds,
                startedAtMs: parsed.startedAtMs,
                workerMarker: "remote-controller",
            };
            return formatBuildStatus(state, { local: false });
        },
    });

    return [startLocalBuild, getLocalBuildStatus, startRemoteBuild, getRemoteBuildStatus];
}

// ─── Export ──────────────────────────────────────────────────────

export function createDevopsTools(opts = {}) {
    const buildTools = createBuildTools(buildWorkerMarker(opts.workerMarker), new Map());
    return [
        queryMetrics,
        queryLogs,
        listDeployments,
        deployService,
        rollbackService,
        getServiceHealth,
        ...buildTools,
    ];
}

const defaultBuildTools = createBuildTools(buildWorkerMarker(), DEFAULT_WORKER_LOCAL_BUILDS);

export const devopsTools = [
    queryMetrics,
    queryLogs,
    listDeployments,
    deployService,
    rollbackService,
    getServiceHealth,
    ...defaultBuildTools,
];

export default devopsTools;
