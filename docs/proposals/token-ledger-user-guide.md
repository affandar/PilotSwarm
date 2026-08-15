# Token pools — what you can do

Status: DRAFT, written against the design in `token-ledger.md`. **Nothing here
is built yet.** This is the user-facing view of the proposal, written early on
purpose: if a capability reads badly here, it is easier to change now than
after it ships.

Audience: everyone who uses the cluster, plus the admins who run it.

## The idea in one paragraph

Every session spends tokens from a **pool**. A pool has a budget — say 10
million tokens a day — and when the budget runs out, sessions drawing on that
pool pause until the window resets, then carry on where they left off. Pools
nest: yours sits inside a bigger one your admin controls. You can see what you
have, what you have spent, and what stopped you.

## What you can do

| | Anyone | Pool owner | Admin |
|---|:--:|:--:|:--:|
| See the pools you can spend from | ● | ● | ● |
| See your own consumption and what is left | ● | ● | ● |
| Set your default pool | ● | ● | ● |
| Choose a different pool for one session | ● | ● | ● |
| Add your own provider key and get a private pool | ● | ● | ● |
| Pause your own session to save budget | ● | ● | ● |
| Create a pool inside one you already have | | ● | ● |
| Split your allocation between sub-pools | | ● | ● |
| Set limits *inside* your own subtree | | ● | ● |
| Share a pool with named users | | ● | ● |
| Open a pool to everyone | | | ● |
| Set limits on shared pools | | | ● |
| Set the cluster default pool and new-user policy | | | ● |
| See fleet-wide consumption and every paused session | | | ● |
| Run a session with no pool at all | | | ● |
| Add or retire providers and models | | | ● |

"Pool owner" means any pool you created or were given admin on — including the
private pool you get from your own API key.

---

# For users

## Finding your pools

Open the **Usage** section of the console. You see only the pools you can
actually spend from: ones shared with you, ones open to everyone, ones you
created, and the private pool behind your own API key if you added one.

Each pool shows its friendly name, what it is rooted at, and a meter for every
limit on it:

```
Azure OpenAI · shared          day  · all models    [####······]  42%   4.2M / 10M   resets 00:00Z
                               week · all models    [#########·]  95%  47.5M / 50M   resets Mon 00:00Z
Crawlers                       day  · all models    [#####·····]  51%   3.1M /  6M   resets 00:00Z
```

A pool can carry more than one limit. Read them all — the one nearest full is
the one that will stop you, and it is often not the one you were watching.

## Picking where a session spends

You do not have to. Creating a session works exactly as it does today: pick a
provider and model, then reasoning, context and agent.

Two things change quietly:

- **You only see providers you can pay for.** If you have no pool on GitHub
  Copilot, Copilot models are not offered. The picker stops showing you things
  that would fail.
- **A "Pool" tab appears** in the same dialog. Ignore it and your default is
  used. Open it when you have more than one pool on that provider and care
  which budget pays — a crawler budget rather than your interactive one.

Set your default once in the Usage section and most days you never think about
this again.

One rule worth knowing: **a pool can only pay for its own provider.** If your
default is an Azure OpenAI pool and you pick a Copilot model, your default
cannot pay, so the next candidate is used instead. Nothing fails; the session
just spends somewhere sensible.

## Bringing your own key

Add your own provider key — a GitHub Copilot key, say — and you get **your own
provider and your own private pool**. Usage on it counts against you, not the
shared cluster budget, and nobody else can see or spend it.

Your admin may put a safety cap on it. That is there to stop a runaway crawler
spending your personal allowance overnight, not to limit you day to day.

## Splitting your own allowance

Whatever you are given, you can subdivide. A common shape:

```
Your pool                     10M / day   (given to you by an admin)
  ├── crawlers                 6M / day   (you set this)
  └── interactive              (no limit of its own — takes what is left)
```

You cannot give yourself more than you were given. A sub-pool can narrow your
allowance, never widen it. What it buys you is protection from yourself: a
crawler that goes haywire runs out of *its* 6M and stops, and your interactive
work keeps going.

## When you run low

Three stages, and you see all of them.

**At 70%** — configurable, so your cluster may differ — the session tells you it
is entering degraded mode. The agent is asked to trim what it can: stretch out
recurring jobs, drop optional work. Nothing stops.

**At 100%** the session pauses. It does not fail and it does not lose its place.
The session shows as paused-by-quota with the reason, and it wakes automatically
when the window resets.

**On reset** it resumes on its own. No action needed.

If several limits apply, the one that stops you is named explicitly — including
when it belongs to a pool further up the tree that you do not own. That is why
your own meter can read 28% while you are stopped: someone else spent the shared
budget you both draw on.

## Reading a pause

```
Paused — quota exceeded
  Pool     Azure OpenAI · shared      (an ancestor of your pool)
  Limit    day · all models · 100M tokens
  Used     100M of 100M
  Resumes  2026-08-16 00:00 UTC       (in 9h 42m)
```

The pool line is the important one. When it names a pool you do not own, your
own budget is fine and you are waiting on a shared one. Ask an admin, or wait
for the reset.

## Pausing on purpose

You can stop a session from spending without ending it — useful when you want to
keep a budget for something else later. Pause it for a set time or indefinitely,
and resume when you want. It takes effect at the next turn boundary, so an
in-flight turn finishes rather than being cut off.

---

# For admins

## Creating and sharing pools

Create a pool anywhere in the tree and open it up two ways:

- **To named users** — a specific list.
- **To everyone** — one grant that covers current and future users, so a team
  pool does not need maintaining as people join.

Every pool gets a friendly name. Use one people will recognise in a picker:
"Research team", "Crawlers", "Azure OpenAI · shared".

## Setting limits

A limit is a pool, a window, and a number of tokens. Optionally one model.

```
Research team    day   · all models      40M
Research team    week  · all models     150M
Research team    day   · gpt-5.6-max      8M
```

All three are checked on every turn and all must pass. Per-model limits mean you
do not need a separate pool just to cap an expensive model.

Windows are `day`, `week` and `month`, aligned to UTC. You can shift the
boundary when the default is wrong — a week that turns over on Wednesday, or a
billing month starting on the 12th.

**Each limit resets on its own schedule.** A daily limit turning over does not
reset a weekly one, and a parent reset does not reset a child. Each limit means
exactly what it says.

## Allocating: overcommit is allowed, deliberately

A child pool may be given more than its parent has. That is how you choose your
policy without any extra machinery:

- **Reservations** — give each of five users 20% of a 100M pool. Everyone is
  guaranteed their slice, and unused headroom goes to waste.
- **Overcommit** — give all five users the full 100M. Whoever gets there first
  uses it, and a heavy user can starve the others.

Neither is wrong. Overcommit is usually what people want, but be aware of the
consequence: a user can be stopped while their own meter reads 10%, because a
pool above them ran dry. The refusal names which pool, so support that with an
answer rather than a shrug.

## The cluster defaults

Two settings decide what happens to people who never touch any of this:

- **The default pool** — what a session spends from when the user has expressed
  no preference.
- **The new-user policy** — whether a new user simply draws on the shared
  provider pool, or gets a sub-pool of their own with a set share.

## Watching consumption

The Usage section gives you the fleet: totals for the window, the pool tree with
live meters, top consumers by agent and by user, and — first, because it is what
you want during an incident — **every session currently paused by quota, with
the limit that stopped it and when it clears.**

You can also just ask the **Token Manager** agent. It reports across pools,
forecasts when a pool will run dry at the current burn ("this runs out
Thursday" beats "78%"), explains why a specific session is stopped, and proposes
reallocations for you to approve. It will not change an enforcing limit on a
shared pool by itself.

## Unblocking someone

Three moves, in increasing order of blast radius:

1. **Raise the limit** on the pool that bound them.
2. **Move their session** to a pool with headroom.
3. **Run it unpooled** — admin only, bypasses enforcement entirely. Usage is
   still recorded, so the ledger stays complete; it is simply not stopped.

You cannot cancel an exhausted window by clearing a hold. Releasing a hold only
undoes a *manual* pause. A budget that is spent stays spent until it resets.

## Providers and models

You control which providers exist and which models each offers. Providers are
either **shared** — the cluster's own credentials, one pool everyone draws on —
or **per-user**, where each person brings a key and gets a private pool.

Retiring a model marks it deprecated rather than deleting it, so historical
usage stays readable. If you name a successor, sessions on the retired model
move across automatically and record the switch.

## A note on the machinery

System agents — the sweeper, the facts manager, the Token Manager itself — draw
on system pools that **warn but never pause**. That is deliberate. A system pool
that could run dry would stop the very agent whose job is to tell you why
everything stopped.

---

## Questions we expect

**Why did my session stop when my meter says 28%?**
A pool above yours ran out. The pause message names it. Your own budget is fine.

**Can I get more budget by making a new pool?**
No. Any pool you create sits inside one you already have, so it can only divide
what you were given, never add to it.

**Does a paused session lose its work?**
No. It stops between turns and resumes at the reset with its context intact.

**Do my own API key's tokens count against the shared budget?**
No. Your key is your own provider with its own private pool.

**What happens if I go over in a single turn?**
It is allowed. Limits are checked between turns, so a turn already running
finishes even if it goes past the limit. The overspend comes out of the rest of
that window.

**Who can see my usage?**
Admins see fleet-wide consumption. Other users see pools they share with you,
not your private ones.
