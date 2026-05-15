import { metrics } from "@opentelemetry/api";
import { buildPgPoolConfig } from "./pg-pool-factory.js";

export interface StuckActivitiesMetricsHandle {
    shutdown(): Promise<void>;
}

export interface StuckActivitiesMetricsOptions {
    storeUrl: string;
    duroxideSchema?: string;
    workerNodeId?: string;
    thresholdMs?: number;
}

const DEFAULT_DUROXIDE_SCHEMA = "duroxide";
const DEFAULT_STUCK_THRESHOLD_MS = 60_000;

function quoteIdent(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function parseNonNegativeInt(raw: unknown): number | undefined {
    const normalized = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
    if (!Number.isFinite(normalized) || normalized < 0) return undefined;
    return Math.floor(normalized);
}

export async function countStuckWorkerQueueActivities(
    pool: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
    opts: { duroxideSchema?: string; thresholdMs?: number },
): Promise<number> {
    const schema = quoteIdent(opts.duroxideSchema ?? DEFAULT_DUROXIDE_SCHEMA);
    const thresholdMs = opts.thresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS;
    const result = await pool.query(
        `
            SELECT count(*)::int AS count
            FROM ${schema}.worker_queue
            WHERE lock_token IS NULL
              AND visible_at < now() - ($1::double precision * interval '1 millisecond')
        `,
        [thresholdMs],
    );
    return Number(result.rows[0]?.count ?? 0);
}

export async function registerStuckActivitiesMetric(
    opts: StuckActivitiesMetricsOptions,
): Promise<StuckActivitiesMetricsHandle | null> {
    if (!opts.storeUrl.startsWith("postgres://") && !opts.storeUrl.startsWith("postgresql://")) {
        return null;
    }

    const { default: pg } = await import("pg");
    const thresholdMs = parseNonNegativeInt(process.env.PILOTSWARM_STUCK_ACTIVITY_THRESHOLD_MS)
        ?? opts.thresholdMs
        ?? DEFAULT_STUCK_THRESHOLD_MS;
    const schema = opts.duroxideSchema ?? DEFAULT_DUROXIDE_SCHEMA;
    const pool = new pg.Pool(buildPgPoolConfig({
        connectionString: opts.storeUrl,
        max: 1,
    }));

    pool.on("error", (err: Error) => {
        console.error("[queue-health] pool idle client error (non-fatal):", err.message);
    });

    const meter = metrics.getMeter("pilotswarm-queue-health");
    const gauge = meter.createObservableGauge("pilotswarm.stuck_activities", {
        description: "Duroxide worker queue activities that have been visible longer than the stuck threshold without a lock.",
        unit: "{activity}",
    });
    const attributes = {
        queue: "worker_queue",
        duroxide_schema: schema,
        threshold_ms: thresholdMs,
        ...(opts.workerNodeId ? { worker_node_id: opts.workerNodeId } : {}),
    };
    let queryErrorLogged = false;

    const callback = async (observableResult: { observe(value: number, attributes?: Record<string, unknown>): void }) => {
        try {
            const stuckCount = await countStuckWorkerQueueActivities(pool, {
                duroxideSchema: schema,
                thresholdMs,
            });
            queryErrorLogged = false;
            observableResult.observe(stuckCount, attributes);
        } catch (err) {
            if (!queryErrorLogged) {
                queryErrorLogged = true;
                console.error("[queue-health] failed to collect stuck activities metric:", err);
            }
        }
    };

    gauge.addCallback(callback);

    return {
        async shutdown() {
            gauge.removeCallback(callback);
            await pool.end();
        },
    };
}
