# pgsql-hackers Corpus Harvest — Full Technical Specification

**Version:** 1.0 (post-pilot, build-ready)
**Status:** Design spec for the full corpus rebuild. The 1-day pilot (2026-06-10, 78 threads) validated every component below. This document is written so another engineer/agent can build it without re-deriving anything.
**Scope of source:** the PostgreSQL `pgsql-hackers` mailing list (`https://www.postgresql.org/list/pgsql-hackers/`).
**Output:** a shared knowledge graph in namespace `corpus/pgsql-hackers` + durable extract facts under `corpus/pgsql-hackers/...`, both promotable from a disposable staging run.

---

## 0. TL;DR of the design

> **Three stages, strict separation of concerns:**
> 1. **Index crawl (deterministic, no LLM):** enumerate threads per time-shard from the archive index, producing a manifest with *ground-truth* author names.
> 2. **Thread extract (gpt-5.4-mini, parallel fan-out):** each worker crawls its assigned threads' flat view, runs a **deterministic** header parser (inlined in the prompt) to get participants/emails, and does *only* semantic enrichment (topics/subsystems/summary). Writes one fact per thread.
> 3. **Graph build (claude-sonnet-4.6 → bulk apply):** read all extract facts, emit a **single deterministic node/edge plan**, and apply it with a script (not per-upsert LLM calls).
>
> **The cardinal rule learned in the pilot:** *never ask the cheap model to produce or reconstruct verbatim factual data (emails, names, scripts).* Determinism for facts; LLM only for judgment.

---

## 1. Goals, non-goals, success criteria

### 1.1 Goals
- Build a faithful, queryable knowledge graph of `pgsql-hackers` activity: who discussed what, which subsystems/patches/bugs/releases, and how threads/people interrelate across time.
- Be **resumable** and **idempotent** — survive worker migration, partial failures, and re-runs without duplication or data loss.
- Be **cost-aware** — cheap model for the bulk mechanical work, capable model only where judgment is required.
- Preserve **provenance** — every node and edge carries `evidence` pointing back to the source extract fact (which points to the source URL).

### 1.2 Non-goals
- Full-text search of message bodies (we store bounded excerpts only; the graph is about entities/relationships, not message retrieval).
- Real-time / streaming ingest. This is a batch harvest with optional periodic top-ups.
- Sentiment/stance analysis of debates (possible later; out of scope here).

### 1.3 Success criteria (acceptance gates)
| Gate | Threshold |
|------|-----------|
| Thread coverage | ≥ 99% of enumerated threads have an extract fact (errors logged, not silent) |
| Email fidelity | 0 fabricated emails in the graph; ≤ 0.5% in extract facts (deterministic parser) |
| Author spot-check | 3 random threads/shard match the live mailing list 100% |
| Person de-dup | Same person across threads/emails resolves to 1 node (verified on known multi-affiliation people) |
| Provenance | ≥ 98% of nodes and 100% of edges carry `evidence` |
| Non-Latin names | Distinct non-empty nodeKeys (CJK/Cyrillic) — **unblocked as of the graph-layer slug fix** |
| Resumability | Killing any worker mid-run and re-running produces the same final graph (idempotent) |

---

## 2. Source reconnaissance (verified facts about the site)

These were all empirically confirmed during the pilot. **Do not re-guess them.**

### 2.1 Endpoints
| Purpose | URL pattern | Notes |
|---------|-------------|-------|
| Monthly archive index | `/list/pgsql-hackers/YYYY-MM/` | lists threads for a month |
| Since-cursor index (preferred) | `/list/pgsql-hackers/since/YYYYMMDDHHMM/` | paginates forward in time, **~200 messages per page** |
| **Whole thread (the key endpoint)** | `/message-id/flat/<message-id>` | entire thread in ONE fetch, all messages + headers |
| Single message | `/message-id/<message-id>` | not needed; flat is better |
| mbox / raw | `/message-id/mbox/...`, `/raw/...` | **301 redirect-loop — BLOCKED. Do not use.** |

### 2.2 Critical site behaviors
- **Pagination cap:** the `since/` index returns **max ~200 messages per page**. The "Next" link jumps to the next `since/` cursor. High-traffic days can exceed 200 messages → you MUST follow pagination, do not assume one page = one day.
- **Fetch tool:** use **`bash` + Node `https`**, NOT the `web_fetch` tool. `web_fetch` truncates large pages (~114 chars in one observed case) and has no pagination/mbox mode.
- **User-Agent:** send a real one (`"Mozilla/5.0 research"`); default/empty UAs risk blocks.
- **Politeness:** 150 ms delay between thread fetches (used in pilot, zero rate-limit issues). At scale, keep ≤ ~6–7 req/s aggregate across all workers.

### 2.3 HTML structure (deterministic parse targets)
- **Index row:** `<a href="/message-id/MSGID">SUBJECT</a></th><td>AUTHOR</td><td>TIME</td>` — the index gives an authoritative **display author name** per message (use as ground-truth cross-check).
- **Flat-thread headers:** `<th scope="row">From|To|Cc:</th><td>Name &lt;user(at)domain(dot)com&gt;</td>`.
- **Email de-obfuscation:** `(at)` → `@`, `(dot)` → `.`. Also `&lt;`/`&gt;` are the angle brackets.
- **Body:** `<div class="message-content...">...</div>` blocks; fall back to `<pre>` if absent.
- **Mailing-list pseudo-participant:** `pgsql-hackers@lists.postgresql.org` / "PostgreSQL Hackers" appears as a To/Cc on nearly every thread — **filter it out**, it is not a person.

### 2.4 Thread identity
- **Thread key** = `sha1(normalized_subject).slice(0,12)`, where `normalized_subject` = subject lowercased with leading `Re:|Fwd:|Aw:|Sv:` prefixes stripped and whitespace collapsed.
- This collapses a whole reply chain into one thread regardless of which message-id you entered through.
- **Caveat:** subject-based threading is imperfect (two unrelated threads can share a subject across months). For the full corpus, **scope the sha by month** (`sha1(YYYY-MM + '|' + normalized_subject)`) to avoid cross-month collisions. (Pilot was single-day so didn't need this.)

---

## 3. Data model

### 3.1 Node kinds
| Kind | Canonical name | Key source of truth |
|------|----------------|---------------------|
| `Thread` | normalized subject | extract fact |
| `Person` | display name | From/To/Cc header (deterministic) |
| `Topic` | lowercase-hyphen tag | mini enrichment |
| `Subsystem` | source-tree path or area | mini enrichment |
| `Patch` | thread subject (if `[PATCH]`) | subject + body |
| `BugReport` | thread subject (if bug) | subject + body |
| `Commit` | git hash | body citation |
| `CommitFestEntry` | CF id/url | body citation |
| `Tool` | tool name (Valgrind, cirrus-ci…) | body |
| `Release` | PG version (PG19, v18, SQL:2016) | body |
| `Affiliation` | org/company | **email domain** (new — see §3.3) |

### 3.2 Edge predicates
| Edge | From → To | Source |
|------|-----------|--------|
| `AUTHORED` | Person → Thread | participant role=AUTHORED (sent ≥1 message) |
| `PARTICIPATED_IN` | Person → Thread | participant role=PARTICIPATED_IN (To/Cc only) |
| `ABOUT_TOPIC` | Thread → Topic | enrichment |
| `TOUCHES_SUBSYSTEM` | Thread → Subsystem | enrichment |
| `CITES_COMMIT` | Thread → Commit | body |
| `FIXES_BUG` | Thread/Patch → BugReport | body |
| `TRACKED_IN` | Thread → CommitFestEntry | body |
| `MENTIONS_TOOL` | Thread → Tool | body |
| `TARGETS_RELEASE` | Thread → Release | body |
| `EMPLOYED_BY` | Person → Affiliation | **email domain (new)** |
| `REPLIES_TO` / `SIBLING_OF` | Thread → Thread | cross-thread refs (phase 2) |
| `DUPLICATE_OF` | Thread → Thread | dedup |

### 3.3 New in the full build (vs pilot)
- **`Affiliation` + `EMPLOYED_BY`:** corporate email domains (`@enterprisedb.com`, `@fujitsu.com`, `@postgrespro.ru`, etc.) are a free, reliable employer signal that the pilot dropped. Map domain → org via a small static lookup; skip generic domains (gmail/outlook/qq/yeah/hotmail/…).
- **Month-scoped thread sha** (see §2.4) to avoid cross-month subject collisions.
- **Person-key fallback** for empty slugs — now handled by the graph layer's slug fix (verified: 홍길동 → `person:홍길동`). Belt-and-suspenders: if a future slug still comes back empty, the extractor seeds the canonical name with the email local-part.

### 3.4 Fact key layout
```
corpus/pgsql-hackers/manifest/<shard>          # thread list per time-shard
corpus/pgsql-hackers/progress/<shard>          # per-shard status (resumability)
corpus/pgsql-hackers/extract/<monthsha>        # one per thread (the deliverable of stage 2)
corpus/pgsql-hackers/plan/<shard>              # stage-3 node/edge plan (bulk apply input)
corpus/pgsql-hackers/result                    # final run summary
corpus/pgsql-hackers/grading/<shard>           # QA findings
```
Staging vs production: run everything under `staging/pgsql-hackers/...` + graph namespace `staging/pgsql-hackers`, grade, then **promote** (re-key to `corpus/...`) only on passing all gates. This preserves the "disposable" safety the user values.

---

## 4. Stage-by-stage architecture

### STAGE 1 — Index crawl (deterministic, supervisor-run, NO sub-agents)

**Why no LLM / no sub-agents:** pure HTML enumeration. The supervisor runs it directly. Cheap, fast, fully deterministic.

**Inputs:** date range (e.g. a month, or "last N days").
**Algorithm:**
1. Start at `/list/pgsql-hackers/since/<rangeStartYYYYMMDDHHMM>/`.
2. Parse all index rows (regex in §2.3). For each: `{msgid, subjectRaw, author, time}`.
3. Follow the "Next" `since/` link; repeat until you pass `rangeEnd`. **This is the pagination loop — mandatory** because of the 200-msg cap.
4. Normalize subjects → thread keys (month-scoped sha). Dedup rows into threads; keep earliest msgid as the thread root; union the per-message index authors as a ground-truth author set.
5. Split threads into **shards** (a shard = a work unit, e.g. one calendar day, target ~10–15 threads/shard).
6. Write `corpus/pgsql-hackers/manifest/<shard>` facts: array of `{sha, subj, id, indexAuthors[]}`.
7. Write a top-level `manifest` fact with shard list + counts.

**Output:** N manifest facts + an index of shards. Ground-truth author names captured for cross-checking.

**Resumability:** manifest facts are the durable checkpoint. Re-running stage 1 is idempotent (same shas).

---

### STAGE 2 — Thread extract (gpt-5.4-mini, parallel fan-out)

**Sub-agent:** `pgsqlh-extract` (one instance per shard, fan-out width = min(shard count, concurrency cap ~6–8)).
**Model:** `azure-openai:gpt-5.4-mini` (cheap; validated for this exact task).

**Each worker's job, per assigned shard:**
1. `read_facts(manifest/<shard>)` → its ~10–15 threads `{sha, subj, id, indexAuthors}`.
2. **Install the deterministic extractor** via an **inlined heredoc** (NOT a fact, NOT base64 — see the pilot lesson in §6). The ~1.4 KB script `/tmp/x.js`:
   - fetches `/message-id/flat/<id>` via Node `https`,
   - regex-parses From/To/Cc headers,
   - de-obfuscates `(at)`/`(dot)`, strips `&lt;&gt;`,
   - filters the mailing-list pseudo-participant,
   - dedups participants by email (or name), assigns role AUTHORED (any From) vs PARTICIPATED_IN (To/Cc only),
   - emits `{id, messageCount, threadAuthor, participants:[{name,email,role}], body(≤1200 chars)}`.
3. For each thread: `node /tmp/x.js '<id>'` (single-quote the id — it contains `= + /`).
   - **participants + emails are AUTHORITATIVE — used verbatim. The worker NEVER invents/edits an email.** If email is null, it stays null.
4. **Semantic enrichment ONLY** (this is the sole LLM judgment in stage 2), from subject + body excerpt:
   - `topics[]` (lowercase-hyphen), `subsystems[]` (src-tree areas), `patches` (bool; `[PATCH]`→true), `bugReport` (bool), `releases[]`, `tools[]`, `commits[]` (cited hashes), `summary` (≤2 sentences).
5. `store_fact(key="…/extract/<sha>", shared=true, value={sha,subj,id,sourceUrl,threadAuthor,messageCount,participants,topics,subsystems,patches,bugReport,releases,tools,commits,summary})` — **one store_fact TOOL call per thread.**
6. On script error for a thread: still write `extract/<sha>` with `{sha,subj,id,error}` and continue.
7. Update `progress/<shard>` = `{done:n, errors:[...], status:"complete"}`.
8. Final message: count done / distinct participants / emails / errors.

**Hard rules baked into the prompt (each maps to a pilot failure):**
- "The session SQL database is NOT the shared store. Use the `store_fact` TOOL once per thread." *(fixes the SQL-instead-of-facts failure)*
- "Copy the extractor block verbatim into a heredoc; do not fetch or decode it from anywhere." *(fixes the 4 KB base64 choke)*
- "Never fabricate emails; only what `/tmp/x.js` returns." *(fixes email hallucination)*

**Supervisor responsibilities during stage 2:**
- Spawn one worker per shard (respect concurrency cap; queue the rest).
- Poll via `read_facts(progress/*)` + `check_agents`; **event-verify** (`read_agent_events`) that a sample worker actually called `store_fact` (not `sql`).
- After each worker finishes, validate its `extract/*` facts: count, 0 fabricated emails (regex `@example.|.example|@company.`), 0 empty-persons (cross-check vs `indexAuthors`).
- Re-task any worker whose facts are missing/SQL-only (the pilot's exact recovery).
- Maintain a deterministic **ground-truth crawl** of a sample of threads (supervisor-side) to grade worker output.

---

### STAGE 3 — Graph build (sonnet plan → deterministic apply)

This is the **redesigned** stage (the pilot's slow leg). Two sub-steps:

#### 3a. Plan generation — `pgsqlh-graphplan` (claude-sonnet-4.6)
**Model:** `github-copilot:claude-sonnet-4.6`.
**Job:** read all `extract/<sha>` facts for a batch of shards and emit a **single structured plan** (NOT live upserts):
```json
{
  "nodes": [{"kind","name","aliases":[...],"evidence":["…/extract/<sha>"]}],
  "edges": [{"fromName","fromKind","toName","toKind","predicate","evidence":[...]}]
}
```
- Sonnet does the **judgment**: canonical person identity (merge "Jacob Champion" across 3 emails into one node with 3 aliases), topic/subsystem normalization, dedup of near-identical topics, Affiliation derivation from email domains.
- It writes the plan to `plan/<batch>` as a fact (or an artifact if large).
- **Why sonnet here:** entity resolution is genuine judgment; mini is not reliable for it.

#### 3b. Plan apply — deterministic script (supervisor-run, NO LLM)
- A Node script reads `plan/<batch>`, then calls `graph_upsert_node` / `graph_upsert_edge` directly, in **dependency order** (all nodes first, then edges), **single-writer** (no concurrent upserts on shared Person nodes — avoids the lock contention seen in the pilot).
- Idempotent: re-applying the same plan is a no-op (upsert dedups).
- **This removes the per-upsert LLM latency** that made the pilot's graph build take ~25 min/78 threads. Sonnet emits one plan; the script applies hundreds of upserts in seconds.

**Why single-writer apply:** the pilot proved concurrent builders contend on hot shared nodes (Tom Lane appears in many threads) → `Entity failed to be updated` lock errors. One applier process, ordered, eliminates this.

---

## 5. Sub-agent roster & prompts

| Agent | Model | Count | Role |
|-------|-------|-------|------|
| (supervisor = this session) | sonnet/opus | 1 | orchestration, stage 1 + stage 3b apply, grading, promotion |
| `pgsqlh-extract` | gpt-5.4-mini | 1 per shard (≤8 concurrent) | crawl + deterministic extract + enrich → facts |
| `pgsqlh-graphplan` | claude-sonnet-4.6 | 1 per ~3–5 shards | read extract facts → emit node/edge plan |

**Extractor prompt skeleton** (the heredoc is the literal ~1.4 KB script; abbreviated here):
```
You are a STAGE-2 EXTRACTOR. Crawl + extract + light-enrich your shard's threads; write one shared fact per thread. NO graph_* tools.
1. read_facts(manifest/<shard>) → your threads.
2. Install extractor EXACTLY (copy verbatim):
   cat > /tmp/x.js <<'SCRIPT'
   …deterministic header parser…
   SCRIPT
3. For each thread: node /tmp/x.js '<id>'. participants+emails are AUTHORITATIVE — verbatim, never invent. null stays null.
4. Enrich from subj+body ONLY: topics/subsystems/patches/bugReport/releases/tools/commits/summary.
5. store_fact(key="…/extract/<sha>", shared=true, value={…}). The store_fact TOOL once per thread — the session SQL DB is NOT the shared store.
6. On script error: store_fact(value={sha,subj,id,error}); continue.
7. Update progress/<shard>; report counts.
RULES: never fabricate emails; copy the heredoc verbatim (don't fetch/decode it); no graph_* tools.
```

**Graph-plan prompt skeleton:**
```
You are a STAGE-3 GRAPH PLANNER. Read extract facts for shards X..Y; emit ONE node/edge plan as JSON. Do NOT call graph_* tools — output a plan only.
- Resolve Person identity: merge same person across threads & multiple emails into one node (name=canonical display, aliases=all real emails). Never invent emails.
- Derive Affiliation from corporate email domains (skip generic domains). Add Person-EMPLOYED_BY->Affiliation.
- Normalize/dedup Topics & Subsystems.
- Every node & edge MUST carry evidence=["…/extract/<sha>"].
- Write the plan to plan/<batch> (fact if small, artifact if large). Report node/edge counts.
```

---

## 6. Pilot lessons encoded as hard requirements

| # | Failure observed in pilot | Root cause | Requirement in full build |
|---|---------------------------|-----------|---------------------------|
| 1 | mini invented emails (`nisha@gmail.com`) | LLM asked to produce verbatim facts | **Deterministic header parser**; mini never emits emails |
| 2 | mini called a valid 4 KB base64 fact "corrupted" | cheap model can't ingest/decode large opaque blobs | **Inline the ≤1.4 KB script as a heredoc** in the prompt; no fact-fetch/decode |
| 3 | 2/6 workers wrote to session SQL, reported success, stored nothing | "store as facts" misread as the SQL DB | Prompt names the **exact `store_fact` tool**; supervisor **event-verifies** + re-tasks |
| 4 | graph build slow (~25 min/78 threads) | per-upsert LLM call, one thread/turn | **Sonnet emits a plan; a script applies it** (stage 3b) |
| 5 | concurrent builders hit `Entity failed to be updated` | two writers on hot shared Person nodes | **Single-writer apply**, nodes-before-edges, ordered |
| 6 | CJK names → empty `person:` key, silent merge | graph slugifier stripped non-Latin → empty | **Graph-layer slug fix (verified)**; extractor email-local-part fallback as backup |
| 7 | 1 stray fabricated email survived in facts | mini back-filled from body where parser returned null | Supervisor **post-validates** extract facts (regex scan) before stage 3 |
| 8 | local `/tmp` wiped on worker migration | ephemeral worker FS | All durable state in **facts/artifacts**; scripts re-materialized from facts on resume |

---

## 7. Orchestration workflow (end-to-end)

```
[Supervisor]
  1. Stage 1: crawl index for date range → manifest/<shard> facts (+ shard list). [deterministic, in-session]
  2. Stage 2: for each shard (≤8 concurrent):
        spawn pgsqlh-extract(shard)
        poll progress/* + check_agents; event-verify store_fact usage
        on finish → validate extract facts (count, 0 fab emails, 0 empty-persons vs indexAuthors)
        re-task on failure
     barrier: all shards have complete extract facts
  3. Stage 3a: for each batch of shards:
        spawn pgsqlh-graphplan(batch) → plan/<batch> fact/artifact
     barrier: all plans written
  4. Stage 3b: [deterministic, in-session, single-writer]
        for each plan: apply nodes (ordered) then edges, idempotent
  5. Grade: node/edge counts; 3 author spot-checks/shard vs live list; provenance %, person-merge checks, fab-email scan
  6. If all gates pass → promote staging/* → corpus/* (re-key facts, rebuild graph namespace) 
  7. Write result fact + report artifact; tear down staging; present.
```

**Durable scheduling:** stages 2 and 3a use a supervision `cron` (e.g. 180 s) — each wake polls progress, nudges idle-incomplete workers, advances the barrier. No in-turn busy-waiting.

**Resumability contract:** every stage's output is a fact. On rehydrate, the supervisor reads `progress/*` + existing `extract/*`/`plan/*` and resumes at the first incomplete unit. Re-running any stage is idempotent.

---

## 8. Scaling & cost shape

| Lever | Pilot (1 day) | Full (per month ≈ 20–30 days) |
|-------|---------------|-------------------------------|
| Threads | 78 | ~1,500–2,500 |
| Shards | 6 | ~25–30 (1/day) |
| Extract workers | 6 mini | ≤8 concurrent mini, queued |
| Extract time | ~3–4 min | ~15–25 min/month (parallel) |
| Graph build | ~25 min (per-upsert) | **minutes** (plan + bulk apply) |
| Dominant cost | sonnet graph build | sonnet **plan** (read-heavy, bounded) |

**Cost principle:** mini does O(threads) cheap work in parallel; sonnet does O(shards) judgment work; the deterministic applier does O(nodes+edges) free work. The expensive model's footprint scales with *shards*, not *threads*.

---

## 9. Open questions / decisions to confirm before building
1. **Time range for v1** — one recent month, or backfill a quarter? (Affects shard count + run time.)
2. **Cross-month thread merging** — month-scoped shas avoid collisions but split genuinely long-running threads across months. Add a post-pass `SIBLING_OF`/`DUPLICATE_OF` reconciliation, or accept per-month threads for v1?
3. **Affiliation lookup** — maintain a static domain→org map (curated) vs. infer org from domain string. Start static + small.
4. **Body retention** — keep the ≤1200-char excerpt in the extract fact (current) or drop it after stage 3 to save space?
5. **Promotion policy** — auto-promote on passing gates, or always pause for human sign-off (the user has preferred disposable-then-review so far → default to **pause for sign-off**).

---

## 10. Appendix — the deterministic extractor (reference, ~1.4 KB)
```js
const https=require("https");
const id=process.argv[2];
https.get("https://www.postgresql.org/message-id/flat/"+id,{headers:{"User-Agent":"Mozilla/5.0"}},r=>{
let d="";r.on("data",c=>d+=c);r.on("end",()=>{
const ppl={};let m,n=0;
const re=/<th scope="row"[^>]*>(From|To|Cc):<\/th>\s*<td>([\s\S]*?)<\/td>/g;
function deob(s){return s.replace(/\(at\)/g,"@").replace(/\(dot\)/g,".").trim();}
while((m=re.exec(d))){const role=m[1]=="From"?"AUTHORED":"PARTICIPATED_IN";if(m[1]=="From")n++;
 for(let p of m[2].split(/,(?![^(]*\))/)){p=p.trim();if(!p)continue;
  let x=p.match(/^(.*?)\s*&lt;(.+?)&gt;/);let name,em=null;
  if(x){name=x[1].trim();em=deob(x[2]);}else{name=deob(p);}
  name=name.replace(/&amp;/g,"&").replace(/^"|"$/g,"").trim();
  if(!name||/lists?\.postgresql\.org/.test(em||name)||/^pgsql-hackers$|^postgresql hackers$/i.test(name))continue;
  const k=(em||name).toLowerCase();if(!ppl[k])ppl[k]={name,email:em,role};if(em&&!ppl[k].email)ppl[k].email=em;}}
const parts=Object.values(ppl);
const body=[...d.matchAll(/<div class="message-content[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].map(z=>z[1].replace(/<[^>]+>/g," ").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&").replace(/\s+/g," ")).join(" ").slice(0,1200);
const au=parts.find(p=>p.role=="AUTHORED");
console.log(JSON.stringify({id,messageCount:n,threadAuthor:au?au.name:null,participants:parts,body}));
});}).on("error",e=>console.log(JSON.stringify({id,error:e.message})));
```
Notes: filters the list pseudo-participant; de-obfuscates emails; dedups by email→name; bounded body. For the full build, optionally extend with month-sha computation and corporate-domain tagging, but keep it ≤ a couple KB so it stays inline-able.

---

*End of spec. Everything above was validated on the 2026-06-10 pilot except the items explicitly marked "new"/"phase 2"; those are extrapolations with stated rationale.*
