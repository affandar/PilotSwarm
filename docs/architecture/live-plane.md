# Ephemeral live plane

The live plane accelerates in-progress UI updates without making token deltas
part of durable history. It is independent of the orchestration provider:
both PgFactStore and HorizonDB deployments use the CMS PostgreSQL connection.

## Data flow and boundaries

1. With `PILOTSWARM_LIVE_TURN=1`, ManagedSession coalesces assistant/reasoning
   deltas into cumulative `assistant.live_tick` snapshots.
2. SessionProxy publishes the `turn` topic through a latest-value queue:
   one write in flight and one replaceable waiting value. Live failures must
   not fail a turn or advance its durable replay cursor.
3. CMS migrations 0073/0074 provide an UNLOGGED last-value table and
   schema-parameterized stored procedures. A write atomically updates its
   per-session/topic sequence and emits `pilotswarm_live` NOTIFY.
4. One LISTEN connection per portal fans notifications out to authorized
   session readers. Large envelopes are pointers resolved through `getLive`.
5. The browser reconciles provisional items with durable
   `assistant.message` events by message ID. Durable content always wins.

No token delta is written into orchestration history or the durable event
transcript. The generic plane also supports merge patches and non-retained
signals, but chat uses complete snapshots, so dropping intermediate ticks
does not lose text.

## Pacing and limits

After the first threshold-triggered paint, normal updates are bounded to one
per 100 ms; turn/final boundaries may flush immediately. A fast provider cannot
bypass pacing by emitting large chunks. Repeated explicit deltas append;
cumulative snapshots do not duplicate already-seen prefixes.

Each text/reasoning preview is capped at 16,384 UTF-16 code units, safely within
the 256 KiB retained JSON limit even with JSON escaping. The UI labels a
truncated preview as paused; the durable final answer remains complete.
The publisher and relay pointer reads are coalesced. A socket with more than
1 MiB pending, or more than 128 updates waiting for an initial snapshot, is
closed with 1013 and recovers by resubscribing.

## Recovery and authorization

Subscriptions use the same session-read authorization as durable events.
Browsers cannot publish. Canvas-share tokens cannot subscribe to chat topics.
Reauthorization replaces an existing subscription only with current authority;
a denial removes the old handler. A client may subscribe to at most 16 topics
per session.

A subscribe burst precedes buffered updates. Duplicate/out-of-order snapshots
are ignored; patch gaps fetch retained state. New readers receive the cached
full value. Reconnects refresh retained topics even if no new notification
arrives; unavailable/reset state releases stale previews. An UNLOGGED table
may be empty after a database crash. Durable event catch-up remains authoritative.

Each model stream has an opaque ID so an old idle tick cannot erase a newer
stream. In-memory closed-stream/message keys suppress late previews after
completion; these bounded tombstones are not durable history.
Retained snapshots also carry their database update time. On re-entry, the
UI rejects a snapshot older than an already-loaded terminal event, including
reasoning-only rows left behind by a crashed worker with no message ID.

## Presentation

Shared ui-core owns message identity, final reconciliation and idle cleanup.
The browser delays provisional chrome by 200 ms, keeps revealed chrome for at
least 700 ms, then fades decoration for 180 ms. The section, reasoning
disclosure and content nodes remain mounted; completion does not remove the
shell or its padding. Fast completed responses skip provisional chrome.

Reasoning stays in an expandable row. Its markdown is parsed only when opened;
the user's disclosure choice survives answer arrival and settlement.
Unchanged history items reuse cached rendering. An idle tick gives already
visible content up to 1.2 seconds for its durable replacement, while previews
that never reached reveal are discarded immediately. Disconnect and session
detach clean up previews and timers.

Browser animation/shading is intentionally host-specific. The direct Node
transport remains durable-event-only; Web API consumers use the ephemeral
topic. Shared native selectors can render a live reasoning item without
browser sentinels, but the native host does not require this plane.

See [API reference](../api/reference.md) for wire operations and
[AKS deployment](../developer/deploy/aks.md) for the opt-in environment setting.
