# Contributing to PilotSwarm

PilotSwarm is **experimental** and under active development. Contributions are
welcome, but please understand that the API surface, internal layout, and
release cadence are still in flux. Treat this as a research-grade project
rather than a stable platform.

## Before You Start

- Read the [README](README.md) and [Architecture](./docs/architecture/system.md) to
  understand the layering: client → orchestration → worker → managed session.
- For changes inside the durable session orchestration, read
  [Orchestration Design](./docs/architecture/orchestration/design.md). The orchestration is a
  duroxide replay generator — changing the order of yields is a versioning
  event, not a free refactor.
- Open an issue first for non-trivial work so we can discuss design before
  you spend time on a PR.

## Development Setup

1. **Prerequisites**

   - Node.js 20+
   - Docker (for local PostgreSQL) — or an existing Postgres instance reachable
     via a connection string
   - At least one LLM provider: a GitHub Copilot token (`GITHUB_TOKEN`) is the
     easiest, or any of the Azure / Anthropic providers configured in
     `.model_providers.json`

2. **Install and configure**

   ```bash
   npm install
   cp .env.example .env
   cp .model_providers.example.json .model_providers.json
   # edit .env: set DATABASE_URL and at least one provider key
   $EDITOR .model_providers.json
   ```

3. **Start Postgres** (skip if you already have one)

   ```bash
   docker run --rm -d \
     -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=pilotswarm \
     -p 5432:5432 postgres:16
   ```

4. **Build and run the test suite**

   ```bash
   npm run build
   npm test
   npm run test:local           # full local integration suite (slow; needs LLM)
   ```

   For faster feedback while iterating on a specific area:

   ```bash
   npm run test:local:smoke
   npm run test:local:durability
   npm run test:local:sub-agents
   ```

   Plugin and consumer repositories can add an explicit Vitest directory to
   the complete PilotSwarm gate without changing its built-in suite:

   ```bash
   ./scripts/run-tests.sh --external-test-dir=../plugin-repo/tests/pilotswarm
   ```

   During plugin-only iteration, skip PilotSwarm's built-in phases and provider
   setup explicitly:

   ```bash
   ./scripts/run-tests.sh --external-only \
     --external-test-dir=../plugin-repo/tests/pilotswarm \
     --external-test-filter=audience-map
   ```

   External directories are optional and are never discovered automatically.
   Their tests should use public PilotSwarm package surfaces while keeping
   repository-specific fixtures, endpoints, and credentials in the repository
   that owns them.

   Each supplied directory is an independent Vitest root and must follow this
   contract:

   - Name test files `*.test.js`, `*.test.mjs`, `*.test.ts`, or `*.test.mts`.
   - Write tests for the Node environment. Vitest globals such as `describe`,
     `it`, and `expect` are enabled; tests do not need to import `vitest`.
   - Resolve fixtures relative to the test module, for example with
     `import.meta.url`. The supplied directory is Vitest's discovery root, but
     `process.cwd()` remains the PilotSwarm checkout that invokes the runner.
   - Install consumer dependencies and prepare generated artifacts before
     invoking the runner. `--external-only` does not build either repository.
     The consumer must install the public `pilotswarm-sdk` version it intends
     to validate; the runner does not substitute the platform checkout's
     private source tree for that package.
   - Provide required environment variables and credentials explicitly.
     PilotSwarm's `.env` and provider setup are not loaded by `--external-only`.
   - Import supported public package exports rather than private source files.
   - Keep shared setup inside the test directory or import it from the consumer
     package. The runner uses `scripts/external-vitest.config.mjs` and does not
     discover a consumer `vitest.config.*` automatically.
   - Treat `--external-test-filter` values as test-file path substrings, not
     individual test-name filters.

   A minimal external test can be created as
   `tests/pilotswarm/platform-contract.test.mjs`:

   ```js
   import { normalizeVisibility } from "pilotswarm-sdk/api";

   describe("platform integration", () => {
     it("uses a public platform contract", () => {
       expect(normalizeVisibility("SHARED_READ")).toBe("shared_read");
     });
   });
   ```

   Run it from the PilotSwarm checkout:

   ```bash
   ./scripts/run-tests.sh --external-only \
     --external-test-dir=../plugin-repo/tests/pilotswarm \
     --external-test-filter=platform-contract
   ```

## Project Layout

```
packages/
  sdk/           — runtime, orchestration, worker, session manager, CMS catalog
    api/         —   zero-dep isomorphic Web API client (pilotswarm-sdk/api)
  app/           — the "pilotswarm" application package
    tui/         —   terminal UI host (+ pilotswarm/host node layer)
    web/         —   portal server (Web API host) + browser portal UI
    mcp/         —   MCP server (Web API mode)
    ui/          —   shared UI layers (pilotswarm/ui-core, pilotswarm/ui-react)
  horizon-store/ — optional enhanced facts/graph provider (dynamically imported)
docs/            — see docs/README.md (quickstart, user guide, architecture, API, developer)
deploy/          — Dockerfiles, Kubernetes manifests, runtime supervisor
```

Most contributions live under `packages/sdk/src/`.

## Pull Request Conventions

- **One change per PR.** Refactors, bug fixes, and features should be separate
  PRs even if related. It makes review possible.
- **Tests required for behavior changes.** New activities, orchestration
  branches, or tool implementations need at least one test under
  `packages/sdk/test/local/`. Pure refactors don't need new tests but must
  keep the existing suite green.
- **Keep `tsc --noEmit` clean.** Add types rather than `any` where practical.
- **Conventional-ish commit messages.** No strict tooling, but follow the
  style in `git log`: lowercase prefix (`sdk:`, `orch:`, `ui:`, `docs:`),
  concise subject, blank line, then a body that explains *why*.
- **Don't change the orchestration without a version bump.** If your change
  alters the order, count, or arguments of `yield` calls inside any
  `durableSessionOrchestration_*` handler, you must:
  1. Freeze the current latest as a `_X_Y_Z.ts` sibling
  2. Edit `packages/sdk/src/orchestration-version.ts` to bump the latest
  3. Update `packages/sdk/src/orchestration-registry.ts`
  4. Trim the registry to versions at or above the compatibility floor

  See [docs/architecture/orchestration/design.md §12](./docs/architecture/orchestration/design.md) for the
  full replay-safety rules.

## Continuous Integration

The full test suite is configured as a manual-trigger GitHub Action gated to
the maintainer. Forks won't auto-run it. When you open a PR, the maintainer
will run the suite once review converges.

You can run the full local suite at any time:

```bash
./scripts/run-tests.sh
```

It takes about 6 minutes against a healthy local Postgres + Copilot token.

## Coding Style

- TypeScript for new SDK code; JavaScript is fine for ui-core/ui-react/cli.
- 4-space indent, double-quoted strings.
- Avoid premature abstractions. Three similar lines beat a half-thought-out
  helper. The `simplify` skill in this repo lays out the philosophy.
- Avoid comments that describe *what* the code does. Comments are for *why* —
  hidden constraints, subtle invariants, surprising behavior.

## Filing Issues

Helpful issue reports include:

- the version of `pilotswarm-sdk` (or commit SHA if running from source)
- minimal reproduction steps
- the orchestration version (`packages/sdk/src/orchestration-version.ts`)
- relevant log output (worker traces, session events) — redact secrets first

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).

### Contributor License Agreement

Contributors must also accept the [PilotSwarm Contributor License Agreement
(CLA)](CLA.md) before their contributions are merged. The agreement grants rights
to Affan Dar, the project maintainer, while contributors retain their copyright.
It includes copyright and patent licenses, permission to sublicense, and provision
for a future project steward. This is separate from the Microsoft CLA.

To sign, follow the CLA Assistant link on your pull request and accept the displayed
agreement using your own GitHub account. Existing contributors can also use the
[PilotSwarm signing page](https://cla-assistant.io/affandar/PilotSwarm).
Signing version 1.0 covers your authorized past and future PilotSwarm contributions.
An updated agreement may require a new acceptance.

If you contribute for an employer, obtain the required permission and signing
authority first. Employment at Microsoft or a signature on another project's CLA
does not exempt you from this agreement. Each human contributor must be covered,
including coauthors; opening a PR for someone else does not sign for them.

CLA Assistant is being connected as part of this rollout. If the signing page or
check is unavailable, contact the maintainer on your PR and wait for verification
before merging. A missing check is not evidence of acceptance.
