// @pilotswarm/horizon-store — retry helpers (HorizonDB preview hardening).
//
// Two distinct retryable classes, each with its own classifier so callers opt
// into exactly the one that is safe for them:
//
// 1. TRANSIENT CONNECTION (isTransientDbError, the default):
//    Azure HorizonDB (preview) intermittently drops pooled TLS connections —
//    ECONNRESET / ENOTCONN / "Connection terminated" / "terminating
//    connection", plus the pg connection-class SQLSTATEs (08xxx, 57P0x). These
//    surface either as a rejected query or at connection acquisition; in both
//    cases the statement did not partially commit, so re-running (on a FRESH
//    connection) is safe. Never matches SQL/logic errors — those must surface.
//    Also covers connection-ESTABLISHMENT failures that are transient under
//    load: EADDRNOTAVAIL (local ephemeral-port exhaustion from rapid connection
//    churn) and DNS hiccups (ENOTFOUND / EAI_AGAIN / getaddrinfo) against the
//    cluster host — the query never ran, so a fresh-connection retry is safe.
//
// 2. AGE LABEL-CREATION RACE (isLabelCreationRaceError):
//    Apache AGE creates a label's backing table LAZILY on the first
//    CREATE/MERGE that references it. The label set is owned by the layer above
//    us (the harvester / app choose node kinds + edge predicates), so we never
//    enumerate it. When two writers race the first reference to the same label,
//    the loser's internal label-table creation aborts the whole Cypher statement
//    — so the MERGE/CREATE persisted nothing. The label now EXISTS, so re-running
//    the SAME statement succeeds. This is label-agnostic by construction.
//
//    The race has TWO observed manifestations (HorizonDB AGE 1.6.0), depending
//    on WHERE the duplicate is detected:
//      - 42P07 duplicate_table — `relation "<label>" already exists` (caught at
//        the relation level), and
//      - 23505 unique_violation on a SYSTEM-CATALOG index, e.g.
//        `pg_class_relname_nsp_index` (two concurrent label-table creations race
//        into pg_class before either registered). NOTE the "already exists"
//        text is in err.detail, not err.message, so a message regex misses it —
//        we key off the code + the catalog constraint name instead. We retry
//        23505 ONLY when the violated constraint is a pg_catalog index, never a
//        user constraint (the graph has no user unique constraints anyway).
//
// The optional process-wide onRetry hook lets the eval harness record retries
// for its perf/error report.

const TRANSIENT_DB_ERROR =
    /ECONNRESET|ENOTCONN|EPIPE|ETIMEDOUT|Connection terminated|terminating connection|server closed the connection|connection to server|read ECONN|EADDRNOTAVAIL|ENOTFOUND|EAI_AGAIN|getaddrinfo/i;

/** pg connection-class SQLSTATEs: 08xxx connection exceptions, 57P0x
 * admin-shutdown / crash-recovery. All mean "connection went away" → safe to
 * re-run on a fresh connection. */
const TRANSIENT_PG_CODE = new Set(["08006", "08003", "08000", "08001", "08004", "57P01", "57P02", "57P03"]);

/** System-catalog unique indexes touched when a label-table creation races
 * itself: pg_class (relname,relnamespace), pg_type (typname,typnamespace),
 * pg_namespace. A 23505 on one of these in the graph layer = the AGE
 * label-creation race. */
const CATALOG_RACE_CONSTRAINT = /pg_(class|type|namespace)_/i;

export function isTransientDbError(err: any): boolean {
    if (err?.code && TRANSIENT_PG_CODE.has(String(err.code))) return true;
    const s = `${err?.code ?? ""} ${err?.message ?? ""}`;
    return TRANSIENT_DB_ERROR.test(s);
}

/** The AGE lazy-label-creation race, in BOTH manifestations (42P07 duplicate_table
 * and 23505 unique_violation on a pg_catalog index). Re-running the same
 * idempotent graph statement once the label exists succeeds. Label-agnostic. */
export function isLabelCreationRaceError(err: any): boolean {
    const code = String(err?.code ?? "");
    if (code === "42P07") return true;                                   // duplicate_table
    if (code === "23505") {                                              // unique_violation…
        const constraint = String(err?.constraint ?? "");
        const message = String(err?.message ?? "");
        if (CATALOG_RACE_CONSTRAINT.test(constraint) || CATALOG_RACE_CONSTRAINT.test(message)) return true;
    }
    return /already exists/i.test(String(err?.message ?? ""));
}

export interface DbRetryHooks {
    onRetry?: (info: { label: string; attempt: number; error: any }) => void;
}

let DB_RETRY_HOOKS: DbRetryHooks = {};
/** Install process-wide retry observers (used by the eval perf/error report). */
export function setDbRetryHooks(hooks: DbRetryHooks): void { DB_RETRY_HOOKS = hooks ?? {}; }

export interface DbRetryOpts {
    tries?: number;
    /** Which errors are retryable. Default: isTransientDbError (connection class). */
    isRetryable?: (err: any) => boolean;
}

export async function withDbRetry<T>(label: string, fn: () => Promise<T>, opts: DbRetryOpts = {}): Promise<T> {
    const tries = opts.tries ?? 4;
    const isRetryable = opts.isRetryable ?? isTransientDbError;
    let lastErr: any;
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isRetryable(err) || attempt === tries) throw err;
            DB_RETRY_HOOKS.onRetry?.({ label, attempt, error: err });
            await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** (attempt - 1), 2000)));
        }
    }
    throw lastErr;
}
