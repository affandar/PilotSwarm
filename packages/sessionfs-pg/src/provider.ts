import type {
    SessionFsProvider,
    SessionFsFileInfo,
} from "@github/copilot-sdk";
import type { PgSessionFsStore } from "./store.js";
import { canonicalizePath } from "./path.js";

/** Local mirror of the SDK's internal `SessionFsReaddirWithTypesEntry` shape. */
type ReaddirEntry = { name: string; type: "file" | "directory" };

/** ENOENT-tagged error so the SDK adapter maps it to the right RPC code. */
class EnoentError extends Error {
    code = "ENOENT" as const;
    constructor(path: string) { super(`ENOENT: ${path}`); }
}

function mapPgError(err: any, path: string): Error {
    // PG SQLSTATE 'P0002' is what every fs_* proc raises for missing nodes.
    if (err && (err.code === "P0002" || /^ENOENT:/i.test(String(err.message ?? "")))) {
        return new EnoentError(path);
    }
    return err instanceof Error ? err : new Error(String(err));
}

export interface PgSessionFsProviderOptions {
    store: PgSessionFsStore;
    sessionId: string;
}

/** Build a Copilot {@link SessionFsProvider} backed by a {@link PgSessionFsStore}. */
export function createPgSessionFsProvider(
    opts: PgSessionFsProviderOptions,
): SessionFsProvider {
    const { store, sessionId } = opts;
    if (!sessionId) throw new Error("sessionId is required");
    const schema = `"${store.schema}"`;

    async function call<T = any>(sql: string, params: any[], pathForError = "/"): Promise<T> {
        try {
            const res = await store.pool.query(sql, params);
            return res as T;
        } catch (err) {
            throw mapPgError(err, pathForError);
        }
    }

    async function ensureSession(): Promise<void> {
        await call(`SELECT ${schema}.fs_ensure_session($1)`, [sessionId]);
    }

    return {
        async readFile(rawPath) {
            const path = canonicalizePath(rawPath);
            await ensureSession();
            const r = await call<any>(
                `SELECT ${schema}.fs_read_file($1, $2) AS content`,
                [sessionId, path],
                path,
            );
            return r.rows[0].content as string;
        },

        async writeFile(rawPath, content, mode) {
            const path = canonicalizePath(rawPath);
            await ensureSession();
            await call(
                `SELECT ${schema}.fs_write_file($1, $2, $3, $4)`,
                [sessionId, path, content, mode ?? null],
                path,
            );
        },

        async appendFile(rawPath, content, mode) {
            const path = canonicalizePath(rawPath);
            await ensureSession();
            await call(
                `SELECT ${schema}.fs_append_file($1, $2, $3, $4)`,
                [sessionId, path, content, mode ?? null],
                path,
            );
        },

        async exists(rawPath) {
            let path: string;
            try { path = canonicalizePath(rawPath); }
            catch { return false; }
            await ensureSession();
            const r = await call<any>(
                `SELECT ${schema}.fs_exists($1, $2) AS e`,
                [sessionId, path],
                path,
            );
            return Boolean(r.rows[0].e);
        },

        async stat(rawPath): Promise<SessionFsFileInfo> {
            const path = canonicalizePath(rawPath);
            await ensureSession();
            const r = await call<any>(
                `SELECT * FROM ${schema}.fs_stat($1, $2)`,
                [sessionId, path],
                path,
            );
            const row = r.rows[0];
            return {
                isFile: Boolean(row.is_file),
                isDirectory: Boolean(row.is_directory),
                size: Number(row.size),
                mtime: new Date(row.mtime).toISOString(),
                birthtime: new Date(row.birthtime).toISOString(),
            };
        },

        async mkdir(rawPath, recursive, mode) {
            const path = canonicalizePath(rawPath);
            await ensureSession();
            await call(
                `SELECT ${schema}.fs_mkdir($1, $2, $3, $4)`,
                [sessionId, path, Boolean(recursive), mode ?? null],
                path,
            );
        },

        async readdir(rawPath) {
            const path = canonicalizePath(rawPath);
            await ensureSession();
            const r = await call<any>(
                `SELECT name FROM ${schema}.fs_readdir($1, $2)`,
                [sessionId, path],
                path,
            );
            return r.rows.map((row: any) => row.name as string);
        },

        async readdirWithTypes(rawPath): Promise<ReaddirEntry[]> {
            const path = canonicalizePath(rawPath);
            await ensureSession();
            const r = await call<any>(
                `SELECT name, kind FROM ${schema}.fs_readdir_with_types($1, $2)`,
                [sessionId, path],
                path,
            );
            return r.rows.map((row: any) => ({
                name: row.name,
                type: row.kind === "directory" ? "directory" : "file",
            }));
        },

        async rm(rawPath, recursive, force) {
            const path = canonicalizePath(rawPath);
            await ensureSession();
            await call(
                `SELECT ${schema}.fs_rm($1, $2, $3, $4)`,
                [sessionId, path, Boolean(recursive), Boolean(force)],
                path,
            );
        },

        async rename(rawSrc, rawDest) {
            const src = canonicalizePath(rawSrc);
            const dest = canonicalizePath(rawDest);
            await ensureSession();
            await call(
                `SELECT ${schema}.fs_rename($1, $2, $3)`,
                [sessionId, src, dest],
                src,
            );
        },
    };
}
