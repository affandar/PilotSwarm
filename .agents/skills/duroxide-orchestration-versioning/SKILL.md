---
name: duroxide-orchestration-versioning
description: Guidance for safely versioning Duroxide orchestrations — file structure, naming conventions, workflow, and registry registration.
---

# Duroxide Orchestration Versioning

## Non‑Negotiable Rule

**Orchestration code is immutable once deployed.**

Running instances replay historical events. If you change orchestration logic (or helpers it calls), replay can break in subtle ways.

This applies to:
- Orchestration functions (anything taking `OrchestrationContext`)
- Helper functions called by orchestrations (also orchestration code)
- Any change in activity scheduling order, parameters, retry policy, timers, branching logic, etc.

**You MUST NOT cause ANY side effect on existing frozen orchestrations.** This includes changes to shared types (e.g., activity input/output structs) that alter serialization behavior. If you add a field to a shared struct:
- The serialized JSON must remain **byte-for-byte identical** for existing call sites
- Use `#[serde(default, skip_serializing_if = "Option::is_none")]` for new `Option<T>` fields so `None` is omitted (not serialized as `null`)
- Verify by checking that `serde_json::to_string(&OldInput { field: None })` produces the same JSON as the original struct without the field
- If you cannot make the change backward-compatible, create a new activity (e.g., `test-connection-v2`) instead of modifying the shared type

## When You MUST Create a New Version

Create a new orchestration version for **any** logic change, including "small fixes":
- Bug fixes, error handling tweaks, logging changes that affect control flow
- Changing activity calls (order/inputs/retry policies)
- Adding/removing timers
- Changing helper functions invoked by orchestrations

## File & Folder Structure

Each orchestration lives in its own folder under the orchestrations directory (e.g., `src/orchestrations/` in Rust projects, or equivalent in Node.js/Python projects):

```
instance_actor/
  mod.rs                                    # Wiring only: NAME const, pub mod, pub use
  instance_actor_orchestration.rs           # Latest version code (currently v1.0.2)
  instance_actor_1_0_1_orchestration.rs     # Frozen v1.0.1
  instance_actor_1_0_0_orchestration.rs     # Frozen v1.0.0
```

### Naming Conventions

| Item | Pattern | Example |
|---|---|---|
| **Function name** (all versions) | `{name}_{version}_orchestration` | `instance_actor_1_0_2_orchestration` |
| **Latest file** | `{name}_orchestration.rs` | `instance_actor_orchestration.rs` |
| **Frozen file** | `{name}_{version}_orchestration.rs` | `instance_actor_1_0_1_orchestration.rs` |

### mod.rs Structure (Wiring Only)

`mod.rs` contains **no orchestration logic** — only wiring:

```rust
/// Orchestration name for registration and scheduling
pub const NAME: &str = "my-project::orchestration::instance-actor";

pub mod instance_actor_1_0_0_orchestration;
pub mod instance_actor_1_0_1_orchestration;
mod instance_actor_orchestration;

pub use instance_actor_1_0_0_orchestration::instance_actor_1_0_0_orchestration;
pub use instance_actor_1_0_1_orchestration::instance_actor_1_0_1_orchestration;
pub use instance_actor_orchestration::instance_actor_1_0_2_orchestration;
```

Note: frozen versions are `pub mod` (needed by registry), latest is `mod` (re-exported via `pub use`).

Shared helper functions (e.g., `update_cms_state`) may live in `mod.rs` since they are shared utilities, not orchestration logic.

## Workflow: Adding a New Version

Assume the current latest is v1.0.1 and you want to add v1.0.2.

### Step 1: Freeze the current latest

```bash
cp instance_actor_orchestration.rs instance_actor_1_0_1_orchestration.rs
```

This frozen copy is byte-for-byte identical. Git shows it as all `+` lines (a new file) — reviewers can ignore it.

### Step 2: Modify the latest file in place

In `instance_actor_orchestration.rs`:
- Rename the function: `instance_actor_1_0_1_orchestration` → `instance_actor_1_0_2_orchestration`
- Update version prefixes in log messages: `[v1.0.1]` → `[v1.0.2]`
- Make your actual code changes

Git diff shows clean `-`/`+` pairs for every real change — exactly what reviewers need.

### Step 3: Update mod.rs wiring

Add the new frozen module and update re-exports:

```rust
pub mod instance_actor_1_0_0_orchestration;
pub mod instance_actor_1_0_1_orchestration;  // ← new frozen module
mod instance_actor_orchestration;

pub use instance_actor_1_0_0_orchestration::instance_actor_1_0_0_orchestration;
pub use instance_actor_1_0_1_orchestration::instance_actor_1_0_1_orchestration;  // ← new
pub use instance_actor_orchestration::instance_actor_1_0_2_orchestration;        // ← updated
```

### Step 4: Register in registry

```rust
.register_versioned_typed(
    instance_actor::NAME,
    "1.0.2",
    instance_actor::instance_actor_1_0_2_orchestration,
)
```

### Step 5: Build and verify

```bash
cargo build --workspace
# or: npm run build / python -m pytest, depending on the SDK
```

## Logging Convention

Prefix all orchestration logs with the version for debugging:
- Rust: `ctx.trace_info("[v1.0.2] ...")`
- Node.js: `ctx.log("[v1.0.2] ...")`
- Python: `ctx.log("[v1.0.2] ...")`

## Version Selection + Rollout Behavior

- `start_orchestration(...)` uses the **latest registered** version.
- Existing running instances stay on their current version until they naturally transition (often at `continue_as_new` boundaries, depending on the workflow design and Duroxide policy).

## Safe Refactors

If you want to "refactor" orchestration code:
- Do it by **adding a new version** with the refactor.
- Do **not** modify earlier versions.

## Language-Specific Notes

### Rust (toygres, pg_durable)
- File naming: `{name}_orchestration.rs` / `{name}_{version}_orchestration.rs`
- Registration: `OrchestrationRegistry::builder().register_versioned_typed(...)`
- Visibility: frozen = `pub mod`, latest = `mod` (private, re-exported)

### Node.js (durable-copilot-sdk, duroxide-node)
- File naming: `{name}Orchestration.ts` / `{name}V{version}Orchestration.ts`
- Registration: `registry.registerOrchestration(NAME, version, handler)`
- Export frozen versions as named exports

### Python (duroxide-python)
- File naming: `{name}_orchestration.py` / `{name}_v{version}_orchestration.py`
- Registration: `registry.register_orchestration(NAME, version, handler)`

## Checklist

Before shipping:
- [ ] Copied latest to frozen file (`{name}_{old_version}_orchestration.rs`)
- [ ] Renamed function in latest file to new version
- [ ] Updated `[vX.Y.Z]` log prefixes
- [ ] Updated `mod.rs` / `index.ts` / `__init__.py` (added frozen module, updated re-export)
- [ ] Registered via `.register_versioned_typed(NAME, "X.Y.Z", ...)` or equivalent
- [ ] No changes to any frozen orchestration files
- [ ] Shared struct/type changes use `skip_serializing_if` / optional fields to preserve JSON compatibility
- [ ] Verified serialization: `None`/default values produce identical JSON to the old struct
- [ ] Build passes (`cargo build` / `npm run build` / `pytest`)
