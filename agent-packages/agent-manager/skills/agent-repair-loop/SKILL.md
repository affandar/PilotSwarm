---
name: agent-repair-loop
description: |
  The order of operations for changing a live package safely — diagnose,
  patch, publish, converge, verify, roll back. Use whenever you are about
  to modify an agent package that something is already running on.
---

# Repairing a live package

The steps are ordered because each one exists to catch a specific failure.

## 1. Diagnose

Never patch on a hypothesis. Pull the evidence first:

| Question | Tool |
| --- | --- |
| What did the agent actually do? | `read_agent_events` |
| Where did the orchestration go? | `read_execution_history` |
| Is it a context/token problem? | `read_session_metric_summary` |
| Is it a retrieval problem? | `read_session_retrieval_usage` |
| What does the agent's prompt currently say? | `read_agent_package` |

State what the evidence shows **and what it rules out**. "The turn failed
after the third tool call" is a finding. "The prompt is probably confusing"
is a guess.

## 2. Establish which copy you are editing

Run `list_agent_packages` and look at `scope` and `shadowed`.

- `shadowed: true` on a shared package means the user's own copy is
  overriding it. Editing the shared one will appear to do nothing.
- If the user has no copy of a shared package, editing means publishing
  their own — which changes behaviour for them alone, not the deployment.

Tell the user which of these is about to happen before you do it.

## 3. Propose the change as a diff

`propose_agent_patch` writes ordered `.patch` artifacts to the session. The
portal renders them with gutter markers.

Do this even when the change is small. A one-line prompt edit that the user
can see is a decision they made; the same edit described in prose is one they
took on trust.

## 4. Publish

Versions are immutable: republishing the same semver with different content
is refused outright. Bump.

- Content unchanged → identical hash → the publish is a no-op. That is a
  success, not a failure.
- Publishing to `shared` affects everyone. Publishing user-scope affects only
  the owner. Prefer the narrower one unless the user asked otherwise.

## 5. Wait for convergence — do not sleep

Publishes land on workers at the next registry poll (observed under 30s).
Anything that runs before convergence runs the **old** definition, silently.
That failure looks exactly like "the edit did nothing", and it has cost real
debugging time.

Poll `read_agent_package` until `activeVersionId` matches what you published.
Then proceed. A fixed sleep is not a convergence check.

## 6. Verify the changed capabilities

Packages can contain reusable skills, executable tools/MCP integrations, and
authored agent workflows. Zero-agent packages are valid. Verify the surfaces
that changed: discover and load skills, activate permitted integrations, and
check real tool/MCP execution evidence in a representative permissions context.
Do not add an agent or create a durable session solely to test a skill or tool.

For an authored workflow, also use `create_agent_session` to test a top-level
session bound to the new version. Do not substitute `spawn_agent`: its child
preamble differs from the entry point a user runs. Tag the test with `test_of`,
reuse its key when appropriate, and observe its events and actual outputs.
Respect the session owner's authorization before messaging or ending it.

**The named-entry-point check is mandatory when you were spawned by the agent
you are editing.** In that arrangement you are the child and the thing you are about
to break is your own parent — the argument that "the publisher still runs the
old version and can pin itself back" does not hold, because the publisher is
not the victim.

## 7. Know the rollback

`pin_agent_package_version` restores a previous version; the fleet converges
on the next poll. Two other levers:

- **Disable the user's copy** → resolution falls back to shared. Fastest way
  out of a bad personal copy.
- **Pin, then investigate.** Restore service first. The broken version is
  still there to look at.

## What not to do

- Do not delete a package to "clean up" a bad publish. Deletion destroys every
  version, including the good one you would have rolled back to.
- Do not promote to `shared` to make a fix reach more people. Promotion hands
  your change to the whole deployment and is refused if the name is taken.
- Do not chain publish → regenerate without the convergence check between.
