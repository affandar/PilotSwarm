# Meters, and the single provider table

Two changes, in order. The first makes usage exist independently of limits.
The second rebuilds the screen around it.

## Part 1 — a meter is not a limit

### The problem

A usage counter exists today only because a limit exists: its primary key is
the rule's id.

```
provider_quota_counters (rule_id, window_key_utc) → used_tokens
```

So a period with no limit has no counter and no number. That is why the
table's ∞ cells have nothing to put beside them, and why saving a limit has
to reconstruct history from the ledger before it can enforce anything.

### The change

Key the counter by what it measures.

```
provider_meters      (provider_name, period, scope, window_key_utc) → used_tokens
provider_meters_user (provider_name, period, scope, window_key_utc, user_id) → used_tokens

  period  day | week | month
  scope   a qualified model reference, or '*' for all models
```

`provider_name` references `provider_instances(name) ON DELETE CASCADE`, so a
deleted-and-recreated name starts from zero — the same rule the ledger's
history already follows.

`provider_quota_counters` and `provider_quota_counters_user` are dropped.
Nothing is deployed, so there is no compatibility shape to keep.

### What each procedure does after

| Procedure | Change |
|---|---|
| `cms_provider_settle_turn` | No rule loop. Two multi-row upserts: three periods × (all-models, the model used), for the total and for the owner. Exactly-once is unchanged — the ledger's `(session_id, turn_index)` insert is still the claim, and the meters move only when it wins. |
| `cms_provider_set_limit` | The 75-line seeding block **deletes**. A limit reads a meter that is already running. |
| `cms_provider_check_turn` | Reads the meter at `(provider, rule.period, rule.scope, window)` instead of by `rule_id`. Verdicts unchanged. |
| `cms_provider_status` | Same re-point. |
| `cms_provider_pause_is_live` | Same re-point. |
| `cms_provider_usage_grid` | **New.** One call returns what the table draws: per provider, and per model-scoped limit, the used and quota figures for day, week and month — for the viewer and for everyone. Widened twice after 0053: 0054 added `owned_by_me` and `manageable` (the database, not the client, says whose a row is and whether the viewer may change it; somebody else's personal provider gets no "your share" figure) and bounded the day chart at the provider's `created_at`, so a recycled name does not inherit the previous holder's chart. 0055 added `owner_label`, so an admin's screen can print whose a user provider is. |

### What this deletes for free

- **Seeding.** Nothing to reconstruct.
- **The lost-update race.** The critical finding from the adversarial pass —
  a turn settling during a limit save had its charge overwritten and a hard
  limit stopped enforcing — existed *only* because seeding was a read then an
  assign. No seeding, no race, structurally rather than by lock ordering.

### Costs, stated honestly

**Rows up, statements down.** Today: two rows per matching rule, one statement
each, and zero when a provider has no limits. After: up to twelve rows in two
multi-row upserts — six total-meter rows (three when the turn names no model),
and the same again for the turn's owner when it has one. System and
unattributed turns move no meter rows at all. A provider with a full set of
limits writes the same rows in fewer round trips; a provider with none goes
from zero to as many as twelve. That is the price of having the number.
Measure it, do not assume it.

**Window boundaries are now fixed by structure.** Day is 00:00 UTC, week is
Monday 00:00 UTC, month is the 1st. That is already true — anchors were
removed in 0049 — but a shared meter key makes it permanent: every rule of a
period on a provider must agree on the window. If a billing cycle starting on
the 15th is ever needed, the anchor belongs on the PROVIDER, not the rule, so
all its month limits share one boundary. Per-rule anchors are not coming
back; the parked design had them and an anchor past day 28 rolled the counter
before its own stated reset, ten times a year.

### What must not change

Exactly-once settlement. System spend recorded and never counted. Unattributed
turns. Every admission verdict. Pause liveness. The tests that pin those are
the tests that prove this shape is at least as correct.

## Part 2 — one table

One tab. One list. Nothing else. The mock below is the design.

### Where it lives

A workspace-REPLACING surface, like the admin console: `ui.budgetOpen`
swaps out the `.ps-workspace` child. A toolbar button (a coin glyph,
labelled **Budget**) opens it; Escape closes it, unless a sheet or a
modal is nearer the person. On a phone, `onSelectMobilePane` dismisses it.

### Vocabulary (binding)

Never: pool, payer, grant, quota rule, bind mode.
Always: provider, limit, allowance, hold, paused, period (Daily / Weekly /
Monthly), your usage vs the provider's usage.

```
PROVIDER                    │        YOUR USAGE
                            │   Day        Week       Month
azure-openai      Shared   │ 480.0K/500.0K  1.2M/∞   3.1M/10.0M
azure-research    Shared   │      0/500.0K     0/∞        0/∞
  expand to see 1 per-model limit
carol-azure (Carol Chen)  User │  0/∞         0/∞         0/∞
my-copilot        User     │  12.0K/∞    840.0K/5.0M  3.2M/∞

[Edit]                          ☐ Show all user spend
```

### Rules

- A cell is `used / quota`. No limit for that period → the quota is `∞`, and
  the number beside it is still real usage.
- **Unticked**: `your used / your share`, the allowance percentage of the
  limit. **Ticked**: `everyone's used / the limit`.
- The allowance appears **only** in the ticked view, as
  `Per-user allowance: N% of each limit` under the provider — or
  `…, but no limit is set to divide` when no period is capped, because a
  share of nothing beside three ∞ cells implies a cap that does not exist.
  It is a fact about how the total is divided, so it belongs beside the
  total, and only on rows the viewer owns.
- Both classes are marked: a chip says `Shared` or `User` on every
  provider row — the two behave differently, and an unmarked row makes the
  reader infer its kind. A user provider also prints its owner's name
  beside the provider name (`carol-azure (Carol Chen)`): the chip says
  what kind it is, the name says whose.
- A provider with model-scoped limits shows `expand to see N per-model
  limits` — and when any of them is over, says so: `— 1 over`. The count
  alone hid the one fact worth expanding for. Selecting it inserts those rows **in the same three columns**,
  read exactly like a provider row — a model limit can bite while the
  provider above it has room, and one grid is what makes that visible.
- Selecting a row also opens a day-by-day chart beneath the table, with the
  dashed line at whatever quota the Day cell just showed. The chart is drawn
  from the same number as the row, so the two cannot disagree.
- Colour: plain under 90%, amber to 100%, red over. A cell is also red —
  with a marker whose hover text says "The provider's own limit is spent."
  — when the provider's limit for that period is spent while your share
  still reads low, because nothing runs then either. Never the only
  signal — the numbers and the hover text say it in words.
- System spend appears in no cell and no bar.
- A failed read renders as a failure. "No limits" and "could not read the
  limits" are different facts and only one is safe to act on.

### Deleted

The Usage tab and the whole two-tab structure. The four stat tiles. The five
filters. The daily chart as a page fixture. The six breakdown pivots. The
provider detail pane, and the allowance, hold, sessions and defaults panels.
(All of it existed only during development — no release ever shipped the
two-tab surface.)

### Kept, moved

`Add`, `Edit`, `Remove` act on the selected row. Hold and the defaults live
inside `Edit`, where the thing being changed is already named.

### Kept, elsewhere

A stopped session says why **on the session itself** — the row and the detail
box already carry the reason, the clock and a way through. That was the
largest usability finding and it is built; this screen does not repeat it.

**One judgement call, flagged rather than buried:** deleting the paused band
costs an administrator the fleet-wide "is anything stopped right now" answer.
Keep one line above the table when something is waiting — not a band, a
sentence with a link. It names a provider only when that one provider
accounts for every waiting session. Cheap, and it preserves the only thing
the band was uniquely good at.

A second line handles the worst arrival: sessions waiting on a provider
name that no longer exists. `No provider is named X, and N sessions wait
on it. They run again as soon as a provider takes that name.` — with a
one-click Create pre-filled with the name, because the name IS the remedy
and retyping it is where a typo makes a second dead provider.

### Sheets

Three sheets on one shell: **Add**, **Edit** (sectioned Limits / Allowance /
Hold / Default — removing a limit is a button inside Limits), **Delete**.
Every one states its consequences before the confirm is reachable:

| Sheet | Says before confirming |
|---|---|
| Add | The name is permanent; sessions refer to it, so it can never be renamed. The credential is the key itself, never a reference to one. A provider starts with no limits. |
| Edit · limit | What this period has ALREADY spent (the provider's own figure — a limit caps everyone) and that saving resets nothing. Warns when the number being saved blocks someone now — including a person's SHARE of it under an allowance. |
| Edit · allowance | Lowering a share pauses anyone already past the new ceiling on their next turn. Other people's usage is not published here, so it cannot say how many. |
| Edit · hold | Independent of every limit: it stops new turns even when there is room. A hold must end in the future; releasing wakes every session waiting on the provider. |
| Delete | Sessions on it wait indefinitely. Its limits are deleted and do not come back. Whether it is a default. Usage history is retained under the name. |

### Errors

A refused call shows the message the server wrote — it is already written
for a person and names the remedy. Never replace it with "something went
wrong". A failed READ says the read failed; it must never render as an
empty state, because "no limits" and "could not load the limits" are
different facts and only one of them is safe to act on.

### Model picker

The picker lists PROVIDERS from `listProviders`, each with its models, so a
provider created at runtime appears without a restart. An empty namespace
refuses creation with a reason, never an unfiltered list.

**Known gap**: `setSessionModel` and `listModels` still validate against
the FILE catalog only, so a runtime-created provider is pickable for a NEW
session but a running session cannot yet be switched to one — the switch
is refused as "Unknown model".

### Phone

Three numeric columns do not survive 390px. Each provider becomes a card with
the periods stacked; a selected card expands the same way.
