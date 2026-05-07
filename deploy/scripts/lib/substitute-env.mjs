// Overlay .env substitution (Phase 4, FR-009).
//
// Reads `deploy/gitops/<service>/overlays/<env>/.env` line-by-line, replaces
// the value for each KEY whose KEY appears in the env map, and writes the
// result to `<staging>/gitops/<service>/overlays/<env>/.env`.
//
// Behavior:
//   - Lines matching `^[A-Z_][A-Z0-9_]*=` are candidate substitutions.
//     If the KEY is in env map → rewrite as `KEY=<env-value>`.
//     If the KEY is NOT in env map → COLLECT as unresolved (fail-closed, EC-3).
//   - Comments (`#`), blank lines, and lines whose first token isn't an
//     UPPER_SNAKE key pass through verbatim.
//
// Fail-closed rationale (plan §EC-3): the overlay .env feeds Kustomize's
// configMapGenerator → worker Deployment env vars. A missed key creates a
// silent runtime CrashLoop (e.g. KV_NAME=placeholder mounts the wrong KV).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const KEY_LINE_RE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;

// Substitute one overlay .env. Returns { substituted: string[], unresolved: string[] }.
// Throws (with a single sorted summary line) if any keys are unresolved.
export function substituteOverlayEnv({ srcPath, dstPath, envMap }) {
  const raw = readFileSync(srcPath, "utf8");
  const outLines = [];
  const substituted = [];
  const unresolved = new Set();

  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(KEY_LINE_RE);
    if (!m) {
      outLines.push(line);
      continue;
    }
    const [, key] = m;
    const v = envMap[key];
    if (v === undefined || v === null || v === "") {
      unresolved.add(key);
      outLines.push(line); // keep original placeholder so the file remains coherent on failure
      continue;
    }
    outLines.push(`${key}=${v}`);
    substituted.push(key);
  }

  if (unresolved.size > 0) {
    const list = [...unresolved].sort().join(", ");
    throw new Error(
      `Unresolved overlay .env keys in ${srcPath}: ${list}. ` +
        `Set them in deploy/envs/local/<env>/env, or run a prior ` +
        `--steps bicep so FR-022 alias map populates them.`,
    );
  }

  mkdirSync(dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, outLines.join("\n"));
  return { substituted, unresolved: [] };
}
