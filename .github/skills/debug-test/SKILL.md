---
name: debug-test
description: Diagnose and fix a failing integration test in PilotSwarm. Covers the full call chain from PilotSwarmSession.sendAndWait through duroxide orchestration to CopilotSession, common failure patterns, and how to inspect orchestration and CMS state.
---

# Debug a Failed Test

## Diagnosis steps

1. **Run the specific test** to reproduce:
   ```bash
   npm test -- --test=<name>
   ```

2. **Identify the failure layer** — the call chain is:
   ```
   test → PilotSwarmSession.sendAndWait()
        → PilotSwarmClient._startAndWait()
        → duroxide orchestration
        → SessionProxy activity (runTurn)
        → SessionManager.getOrCreate()
        → ManagedSession.runTurn()
        → CopilotSession.send() + on()
   ```

3. **Common failure causes**:

   | Symptom | Likely cause |
   |---------|-------------|
   | Timeout with no response | Orchestration stuck — check duroxide logs |
   | Tool handler not called | Tools not registered — check `setSessionConfig` or `registerTools` was called |
   | Wrong tool called | System message not directive enough — use `mode: "replace"` |
   | Assertion on content fails | LLM non-determinism — make assertions flexible (`.includes()`, case-insensitive) |
   | "Not started" error | `worker.start()` or `client.start()` not called |
   | Session not found | Session wasn't created in CMS — check `catalog.createSession()` |
   | Warm session missing tools | `updateConfig()` not called — check `session-manager.ts` warm path |
   | `nondeterministic: custom status mismatch` | Orchestration code uses `Date.now()` or other non-deterministic values to branch before yields — use `yield ctx.utcNow()` instead. Can also happen after redeploying changed orchestration code without resetting the database. |

4. **Check CMS events** — verify what actually happened:
   ```javascript
   const events = await session.getMessages();
   console.log(events);
   ```

5. **Check session info**:
   ```javascript
   const info = await session.getInfo();
   console.log(info.status, info.iterations);
   ```

## Key files
- [packages/sdk/test/sdk.test.js](../../../packages/sdk/test/sdk.test.js) — test definitions
- [packages/sdk/src/client.ts](../../../packages/sdk/src/client.ts) — client-side orchestration polling
- [packages/sdk/src/orchestration.ts](../../../packages/sdk/src/orchestration.ts) — orchestration logic
- [packages/sdk/src/managed-session.ts](../../../packages/sdk/src/managed-session.ts) — LLM turn execution
- [packages/sdk/src/session-manager.ts](../../../packages/sdk/src/session-manager.ts) — session lifecycle and tool resolution

## TUI note

If the bug touches TUI keybindings or keyboard help text, verify that the startup keybinding hint/splash and the help dialog/modal are still synchronized with the actual bound keys.
