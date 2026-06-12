<!-- generated 2026-06-12T20:33:18.299Z by generate-report.mjs (report model: claude-opus-4.8) -->

# REPORT.md — Harvested Knowledge Graph vs. Web-Search Baseline on pgsql-hackers Q&A

## 0. Setup & Methodology

**Question.** Can answering PostgreSQL `pgsql-hackers` questions from a *harvested knowledge graph* beat a strong baseline that uses parametric knowledge plus live web search? The experiment sweeps a full 3×3×3 tensor over **harvester model** (built the graph), **query model** (answered the question), and **judge model** (graded the answer).

**Models** (same three play all three roles):

| Code | Model | Family |
|---|---|---|
| `gpt55` | gpt-5.5 | OpenAI |
| `opus48` | claude-opus-4.8 | Anthropic |
| `son46` | claude-sonnet-4.6 | Anthropic |

**Corpus:** `pgsql-hackers-recent.json` (recent PostgreSQL hackers mailing-list traffic).

**Actual question count:** **8 questions per cell** (`config.questions = 8`). Note this is **half** of the `configuredQuestionCount = 16` — the headline rests on 8 questions/cell, not 16.

**Coverage:** 27 of 27 expected score cells populated; **216 graded rows** = 27 cells × 8 questions = 72 distinct (harvester×query×question) answer pairs, each scored by all 3 judges.

**Baseline regime — disclosed up front (this is part of the design, not a footnote):**

| Constraint | Value |
|---|---|
| `web_search` cap | **2 searches** |
| `web_fetch` cap | **8 fetches** |
| Idle watchdog (`armIdleTimeoutMs`) | **90,000 ms (90 s)** |

The baseline arm ran under **deliberately constrained web access**. If the baseline streamed *no output for 90 seconds*, the answer was recorded as **FAILED** (see transcript excerpts: `"(no answer — baseline: idle > 90000ms)"`). We treat these idle-timeouts as a **genuine reliability signal** — the model failed to deliver an answer within the responsiveness bar — *and* as a factor that inflates the raw margin (Section 5). Scores cluster in a ~1–5 band (cell means span 4.25–5.00 for graph, 1.13–3.38 for baseline), consistent with a 5-point rubric.

---

## 1. Headline Result

| Metric | Graph | Baseline | Δ (graph−baseline) |
|---|---|---|---|
| Mean score (n=216) | **4.76** | **2.42** | **+2.34** |
| Win rate | **163 / 216 (75.5%)** | 4 / 216 (1.9%) | — |
| Ties | 49 / 216 (22.7%) | | |

The graph wins decisively on aggregate: a **+2.34 point** mean advantage and a **163–4** win/loss record (49 ties). The baseline essentially never wins outright. This is a large, consistent effect — but as Sections 4–6 show, a meaningful slice of it comes from the **baseline failing to answer at all** under the web caps and watchdog, plus a strong **corpus framing** advantage. Scrutinize before celebrating.

---

## 2. Does the Harvester Model Matter?

| Harvester | n | Graph | Baseline | Δ | Graph wins | Baseline wins | Tie |
|---|---|---|---|---|---|---|---|
| `gpt55` | 72 | 4.82 | 2.35 | +2.47 | 60 | 0 | 12 |
| `opus48` | 72 | 4.76 | 2.58 | +2.18 | 51 | 3 | 18 |
| `son46` | 72 | 4.69 | 2.33 | +2.36 | 52 | 1 | 19 |

**Verdict: barely.** Graph-answer quality is nearly flat across harvesters (4.69–4.82, a 0.13 spread). `gpt55`-harvested graphs score marginally highest (4.82) and concede zero baseline wins; `son46`-harvested graphs score marginally lowest (4.69). The differences are small relative to per-cell noise (8 questions/cell). Any of the three models builds a graph good enough to dominate this baseline.

---

## 3. Does the Query Model Matter?

| Query | n | Graph | Baseline | Δ | Graph wins | Baseline wins | Tie |
|---|---|---|---|---|---|---|---|
| `gpt55` | 72 | 4.63 | 2.64 | +1.99 | 45 | 2 | 25 |
| `opus48` | 72 | 4.86 | **3.08** | +1.78 | 48 | 2 | 22 |
| `son46` | 72 | 4.79 | **1.54** | **+3.25** | 70 | 0 | 2 |

**Verdict: yes — and mostly through the *baseline* side.** Graph means are again tight (4.63–4.86). The dramatic variation is in the **baseline** column:

- `opus48` is the **most reliable baseline answerer** (2.64→3.08 baseline mean) → smallest gap (+1.78).
- `son46` as query model produces a baseline mean of just **1.54** and an almost total sweep (**70–0–2**) → the largest gap (+3.25).

This strongly suggests `son46`'s baseline arm **fails / times out / punts far more often** than `opus48`'s under the same 90 s watchdog and 2-search / 8-fetch caps. The query model matters primarily because some models *cope* with the constrained web regime and others *collapse* under it. That is a real reliability difference — but it means the headline +2.34 is partly a story about `son46`'s baseline responsiveness, not about graph substance.

---

## 4. Judge Bias — The Key Skeptical Question

### 4a. Judge leniency

| Judge | Graph | Baseline | Δ | Graph wins | Baseline wins | Tie |
|---|---|---|---|---|---|---|
| `gpt55` | 4.71 | 2.31 | +2.40 | 54 | 0 | 18 |
| `opus48` | 4.85 | 2.44 | +2.40 | 55 | 1 | 16 |
| `son46` | 4.72 | 2.51 | +2.21 | 54 | 3 | 15 |

Judges are **remarkably consistent**. `opus48` is slightly the most generous to graph answers (4.85) and `son46` slightly the most generous to the baseline (2.51, and gives the most baseline wins: 3). But the **delta** barely moves (2.21–2.40, a 0.19 spread). No judge is an outlier that drives the result.

### 4b. Same-family favoritism

"Same family" = the judge grading a query model from its own vendor (OpenAI for `gpt55`; Anthropic for `opus48`/`son46`).

| Judge | Same-family graph mean | Diff-family graph mean | Direction |
|---|---|---|---|
| `gpt55` | **4.38** | 4.88 | Scores own family **lower** (−0.50) |
| `opus48` | 4.90 | 4.75 | Slight own-family bump (+0.15) |
| `son46` | 4.71 | 4.75 | Essentially neutral (−0.04) |

There is **no consistent same-family favoritism**. If anything the OpenAI judge (`gpt55`) is *harsher* on the only same-family target it has (`gpt55` query, 4.38 vs 4.88). Note this is partly confounded: `gpt55`-query graph answers score lower across *all* judges (byQuery: 4.63 vs 4.86/4.79), so the OpenAI judge's "own-family penalty" largely reflects genuinely lower `gpt55`-query answers, not bias. The Anthropic judges show only a tiny (+0.15 / −0.04) tilt. Favoritism is not driving the conclusion.

### 4c. Inter-judge agreement

| Metric | Value |
|---|---|
| Answers with multiple judges | 72 |
| Mean graph score spread (across 3 judges) | **0.39** |
| Mean baseline score spread | **0.47** |
| Unanimous graph wins (all 3 judges) | **52 / 72 (72%)** |
| Split decisions | **7 / 72 (10%)** |

Agreement is high: a mean spread of **0.39** (graph) and **0.47** (baseline) on a ~5-point scale is tight. **72%** of answer pairs are *unanimous* graph wins; only **10%** are split. Baseline answers show slightly more disagreement (0.47), consistent with judges differing on how to score partial/failed answers.

### 4d. Does judge choice change the conclusion?

**No.** Every judge ranks graph far above baseline (Δ 2.21–2.40), every judge gives the graph 54–55 wins out of 72, and no judge produces same-family favoritism large enough to matter. The graph-wins result is **robust to judge choice.**

---

## 5. Confounds — Verbosity and Baseline Failure

### 5a. Verbosity (length) is **not** the explanation

| Metric | Graph | Baseline |
|---|---|---|
| Score-vs-length correlation | **0.15** | 0.026 |
| Avg answer length (chars) | **1,150** | 1,351 |

The score-vs-length correlation is weak for the graph (0.15) and effectively zero for the baseline (0.026). Crucially, the **winning** (graph) answers are **shorter on average** (1,150 vs 1,351). The graph is not winning by padding — it wins while being more concise. Verbosity is **ruled out** as a driver.

### 5b. Baseline abstention / failure — separate the two effects

| Metric | Value |
|---|---|
| Baseline low-score rate | **0.616 (61.6%)** |
| Baseline used-web rate | **1.00 (100%)** |

**61.6%** of baseline answers landed in the low-score band, while the baseline **attempted web access 100% of the time** — i.e., it did not silently abstain; it tried and either **timed out (90 s watchdog)** or **punted under the 2-search / 8-fetch caps**. The transcripts make both failure modes concrete:

- **Hard idle-timeout:** `"(no answer — baseline: idle > 90000ms)"` (two `gpt55×gpt55` RPR questions).
- **Budget-exhausted punt:** `"…the archive search ranking only surfaces recent messages — I wasn't able to pull up the exact 2022-era v2 email within my fetch budget. So let me answer from the feature's semantics…"` (`gpt55×opus48`).

We must distinguish two effects feeding the +2.34 margin:

- **(a) Substance, both answer.** Where the baseline *does* answer (e.g., `opus48` query, baseline mean 3.08, Δ +1.78; and the `gpt55×opus48` excerpt where the baseline correctly recovers R010/R020), the graph still wins — but by a **smaller** margin. This is the legitimate "graph is better on substance" signal.
- **(b) Reliability, baseline fails.** Where the baseline fails to deliver under the responsiveness bar (most visibly `son46` query, baseline mean **1.54**, near-sweep **70–0**), the gap balloons to **+3.25**. This is a **real operational property** of that query model under the 90 s watchdog and web caps — the baseline *failed the responsiveness bar* — **and** it mechanically inflates the raw mean delta.

**Magnitude of inflation:** the `son46`-query Δ (+3.25) sits ~1.5 points above the `opus48`-query Δ (+1.78). Much of that 1.5-point gap is attributable to baseline non-answers rather than graph superiority on substance.

**Recommendation:** the headline conflates "better answer" with "answered at all." Future reporting **must split results by answered-vs-failed**: (i) graph-vs-baseline restricted to questions where the baseline actually produced a substantive answer, and (ii) a separate baseline **failure/timeout rate** reported as its own reliability metric per query model. The current dataset lacks an explicit answered/failed flag per row; `baselineLowScoreRate = 0.616` and the per-query baseline means are the best available proxies and they point clearly at effect (b) being a substantial contributor.

---

## 6. Bottom Line + Honest Caveats

**Bottom line.** On this experiment, the harvested knowledge graph **wins decisively and consistently**: +2.34 mean (4.76 vs 2.42), a 163–4 win/loss record (49 ties), and the result holds across **every harvester, every query model, and every judge**. There is **no meaningful judge leniency or same-family bias** distorting it, inter-judge agreement is high (0.39 graph spread, 72% unanimous), and **verbosity does not explain it** (the winner is shorter). On substance, where both sides actually answer, the graph still wins — just by a narrower +1.78 to ~+2.0 rather than +3.25.

**But the margin is inflated and the comparison is structurally favorable to the graph:**

1. **Corpus framing is the dominant caveat.** The questions are drawn from `pgsql-hackers-recent.json`, and the graph was *harvested from that same corpus*. This is effectively **open-book retrieval over the exact source** versus a baseline **denied that source** and limited to **2 web searches + 8 fetches**. The transcripts (Tatsuo Ishii RPR thread, specific v2-patch row results) are precisely the kind of needle-in-mailing-list detail that lives verbatim in the graph and is hard to surface via constrained web search. The graph's advantage is partly an artifact of *having the answer key*.

2. **Baseline web caps + 90 s watchdog.** These are real, disclosed constraints. They make the baseline's failures a legitimate reliability signal, but a different cap (more searches/fetches, longer watchdog) would likely raise the baseline mean — especially for `son46` (baseline 1.54). The +2.34 is **regime-specific**, not a universal verdict on parametric+web models.

3. **Failure inflation.** ~61.6% of baseline answers scored low, with notable non-answers/punts; the raw delta overstates the substance gap. Report answered-vs-failed separately.

4. **Single eval, small n.** Only **8 questions per cell** (vs 16 configured), a single corpus, a single run, three models. Per-cell estimates rest on 8 items; treat cell-level deltas (e.g., 1.38 vs 3.50) as noisy.

**Net:** the graph is genuinely and robustly better here, free of detectable judge bias or verbosity gaming — but the headline +2.34 should be read as "open-book graph over a web-capped, watchdog-limited baseline on questions sourced from the graph's own corpus." The honest, deflated estimate of the *substantive* advantage (both sides answering) is closer to **+1.8 to +2.0**, with the remainder driven by baseline non-response under the responsiveness bar.
