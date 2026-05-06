/**
 * Process-level registry of outstanding temp plugin directories created by the
 * prompt-testing variant runner.
 *
 * Why this exists:
 *   `runVariantMatrix()` creates temp dirs with `mkdtempSync()` and removes
 *   them in a `finally` block on the happy path. That handles clean returns
 *   and thrown errors, but NOT:
 *     - SIGINT / SIGTERM (e.g. Ctrl-C, vitest hard kill on timeout)
 *     - `process.exit(...)` from inside a handler
 *     - `uncaughtException` that bypasses the finally
 *
 *   In any of those cases the OS temp dir leaks. Over many CI runs that adds
 *   up to gigabytes of stale `ps-prompt-variant-*` directories.
 *
 * What this module guarantees:
 *   - Every dir registered here is best-effort removed on `process.exit`
 *     (covers normal exit and `process.exit()` calls).
 *   - On `SIGINT` / `SIGTERM`, registered dirs are cleaned up and then the
 *     signal's default exit code (130 / 143) is used.
 *   - On `uncaughtException`, the `exit` event still fires after Node prints
 *     the stack and terminates. We deliberately do NOT install our own
 *     `uncaughtException` handler: doing so suppresses Node's default crash
 *     behavior and risks re-entering ourselves if we re-throw inside the
 *     handler. The `exit` listener above already runs in that path.
 *   - Hooks are installed lazily, exactly once per process. Calling
 *     `registerTempDir()` is the only way to opt in. This avoids polluting
 *     the process for callers that never use prompt-testing.
 *   - Other libraries' SIGINT/SIGTERM listeners are NOT replaced — we add
 *     our own listeners and rely on Node's multi-listener model.
 *
 * Limitations:
 *   - SIGKILL cannot be intercepted. A hard kill -9 will still leak.
 *   - If a parent process crashes the entire Node runtime mid-cleanup,
 *     any dirs not yet removed will remain. The OS temp dir is the right
 *     place for them — it's swept by the platform.
 *   - `process.exit()` inside an async chain may run before all
 *     listeners — registered dirs that were already removed via the
 *     normal `finally` are a no-op here.
 */

import { rmSync } from "node:fs";

const TRACKED: Set<string> = new Set();
let installed = false;

/** Internal — exposed for tests that need to inspect outstanding dirs. */
export function _getTrackedTempDirs(): readonly string[] {
  return Array.from(TRACKED);
}

/** Best-effort remove a single dir; errors swallowed (we are in shutdown). */
function rmDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* shutdown path — surfacing here would mask the real exit cause */
  }
}

function cleanupAll(): void {
  for (const dir of TRACKED) rmDir(dir);
  TRACKED.clear();
}

function installHooks(): void {
  if (installed) return;
  installed = true;

  // Normal exit (process.exit, empty event loop). Synchronous only.
  process.on("exit", cleanupAll);

  // Signals — Node's default action for SIGINT/SIGTERM is to terminate
  // without firing 'exit'. Because we attach a listener, that default is
  // suppressed; we must explicitly call `process.exit()` after cleanup.
  // Use the conventional exit codes (128 + signal number).
  const onSig = (sig: NodeJS.Signals): void => {
    cleanupAll();
    const code = sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 1;
    // Defer exit so any other listeners get a chance to fire too.
    setImmediate(() => process.exit(code));
  };
  process.on("SIGINT", () => onSig("SIGINT"));
  process.on("SIGTERM", () => onSig("SIGTERM"));

  // NOTE: We deliberately do NOT install an `uncaughtException` handler.
  // Doing so suppresses Node's default crash semantics (printed stack +
  // non-zero exit) and risks re-entering this same handler if a rethrow
  // happens to fire while the listener is still attached. The `exit`
  // listener above runs after `uncaughtException`, so cleanup still happens
  // — and the process crashes cleanly with the original error.
}

/** Track a dir for best-effort cleanup at process exit / signal / crash. */
export function registerTempDir(dir: string): void {
  installHooks();
  TRACKED.add(dir);
}

/**
 * Remove a dir from the registry — call after the dir has been cleaned up
 * normally so the exit hook doesn't try to remove it again (which is harmless
 * but noisy).
 */
export function unregisterTempDir(dir: string): void {
  TRACKED.delete(dir);
}
