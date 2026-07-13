# Artifact API v2: a real data plane for agents

**Status:** implemented (SDK, stores, MCP, portal transport) · **Origin:** 2026-07-12 Diagon Alley incident

## Problem

The v1 artifact surface made the model the wire: `write_artifact` accepted only inline
`content` (every byte re-emitted as output tokens), `read_artifact` returned text-only
content into context (binary → dead end, ~15KB practical inline bound), and no digest was
ever computed. Agents responded rationally — base64 sidecars, staging pods, SHA-256s
smuggled through facts, "transfers reported as blocked" — burning hours and millions of
tokens on ceremony, then canonizing it as learned skills. Separately, the portal resolved
its artifact store from the wrong env flag (`PILOTSWARM_USE_MANAGED_IDENTITY`, the DB flag,
instead of `PILOTSWARM_BLOB_USE_MANAGED_IDENTITY`) and silently fell back to an empty
filesystem store — every TUI/MCP download said "not found" while workers wrote to blob.

## Design rule

**The model is a control plane, not a wire.** Bytes that already exist move by reference
(paths, artifact refs); every operation returns provenance (`sha256`, `contentType`,
`sizeBytes`, `artifactLink`) so verification never requires a transfer.

## The surface (3 agent tools, was 4, capability strictly greater)

| Tool | Modes |
|---|---|
| `write_artifact` | exactly one source: `content` (inline, 1MB) · `fromFile` (worker-local path, streamed, jailed, 256MB) · `fromArtifact` (server-side copy, optional `expectedSha256` precondition) — plus `pin` for deliverables |
| `read_artifact` | inline (bounded by `maxBytes`/`offset`, `encoding: base64` for small binaries) · `toFile` (stream to worker disk) · `metaOnly` (stat) |
| `list_artifacts` | discovery with full metadata |

`export_artifact` is retired — every result carries the `artifact://` link. Handler
validation returns teaching errors (`EXCLUSIVE_SOURCE`, `SHA_MISMATCH`,
`PATH_OUTSIDE_WORKDIR`, `ARTIFACT_IS_BINARY` with a `toFile` hint); models recover
reliably from actionable tool errors, and consolidation beats tool bloat for selection.

## Stores & other surfaces

`ArtifactStore` (blob + filesystem) gains `uploadArtifactFromFile` (streamed, hashed),
`copyArtifact`, `statArtifact`, `setArtifactPinned`; `sha256`/`pinned`/`sourceDetail`
persist in metadata; bulk cleanup skips pinned artifacts. MCP gains `copy_artifact`,
`pin_artifact`, `get_artifact include:'base64'`, and loud not-found instead of
`meta: null` + fabricated URLs. Base prompts (framework default agent, sub-agent and
top-level session prompts) now state that **pods never share a filesystem** and teach the
`fromFile`/`toFile` handoff. The env fix makes `createSessionBlobStore` honor the
`_BLOB_` flag and throw instead of silently degrading to filesystem.

## Notes

- Found during rollout: the framework default agent's `tools:` frontmatter had silently
  dropped `list_artifacts` for all agents — allowlists in agent files are part of the API
  surface; the contracts test now pins the trio.
- Follow-ups (not in scope): blob-native `beginCopyFromURL` for large copies; retention
  TTLs beyond pin/unpin; retiring the incident-learned "artifact ceremony" skills facts
  in deployed knowledge stores.
- Tests: `packages/sdk/test/unit/artifact-api-v2.test.mjs` (16 cases incl. prompt
  contract), updated `contracts.test.js`, MCP registration test, existing binary
  artifact suites green.
