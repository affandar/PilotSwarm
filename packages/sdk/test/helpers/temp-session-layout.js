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
                // maxRetries/retryDelay: a just-killed worker may still be
                // flushing into the tree (same ENOTEMPTY race as
                // local-env.js reset()).
                rmSync(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            }
        },
    };
}
