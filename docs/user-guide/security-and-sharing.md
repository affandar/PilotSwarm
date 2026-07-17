# Access, sharing & security

This page explains who can see and act on a session, how to share your work
with teammates, and the rules PilotSwarm enforces. It applies to both the
terminal UI and the browser portal — they share one runtime and one set of
rules.

> **When these rules are active.** Ownership enforcement is a per-deployment
> setting (`AUTHZ_ENFORCE_OWNERSHIP`). On a single-user or no-auth deployment
> there is nothing to isolate and everything below is inert — you are always
> effectively the admin. On a shared, authenticated deployment the rules apply
> as written.

## Who you are: identity and roles

You sign in through your deployment's identity provider (Microsoft Entra in
production; a [dev-auth roster](./mcp-local-setup.md) for local testing). PilotSwarm
derives a stable identity — a `(provider, subject)` pair — plus one **role**:

| Role | Who | What it grants |
|---|---|---|
| **user** | A person doing their own work | Full control of their own sessions; collaboration on sessions shared with them; read of the shared knowledge stores |
| **admin** | A fleet operator | Everything a user can do, **plus** fleet-wide visibility, any-session management, system sessions, and operational tooling |
| **anonymous** | No-auth deployments only | Equivalent to admin (nothing to isolate) |

Your role comes from your identity provider (an Entra app-role assignment, or
the dev persona's role). PilotSwarm never issues its own tokens, and access is
decided fresh from your live token on every request — so **revoking access is
done at the identity provider**: remove the assignment and access ends when the
current token expires (typically within an hour).

## Ownership

Every session has exactly one **owner** — the identity that created it. Ownership
is stamped durably and inherited by any sub-agents the session spawns. You always
have full control over sessions you own.

System sessions (Sweeper, Resource Manager, etc.) are owned by the system, not by
any person.

## Visibility: sharing with everyone

Each session tree has a **visibility** that its owner controls:

| Visibility | Who can read | Who can send / act |
|---|---|---|
| **private** (default) | Owner + admins | Owner + admins |
| **shared_read** | Everyone signed in | Owner + admins |
| **shared_write** | Everyone signed in | Everyone signed in |

`shared_read` and `shared_write` are **deployment-wide** — they open the session
to every authenticated user of that deployment. `shared_write` implies read.

The default for new sessions is set per-deployment (`SESSIONS_DEFAULT_VISIBILITY`,
usually `private`).

## Targeted shares: sharing with specific people

On top of visibility, an owner can grant **specific people** access to a session,
at **read** or **write** level. Use this to collaborate with a named teammate
without opening the session to the whole deployment. Visibility and targeted
grants stack — your effective access is the most permissive of: being the owner,
the visibility level, any targeted grant to you, or being an admin.

Only the **owner** (or an admin) can change visibility or manage grants.

## The rules, in one table

For a given session, your access resolves to:

| You want to… | Allowed if you are… |
|---|---|
| **Read** (view transcript, events, history, metrics, artifacts, live updates — and place the session in one of *your own* groups) | owner · admin · visibility is shared_read/shared_write · granted read or write |
| **Write** (send a message, answer a question, stop a turn, upload an artifact) | owner · admin · visibility is shared_write · granted write |
| **Manage** (rename, switch model, cancel, complete, delete artifacts) | owner · admin |
| **Destroy** (delete the session) | owner · admin |
| **Share** (change visibility, grant/revoke access) | owner · admin |

Read/write can be delegated by sharing; manage, destroy, and share stay
**owner-only** (admins can always do everything).

### The unit of sharing is the whole session tree

Sharing applies to a session **and all of its sub-agents** — the entire tree,
rooted at the top-level session. This is deliberate: a run and the sub-agents it
spawns are one piece of work.

- You cannot share a single sub-agent, or open part of a tree while keeping the
  rest private — it is all-or-nothing per tree.
- There is **no per-node override**: a child never has different access from its
  root. Setting visibility or a grant on any node in the tree applies to the
  whole tree.

### Groups are private, and don't affect access

A **session group** is *your* private way of organizing the sessions you can
see — like folders in a mail client. Groups carry **no sharing semantics**, and
your grouping is **never visible to anyone else**:

- Everyone sees **only their own groups** — in the sessions list, in
  `listSessionGroups`, everywhere. That includes admins.
- **Sharing a session never reveals the owner's group.** The recipient sees the
  session ungrouped and can place it into one of **their own** groups; neither
  side's organization affects the other.
- **Read access is enough to place** a session in one of your groups —
  organizing something you can see is your business, not a management action on
  the session.
- Putting sessions in a group does not share them, and **sharing one session in
  a group shares only that session's tree** — not the group and not the other
  sessions in it. To share several grouped sessions, share each one.
- **Deleting a group only deletes your organization** — the sessions themselves
  are untouched.

### Sessions you can't see simply aren't there

If you don't have access to a session, it doesn't appear in your lists, and
looking it up by id returns **not-found** — not "forbidden." PilotSwarm won't
confirm that a session you can't see even exists (no existence oracle). A session
you can *read* but not *write* returns a clear "write access required — ask the
owner" message when you try to act.

### Links are locators, not grants

The portal's **Copy link** puts a `?session=<id>` deep link on your clipboard.
The link only *points at* the session — opening it never grants access. If the
session is private with no grants, only the owner and admins can open the link
(the portal warns you when you copy a link in that state); share the session
first if you want a teammate to be able to follow it. Someone without access
who opens a deep link gets an explicit error — *"This session was not found or
has not been shared with you"* — deliberately the same message whether the id
is wrong or the session simply isn't shared — instead of being silently
dropped onto a different session.

## System sessions

System sessions are readable (metadata + transcript) by everyone by default, but
only admins can interact with or restart them. A deployment can hide them from
users entirely (`SESSIONS_SYSTEM_VISIBILITY=admin`).

## Admins and break-glass

Admins can see and act on any session in the fleet. This is intentional — admins
are operators — but it is **not invisible**: an admin reading a private session
they don't own is recorded as a **break-glass** access in the audit log. Share
grants, visibility changes, and denied operations are audited too. Owners can see
audit entries about their own sessions ("who accessed my session"); admins can
see the full audit surface.

## Identity in messages, and how agents weigh it

When more than one person can write to a session, every message carries a
server-stamped **sender** (who sent it, and their relation to the owner —
`owner`, `collaborator`, or `admin`). You'll see this in the transcript as a
speaker label; your own messages read as **"You"**.

In a shared session the agent is told that **the owner's directives are
authoritative**: it helps collaborators when their requests fit the owner's
goals, but if a collaborator's request conflicts with or would redirect the
owner's mission, it won't silently comply — it says so, and defers to the owner.

**Session-to-session (agent) messaging** is a separate channel: one session's
agent can message another session. A message from a session owned by a **different
user** is delivered but framed as **advisory** — the receiving agent's own task
takes precedence, and it declines anything that distracts from or contradicts its
mission. Messages within your own session tree (same owner) and to/from system
sessions are unaffected.

Two things identity is **never** used for:

- **It is not the security boundary.** Every action is authorized at the server
  before it reaches the agent. The agent never decides whether an action is
  allowed — a message from someone without access is rejected before delivery,
  not handed to the agent to judge.
- **It does not select credentials.** A session always runs on its **owner's**
  credentials. A collaborator writing to your session does not run on your key
  for their own work, and cannot swap the session onto theirs. One session, one
  credential owner. "Share" means share, not delegate your credentials.

## Deployment settings

Operators control the posture with these environment variables:

| Variable | Values | Meaning |
|---|---|---|
| `AUTHZ_ENFORCE_OWNERSHIP` | `true` / `false` | Enforce the rules above. `false` = legacy everyone-sees-everything, but still records would-be denials for a safe dark-launch. |
| `SESSIONS_DEFAULT_VISIBILITY` | `private` / `shared_read` / `shared_write` | Visibility for newly created sessions. `shared_write` reproduces the old trusted-team behavior. |
| `SESSIONS_SYSTEM_VISIBILITY` | `read` / `admin` | Whether users can see system sessions at all. |

`SESSIONS_DEFAULT_VISIBILITY` affects only sessions created after the setting
is deployed. Migration `0029` stamps existing sessions as `private`; changing
the default does not reopen them. Before enabling ownership enforcement on an
existing collaborative stamp, explicitly share/update the session trees that
should remain collaborative, or leave enforcement disabled while owners make
that transition.

## A note on prompt-injection blast radius

Private-by-default isn't only about privacy — it **shrinks what a compromised or
prompt-injected agent can reach**. An agent driving the API with your token has
exactly your access: with ownership enforcement on and sessions private, that is
your own sessions, not the entire fleet.

## Try it locally

The [dev auth provider](./mcp-local-setup.md) lets you exercise the whole model
on a laptop with predefined personas (an admin plus several users). Sign in as
different personas in separate browser profiles (or `PILOTSWARM_DEV_USER=<persona>`
for the TUI), create a private session as one user, share it read/write with
another, and watch access change.

---

**See also:** [Browser portal](./portal.md) · [Terminal UI](./tui.md) ·
[Local MCP setup & dev auth](./mcp-local-setup.md) ·
[Web API reference](../api/reference.md). The full design rationale lives in
[docs/proposals/user-admin-security-model.md](../proposals/user-admin-security-model.md).
