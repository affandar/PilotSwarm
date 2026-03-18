/**
 * DevOps Command Center — Mock Tools
 *
 * All tools return realistic mock data. No real cloud APIs.
 * Register on the worker with: worker.registerTools(devopsTools)
 */

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
const DEPLOYMENTS = [
    { id: "deploy-1001", service: "payment-service", version: "2.4.1", status: "active",      deployed_at: "2026-03-16T08:30:00Z", deployed_by: "ci-pipeline" },
    { id: "deploy-1002", service: "user-service",    version: "3.1.0", status: "active",      deployed_at: "2026-03-15T14:20:00Z", deployed_by: "ci-pipeline" },
    { id: "deploy-1003", service: "order-service",   version: "1.9.2", status: "active",      deployed_at: "2026-03-14T10:00:00Z", deployed_by: "ci-pipeline" },
    { id: "deploy-1004", service: "gateway",          version: "5.0.3", status: "active",      deployed_at: "2026-03-13T09:15:00Z", deployed_by: "ci-pipeline" },
    { id: "deploy-0998", service: "payment-service", version: "2.3.9", status: "rolled_back", deployed_at: "2026-03-12T16:45:00Z", deployed_by: "ci-pipeline" },
    { id: "deploy-0995", service: "order-service",   version: "1.9.0", status: "failed",      deployed_at: "2026-03-11T11:30:00Z", deployed_by: "ci-pipeline" },
];

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

// ─── Export ──────────────────────────────────────────────────────

export const devopsTools = [
    queryMetrics,
    queryLogs,
    listDeployments,
    deployService,
    rollbackService,
    getServiceHealth,
];

export default devopsTools;
