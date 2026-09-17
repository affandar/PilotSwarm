# Session navigation on slow connections

An explicit selection belongs to the current tab. The saved profile restores the initial selection; subsequent profile polls can update preferences but cannot undo local navigation. Profile reads that overlap local preference edits are discarded, and queued saves remain tracked until every outstanding write settles.

History and details load concurrently. An in-flight history request is shared by navigation and background refresh. Every navigation attempt has a generation, so A → B → A cannot complete the first A attempt into the last visit. Background refresh also checks that selection and navigation generation still match before attaching live updates.

The periodic catalog loop permits only one outstanding periodic refresh. Session pages and folders load independently, overlapping their network waits. Explicit refreshes retain the existing ordering guard. Missing history displays loading or retry text; cached conversation content stays visible while refreshed.

These changes apply to the shared UI controller and the browser profile synchronization. There are no SDK scheduling, agent, or transport protocol changes.

## Desktop view history and MoA focus

The browser navigation hook keeps ten sanitized view references in per-account sessionStorage.
It records state transitions around explicit clicks and keyboard gestures, plus the completion
of a user-created session, rather than recording store updates from polling or live events.
Restoration selects the destination synchronously and refreshes its data asynchronously;
late fetches cannot reopen an artifact or change the selected session. Normal API access checks
still apply, including eviction of inaccessible cached sessions.

MoA registers each live panel controller by dashboard and panel ID. Focus can adopt the panel's
cached history without waiting for session detail or canvas reads. It preserves a main-view
cache that is newer or contains older pages, transfers the draft and scroll state, and uses
the controller's navigation generation to prevent late attachment after leaving again.

Regression coverage lives in `web/test/view-history.test.mjs` and
`web/test/e2e/view-navigation.spec.mjs`, alongside the existing MoA, toolbar, layout,
created-session and session-pane workflow suites.
