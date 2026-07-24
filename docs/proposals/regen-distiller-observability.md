# Regen Distiller as a Service Session (M3 implementation spec)

Delta spec for `session-regen-and-footprint.md` §9 (which is the north
star; this file is the implementation-ordered view). The distiller stops
being an invisible ephemeral subprocess and becomes a **service session**:
a real, orchestration-modeled PilotSwarm session that reads the whole
archived transcript map-reduce style and emits the ResumePackage.

## 1. Service sessions — the new session class

Tree-scoped system sessions: machinery that serves ONE session tree, not
the cluster.

- CMS: `sessions.service_kind text` (`"regen-distiller"`),
  `sessions.service_of uuid` (the served session). `is_system` stays
  false. Migration **0037** is `ALTER TABLE ADD COLUMN` only; read paths
  use the established JS-side JOIN (the `transcript_epoch` precedent) —
  no proc return-type changes.
- Parent: the **root ancestor** of the served session (walk
  `parentSessionId` to null at spawn time). Sub-agent regens surface
  under the root.
- Identity: `agentId: "regen-distiller"`, title
  `Regen Distiller — <shortId> e<from>→e<to>`.
- **Orchestration-modeled**: spawned through the normal session-creation
  machinery and runs `durable-session-v2` like any session — lifecycle
  events, metrics, tokens-by-model, status, and **sweeper cleanup in the
  normal stale-terminal flow** all apply because nothing is special-cased.
  On completion of its single distillation turn it self-completes
  (terminal `completed`).
- Read-only + distinct icon in portal/TUI (§6); refuses user messages,
  regen, cron, children. Visibility follows the served tree.
- Deterministic distills create **no** service session; the parent gets a
  `session.regen_distill` event (`mode: "deterministic"`, reason,
  artifact ids).
- Idempotency: distiller sessionId = UUIDv5 of
  `(forSessionId, epoch, attemptId)` — pipeline retries reuse the same
  session instead of duplicating.

## 2. Pipeline change (orchestration 1.0.68)

Freeze `orchestration/` as `orchestration_1_0_67/` (hardcoding its
version — the frozen-1.0.65 lesson), live becomes **1.0.68**. The distill
stage changes from "run an in-activity subprocess" to:

1. `spawnDistiller` activity — create the service session (root parent,
   service columns, prompt = distiller input), start its orchestration.
2. Durable **timer-poll** (~10s) on the distiller's status via a cheap
   activity — polling, not child-wake, because the distiller is parented
   to the ROOT, which is not necessarily the regenerating session.
3. On `completed`: `collectDistillerResult` activity parses/validates the
   final message into the ResumePackage (existing normalize + validation),
   writes `package-e<E>-<attemptId>.json`, pipeline advances to flip.
4. On overall deadline (default 5 min), junk output, or distiller
   failure: cancel the distiller session, fall back to the deterministic
   package. The regen NEVER blocks on distillation quality.

`RegenState` gains `distillMode`, `instructions?`, `distillerModel?`,
`distillerSessionId?`.

## 3. Map-reduce distillation

The distiller agent's toolset: `read_transcript_page` (pages
`transcript-e<E>-<attemptId>.jsonl` from `service_of`'s artifact store —
registered ONLY for the `regen-distiller` identity) and nothing else. Its
prompt: page the archive start to finish, extract per-page notes (map),
then emit the ResumePackage JSON as the final assistant message (reduce),
with handoff + instructions as fenced untrusted inputs and the closure
(fact keys, child roster, artifact list) as control-plane truth. Long
transcripts cost more tool iterations, not new machinery.

## 4. Options & model policy

- `distillMode: "llm" | "deterministic"` — **default `llm`** on every
  surface; per-regen user choice. Deployment kill switch:
  `PILOTSWARM_REGEN_DETERMINISTIC_ONLY=1` (replaces the old opt-in
  `PILOTSWARM_REGEN_LLM_DISTILLER`).
- `instructions` (≤4000): how to distill; every surface (self tool,
  parent tool, API, MCP, portal textarea; TUI input). Untrusted-fenced;
  embedded as `requesterInstructions` in deterministic packages.
- Model: per-call `distillerModel` (catalog-validated) → **cluster
  default model** (`defaultModel`) → configured fallback → deterministic.
  The served session's model is not in the chain.

## 5. Dumps & stats

- Artifacts on the served session: `distill-input-e<E>-<attemptId>.md`,
  `distill-output-e<E>-<attemptId>.txt`, `package-e<E>-<attemptId>.json`.
- `session.epoch_committed` += `{distillMode, distillerModel?, distillerSessionId?}`;
  same fields into `lastRegenStats` → Stats "Last Regen" row shows the
  model; the distiller session itself carries per-turn model/tokens.

## 6. UX

- Icon: alembic glyph for `service_kind: "regen-distiller"` (generic
  service icon if other kinds appear later); rendered in the tree under
  the root.
- Read-only: no prompt input for service sessions; Lifecycle menu offers
  only Delete (operator escape hatch); regen/model-switch hidden.
- Portal Regenerate confirm: mode select (Intelligent LLM / Fast
  deterministic) + optional "Distilling instructions" textarea.

## 7. Test plan (delta)

- Unit: service-session row shape; UUIDv5 idempotency; model chain;
  instructions fencing; deterministic embed of `requesterInstructions`.
- Harness (1.0.68): distill stage spawn→poll→collect; deadline fallback;
  cancel mid-distill; goldens (fingerprint, lineage-jump) updated.
- e2e: live regen produces a visible read-only distiller session under
  the root with input/output artifacts; deterministic mode produces no
  session but the `session.regen_distill` event; sweeper reclaims the
  completed distiller.
