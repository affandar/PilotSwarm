---
name: pilotswarm-release
description: Prepare and cut a PilotSwarm release. Use when validating release readiness, updating release-facing docs and templates, checking npm packaging, and handling commit/push/tag/publish flow.
---

# PilotSwarm Release

Use this skill when a user wants to prepare or cut a release of PilotSwarm.

Keep the workflow tight and deterministic. The goal is to verify what will ship, fix release blockers, and only then commit, push, tag, and publish.

## Release Workflow

1. Inspect the release surface.
   - Run `git status --short`.
   - Check changed runtime, docs, templates, examples, and workflow files.
   - Check current package names and versions in `packages/sdk/package.json` and `packages/cli/package.json`.
   - Check whether each published workspace package has its own `README.md`.

2. Verify feature-completeness around the change.
   - If behavior changed, confirm the canonical docs in `docs/` were updated.
   - Confirm the DevOps sample in `examples/devops-command-center/` still reflects the shipped behavior.
   - Confirm relevant builder templates in `templates/builder-agents/` were updated when builder-facing behavior changed.
   - Confirm `.github/copilot-instructions.md` was updated if contributor workflow or maintenance expectations changed.

3. Run build and full test suite.
   - Start with `npm run build`.
   - Run the **full** local integration test suite before any release:
     ```bash
     ./scripts/run-tests.sh
     ```
     All suites must pass. Do not skip suites or accept partial runs for an official release.
    - If the full suite fails, identify the specific failing test files and rerun those failing tests sequentially a few times, for example:
       ```bash
       ./scripts/run-tests.sh --sequential <suite-name>
       ```
       or run the specific file directly with `npx vitest run <path-to-test>`.
    - If the previously failing tests pass repeatedly in sequential mode, treat the failure as a parallel-run flake in the test harness and continue with the release. Call this out explicitly in the release notes.
   - If a test fails, investigate and fix the root cause. Do not silence failures or weaken assertions to proceed.
   - If package contents matter, run:
     ```bash
     npm pack --dry-run
     ```
     from `packages/sdk` and `packages/cli`.

4. Validate npm-release wiring.
   - Check `.github/workflows/publish-npm.yml`.
   - Confirm publish targets, access level, provenance flags, and required secrets still match the intended release.
   - Confirm each published package has correct `repository`, `homepage`, and `bugs` metadata for npm provenance verification.
   - Confirm built-in PilotSwarm plugins that must ship with the SDK are included by package `files` config.
   - Confirm package-local `README.md` files are actually present in `npm pack --dry-run` output for each workspace package.
   - If package names, publish workflow wiring, or npm metadata changed, run the CI publish workflow in dry-run mode from `main` before tagging a real release.

5. Prepare release notes for the user.
   - Summarize what changed.
   - List what was verified.
   - Call out blockers or skipped checks explicitly.

6. Commit and push only with explicit user approval.
   - Use non-interactive git commands.
   - Do not amend unless the user explicitly asks.
   - Prefer a commit message that describes the release-ready outcome, not just one file.

7. Tag and publish only with explicit user approval.
   - Create an annotated tag for the release version.
   - Push the commit and tag.
   - Create a **GitHub Release** from the tag using `gh release create`. The npm publish workflow (`publish-npm.yml`) triggers on `release: [published]`, **not** on tag push alone. Without a GitHub Release, the publish will not run.
   - Include a concise release notes summary in the GitHub Release body.
   - If a manual workflow dispatch is used instead, report the exact inputs used.

8. Verify publication.
   - Check that the GitHub Actions publish workflow started and completed using `gh run list --workflow=publish-npm.yml`.
   - Report the published package names and versions.
   - Verify the registry directly with `npm view <package> version`.
   - If publish failed, surface the workflow error rather than guessing.

## Release Checklist

- build passes
- full test suite passes (`./scripts/run-tests.sh`) or any failing suites pass repeatedly when rerun sequentially
- sample app still reflects shipped behavior
- relevant docs and guides are updated
- relevant builder templates are updated
- package metadata is correct
- `npm pack --dry-run` looks right
- package-local `README.md` files are present for published workspaces
- provenance metadata (`repository`, `homepage`, `bugs`) is correct
- commit, push, and tag are complete
- publish workflow ran successfully

## Current Package Surface

At the time this skill was added, PilotSwarm publishes:

- `pilotswarm-sdk`
- `pilotswarm-cli`

If package names change later, update this skill in the same change.

## Notes

- Prefer fixing brittle tests over loosening product behavior just to get green.
- If a test failure is caused by stale hardcoded assumptions such as old model names, update the test to follow the current repo contract.
- npm package pages for workspace publishes come from the workspace-local `README.md`, not the repo-root README.
- When provenance is enabled for npm publish, mismatched or missing repository metadata is a release blocker, not a cosmetic issue.
- Treat the release agent as a maintainer workflow for this repository, not as an app-builder template.
