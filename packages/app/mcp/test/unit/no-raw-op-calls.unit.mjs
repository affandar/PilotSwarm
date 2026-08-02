// No raw `api.call("opName", …)` in MCP source — operations go through the
// typed generated surface (`ctx.web.ops.*` / `web.ops.*`).
//
// Why this matters: raw string calls are unchecked, and they hid a real
// break for months — readArtifactBase64 / copyArtifact / setArtifactPinned
// were dispatched server-side but absent from the OPERATIONS table, so every
// ApiClient.call() of them threw "Unknown API operation" client-side. The
// typed surface turned that into a compile error; this test keeps the door
// shut. Bespoke non-operation endpoints (health, auth, bootstrap, binary
// download) are ApiClient methods, not `.call("…")`, and stay allowed.
//
// Run: node test/unit/no-raw-op-calls.unit.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "..", "src");

const offenders = [];
(function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (!p.endsWith(".ts")) continue;
        const lines = readFileSync(p, "utf8").split("\n");
        lines.forEach((line, i) => {
            if (/\.call\(\s*"/.test(line)) {
                offenders.push(`${relative(SRC, p)}:${i + 1}: ${line.trim()}`);
            }
        });
    }
})(SRC);

if (offenders.length > 0) {
    console.error("raw operation calls found — use ctx.web.ops.<operation>(params) instead:");
    for (const o of offenders) console.error("  " + o);
    process.exit(1);
}
console.log("ok: no raw api.call(\"op\") sites in mcp/src");
