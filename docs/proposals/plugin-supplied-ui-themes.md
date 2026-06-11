# Plugin-Supplied UI Themes

> **Status:** Proposal  
> **Date:** 2026-04-24  
> **Goal:** Let app layers such as Waldemort contribute TUI and portal themes without hardcoding downstream palettes into PilotSwarm's built-in theme registry.

---

## Summary

PilotSwarm already has a shared theme system used by both the native TUI and browser portal. Today the list of available themes is compiled into `pilotswarm-ui-core`, so a downstream app that wants a domain-specific palette must either patch the vendored UI package or request that its app-specific theme be added to PilotSwarm itself.

This proposal adds a generic app-layer theme extension point. A plugin or deployment can define extra themes in its local `plugin.json`; PilotSwarm loads, validates, and merges those themes with the built-in list at runtime. Waldemort can then ship themes such as `waldemort-cauldron` from the Waldemort plugin layer while PilotSwarm remains product-neutral.

---

## Motivation

- **Keep app identity in the app layer.** Waldemort-specific colors, labels, and visual tone belong beside Waldemort's existing `plugin/plugin.json` branding, not inside PilotSwarm's core packages.
- **Preserve shared TUI/portal behavior.** A selected theme should apply to both the native TUI and the browser portal, using the existing theme picker and persistence paths.
- **Avoid vendored package churn.** Downstream apps should not need to edit `pilotswarm-ui-core-local/src/themes/*` just to add an app palette.
- **Support deployment branding.** The same mechanism can serve other PilotSwarm-based apps without expanding the built-in theme catalog indefinitely.

---

## Current State

PilotSwarm's shared UI stack already has:

- built-in theme definitions in `packages/ui-core/src/themes/*`
- `listThemes()` and `getTheme(themeId)` in `packages/ui-core/src/themes/index.js`
- a theme picker in the shared controller
- TUI persistence in the local config file
- portal persistence in local storage / cookie
- portal CSS variable application from the selected theme

Downstream app metadata already flows from `plugin/plugin.json` into the TUI and portal for branding:

```json
{
  "name": "waldemort",
  "tui": {
    "title": "Waldemort",
    "splashFile": "./tui-splash.txt"
  },
  "portal": {
    "title": "Waldemort",
    "pageTitle": "Waldemort - Postgres Stress Testing",
    "logoFile": "./assets/logo.svg"
  }
}
```

The missing piece is a way for the same app metadata path to provide theme definitions and an app default theme.

---

## Proposed `plugin.json` Shape

Add an optional shared `ui` section for cross-surface UI configuration:

```json
{
  "name": "waldemort",
  "ui": {
    "defaultTheme": "waldemort-cauldron",
    "themes": [
      {
        "id": "waldemort-cauldron",
        "label": "Waldemort Cauldron",
        "description": "Dark operational palette with green, blue, and red accents for Postgres stress analysis.",
        "page": {
          "background": "#05070b",
          "foreground": "#e5edf5",
          "overlayBackground": "#05070b",
          "overlayForeground": "#e5edf5",
          "hintColor": "#8bd450",
          "modalBackdrop": "rgba(3, 5, 8, 0.78)",
          "modalBackground": "#111827",
          "modalBorder": "#365314",
          "modalForeground": "#f8fafc",
          "modalMuted": "#9ca3af",
          "modalSelectedBackground": "#1f2937",
          "modalSelectedBorder": "#84cc16",
          "modalSelectedForeground": "#ffffff"
        },
        "terminal": {
          "background": "#05070b",
          "foreground": "#dbeafe",
          "cursor": "#84cc16",
          "cursorAccent": "#05070b",
          "selectionBackground": "rgba(132, 204, 22, 0.28)",
          "black": "#0b1120",
          "red": "#ef4444",
          "green": "#84cc16",
          "yellow": "#facc15",
          "blue": "#38bdf8",
          "magenta": "#a78bfa",
          "cyan": "#22d3ee",
          "white": "#e5edf5",
          "brightBlack": "#64748b",
          "brightRed": "#f87171",
          "brightGreen": "#bef264",
          "brightYellow": "#fde047",
          "brightBlue": "#7dd3fc",
          "brightMagenta": "#c4b5fd",
          "brightCyan": "#67e8f9",
          "brightWhite": "#ffffff"
        },
        "tui": {
          "surface": "#07110d",
          "activeHighlightBackground": "#1a2e05",
          "activeHighlightForeground": "#f7fee7",
          "selectionBackground": "#84cc16",
          "selectionForeground": "#05070b",
          "promptCursorBackground": "#84cc16",
          "promptCursorForeground": "#05070b"
        }
      }
    ]
  }
}
```

Rules:

- `ui.themes` is optional. Missing means use only built-in themes.
- `ui.defaultTheme` is optional. Missing means use PilotSwarm's built-in default.
- Theme objects use the same `createTheme()` input shape as built-in themes.
- `id` must be stable, lower-case, and app-scoped, for example `waldemort-cauldron`.
- A plugin theme id must not collide with a built-in theme id unless a future explicit override mechanism exists.

---

## Runtime Model

### Theme registry

Move the theme list from a closed module constant to a small registry abstraction:

```ts
listThemes(): Theme[]
getTheme(id: string): Theme | null
registerThemes(themes: Theme[], options?: { source?: string }): void
setDefaultThemeId(themeId: string): void
getDefaultThemeId(): string
```

The built-in theme files still register first. Plugin themes register later from app configuration.

### CLI / TUI startup

`pilotswarm-cli` already reads `plugin.json` via `resolveTuiBranding(pluginDir)`. Extend that path to also return:

```ts
{
  branding,
  themes,
  defaultThemeId
}
```

Then startup registers plugin themes before calling `createInitialState()`. Initial theme selection order:

1. user config persisted `themeId`, if it still resolves
2. plugin `ui.defaultTheme`, if present and valid
3. PilotSwarm built-in default

If the persisted user theme no longer exists, fall back to the app default and overwrite persistence on the next normal theme change.

### Portal startup

`/api/portal-config` already returns plugin-derived portal branding. Extend the returned payload with:

```json
{
  "portal": {
    "theme": {
      "defaultTheme": "waldemort-cauldron",
      "themes": []
    }
  }
}
```

The portal registers these themes before creating the shared controller. Initial theme selection order mirrors the TUI:

1. browser cookie / localStorage theme id, if it still resolves
2. portal config default theme
3. PilotSwarm built-in default

### Theme picker

The existing theme picker should list built-in and plugin themes together. Plugin themes should sort by label like built-ins. Optionally, the details pane can display a source label such as `Source: Waldemort`, but this is not required for the first version.

---

## Validation

The loader should validate plugin themes before registration:

- require `id`, `label`, `page.background`, `page.foreground`, `terminal.background`, and `terminal.foreground`
- normalize hex colors through existing helper behavior where possible
- reject malformed color values instead of silently registering a broken theme
- reject duplicate ids within one plugin
- reject collisions with built-in ids
- cap the number of plugin themes per plugin to a small number, for example 16

For initial implementation, validation can be synchronous and local because `plugin.json` is already loaded from trusted deployment configuration.

---

## Security and Safety

Plugin themes are structured color tokens, not arbitrary CSS. They must not support:

- raw CSS strings beyond color values
- external URLs
- custom font URLs
- injected style blocks
- executable theme code

This keeps portal theming safe to serve through `/api/portal-config` and avoids turning app branding into a CSS injection surface.

---

## Non-Goals

- No built-in Waldemort theme inside PilotSwarm's core theme list.
- No marketplace or registry for themes.
- No live theme editor in the TUI or portal.
- No arbitrary CSS overrides in `plugin.json`.
- No theme distribution through the proposed DB plugin packaging system. This is deployment/app chrome, not agent/skill/MCP plugin payload.
- No per-session theme selection. Theme is a client UI preference.

---

## Backward Compatibility

Existing apps continue to work unchanged:

- if `ui.themes` is absent, only built-in themes are available
- if `ui.defaultTheme` is absent, the existing PilotSwarm default remains
- existing persisted user theme ids remain valid for built-in themes
- existing `tui` and `portal` branding keys keep their current behavior

If a user has a persisted theme id that disappears after an app removes a plugin theme, the UI falls back to the app default or built-in default.

---

## Implementation Plan

1. Add a mutable but controlled theme registry to `packages/ui-core/src/themes/index.js`.
2. Export `registerThemes`, `setDefaultThemeId`, and `getDefaultThemeId` from `pilotswarm-ui-core`.
3. Extend `createInitialState()` to use `getDefaultThemeId()` rather than a closed `DEFAULT_THEME_ID` constant.
4. Extend CLI plugin config parsing to read `ui.themes` and `ui.defaultTheme`.
5. Register plugin themes during TUI startup before controller/state creation.
6. Extend portal config output to include plugin theme definitions and default id.
7. Register portal plugin themes before creating the web controller.
8. Add tests for parsing, duplicate rejection, default fallback, TUI startup, and portal config round trip.

---

## Waldemort Example

Waldemort can then stay entirely in its own layer:

```text
waldemort/
  plugin/
    plugin.json        # declares Waldemort themes
    assets/logo.svg
    tui-splash.txt
```

No Waldemort-specific file is added to:

```text
packages/ui-core/src/themes/
packages/ui-react/src/
packages/portal/src/
```

The only PilotSwarm change is the generic ability to accept and validate app-supplied theme definitions.

---

## Open Questions

- Should plugin themes be grouped under `ui.themes`, or should the key be `themes` at the root for shorter manifests?
- Should TUI and portal be allowed to specify separate defaults, or should one shared `ui.defaultTheme` be required for consistency?
- Should theme picker details show theme source (`Built-in`, `Waldemort`, etc.)?
- Should validation enforce contrast ratios, or only basic structural/color validity in the first version?