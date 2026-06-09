// Phase 7 (FR-027): `pilotswarm smoke` subcommand entry.
//
// Parses args, validates, then hands off to runDriver. Keeps the
// arg-parsing surface and exit-code mapping in one place so the
// driver itself can be unit-tested as a pure function.

import { parseArgs } from "node:util";
import { runDriver, DEFAULT_DRIVER_DEPS } from "./driver.js";
import oboProfile from "./profiles/obo.js";

const HELP_TEXT = `pilotswarm smoke <stamp> [options]

Run a live-tenant smoke profile against a deployed PilotSwarm stamp.

Arguments:
  <stamp>                    The local-env name (resolves
                             deploy/envs/local/<stamp>/.env).

Options:
  --profile <name>           Smoke profile to run. Built-in: 'obo'.
                             Default: 'obo'.
  --auth <mode>              User-token acquisition mode:
                               device-code  (default; interactive)
                               from-env     (reads OBO_SMOKE_USER_ADMISSION_TOKEN
                                             and OBO_SMOKE_USER_DOWNSTREAM_TOKEN
                                             from the environment;
                                             intended for CI)
  --portal-base-url <url>    Override portal base URL (default: derived
                             from the stamp env / DNS).
  --skip-kube-bootstrap      Skip the implicit `az aks get-credentials`
                             step. Use this in CI where kubeconfig is
                             already loaded explicitly.
  --json                     Emit only the result JSON record on stdout.
                             Progress lines go to stderr regardless.
  -h, --help                 Show this help and exit.

Exit codes:
  0  smoke passed
  1  smoke failed (see JSON record for failedStep + reason)
  2  invalid args / preflight failure (e.g., stamp env missing keys)
`;

const PROFILES = {
    obo: oboProfile,
};

function parseSmokeArgs(argv) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            strict: true,
            options: {
                profile: { type: "string", default: "obo" },
                auth: { type: "string", default: "device-code" },
                "portal-base-url": { type: "string" },
                "skip-kube-bootstrap": { type: "boolean", default: false },
                json: { type: "boolean", default: false },
                help: { type: "boolean", short: "h", default: false },
            },
        });
    } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
    }
    if (parsed.values.help) {
        return { ok: true, help: true };
    }
    const stamp = parsed.positionals[0];
    if (typeof stamp !== "string" || stamp.length === 0) {
        return { ok: false, error: "missing required positional <stamp>" };
    }
    const profile = parsed.values.profile;
    if (!Object.prototype.hasOwnProperty.call(PROFILES, profile)) {
        return { ok: false, error: `unknown profile: ${profile} (built-in: ${Object.keys(PROFILES).join(", ")})` };
    }
    const auth = parsed.values.auth;
    if (auth !== "device-code" && auth !== "from-env") {
        return { ok: false, error: `unknown --auth mode: ${auth} (valid: device-code, from-env)` };
    }
    return {
        ok: true,
        opts: {
            stamp,
            profile,
            authMode: auth,
            portalBaseUrl: parsed.values["portal-base-url"] ?? null,
            skipKubeBootstrap: parsed.values["skip-kube-bootstrap"] ?? false,
            json: parsed.values.json,
        },
    };
}

/**
 * Entry point for the `pilotswarm smoke` subcommand. Returns a
 * process exit code (0 / 1 / 2).
 */
export async function runSmoke(argv, deps = DEFAULT_DRIVER_DEPS) {
    const parsed = parseSmokeArgs(argv);
    if (parsed.help) {
        process.stdout.write(HELP_TEXT);
        return 0;
    }
    if (!parsed.ok) {
        process.stderr.write(`pilotswarm smoke: ${parsed.error}\n\n`);
        process.stderr.write(HELP_TEXT);
        return 2;
    }
    const profileImpl = PROFILES[parsed.opts.profile];
    const result = await runDriver({ ...parsed.opts, profileImpl }, deps);

    const json = JSON.stringify(result, null, 2);
    if (parsed.opts.json) {
        process.stdout.write(json + "\n");
    } else {
        process.stdout.write(json + "\n");
    }
    if (!result.pass) return result.exitCode ?? 1;
    return 0;
}
