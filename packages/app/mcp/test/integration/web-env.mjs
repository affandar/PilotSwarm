// Shared harness for the MCP live suites — Web API mode only.
//
// The MCP server under test never touches the database: the harness boots the
// real portal server in-process (no-auth, embedded workers, same DATABASE_URL
// the suite's own pg verification uses) and spawns the actual MCP bin with
// `--api-url http://localhost:<port>`. Direct `pg` access remains available to
// the SUITES for state verification — tests sit below the Web API seam by
// design (docs/architecture/layering.md); the MCP server does not.

import { readFileSync, mkdtempSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

/** Load ROOT/.env into process.env (existing values win). */
export function loadDotEnv(root) {
    let envFile;
    try {
        envFile = readFileSync(resolve(root, ".env"), "utf-8");
    } catch {
        return;
    }
    for (const line of envFile.split("\n")) {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        let val = match[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (process.env[match[1]] === undefined) process.env[match[1]] = val;
    }
}

/**
 * Boot the portal server (Web API + embedded workers) against the dev
 * database. Returns { apiUrl, stop }.
 */
export async function startWebEnv(root) {
    loadDotEnv(root);
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL not set — the portal server needs the datastore.");
    }
    process.env.WORKERS ||= "1";
    process.env.PORTAL_TUI_MODE ||= "local";
    process.env.SESSION_STATE_DIR ||= mkdtempSync(resolve(tmpdir(), "ps-mcp-web-live-"));

    const { startServer } = await import("pilotswarm/web");
    const server = await startServer({ port: 0 });
    const apiUrl = `http://localhost:${server.address().port}`;
    console.log(`✅ portal server (Web API, no-auth) at ${apiUrl}\n`);

    return {
        apiUrl,
        async stop() {
            if (server?.stopPortal) await server.stopPortal();
        },
    };
}

/** StdioClientTransport args for the real MCP bin in Web API mode. */
export function mcpStdioArgs(root, apiUrl, extraArgs = []) {
    return {
        command: "node",
        args: [
            resolve(root, "packages/app/mcp/dist/bin/pilotswarm-mcp.js"),
            "--api-url", apiUrl,
            "--transport", "stdio",
            "--log-level", "error",
            ...extraArgs,
        ],
        env: { ...process.env },
        cwd: root,
        stderr: "pipe",
    };
}
