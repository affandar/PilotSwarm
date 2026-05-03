# Contributing to PilotSwarm

PilotSwarm is **experimental** and under active development. Contributions are
welcome, but please understand that the API surface, internal layout, and
release cadence are still in flux. Treat this as a research-grade project
rather than a stable platform.

## Before You Start

- Read the [README](README.md) and [Architecture](docs/architecture.md) to
  understand the layering: client → orchestration → worker → managed session.
- For changes inside the durable session orchestration, read
  [Orchestration Design](docs/orchestration-design.md). The orchestration is a
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

## Project Layout

```
packages/
  sdk/         — runtime, orchestration, worker, session manager, CMS catalog
  cli/         — terminal UI host
  portal/      — browser portal (React)
  ui-core/     — framework-free shared UI controller / state / selectors
  ui-react/    — shared React composition for cli + portal
  mcp-server/  — MCP server for exposing PilotSwarm tools
  sessionfs-pg — PostgreSQL session-state store
docs/          — architecture, orchestration design, proposals
deploy/        — Dockerfiles, Kubernetes manifests, runtime supervisor
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
  4. Trim the registry to the most recent five frozen versions

  See [docs/orchestration-design.md §12](docs/orchestration-design.md) for the
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
