# Mobile focus views

The phone chat header has a full-screen icon beside its status for mobile Zen.
The normal phone toolbar has the Master of Agents icon for the personal MoA layout. These browser features do not add
controls to the TUI.

Mobile Zen shows only a restore icon, a session selector, the transcript and a
compact composer. The mobile placeholder is “Message…”; input and placeholder
use the same 16px font. Drafts grow from one line and are capped against the
visible viewport. Session changes retain drafts during the current page visit.
The selector disables during navigation; failed navigation restores the source
session and its draft. Read-only sessions retain their access restrictions.

On a phone, MoA shows one panel at a time. The map icon opens the saved desktop
split tree, including unequal splits and the desktop viewport aspect ratio.
Older layouts use 16:9 until next opened on desktop. Numbering starts with the
top-left panel and follows clockwise order. Tap a tile or its full-sized list
row to select it. Swipe left to advance clockwise, right to reverse. For a
canvas, swipe its title bar; the iframe retains its own touch interactions.

Text selection, controls and horizontally scrollable content do not trigger
panel navigation. Hidden panels stay mounted so drafts, reading position and
canvas state survive switches. Desktop Tab/Shift+Tab navigation remains intact;
arrow keys retain native editing behavior. Profile persistence stores only panel
references and geometry, never transcript content or drafts.

Mobile Zen and MoA show activity and queue counts in the existing header, with
a full-size header button opening the shared searchable session picker in Zen.
The picker includes session details, canvases, and the standard new-session + action. Queued prompt bodies appear once
in the transcript; these focus views have no reserved footer strip. The normal
workspace chat footer keeps its status-line baseline. Status ordering rejects stale
snapshots, while real completion and Stop availability update immediately.
There is no timer that keeps a completed turn looking busy.

## Validation and rollout boundary

Browser regression coverage includes Chromium and WebKit composer behavior,
mobile navigation and permission failures, map geometry, native horizontal
scrolling, canvas state, and Win95, Winamp, MS-DOS and terminal themes. Backend
coverage verifies provider-pool matching, existing cap removal without a model
catalog, authorized budget wakeups, remaining admission caps, and stale status
ordering through both polling paths.

This work targets a PilotSwarm AKS test deployment. The application version
remains 0.5.60; a package release and downstream deployment are separate steps.

The mobile MoA header includes the session control-panel icon beside the map.
Tap it, then Split right or Split below to create and select an empty panel;
tap its + to select a session or canvas. The same menu handles replacement
and removal without requiring a right-click or long press.
