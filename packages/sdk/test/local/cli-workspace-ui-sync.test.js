import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { syncBundledWorkspaceUiPackages } from "../../../cli/src/sync-workspace-ui.js";
import { assertEqual, assertIncludes } from "../helpers/assertions.js";

const tempDirs = [];

function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-cli-sync-"));
    tempDirs.push(dir);
    return dir;
}

function writeFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
}

afterEach(() => {
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe("CLI workspace UI sync", () => {
    it("refreshes the vendored ui-core and ui-react copies from sibling workspace packages", () => {
        const rootDir = makeTempDir();
        const packagesDir = path.join(rootDir, "packages");
        const cliDir = path.join(packagesDir, "cli");

        writeFile(path.join(packagesDir, "ui-core", "package.json"), "{\"name\":\"pilotswarm-ui-core\"}\n");
        writeFile(path.join(packagesDir, "ui-core", "README.md"), "# ui-core\n");
        writeFile(path.join(packagesDir, "ui-core", "src", "controller.js"), "export const controllerVersion = 'fresh-core';\n");

        writeFile(path.join(packagesDir, "ui-react", "package.json"), "{\"name\":\"pilotswarm-ui-react\"}\n");
        writeFile(path.join(packagesDir, "ui-react", "README.md"), "# ui-react\n");
        writeFile(path.join(packagesDir, "ui-react", "src", "components.js"), "export const componentVersion = 'fresh-react';\n");

        writeFile(path.join(cliDir, "node_modules", "pilotswarm-ui-core", "src", "controller.js"), "export const controllerVersion = 'stale-core';\n");
        writeFile(path.join(cliDir, "node_modules", "pilotswarm-ui-react", "src", "components.js"), "export const componentVersion = 'stale-react';\n");

        const syncedPackages = syncBundledWorkspaceUiPackages({ cliPackageDir: cliDir });

        assertEqual(syncedPackages.length, 2, "both bundled UI packages should be synced");
        assertIncludes(
            fs.readFileSync(path.join(cliDir, "node_modules", "pilotswarm-ui-core", "src", "controller.js"), "utf8"),
            "fresh-core",
            "ui-core copy should be refreshed from the workspace source",
        );
        assertIncludes(
            fs.readFileSync(path.join(cliDir, "node_modules", "pilotswarm-ui-react", "src", "components.js"), "utf8"),
            "fresh-react",
            "ui-react copy should be refreshed from the workspace source",
        );
    });
});
