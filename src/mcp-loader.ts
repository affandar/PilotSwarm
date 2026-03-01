/**
 * MCP config loader — reads .mcp.json files from plugin directories.
 *
 * File format (matches @github/copilot-sdk MCPServerConfig):
 *
 *   {
 *     "my-server": {
 *       "command": "node",
 *       "args": ["server.js"],
 *       "tools": ["*"]
 *     },
 *     "remote-api": {
 *       "type": "http",
 *       "url": "https://api.example.com/mcp",
 *       "tools": ["query"],
 *       "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
 *     }
 *   }
 *
 * Environment variable references like `${VAR}` in string values
 * are expanded at load time.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";

// ─── Types ───────────────────────────────────────────────────────

/** Matches @github/copilot-sdk MCPServerConfig union. */
export type MCPServerConfig = MCPLocalServerConfig | MCPRemoteServerConfig;

export interface MCPLocalServerConfig {
    type?: "local" | "stdio";
    command: string;
    args: string[];
    tools: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
}

export interface MCPRemoteServerConfig {
    type: "http" | "sse";
    url: string;
    tools: string[];
    headers?: Record<string, string>;
    timeout?: number;
}

// ─── Env Expansion ──────────────────────────────────────────────

/** Expand `${VAR}` references in a string using process.env. */
function expandEnv(value: string): string {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

/** Recursively expand env vars in all string values of an object. */
function expandEnvDeep(obj: any): any {
    if (typeof obj === "string") return expandEnv(obj);
    if (Array.isArray(obj)) return obj.map(expandEnvDeep);
    if (obj && typeof obj === "object") {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = expandEnvDeep(value);
        }
        return result;
    }
    return obj;
}

// ─── Loader ─────────────────────────────────────────────────────

/**
 * Load MCP server config from a `.mcp.json` file in a plugin directory.
 *
 * @param pluginDir - Path to the plugin directory (looks for `.mcp.json` at root).
 * @returns Record of server name → config. Empty record if no `.mcp.json` found.
 */
export function loadMcpConfig(pluginDir: string): Record<string, MCPServerConfig> {
    const absDir = path.resolve(pluginDir);
    const mcpPath = path.join(absDir, ".mcp.json");

    if (!fs.existsSync(mcpPath)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(mcpPath, "utf-8");
        const parsed = JSON.parse(raw);

        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            console.warn(`[mcp-loader] Invalid .mcp.json in ${absDir}: expected object`);
            return {};
        }

        // Expand env vars and validate each entry
        const result: Record<string, MCPServerConfig> = {};
        for (const [name, config] of Object.entries(parsed)) {
            if (typeof config !== "object" || config === null) {
                console.warn(`[mcp-loader] Skipping MCP server "${name}": invalid config`);
                continue;
            }
            result[name] = expandEnvDeep(config);
        }

        return result;
    } catch (err: any) {
        console.warn(`[mcp-loader] Failed to parse .mcp.json in ${absDir}: ${err.message}`);
        return {};
    }
}
