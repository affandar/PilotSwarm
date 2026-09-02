// Devbox worker owner preload.
//
// Loaded via `node --import ./scripts/devbox-owner.mjs` BEFORE the SDK worker
// constructor reads the environment. Resolves the signed-in Azure (Entra)
// identity of whoever is running this devbox and injects it as the worker
// owner, so the worker claims owner-scoped work induced for generators this
// user registered.
//
// Owner alone is a no-op: scopeWorkerTagFilter only applies the owner by
// rewriting a concrete tag list. PILOTSWARM_WORKER_TAGS (e.g. repo:myrepo)
// must also be set for the owner to take effect. That stays in the env file so
// each devbox declares which repo(s) its generators target.
//
// Respects an explicit override: if PILOTSWARM_WORKER_OWNER_SUBJECT is already
// set, this preload does nothing.

import { execFileSync } from "node:child_process";

const PROVIDER = "entra";

function log(message) {
    console.log(`[devbox-owner] ${message}`);
}

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
