# Master of Agents (MoA)

Master of Agents is an alternate **desktop browser** workspace. Use the
**Master of Agents** tiled-panel icon between Workspace and Budget
in the PilotSwarm header, followed by Admin/Settings. Those view buttons stay available in MoA, except in zen. It is unavailable on
screens 920 pixels wide or narrower and in the TUI.

MoA is one personal workspace saved to your user profile. There are no dashboard
tabs, names, sharing controls, or MoA links. The header holds just add panel,
clear layout, and zen alongside the existing view controls. Layouts remember
session and canvas references, split directions, and divider proportions.
Changes save automatically; the toolbar reports a failed save and offers Retry.
Enter MoA explicitly after reloading the portal.

Existing multi-dashboard profiles migrate to the selected populated layout.
If the selected dashboard is blank or invalid, the first populated layout is
retained. Other dashboards are no longer available. Old MoA links and pending
imports are ignored; they cannot replace your personal workspace.

## Panels and focus

A new layout starts empty. Click **+** or right-click the empty area to select
from your session list, then choose the chat or one of that session's canvases.
The picker mounts the same Sessions pane as the normal workspace: rows,
folders, owner badges, pinning, scrolling, and the expandable detail box.
Its selection stays local to the picker; choosing content does not navigate
the default chat. Arrow keys navigate the list; select chat or canvas below it.
The **Create New Session** row at the top of the list opens the existing
model/agent creation flow, including when the list is filtered or empty.
Creating fills that panel and keeps the default workspace’s selection.
Cancelling returns to the picker; failed creation leaves the panel intact.

One full-width composer sits below all panels, including in zen. It targets
the focused panel’s session, whether the panel shows chat or a canvas. Click
a panel or focus one of its controls to select it; its border and title bar
highlight, and the composer names its target. Empty or unavailable panels have
no composer. Working and queued-message status stays inside each chat panel. Drafts remain when switching focus or
views during the current page session. Read-only sessions retain their normal
read-only behavior.

**Tab** moves to the next panel clockwise; **Shift+Tab** moves in reverse.
The selected session’s composer is automatically focused and ready to type,
including after clicking a different panel. Drafts stay with their sessions.
Arrow keys and Ctrl+Arrow never change panel selection; composer editing stays
native. Empty or read-only panels cannot accept prompts. Toolbar controls
and dialogs retain their normal keyboard navigation.

Each populated title bar has just **maximize** (open in the main view) and a
**sliders** icon for the session control panel. Its **Session** group contains
the existing spanner/manage, trash, and info actions. MoA omits session-link
and sharing controls; those remain available in the normal session view. Zoom is available
only in the session title bar.
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
and enter zen (expand corners). **Clear MoA layout** asks for
confirmation, then returns your workspace to its blank **+** screen.
Sessions and canvases are preserved.

**Zen** hides the PilotSwarm header and MoA toolbar. The small **Exit zen**
handle and Escape restore the regular MoA view. Panel controls remain available.

**Open in main view** opens that panel's session, or maximizes its chosen
canvas. The **Master of Agents** icon (labelled **Back to MoA** after zooming) restores
the saved arrangement.
Resizing to a mobile screen exits MoA and releases its panel subscriptions.
Returning to desktop does not automatically reopen it.
