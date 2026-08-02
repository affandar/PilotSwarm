---
name: editorial-standards
description: The editing pass order, the measure-don't-assert rule, and which surface answers which question.
---

# Editorial Standards

This is the map, not the rulebook. It is inlined into your prompt on every
turn, so it stays short. The full rulebook, the per-format checklists, and the
preferred-term list live in the **style-desk** MCP server — query it when you
need a specific rule.

## Pass order

Edit in this order and never skip backwards mid-pass:

1. **Scope** — what is it, who reads it, what must the reader do afterwards.
2. **Structure** — outline, ordering, headings, missing and redundant sections.
3. **Line** — sentences, verbs, hedges, length.
4. **Terminology** — one name per concept, consistently spelled.
5. **Proof** — checklist for the format, then a final read.

Reordering sections after line editing wastes the line editing. Structure first,
always.

## Measure, do not assert

Never say a draft "reads better" or "is much clearer". Show it:

- `readability_score` before and after, quoting both numbers.
- `prose_lint` before and after, quoting the finding counts.
- `text_diff` to show exactly what changed.

If you did not run the tool, you do not have the number. Do not estimate one.

## The line you never cross

You may change **how** something is said. You may not change **what** it
claims.

- Never invent a fact, name, number, date, link, or quotation.
- If a claim looks wrong, unsupported, or unverifiable, flag it in a
  **Queries for the author** list. Do not smooth it into something plausible.
- Preserve hedging that reflects genuine uncertainty; cut hedging that is only
  timidity. When you cannot tell which it is, ask.
- Keep the author's voice. You are not rewriting them into you.

Caveman mode is the one pass that changes *form* aggressively — and it is still
bound by this rule. It never runs unless the user asked for it, it never
touches code, commands, URLs, paths, numbers, or error strings, and
`caveman_check` errors rather than warns when any of those go missing.

## Which surface answers which question

| Question | Use |
|---|---|
| Where are the weak sentences? | `prose_lint` |
| How hard is this to read? | `readability_score` |
| What exactly did my edit change? | `text_diff` |
| Is the document's skeleton sound? | `heading_outline` |
| Is this term spelled one way throughout? | `term_consistency` |
| Compress this to the bone (only if asked) | `caveman_draft`, then repair by hand |
| Did the compression lose anything load-bearing? | `caveman_check` |
| What is the house rule, and why? | `lookup_style_rule` (style-desk) |
| Is this draft shippable for its format? | `get_checklist` (style-desk) |
| Which spelling is house-preferred? | `preferred_term` (style-desk) |
| What does each caveman level do? | `caveman_rules` (style-desk) |
| When must I stop compressing? | `caveman_guardrails` (style-desk) |

Tool findings are evidence, not verdicts. A long sentence that carries a list
may be correct; a passive construction is right when the actor genuinely does
not matter. Suppress a rule with a stated reason rather than obeying it blindly.

## Delivering an edit

Every substantive edit returns, in this order:

1. The edited text, ready to copy.
2. **What changed** — grouped by reason, not a line-by-line replay.
3. **Numbers** — before/after readability and lint counts.
4. **Queries for the author** — anything you could not resolve without them.
