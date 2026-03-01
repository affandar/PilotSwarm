---
name: add-activity
description: Add a new duroxide activity to the runtime. Activities are the durable boundary between the orchestration and session management — they dispatch to ManagedSession or SessionManager methods.
---

# Add a New Activity

Activities are the durable boundary between the orchestration generator and the session layer. They must only accept and return serializable data.

## Steps

1. **Define the activity function** in `src/session-proxy.ts` inside `registerActivities()`:
   ```typescript
   runtime.registerActivity("myActivity", async (ctx: any, input: any) => {
       const { sessionId, ...args } = input;
       const session = await sessionManager.getOrCreate(sessionId, args.config);
       const result = await session.myMethod(args);
       return result;
   });
   ```

2. **Create a proxy function** in `createSessionProxy()` (session-scoped) or `createSessionManagerProxy()` (manager-scoped):
   ```typescript
   myActivity: (args: any) => {
       return ctx.scheduleActivityOnSession(
           "myActivity",
           { sessionId, ...args },
           affinityKey,
       );
   }
   ```

3. **Call it from the orchestration** in `src/orchestration.ts`:
   ```typescript
   const result = yield session.myActivity(args);
   ```

4. **Add tests** in `test/sdk.test.js`.

## Key constraints

- Activities must only accept and return **serializable** data (no functions, no class instances).
- Activity functions should be thin — delegate business logic to `ManagedSession` or `SessionManager`.
- Use `ctx.scheduleActivityOnSession()` (not `ctx.scheduleActivity()`) to maintain session affinity.
- The `affinityKey` ensures the activity runs on the same worker that holds the in-memory session.

## Key files
- [src/session-proxy.ts](../../../src/session-proxy.ts) — activity definitions and proxy factories
- [src/orchestration.ts](../../../src/orchestration.ts) — orchestration generator function
- [src/types.ts](../../../src/types.ts) — type definitions for activity inputs/outputs
