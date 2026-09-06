# Master of Agents (MoA)

Master of Agents is an alternate **desktop browser** workspace. Use the
**Master of Agents** tiled-panel icon between Workspace and Budget
in the PilotSwarm header, followed by Admin/Settings. Those view buttons stay available in MoA, except in zen. It is unavailable on
screens 920 pixels wide or narrower and in the TUI.

Start with one named tab. Use **+** beside the tabs to add another, up to five.
Double-click a tab or use **Rename MoA** to name it. Existing saved layouts
automatically appear as tabs. Layouts remember
session and canvas references, split directions, and divider proportions.
Changes save automatically; the toolbar reports a failed save and offers Retry.
The active slot is remembered. Enter MoA explicitly after reloading the portal.

## Panels and focus

A new layout starts empty. Click **+** or right-click the empty area to select
from your session list, then choose the chat or one of that session's canvases.
The picker mounts the same Sessions pane as the normal workspace: rows,
folders, owner badges, pinning, scrolling, and the expandable detail box.
Its selection stays local to the picker; choosing content does not navigate
the default chat. Arrow keys navigate the list; select chat or canvas below it.
The new-session icon at the top opens the existing model/agent creation flow.
Creating fills that panel and keeps the default workspace’s selection.
Cancelling returns to the picker; failed creation leaves the panel intact.

One full-width composer sits below all panels, including in zen. It targets
the focused panel’s session, whether the panel shows chat or a canvas. Click
a panel or focus one of its controls to select it; its border and title bar
highlight, and the composer names its target. Empty or unavailable panels have
no composer. Working and queued-message status stays inside each chat panel. Drafts remain when switching focus or
layouts during the current page session. Read-only sessions retain their normal
read-only behavior.

Within the panels, **Tab** moves focus clockwise around the screen and
**Shift+Tab** moves in reverse, including from a canvas. Drafts stay in their
own panels. Toolbar controls and dialogs keep normal Tab navigation; the
layout tabs also support Left/Right and Home/End.

Each populated panel also has the same **spanner**, **session link**, and
**trash** controls as the session list. Trash opens the existing lifecycle
chooser and confirmation; removing a panel remains a separate layout action.
The **info** icon shows the existing session-details fields.

Use a panel's **…** menu or right-click a populated panel to replace it,
split right/below, open it in the main view, or remove it. Splitting immediately
creates a focused empty panel; select its content separately with **+** or
right-click. Drag a divider to resize; a keyboard-focused divider supports
arrow keys and Home/End. Removing a panel expands its sibling into the freed
space. Each layout supports up to 16 panels.

A canvas panel stays pinned to its chosen session and canvas slot, even when
an agent presents a different slot. Empty, deleted, or inaccessible content
stays a placeholder that can be replaced; it never falls back to another
session. Each populated panel has an isolated session controller/subscription.

## Zen and opening a session

The toolbar uses icons with hover labels: add panel, clear layout (eraser),
share link, and enter zen (expand corners). **Clear MoA layout** asks for
confirmation, then returns only the current tab to its blank **+** screen.
Its name, other tabs, sessions, and canvases are preserved.

**Zen** hides the PilotSwarm header and MoA toolbar. The small **Exit zen**
handle and Escape restore the regular MoA view. Panel controls remain available.

**Open in main view** opens that panel's session, or maximizes its chosen
canvas. The **Master of Agents** icon (labelled **Back to MoA** after zooming) restores
the saved arrangement.
Resizing to a mobile screen exits MoA and releases its panel subscriptions.
Returning to desktop does not automatically reopen it.

## Sharing a layout

**Share** creates a snapshot link. Its URL fragment contains only the layout
name, panel IDs, session IDs, canvas slot numbers, and split geometry. It does
not contain transcripts, session titles, canvas documents, credentials, or
access grants. It can be copied before anyone opens it; no new sharing service
or public session permission is created.

Recipients sign in normally, preview the arrangement, and choose one of their
five slots. Replacing an occupied slot requires an explicit second action.
The copied layout is independent of the original; the session references still
point to live sessions and retain their existing permissions. Inaccessible
sessions show a placeholder with Retry, plus the normal Replace action.

Ctrl+Left/Right/Up/Down moves focus to the nearest panel in that direction, including from the composer or a canvas. It stops at the screen edge. Tab and Shift+Tab still cycle clockwise and counterclockwise. These shortcuts pause while dialogs are open.
