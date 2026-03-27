# Proposal: npm Packaging and Embedded PilotSwarm Plugins

## Status

Implemented

## Goal

Package PilotSwarm as a small npm family that app authors can consume directly while keeping PilotSwarm's own built-in plugins embedded inside the published packages.

This proposal covers:

- dedicated unscoped package names
- package responsibilities
- what gets published in each tarball
- how embedded PilotSwarm plugins should load
- how app packages layer on top

---

## Recommended Packages

### `pilotswarm-sdk`

The core runtime package.

It should export:

- `PilotSwarmWorker`
- `PilotSwarmClient`
- `PilotSwarmManagementClient`
- types
- helper utilities such as tool-definition helpers

It should also ship PilotSwarm's built-in runtime assets:

- embedded framework base prompt
- embedded framework skills
- embedded PilotSwarm management agents
- embedded PilotSwarm management skills

### `pilotswarm-cli`

The terminal UI package.

It should:

- depend on `pilotswarm-sdk`
- provide the `pilotswarm` CLI binary
- ship CLI/TUI code and optional CLI-specific assets
- avoid duplicating PilotSwarm framework prompt content already owned by `pilotswarm-sdk`

---

## Naming Recommendation

Use dedicated unscoped package names:

- `pilotswarm-sdk`
- `pilotswarm-cli`

Keep the binary name short:

- `pilotswarm`

That gives us clear ownership in npm while preserving a clean CLI experience:

```bash
npm install pilotswarm-sdk
npm install pilotswarm-cli
npx pilotswarm
```

---

## Packaging Model

### What `pilotswarm-sdk` should contain

```text
pilotswarm-sdk
├── dist/
│   ├── index.js
│   ├── worker.js
│   └── ...
├── embedded/
│   ├── framework/
│   │   ├── base-prompt.md
│   │   └── skills/
│   └── mgmt/
│       ├── agents/
│       └── skills/
└── README.md
```

If we keep the current `plugins/` folder name instead of introducing `embedded/`, the important invariant is the same:

- built-in PilotSwarm assets ship inside the package tarball
- the worker resolves them relative to the installed package location
- consumer apps do not copy those files into their own repos

### What `pilotswarm-cli` should contain

```text
pilotswarm-cli
├── bin/
│   └── tui.js
├── cli/
│   └── tui.js
└── README.md
```

If the CLI needs branding or CLI-only plugin assets, they should be clearly separated from the framework base prompt and management plugins owned by `pilotswarm-sdk`.

### What an app package should contain

```text
@your-org/your-app
├── dist/
│   ├── worker-module.js
│   └── ...
├── plugin/
│   ├── plugin.json
│   ├── session-policy.json
│   ├── agents/
│   │   ├── default.agent.md
│   │   └── *.agent.md
│   └── skills/
└── README.md
```

---

## Embedded Plugin Rule

PilotSwarm's built-in plugins should be embedded package assets, not scaffolded app content.

That means:

- users install them by installing `pilotswarm-sdk`
- the worker auto-loads them from the package itself
- app packages layer their own plugin directories on top

This keeps the PilotSwarm base consistent across all consuming apps and avoids stale copies of framework prompt text floating around in downstream repositories.

---

## Install and Load Order

```text
npm install pilotswarm-sdk
│
├─ SDK code
├─ embedded framework base
├─ embedded framework skills
├─ embedded management agents
└─ embedded management skills

npm install @your-org/app
│
├─ app worker code
└─ app plugin directory

Runtime load order
1. PilotSwarm embedded framework layer
2. PilotSwarm embedded management layer
3. app pluginDirs
4. direct inline worker config
```

This matches the prompt-layering proposal:

- PilotSwarm installs the framework base
- the app overlays its own default prompt and agents
- the app does not replace the framework layer by accident

---

## Why Embedded Is Better Than Copying

### 1. Fewer stale docs and prompts

If built-ins are copied into every app, they drift.

### 2. Cleaner ownership

PilotSwarm owns framework instructions.

Apps own app instructions.

### 3. Simpler upgrades

Upgrading `pilotswarm-sdk` upgrades the built-in framework assets in one place.

### 4. Better support story

The supported extension point is the app's plugin directory, not patching core framework prompt files.

---

## Important Caveat: "Embedded" Is Not True Immutability

Because npm packages are installed on the user's machine, a determined user can still patch package files in `node_modules`.

So "embedded" means:

- built into the package by default
- not scaffolded into app repos
- not part of the normal customization surface
- unsupported to modify directly

It does **not** mean cryptographically immutable.

If we want an even stronger separation, we can move the framework base prompt from a disk file into a build-time string constant in the runtime package. That would reduce casual editing further, but it is still not a security boundary.

---

## Consumer App Model

Apps like Waldemort should depend on PilotSwarm and ship only app-specific assets.

Recommended responsibilities:

- `pilotswarm-sdk`
  - runtime primitives
  - embedded PilotSwarm framework prompt
  - embedded PilotSwarm management agents and skills

- `@your-org/app`
  - app `plugin/`
  - app tools
  - app worker wiring
  - app UI or API

At runtime, the app resolves its own package-local plugin directory and passes it to `pluginDirs`.

---

## Recommended Publish Settings

### `pilotswarm-sdk`

Publish compiled runtime code and embedded assets.

At minimum:

```json
{
  "name": "pilotswarm-sdk",
  "files": [
    "dist/**/*",
    "embedded/**/*",
    "README.md"
  ]
}
```

If we keep the current folder name:

```json
{
  "name": "pilotswarm-sdk",
  "files": [
    "dist/**/*",
    "plugins/**/*",
    "README.md"
  ]
}
```

### `pilotswarm-cli`

Publish the CLI entrypoints plus any CLI-only assets.

```json
{
  "name": "pilotswarm-cli",
  "bin": {
    "pilotswarm": "./bin/tui.js"
  },
  "files": [
    "bin/**/*",
    "cli/**/*",
    "README.md"
  ]
}
```

---

## Versioning

Start with lockstep versions for the core runtime and CLI:

- `pilotswarm-sdk@0.x.y`
- `pilotswarm-cli@0.x.y`

That keeps upgrades simple while the packaging contract settles.

Later, if the CLI and runtime need different cadences, they can diverge.

---

## Migration Notes

The repo currently uses unscoped workspace names:

- `pilotswarm`
- `pilotswarm-cli`

Moving to scoped publish names will require updating:

- package names in `package.json`
- cross-workspace dependency names
- docs and install examples
- import examples in SDK docs

The runtime loader should also be updated to make the embedded nature explicit in naming and docs, even if the underlying folder continues to be `plugins/`.
