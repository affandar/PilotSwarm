# Generic Superagent management capabilities

The `generic-superagent` identity receives the same management bundle as `agent-manager`: diagnostics, caller-visible package/file inspection, package editing and publication, and session-management controls. Declaration and per-turn control handlers share `MANAGER_AGENT_IDS`, keeping them consistent. Its administrator owners also receive the existing feature tools.

The identity selects tools, not authority. Every operation retains the existing live viewer and owner/admin checks; system-session restrictions remain unchanged. No other identity's tools or behavior changes. Native Copilot tasks retain their existing local CLI tool scope; management operations run in the parent session.
