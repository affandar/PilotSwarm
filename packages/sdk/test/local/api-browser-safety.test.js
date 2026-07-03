/**
 * Browser-safety guard for the `pilotswarm-sdk/api` subpath.
 *
 * The wire client used to be a separate zero-dependency package, which made
 * browser-safety structural. Folded into the SDK, the guarantee is enforced
 * here instead: the api subgraph must bundle for the browser with NO external
 * imports and NO Node builtins. If someone adds `node:crypto` (or any bare
 * import) to anything under packages/sdk/api/, this test fails at the exact
 * import.
 */

import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { build } from "esbuild";
import { assert, assertEqual } from "../helpers/assertions.js";

const API_ENTRY = fileURLToPath(new URL("../../api/index.js", import.meta.url));
const API_DIR = dirname(API_ENTRY);

describe("pilotswarm-sdk/api browser safety", () => {
    it("bundles for the browser with zero external/node imports", async () => {
        const result = await build({
            entryPoints: [API_ENTRY],
            bundle: true,
            platform: "browser",
            format: "esm",
            write: false,
            logLevel: "silent",
            metafile: true,
        });
        assertEqual(result.errors.length, 0, "esbuild browser bundle has no errors");
        // Every input must come from inside the api/ tree — a bare or node:
        // import would either error the build or appear as an external input.
        const inputs = Object.keys(result.metafile.inputs);
        // Metafile inputs are cwd-relative; resolve before comparing.
        const outsiders = inputs.filter((p) => !resolve(p).startsWith(API_DIR));
        assert(outsiders.length === 0, `api subgraph pulled non-api inputs: ${outsiders.join(", ")}`);
    });
});
