# Providers & Budgets — the user-facing model

Status: SHIPPED. This is the model as built, described as a user sees
it. It deliberately says nothing about implementation.
It deliberately says nothing about implementation. It replaces the
token-ledger pool design in full; there is no migration story because
nothing that must be preserved runs the old model.

One principle carries over unchanged: **surface parity**. Every
capability in this document exists on all four surfaces — the web
portal, the HTTP API, the MCP server, and the agent tools. Authority
comes from your role, never from which surface you used.

---

## The model at a glance

```
PROVIDER TYPE — a template, defined in the deployment's
  model-providers file. It says what an instance of it provides:
  the backend, the models, the capabilities, and what credentials
  an instance needs.

PROVIDER — an instantiation of a type. It lives in the CMS: the
  deployment seeds initial ones at first boot, and admins or users
  create more at runtime. Every provider has a UNIQUE NAME, and
  that name is what the model selector shows.

  provider = type + unique name + credentials + limits [+ allowance]

  SHARED provider    — created by an admin. Anyone can use it.
                       The admin sets its quotas and its per-person
                       allowance.
  PERSONAL provider  — created by a user with their own credentials.
                       Only its creator can use it; admins can see
                       that it exists. The
                       creator sets their own quotas. No allowance —
                       it is not shared.

A session runs  provider:model.  That provider is charged.
There are no pools, no payers, no fallbacks, and no access lists.
```

Access is controlled by **quantity, not identity**: an admin decides
what exists (which providers), how much it holds (limits), and how
much of that one person may use (allowance). Never who.

---

## Providers

### Types and instances

The model-providers file defines **types**: what backend an instance
talks to, which models it serves, and what credentials it requires. A
type does nothing by itself.

A **provider** is an instance of a type with a unique name. Two
shared providers of the same type are ordinary — "azure-prod" and
"azure-dev" are two instantiations with two names, two credentials,
and two independent budgets. Creating a second one is a runtime
action, not a config edit.

Any type can be instantiated by a user with their own credentials,
A user's GitHub Copilot key is
the first example: it is simply a personal provider of the
github-copilot type.

### Names

- Unique across the cluster — shared and personal together.
- Immutable. There is nothing to rename, because
  sessions refer to it.
- Re-creating a deleted name is allowed, and it is the intended
  rescue: sessions waiting on that name start resolving again (with
  the new provider's fresh budget). That is the name coming back,
  not magic. A provider is otherwise simply there or not there — no
  in-between state.

### Who sees what

Your namespace is: **every shared provider, plus your own personal
providers**. Another user's personal provider is not hidden from you
by a permission — it simply does not exist in your namespace. A
reference to it behaves exactly like a reference to a name that was
never created. The two cases are indistinguishable on purpose.

For every shared provider, every user can see: its limits, its total
usage, its reset times, and their own usage and allowance ceiling.
**Who** spent from it is visible to admins only. Admins can see that
personal providers exist and their totals; their owners see
everything about them.

---

## Sessions

### Creating a session

A session is created with a concrete **provider + model** (plus
reasoning effort and context settings). The picker lists exactly the
providers in your namespace, each with its budget state inline: room
left, at its limit, your allowance. If nothing in your namespace can
run any model, creation is refused with a clear reason — an empty
list is never treated as "anything goes".

You rarely pick from scratch: your **default** (below) prefills the
choice.

### Being charged

Every turn is charged to the session's provider — the one its model
reference names. Nothing else decides payment. There is no payer
concept, no binding step, and nothing to rebind later.

### When the provider is gone

If a session's provider no longer resolves — the admin removed a
shared provider, or you deleted your personal one — the session
**waits**, labeled honestly: "no provider named carol-ghcp". It waits
indefinitely. It is never moved to another provider automatically.

Two ways out, both explicit:

1. The name comes back (the credential is re-created under the same
   name) — waiting sessions resume on their own.
2. You switch the session to a different provider + model.

**Known gap**: switching currently accepts only providers named in
the deployment's model-providers file. A provider created at runtime
— shared or personal — can be chosen when a session is created, but a
running session cannot yet be switched to it; the switch is refused
with "Unknown model". Until this is closed, the rescue for a stranded
session is option 1, or a switch to a file-defined provider.

---

## Budgets

A budget has two parts. Limits cap the total; the allowance divides
it fairly.

### Limits

A limit caps token usage on one provider for one time period:

| Field  | Values |
|---|---|
| Period | Daily, Weekly (Monday-anchored), Monthly — all UTC |
| Scope  | All models, or one named model |
| Cap    | A whole number of tokens. Hard. There is no warn-only limit. |

- One limit per (period, scope) on a provider. Saving the same
  combination replaces it.
- A period with no limit is uncapped.
- A limit counts from what was already spent in the current period;
  setting it never resets anything. If current usage already meets a
  new limit, affected sessions pause on their next turn — the editor
  says so before you save.
- The turn that crosses a limit completes and is charged; the *next*
  turn pauses. Counters are exact; enforcement is at the turn
  boundary.

Admins set limits on shared providers. You set limits on your own
personal providers if you want self-discipline; nobody else can.

### Allowance

Every shared provider has an **allowance**: the share of each of its
limits that one person may use. The default is **full** — no
per-person ceiling, everyone draws from the same total.

Set to N%, each person may use at most N% of each limit, per period:

- **Derived live.** The ceiling is N% of the limit *as it stands*.
  Raise the limit and every person's ceiling rises with it. There is
  nothing to re-stamp.
- **Oversubscription is the point.** Ten people at 20% is 200% of the
  pool of tokens — fine. The allowance is a fairness ceiling, not a
  reservation; the provider's own limit still caps the total,
  first-come-first-served.
- **It binds everyone**, admins and the provider's creator included.
  There are no per-person exceptions.
- **A share of no limit is no limit.** On a provider without limits
  the allowance has no effect, and the UI says so rather than
  implying a cap exists.

A session paused by an allowance says so distinctly: "Your daily
allowance on azure-prod is used up. The provider has room; your share
of it does not. Resets in 2h 10m (00:00 UTC)." — never the provider-wide
"azure-prod has reached its daily limit." The remedy differs from a
provider-wide stop, so the message must too.

### Pauses, resumes, holds

A session pauses when its next turn would run against a reached
limit or a reached allowance ceiling. While paused:

- It shows as waiting, with the limit, the period, and the reset
  time.
- Messages sent to it are kept, and answered when it resumes.

It resumes when the period resets, or earlier the moment the reason
stops being true: the limit is raised or removed, the allowance is
raised, a hold is released. A raise that is still not enough wakes
nobody.

Admins can also place a **manual hold** on a provider — pause new
turns against it until a set time, or until released — independent
of any limit.

---

## Defaults

> **Superseded:** runtime provider onboarding and default routing are specified
> by [runtime-model-providers-and-defaults.md](runtime-model-providers-and-defaults.md).
> Ordinary-session and system-session defaults are independent; configured
> invalid defaults fail loudly, while first-available fallback applies only
> when no default is configured.

A default is one tuple: **provider + model + reasoning + context**.
It prefills session creation. It is never consulted after that — a
running session's charges follow its own model reference, not
anyone's default.

- **The cluster default** (admin-set, one tuple): what any user who set no
  default of their own gets. It must name a shared provider.
- **Your default** (optional, per user): may name a shared provider
  or one of your own. If a configured default is invalid, creation fails
  rather than spending through another provider.
- **The system default** (admin-set, independent): what system sessions use
  unless a per-agent override exists. It may name a shared provider or the
  calling admin's system-enabled personal provider.

---

## System and unattributed spend

**System sessions** — the machinery PilotSwarm runs for itself — start on a
per-agent override, the system default, or the first system-eligible provider.
They are tracked as **system spend**. A system-default update may be future-only
or explicitly restart inheriting sessions with one of the three restart
dispositions.

- Visible: admins see a separate system total and per-model breakdown for the
  selected provider. It is never drawn against user limits.
- Never counted against the provider's limits — machinery must not
  silently consume the budget users plan around.
- Never paused. No limit, allowance, or hold stops a system session.

A turn that cannot be attributed to any provider is recorded as
**unattributed** and reported rather than dropped.

---

## The usage view

The portal is one table: Provider | Day | Week | Month.

- **Every cell is `used / quota`.** A period with no limit shows real
  usage beside an infinity sign — the meter runs whether or not
  anybody capped it.
- **A toggle swaps the pair**: your spend against your share, or
  all user spend against the limit. Both columns at once, never
  mixed. The per-user allowance is named only beside the total.
- **Shared providers first, then your own**; models with current spend or a
  limit sit directly under the provider. An uncapped model still shows spend
  beside `∞`.
- **Selecting a provider opens a daily chart**: 14 days by default, with
  30-day and 90-day ranges available; one bar per day, peak labeled, the
  daily limit drawn as a line. The same range applies to the separate admin
  system-spend breakdown.
- **One line above the table says what is waiting** — "N sessions are
  waiting on <provider>" — linking to the provider stopping the most.
  Which limit, and when it clears, is said on the paused session
  itself, where the remedy is.
- A refused or failed read renders as a failure; it never renders as
  "zero spend" or "no providers".

Deeper questions — totals over a chosen day range, breakdowns by
session, model, provider, agent, or (for admins) user, filtered by
owner, session, or charge class — are the **usage report**, available
on the HTTP API, the MCP server, and the agent tools.

Scope follows role: you see your own usage everywhere; admins can
widen any view to the whole fleet.

---

## Roles

| Capability | User | Admin |
|---|---|---|
| Use any shared provider | yes | yes |
| Create / delete personal providers (own credentials) | yes | yes |
| Set limits on own personal providers | yes | yes |
| Set own default tuple | yes | yes |
| See shared providers' limits, totals, resets | yes | yes |
| See own usage and allowance ceilings | yes | yes |
| Create / delete shared providers | — | yes |
| Set limits and allowances on shared providers | — | yes |
| Set the cluster default tuple | — | yes |
| Place / release holds | — | yes |
| See who spent (attribution), fleet-wide reports | — | yes |

There are no other roles, and no per-provider roles.

---

## Surface parity

Every capability above is available on all four surfaces:

| Surface | For |
|---|---|
| Web portal | People |
| HTTP API | Scripts and integrations |
| MCP server | External agents and operator tooling |
| Agent tools | The Token Manager agent (admin) and the personal token manager (any user) |

The same operation exists everywhere; your role decides what it may
do. A capability that reaches one surface but not the others is a
bug, and a test enforces the parity.

---

## What deliberately does not exist

| Absent | Why |
|---|---|
| Pools | The provider is the budget. A second hierarchy added concepts, not control. |
| Grants / access lists | Access is governed by quantity (limits, allowances), never identity. |
| Nested budgets | One level: the provider. Team separation = a second provider. |
| Per-person overrides | One allowance per shared provider, binding everyone equally. |
| Warn-only limits | Every limit blocks at its cap. A warning that blocks nothing is a number nobody plans around. |
| Payment fallbacks | A session pays the provider it names, or waits. It is never silently moved to another budget. |
| Per-provider admins | Admins administer; users bring their own. Nothing in between. |
| Ownership checks | Not needed: another user's personal provider is not forbidden — it is absent from your namespace. |
