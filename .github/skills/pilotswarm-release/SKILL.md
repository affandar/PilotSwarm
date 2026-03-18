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

2. Verify feature-completeness around the change.
   - If behavior changed, confirm the canonical docs in `docs/` were updated.
   - Confirm the DevOps sample in `examples/devops-command-center/` still reflects the shipped behavior.
   - Confirm relevant builder templates in `templates/builder-agents/` were updated when builder-facing behavior changed.
   - Confirm `.github/copilot-instructions.md` was updated if contributor workflow or maintenance expectations changed.

3. Run build and targeted verification.
   - Start with `npm run build`.
   - Run the smallest set of tests that proves the changed behavior.
   - If you are fixing regressions, rerun the failing tests first, then a broader confidence pass.
   - For local integration tests, prefer:
     ```bash
     node --env-file=.env ./node_modules/vitest/vitest.mjs run <path-to-test>
     ```
   - If package contents matter, run:
     ```bash
     npm pack --dry-run
     ```
     from `packages/sdk` and `packages/cli`.

4. Validate npm-release wiring.
   - Check `.github/workflows/publish-npm.yml`.
   - Confirm publish targets, access level, and required secrets still match the intended release.
   - Confirm built-in PilotSwarm plugins that must ship with the SDK are included by package `files` config.

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
   - If npm publish is CI-driven, create or publish the GitHub release that triggers the workflow.
   - If a manual workflow dispatch is used, report the exact inputs used.

8. Verify publication.
   - Check that the GitHub Actions publish workflow started and completed.
   - Report the published package names and versions.
   - If publish failed, surface the workflow error rather than guessing.

## Release Checklist

- build passes
- changed tests pass
- sample app still reflects shipped behavior
- relevant docs and guides are updated
- relevant builder templates are updated
- package metadata is correct
- `npm pack --dry-run` looks right
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
- Treat the release agent as a maintainer workflow for this repository, not as an app-builder template.
