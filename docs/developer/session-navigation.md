# Session navigation on slow connections

An explicit selection belongs to the current tab. The saved profile restores the initial selection; subsequent profile polls can update preferences but cannot undo local navigation. Profile reads that overlap local preference edits are discarded, and queued saves remain tracked until every outstanding write settles.

History and details load concurrently. An in-flight history request is shared by navigation and background refresh. Every navigation attempt has a generation, so A → B → A cannot complete the first A attempt into the last visit. Background refresh also checks that selection and navigation generation still match before attaching live updates.

The periodic catalog loop permits only one outstanding periodic refresh. Session pages and folders load independently, overlapping their network waits. Explicit refreshes retain the existing ordering guard. Missing history displays loading or retry text; cached conversation content stays visible while refreshed.

These changes apply to the shared UI controller and the browser profile synchronization. There are no SDK scheduling, agent, or transport protocol changes.
