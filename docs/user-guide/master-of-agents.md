# Master of Agents (MoA)

Master of Agents is an alternate browser workspace. On desktop, use the
**Master of Agents** tiled-panel icon between Workspace and Budget
in the PilotSwarm header, followed by Admin/Settings. Those view buttons stay
available in MoA, except in zen. It is unavailable in the native TUI.

MoA supports up to **five personal dashboards**, saved to your user profile.
Each dashboard remembers its name, session and canvas references, split geometry,
and focused panel. Changes save automatically. Routine save status stays hidden;
a failed save shows a retry icon. Enter MoA explicitly after reloading the portal;
your last selected dashboard returns.

On desktop, named tabs sit in the PilotSwarm header. When the available width
cannot fit them, the tabs become a single dashboard picker; action icons keep
their size. **+** creates an empty dashboard (disabled at five). The adjacent
sliders icon opens dashboard options to rename or delete it. Deletion requires
confirmation and is disabled for the last dashboard. It never deletes sessions.
Clear layout affects only the current dashboard. MoA has no sharing or links.

Switching dashboards reconnects their visible sessions without stopping the agents.
Drafts belong to sessions, including when the same session appears on multiple
dashboards. Drafts last for the current page session; they are not saved in the
profile. Layouts and focused-panel selections survive reloads.

Existing single-workspace profiles become the first dashboard with their panels
and geometry intact. The older slot-based format retains its selected populated
layout, or the first populated layout when the selected slot is blank. Discarded
legacy slots are not restored. Old MoA links and pending imports are ignored.
Older open clients cannot downgrade a saved multi-dashboard profile.

## Panels and focus

A new layout starts empty. Click **+** or right-click the empty area to select
from your session list, then choose the chat or one of that session's canvases.
The picker mounts the same Sessions pane as the normal workspace: rows,
folders, owner badges, pinning, scrolling, and the expandable detail box.
Its selection stays local to the picker; choosing content does not navigate
the default chat. Arrow keys navigate the list; select chat or canvas below it.
The **+** icon beside Close replaces the picker pin button and opens the existing
model/agent creation flow, including when the list is filtered or empty.
Creating fills that panel and keeps the default workspace’s selection.
Cancelling returns to the picker; failed creation leaves the panel intact.

Each panel has its own message box by default, including in zen. Send, Stop,
attachments, and drafts belong to that panel's session. **Dashboard options →
Message boxes → Shared below all panes** restores the full-width composer for
the focused panel. This preference applies to all your dashboards and survives
reloads. Changing it preserves session drafts. Working and queued-message status
stays inside the chat panel. Read-only sessions keep their normal restrictions.

**Tab** moves to the next panel clockwise; **Shift+Tab** moves in reverse.
Keyboard panel navigation focuses the selected session’s message box.
Click a message box to write to that session. Drafts stay with their sessions.
Arrow keys and Ctrl+Arrow never change panel selection; composer editing stays
native. Empty or read-only panels cannot accept prompts. Toolbar controls
and dialogs retain their normal keyboard navigation.

Only the focused panel shows its title-bar buttons. It has **split right** and
**split below** shortcuts; in narrow panels these stay available in the control
menu, leaving room for the title and primary actions. Populated panels
also have a **diagonal arrow** (focus in the main view) and a **sliders** icon for the session
control panel. Its **Session** group contains
the existing spanner/manage and trash actions. Session details appear directly below the controls. MoA omits session-link
and sharing controls; those remain available in the normal session view. Focus is available
only in the session title bar.
Trash opens the existing lifecycle chooser and confirmation. The details use the
same fields as the session list. Its **Panel layout** group contains replace,
split right/below, and **Close panel** (a panel outline with an ×). These actions
remain icon buttons with hover labels. Closing a panel keeps its session available.
The trash icon in the Session group remains reserved for session lifecycle actions.

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

The centered toolbar uses icons with hover labels: clear layout (eraser)
and enter zen (expand corners). **Clear MoA layout** asks for
confirmation, then returns the current dashboard to its blank **+** screen.
Sessions and canvases are preserved.

**Zen** hides the PilotSwarm header and MoA toolbar. The small **Exit zen**
handle and Escape restore the regular MoA view. Panel controls remain available.

**Focus panel** opens that panel's session, or maximizes its chosen
canvas. The **Master of Agents** icon (labelled **Back to MoA** after zooming) restores
the saved arrangement.

Clicking an artifact link inside a chat also leaves MoA and focuses that chat's
session. Desktop opens the artifact preview beside the conversation. Mobile opens
the artifact reader. Your draft is preserved, and **Back to MoA** restores the layout.

## Phone layout

On phones, tap the down-triangle button at the far right of the header to switch dashboards. The picker
shows each dashboard’s saved proportions and selected tile, with options to add,
rename, or delete dashboards. Its list scrolls within the screen. A single header
shows the current session and activity on the left, then panel controls, the
minimap, and the dashboard selector on the right. Dashboard names stay in the
picker; reordering is available on desktop only.

MoA keeps the saved desktop split geometry but displays one panel
at a time. Tap the map icon to see a minimap with the same proportions as the
desktop layout, then tap a tile or its full-size session row to select it.
Swipe left to move clockwise and right to move counter-clockwise. Swipes that
start on text selection, controls, horizontally scrolling content, or a canvas
iframe keep their native behavior.

The phone header exposes the map and the focused panel's control menu. Use the
control menu to split right or below, replace content, or remove the panel.
Hidden panels stay mounted so drafts, transcript positions, and canvas state
survive panel changes. The compact composer always targets the visible panel.
While that session is running, Stop remains available beside Send and preserves
your draft when used.

Mobile Zen reduces the view to a restore control, the shared searchable session
picker, the transcript, and the compact composer. The picker includes session
details, canvases, and the standard new-session action. Activity and queued
prompt counts appear in the header instead of reserving a footer strip.
