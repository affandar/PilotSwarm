import { createPgSessionFsProvider, type PgSessionFsProviderOptions } from "./provider.js";

/**
 * Build a Copilot SessionFs handler backed by Postgres.
 *
 * **Why not `createSessionFsAdapter` from `@github/copilot-sdk`?**
 *
 * Empirically, `@github/copilot` 1.0.36 invokes the SessionFs handler with
 * **positional arguments** (e.g. `handler.readFile(path)`,
 * `handler.writeFile(path, content, mode)`), not with the `{path}` request
 * envelopes documented in the SDK's `generated/rpc.d.ts`. The SDK's own
 * `createSessionFsAdapter` destructures `({path})` and ends up passing
 * `undefined` to providers. Bypassing the adapter and writing the handler
 * shape the CLI actually sends keeps things working.
 *
 * @example
 * ```ts
 * const session = await client.createSession({
 *   onPermissionRequest: () => ({ allow: true, level: "always" }),
 *   createSessionFsHandler: (s) =>
 *     createPgSessionFsHandler({ store, sessionId: s.sessionId }),
 * });
 * ```
 */
export function createPgSessionFsHandler(opts: PgSessionFsProviderOptions): any {
    const inner = createPgSessionFsProvider(opts);

    const toErr = (err: any) => ({
        code: err?.code === "ENOENT" ? "ENOENT" : "UNKNOWN",
        message: err?.message ?? String(err),
    });

    return {
        readFile: async (path: string) => {
            try { return { content: await inner.readFile(path) }; }
            catch (err) { return { content: "", error: toErr(err) }; }
        },
        writeFile: async (path: string, content: string, mode?: number) => {
            try { await inner.writeFile(path, content, mode); return undefined; }
            catch (err) { return toErr(err); }
        },
        appendFile: async (path: string, content: string, mode?: number) => {
            try { await inner.appendFile(path, content, mode); return undefined; }
            catch (err) { return toErr(err); }
        },
        exists: async (path: string) => {
            try { return { exists: await inner.exists(path) }; }
            catch { return { exists: false }; }
        },
        stat: async (path: string) => {
            try { return await inner.stat(path); }
            catch (err) {
                return {
                    isFile: false,
                    isDirectory: false,
                    size: 0,
                    mtime: new Date().toISOString(),
                    birthtime: new Date().toISOString(),
                    error: toErr(err),
                };
            }
        },
        mkdir: async (path: string, recursive?: boolean, mode?: number) => {
            try { await inner.mkdir(path, recursive ?? false, mode); return undefined; }
            catch (err) { return toErr(err); }
        },
        readdir: async (path: string) => {
            try { return { entries: await inner.readdir(path) }; }
            catch (err) { return { entries: [], error: toErr(err) }; }
        },
        readdirWithTypes: async (path: string) => {
            try { return { entries: await inner.readdirWithTypes(path) }; }
            catch (err) { return { entries: [], error: toErr(err) }; }
        },
        rm: async (path: string, recursive?: boolean, force?: boolean) => {
            try { await inner.rm(path, recursive ?? false, force ?? false); return undefined; }
            catch (err) { return toErr(err); }
        },
        rename: async (src: string, dest: string) => {
            try { await inner.rename(src, dest); return undefined; }
            catch (err) { return toErr(err); }
        },
    };
}
