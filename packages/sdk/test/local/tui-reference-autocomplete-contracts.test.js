import { describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertIncludes } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readRepoFile(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("tui reference autocomplete contracts", () => {
    it("accepts @ / @@ autocomplete from the native prompt on Tab", () => {
        const cliApp = readRepoFile("packages/cli/src/app.js");

        assertIncludes(
            cliApp,
            'if (focus === "prompt" && controller.acceptPromptReferenceAutocomplete()) {',
            "TUI should accept prompt reference autocomplete before cycling focus",
        );
    });
});
