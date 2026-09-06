# Master of Agents (MoA)

Master of Agents is an alternate **desktop browser** workspace. Use the
**Master of Agents** button in the PilotSwarm header. It is unavailable on
screens 920 pixels wide or narrower and in the TUI.

Each user has five named layouts, saved in their profile. Layouts remember
session and canvas references, split directions, and divider proportions.
Changes save automatically; the toolbar reports a failed save and offers Retry.
The active slot is remembered. Enter MoA explicitly after reloading the portal.

## Panels and focus

A new layout starts empty. Click **+** or right-click the empty area to select
from your session list, then choose the chat or one of that session's canvases.
The picker uses the same rows, folders, owner badges, and access-filtered
catalog as the normal workspace.

Only the focused chat displays a composer. Click a panel or focus one of its
controls to focus it; its border and title bar highlight. Focusing a canvas or
empty panel hides all chat composers. Drafts remain when switching focus or
layouts during the current page session. Read-only sessions retain their normal
read-only behavior.

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

**Zen** hides the PilotSwarm header and MoA toolbar. The small **Exit zen**
handle and Escape restore the regular MoA view. Panel controls remain available.

**Open in main view** opens that panel's session, or maximizes its chosen
canvas. **Back to MoA** in the header restores the saved arrangement.
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
