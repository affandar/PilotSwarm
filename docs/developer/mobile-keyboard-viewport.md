# Mobile keyboard viewport

The portal shell follows `visualViewport.height` and `visualViewport.offsetTop` separately. Safari can leave the layout viewport tall while the keyboard shrinks and pans the visible rectangle; adding the offset to the shell's height incorrectly treats the pan as usable content space. The shell is fixed at the visual offset and uses only the visible height. Resize and scroll events are coalesced into animation frames.

When composer focus triggers keyboard takeover, the session list is removed from the grid and the chat occupies a single remaining row. Hiding only the list's pixels can leave an automatically sized empty row above the chat. Search focus does not trigger composer takeover, so the search input stays visible. Dismissing the keyboard restores normal layout without clearing the draft or requiring blur.

`web/test/e2e/mobile-keyboard-viewport.spec.mjs` simulates Safari's independent visual height and pan while preserving the layout viewport. It verifies composer geometry, absence of the empty row, search focus, and restoration. It runs under Chromium and WebKit. This supplements browser automation; it does not emulate the actual iOS keyboard or replace a device check.
