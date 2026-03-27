import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempSessionLayout(prefix = "pilotswarm-test-") {
    const baseDir = mkdtempSync(join(tmpdir(), prefix));
    const sessionStateDir = join(baseDir, "session-state");

    return {
        baseDir,
        sessionStateDir,
        cleanup() {
            if (existsSync(baseDir)) {
                rmSync(baseDir, { recursive: true, force: true });
            }
        },
    };
}
