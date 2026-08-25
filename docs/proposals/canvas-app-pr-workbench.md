# Worked example: the PR review workbench

The concrete companion to [interactive-canvas-apps.md](interactive-canvas-apps.md).
That document specifies the mechanism. This one shows the actual keys, the
actual protocol, and the four gaps a real PR workflow exposes.

## 1. What already exists on chk

Someone built this by hand. Session `4611f2a0`, artifact
`pg-durable-pr-review-workbench.html`, 52 KB, manifest v1.0.0:

```jsonc
"responseContract": { "actions": {
    "submit_review":  { "payload": "json" },
    "resolve_thread": { "threadId": "string", "resolved": "boolean" } } },
"data":  "{rev, threads:[{id,file,hunk,lineStart,lineEnd,quote,kind,body,
          author,status,createdAt,replies:[{author,body,at}]}]} — WHOLE-STATE, <=32KB",
"notes": "Persist submitted threads under pr-review/pg-durable/thread/<threadId>
          and the index under pr-review/pg-durable/index."
```

The author independently invented per-thread fact keys and an index fact —
the KV model, hand-rolled a phase early. It works, and it hits four ceilings:

- **The page cannot read those facts.** Threads reach the page only as
  `update_canvas` whole-state ticks, capped at 32 KB for every thread combined.
- **Every comment round-trips through an LLM turn.** There is no page→page path.
- **Only the session creator may comment.** Actions are creator-only.
- **The code is baked.** Measured: `DATA` is 17.5 KB covering 11 files,
  14 findings, **97 lines of quoted code** across three PRs — 49% of the payload
  is hunk text. The page has **zero** `fetch`, `XMLHttpRequest`, or `WebSocket`.

That last point is the important one. **This is an evidence board, not a diff
viewer.** The reviewer can only look at what the agent pre-selected.

## 2. The scenario

```
Bob opens a PR.
Alice starts a review session. She owns it.
The AI analyses the PR and loads the workbench.
Alice comments. Some comments ask the AI to dig deeper, some ask Bob,
  some say "file an ADO item", some say "write the fix".
Bob sees the same board and replies.
The AI sees Bob's replies and answers them.
Bob pushes a new commit and asks for a re-analysis.
```

Three parties, two of whom are humans who must not have to take turns.

## 3. The data model, concretely

Everything below lives under one prefix the server stamps and the page never
writes:

```
session:<AliceSession>:canvas/1/kv/
```

### Keys

```
cfg/pr                     { repo, prId, url, title, author, baseSha, headSha }
cfg/policy                 { autoQueueFrom, reviewers, aiBudget }
cfg/analysis               { rev, headSha, generatedAt, artifactPrefix, fileCount }
                           ↑ cfg/* is owner-and-agent writable. The page reads it.

app/file/<idx>             { path, status, add, del, hunkCount, artifact }
app/finding/<fid>          { file, line, sev, title, body, evidence, anchorSha }
                           ↑ the agent writes these. Everyone reads.

app/thread/<tid>           { file, line, anchorSha, to, kind, author,
                             body, status, createdAt }
app/thread/<tid>/reply/<n> { author, body, at }
                           ↑ anyone the policy admits writes these.

req/<rid>                  { op, args, status, by, threadId? }
evt/<n>                    { kind, ... }            agent → page notices
ui/<writerId>              { viewing, typing, at }  presence, expires on `at`
```

**One key per independently-edited unit** is what makes this safe. Alice and
Bob replying to the same thread write `reply/3` and `reply/4` — different keys,
no clobber. A thread list in one key would lose one of them.

### Thread shape

```jsonc
{ "file": "src/worker.rs", "line": 412, "anchorSha": "c4cac50…",
  "to": "ai" | "bob@…" | "all",
  "kind": "question" | "blocker" | "nit" | "request",
  "body": "Does this path hold the lock across the await?",
  "status": "open" | "answered" | "resolved" }
```

`to` is what routes it. `anchorSha` is what survives Bob's next push (§5).

### Requests

A thread addressed to the AI also creates a request:

```jsonc
req/r12 = { "op": "investigate", "threadId": "t7",
            "status": "suggested",        // Bob wrote it
            "by": { "kind": "user", "id": "bob@…" } }
```

Ops this workflow needs: `investigate`, `file_ado_item`, `propose_fix`,
`reanalyse`. Each is a verb the agent already has tools for — the request just
names it and points at the thread carrying the detail.

## 4. The protocol

### Setup — the agent, once

```
1. Analyse the PR with its own repo tools (repo-cache, ado_rest).
2. Write the diff as ARTIFACTS, not into the KV:
     pr/<prId>/<headSha>/manifest.json
     pr/<prId>/<headSha>/file/<n>.json
3. Write cfg/* , app/file/* , app/finding/* into the KV.   (small, structured)
4. draw_canvas(fromArtifact: "apps/pr-workbench.html")     (the shell, data-free)
5. Tell Alice: set the canvas policy, and share with Bob.
```

Step 2 is the load-bearing one and §6 is about why.

### canvas ↔ canvas — no agent, ~50 ms

```
Alice types a comment  → kv.put("app/thread/t7", {...})
Bob's browser renders it via onChange, ~50 ms later. No turn. No tokens.
Bob replies            → kv.put("app/thread/t7/reply/1", {...})
Presence               → kv.put("ui/<me>", {viewing:"src/worker.rs"})
```

This is the half that does not exist today, and it is most of the interaction.

### canvas → LLM

```
Alice's thread to:"ai"  → req/<rid> lands "queued"     (she owns the session)
Bob's thread to:"ai"    → req/<rid> lands "suggested"  (he does not)
Alice promotes Bob's    → status:"queued"
Agent drains queued rows on its next wake, or immediately if Alice's page rings.
```

### LLM → canvas

```
Answer a thread    → kv.put("app/thread/t7/reply/2", {author:"ai", body})
Progress           → kv.put("req/r12", {...,status:"working"})
New finding        → kv.put("app/finding/f9", {...})
Filed an ADO item  → kv.put("evt/14", {kind:"ado_filed", id:5525012, url})
Re-analysis done   → new artifacts + kv.put("cfg/analysis", {rev:2, headSha:…})
```

Note what is absent: **no redraw.** The board changes because rows changed.
The document is drawn once and stays.

## 5. Bob pushes a new commit

The hard part of any review tool, and the current chk app has no answer — its
hunks are bare indices with no SHA.

```
1. Bob: kv.put("app/thread/t20", {to:"ai", kind:"request",
                                  body:"pushed 3f9a1c, please re-analyse"})
   → req/<rid> "suggested"
2. Alice promotes it.
3. Agent re-analyses at the new head:
     - writes pr/<prId>/3f9a1c/…  artifacts (the OLD ones stay; they are cheap)
     - cfg/analysis → { rev: 2, headSha: "3f9a1c" }
4. Every open thread is re-anchored or marked stale:
     anchorSha === new headSha        → still exact
     line still maps through the diff → re-anchor, keep the thread
     otherwise                        → status:"outdated", shown greyed with
                                        its original quote preserved
```

Rule: **never silently move a comment.** A thread that cannot be re-anchored is
marked outdated and keeps the code it was written against. Threads are keyed by
`tid`, not by line, so re-anchoring is a field update — no key churn, no lost
replies.

## 6. The gap the user named: the canvas cannot see the code

### Why it is real

| Channel | Ceiling | Verdict for a PR diff |
|---|---|---|
| Bake into the document | 900 KB doc | works for small PRs; makes the app unpublishable (data-baked) and re-authored on every redraw |
| KV values | 16 KB each, 1000 keys, **2 MB total** | wrong lane — burns the collaborative budget on static bytes |
| `update_canvas` ticks | 32 KB merged | far too small |
| `fetch` from the page | **impossible** — sandbox has no `allow-same-origin`, no network | measured: 0 network calls in the real app |
| Ask the agent per file | one LLM turn | seconds-to-minutes and real tokens, to expand a file |

The chk app took the only available option and curated: 97 lines for three PRs.
For a 50-file PR that means Alice cannot open anything the AI did not flag —
which is precisely the thing a reviewer needs to do.

### Decision (2026-08-24): no bulk read channel

A host-mediated read channel (`canvas-fetch`, a fourth postMessage type
resolving manifest-scoped artifact reads) was drafted here and **removed by
decision**. The gap above stands as evidence; the answer is not a new
channel. What a PR workbench does instead:

- The agent bakes what a reviewer will open into the document, or writes it
  into the KV as ≤16 KB values keyed per file, on request (`req/*` at
  `queued`, owner-promoted). Large or rarely opened files are not on the
  canvas.
- Anything genuinely large links out (`<a target="_blank">` to the PR, the
  file in the repo, or an artifact download the portal already serves to a
  signed-in viewer).

See `interactive-canvas-apps.md` Part K for the rejection entry.

## 7. The other three gaps

### 7a. Bob needs the board without the transcript

Alice owns the session. Bob is the PR author. Today he can be:

| | Sees | Identity |
|---|---|---|
| session read-share (`readers`) | the board **and Alice's whole review conversation** | real, named |
| public link (`link`) | the board only | **anonymous, unverified label** |

Neither is right. Alice's deliberation with the AI is not for the PR author,
and a PR review needs Bob attributable.

**Fix, and it is cheap:** an authenticated viewer opening a canvas link keeps
the link's *scope* and gains their real *identity*. The token still decides
what they can reach; the signed-in cookie, when present, decides who they are
in `by`. Authorization never falls back to the cookie — that rule stands
unchanged — but attribution does.

Result: Bob opens the link, sees only the canvas, and every row he writes
carries `by.kind:"user", id:"bob@…"`.

This is the case that justified the per-person `canvas_grant` dropped in D.6.
The link-plus-identity refinement gets the same outcome without the table.

### 7b. Who may spend Alice's tokens

Bob asking the AI to re-analyse costs Alice's budget. The `suggested`/`queued`
gate handles it: his request waits for her.

For a PR review that may be too strict — Alice may want Bob to drive the AI
directly. One knob, in the owner-writable config:

```jsonc
cfg/policy = { "autoQueueFrom": ["owner"] }               // default
cfg/policy = { "autoQueueFrom": ["owner", "readers"] }    // Bob may task the AI
```

The chokepoint reads it when stamping the status. Default stays closed.

### 7c. Threads address people, not just the agent

`to: "bob@…"` has no delivery mechanism. Bob sees it only if he has the board
open. That is acceptable for v1 — say so in the UI — but the honest options are
a notification on the session, or an `evt/*` row the portal surfaces. Do not
pretend a thread addressed to a human is delivered.

## 8. What this changes in the main spec

1. **Attribution for authenticated link bearers** (§7a) — small change to how
   door 2 stamps `by`, with the authorization rule explicitly unchanged.
2. **`cfg/policy.autoQueueFrom`** (§7b) — one config key, default closed.
3. **Anchoring guidance** (§5) — threads carry `anchorSha`; never silently
   move a comment.

Nothing here contradicts the existing design; all three are refinements. The
bulk read channel that §6 once proposed was removed on 2026-08-24 (Part K of
the main spec).
