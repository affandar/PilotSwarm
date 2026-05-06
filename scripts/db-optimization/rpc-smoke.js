#!/usr/bin/env node
/**
 * RPC smoke test for DB optimization Phase 2 endpoints.
 *
 * Calls four key RPC methods and prints: status, latency (ms), payload size (bytes).
 * Useful for confirming guardrails are live on a running instance.
 *
 * Environment variables:
 *   PORTAL_URL    Base URL of the portal (default: http://localhost:3001)
 *   RPC_COOKIE    Full Cookie header string (e.g. "session=abc123")
 *   RPC_TOKEN     Bearer token (used if RPC_COOKIE is not set)
 *
 * Usage:
 *   PORTAL_URL=http://localhost:3001 RPC_COOKIE="session=..." node scripts/db-optimization/rpc-smoke.js
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const BASE_URL = process.env.PORTAL_URL ?? "http://localhost:3001";
const COOKIE   = process.env.RPC_COOKIE  ?? "";
const TOKEN    = process.env.RPC_TOKEN   ?? "";

const SINCE_30D = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
const SINCE_1H  = new Date(Date.now() -  1 * 60 * 60 * 1000).toISOString();

const CALLS = [
    {
        label: "listSessionsPage (limit=10)",
        method: "listSessionsPage",
        params: { limit: 10 },
    },
    {
        label: "getSessionEvents (limit=50, no session — expects empty or 500)",
        method: "getSessionEvents",
        params: { sessionId: "__smoke_nonexistent__", limit: 50 },
    },
    {
        label: "getFleetTurnAnalytics (since=30d ago)",
        method: "getFleetTurnAnalytics",
        params: { since: SINCE_30D },
    },
    {
        label: "getTopEventEmitters (since=1h ago, limit=10)",
        method: "getTopEventEmitters",
        params: { since: SINCE_1H, limit: 10 },
    },
];

function rpcRequest(method, params) {
    return new Promise((resolve, reject) => {
        const url = new URL("/api/rpc", BASE_URL);
        const body = JSON.stringify({ method, params });
        const headers = {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
        };
        if (COOKIE) headers["Cookie"] = COOKIE;
        if (!COOKIE && TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;

        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(
            { hostname: url.hostname, port: url.port || undefined, path: url.pathname, method: "POST", headers },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
            },
        );
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

const pad = (s, n) => String(s).padEnd(n);

console.log("\nDB Optimization Phase 2 — RPC Smoke Test");
console.log("=".repeat(72));
console.log(`Target: ${BASE_URL}\n`);
console.log(pad("Endpoint", 50) + pad("Status", 8) + pad("Latency", 12) + "Size (bytes)");
console.log("-".repeat(72));

for (const { label, method, params } of CALLS) {
    const t0 = Date.now();
    let status = "ERR";
    let latency = 0;
    let size = 0;
    try {
        const { status: s, body } = await rpcRequest(method, params);
        latency = Date.now() - t0;
        status = s;
        size = body.length;
    } catch (err) {
        latency = Date.now() - t0;
        status = `ERR: ${err.message}`;
    }
    console.log(pad(label, 50) + pad(status, 8) + pad(`${latency}ms`, 12) + size);
}

console.log("-".repeat(72));
console.log("\nExpected: all status 200, latency <500ms, payload <50 KB for bounded reads.");
console.log("If status 401/403: set RPC_COOKIE or RPC_TOKEN.");
console.log("If status 500: check portal logs — likely a DB connection issue.\n");
