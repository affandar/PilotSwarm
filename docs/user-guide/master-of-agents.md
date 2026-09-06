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

With keyboard focus on a panel, **Left/Right/Up/Down** selects the nearest
panel in that direction, stopping at the edge. **Tab** or **Shift+Tab** toggles
between the selected panel and its composer. Inside the composer, arrows edit
text normally; Ctrl+Arrow does not change panel selection. Tab from inside a
canvas moves to the composer, and the next Tab returns to its panel.
Toolbar controls and dialogs keep normal Tab navigation; layout tabs also
support Left/Right and Home/End.

Each populated title bar has just **maximize** (open in the main view) and a
**sliders** icon for the session control panel. Its **Session** group contains
the existing spanner/manage, link, trash, info, and open-in-main-view actions.
Trash opens the existing lifecycle chooser and confirmation. Info shows the
existing session-details fields. Its **Panel layout** group contains replace,
split right/below, and remove panel. These actions remain icon buttons with
hover labels. Removing a panel does not delete its session.

Use the control-panel icon or right-click a populated panel. Splitting immediately
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
