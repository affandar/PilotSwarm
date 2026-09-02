// Devbox worker preload — the single source of devbox worker identity.
//
// Loaded via `node --import ./scripts/devbox-owner.mjs` (the `worker:dev` npm
// script) BEFORE the SDK worker constructor reads the environment. This is the
// ONE canonical way to launch a worker on a devbox: `npm run worker:dev`. All
// devbox-specific setup lives here so there is no second, drift-prone launch
// path to keep in sync. It does two things, each idempotent and each
// respecting an explicit override:
//
//  1. Owner. Resolves the signed-in Azure (Entra) identity of whoever is
//     running this devbox and injects it as the worker owner, so the worker
//     claims owner-scoped work induced for generators this user registered.
//     Owner alone is a no-op: scopeWorkerTagFilter only applies the owner by
//     rewriting a concrete tag list. PILOTSWARM_WORKER_TAGS (e.g. repo:myrepo)
//     must also be set for the owner to take effect. That stays in the env
//     file so each devbox declares which repo(s) its generators target.
//     Skipped if PILOTSWARM_WORKER_OWNER_SUBJECT is already set.
//
//  2. Node id. Pins POD_NAME to `devbox-<hostname>` so every restart reuses
//     ONE canonical worker registration. worker.js derives workerNodeId from
//     POD_NAME || os.hostname(); without this pin, a bare-hostname launch
//     registers under a DIFFERENT identity than a `devbox-`-prefixed one,
//     leaving a duplicate row (one live, one aging to `stale`) for a single
//     machine. Skipped if POD_NAME is already set.
//
// It deliberately does NOT set GITHUB_TOKEN. On a devbox the model credential
// is the signed-in Copilot user from the `copilot` CLI login (COPILOT_HOME):
// when no GITHUB_TOKEN is set the worker resolves NO token and the SDK builds a
// tokenless client that authenticates as that signed-in user. A `gh auth token`
// is an unrelated gh-CLI OAuth token that GitHub rejects for the Copilot
// exchange (HTTP 403), so injecting it here would REPLACE working signed-in-user
// auth with a poisoned session. Fleet/CI still pass an explicit GITHUB_TOKEN via
// the environment, which is honored unchanged.

import { execFileSync } from "node:child_process";
import os from "node:os";

const PROVIDER = "entra";

function log(message) {
    console.log(`[devbox-owner] ${message}`);
}

// 2. Pin the canonical worker node id so restarts reuse one registration.
if (process.env.POD_NAME?.trim()) {
    log(`POD_NAME already set (${process.env.POD_NAME.trim()}); leaving as-is.`);
} else {
    process.env.POD_NAME = `devbox-${os.hostname()}`;
    log(`worker node id pinned to ${process.env.POD_NAME}.`);
}

// 1. Resolve and inject the devbox worker owner.
if (process.env.PILOTSWARM_WORKER_OWNER_SUBJECT?.trim()) {
    log(
        `PILOTSWARM_WORKER_OWNER_SUBJECT already set (${process.env.PILOTSWARM_WORKER_OWNER_SUBJECT.trim()}); leaving as-is.`,
    );
} else {
    try {
        const subject = execFileSync(
            "az",
            ["ad", "signed-in-user", "show", "--query", "id", "-o", "tsv"],
            { encoding: "utf8", shell: true },
        ).trim();

        if (!subject) {
            throw new Error("az returned an empty object id");
        }

        process.env.PILOTSWARM_WORKER_OWNER_PROVIDER = PROVIDER;
        process.env.PILOTSWARM_WORKER_OWNER_SUBJECT = subject;
        log(`worker owner set to ${PROVIDER}:${subject} (signed-in az identity).`);

        if (!process.env.PILOTSWARM_WORKER_TAGS?.trim()) {
            log(
                "WARNING: PILOTSWARM_WORKER_TAGS is not set. Owner has no effect without a tag list; "
                + "set e.g. PILOTSWARM_WORKER_TAGS=repo:myrepo so the owner scopes a concrete tag.",
            );
        }
    } catch (error) {
        log(
            `WARNING: could not resolve signed-in az identity (${error?.message ?? error}). `
            + "Falling back to unowned worker. Run 'az login' or set "
            + "PILOTSWARM_WORKER_OWNER_PROVIDER/SUBJECT manually.",
        );
    }
}
