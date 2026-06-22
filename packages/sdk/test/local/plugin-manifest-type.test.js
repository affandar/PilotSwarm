/**
 * Public `PluginManifest` type — surface test.
 *
 * Verifies the public type re-export from `pilotswarm-sdk` is available
 * to plugin authors and that the live `plugin.json` files in this repo
 * conform to the typed shape. This guards against accidental regressions
 * where the type signature drifts from the actual loader behavior.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Import the public type from the SDK's index. If this import path
// breaks, plugin authors will see the same breakage — that is the gate.
/** @type {import("../../src/index.ts").PluginManifest | null} */
let _typeProbe = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

describe("PluginManifest public type", () => {
    it("is re-exported from pilotswarm-sdk's public index", async () => {
        const sdkIndex = await fs.promises.readFile(
            path.join(REPO_ROOT, "packages", "sdk", "src", "index.ts"),
            "utf-8",
        );
        expect(sdkIndex).toMatch(/export\s+type\s*\{\s*PluginManifest\s*\}/);
    });

    it("matches the shape of every checked-in plugin.json", () => {
        // Discover every checked-in plugin.json under packages/ and examples/
        // (excluding node_modules, dist, and test fixtures).
        const roots = [
            path.join(REPO_ROOT, "packages"),
            path.join(REPO_ROOT, "examples"),
        ];
        const pluginJsonPaths = [];
        const walk = (dir) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    if (
                        entry.name === "node_modules" ||
                        entry.name === "dist" ||
                        entry.name === "fixtures" ||
                        entry.name === ".git"
                    ) continue;
                    walk(path.join(dir, entry.name));
                } else if (entry.isFile() && entry.name === "plugin.json") {
                    pluginJsonPaths.push(path.join(dir, entry.name));
                }
            }
        };
        for (const root of roots) walk(root);

        expect(pluginJsonPaths.length).toBeGreaterThan(0);

        for (const pluginJsonPath of pluginJsonPaths) {
            const raw = fs.readFileSync(pluginJsonPath, "utf-8");
            /** @type {import("../../src/index.ts").PluginManifest} */
            const manifest = JSON.parse(raw);

            // Spot-check the known typed fields. Type-level validation
            // happens at compile time via `tsc --noEmit`; this runtime
            // assertion catches regressions that bypass the type system
            // (e.g. someone writing a plugin.json with `tools: 123`).
            if ("name" in manifest) expect(typeof manifest.name).toBe("string");
            if ("version" in manifest) expect(typeof manifest.version).toBe("string");
            if ("tools" in manifest) expect(typeof manifest.tools).toBe("string");
            if ("agents" in manifest) {
                const a = manifest.agents;
                expect(typeof a === "string" || Array.isArray(a)).toBe(true);
            }
            if ("skills" in manifest) {
                const s = manifest.skills;
                expect(typeof s === "string" || Array.isArray(s)).toBe(true);
            }
        }
    });
});
