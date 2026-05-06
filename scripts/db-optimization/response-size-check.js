#!/usr/bin/env node
/**
 * Compares listSessions (unbounded) vs listSessionsPage (bounded) payload sizes.
 *
 * Prints the raw byte counts and the reduction ratio. A ratio >= 5x is
 * the target for fleets with 200+ sessions (where one full fetch was ≥200 KB).
 *
 * Environment variables (same as rpc-smoke.js):
 *   PORTAL_URL    Base URL of the portal (default: http://localhost:3001)
 *   RPC_COOKIE    Full Cookie header string
 *   RPC_TOKEN     Bearer token (used if RPC_COOKIE is not set)
 *   PAGE_LIMIT    Page size to use for listSessionsPage (default: 50)
 *
 * Usage:
 *   PORTAL_URL=http://localhost:3001 RPC_COOKIE="session=..." node scripts/db-optimization/response-size-check.js
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const BASE_URL  = process.env.PORTAL_URL  ?? "http://localhost:3001";
const COOKIE    = process.env.RPC_COOKIE  ?? "";
const TOKEN     = process.env.RPC_TOKEN   ?? "";
const PAGE_LIMIT = Number(process.env.PAGE_LIMIT ?? "50");

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

console.log("\nDB Optimization Phase 2 — Response Size Comparison");
console.log("=".repeat(60));
console.log(`Target: ${BASE_URL}\n`);

const [unbounded, paged] = await Promise.all([
    rpcRequest("listSessions", {}),
    rpcRequest("listSessionsPage", { limit: PAGE_LIMIT }),
]);

if (unbounded.status !== 200) {
    console.log(`listSessions returned HTTP ${unbounded.status} — skipping comparison.`);
    console.log("(This is expected if listSessions is not available in your build.)");
} else {
    const unboundedBytes = unbounded.body.length;
    const pagedBytes     = paged.body.length;
    const ratio = pagedBytes > 0 ? unboundedBytes / pagedBytes : null;

    console.log(`listSessions  (unbounded)          : ${unboundedBytes.toLocaleString()} bytes  [HTTP ${unbounded.status}]`);
    console.log(`listSessionsPage (limit=${PAGE_LIMIT})  : ${pagedBytes.toLocaleString()} bytes  [HTTP ${paged.status}]`);
    console.log(`\nReduction ratio : ${ratio === null ? "N/A" : `${ratio.toFixed(1)}x`}`);
    console.log("\nInterpretation:");
    if (ratio === null) {
        console.log("  - Could not compute ratio (paged response was 0 bytes).");
    } else if (ratio >= 5) {
        console.log("  ✓ Significant reduction achieved. Pagination is working as intended.");
    } else if (ratio >= 2) {
        console.log("  ~ Moderate reduction. Fleet may be small or PAGE_LIMIT is close to total session count.");
    } else {
        console.log("  ✗ Minimal reduction. Fleet likely has fewer sessions than PAGE_LIMIT, or listSessions is broken.");
    }
}

console.log("");
