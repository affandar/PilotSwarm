---
name: add-tool
description: Add a new tool to the durable-copilot-runtime. Covers defining the tool with defineTool(), registering it on the worker (worker-level or per-session), referencing it from the client via toolNames, and adding an integration test.
---

# Add a New Tool

Tools are defined using `defineTool()` from `@github/copilot-sdk` and registered on the worker.

## Steps

1. **Define the tool** using `defineTool(name, { description, parameters, handler })`.
   - `name` must be a unique string identifier (snake_case).
   - `description` should clearly explain when the LLM should use it.
   - `parameters` uses JSON Schema format with `type: "object"`, `properties`, and `required`.
   - `handler` is an async function that receives the validated arguments and returns a result.

2. **Register on the worker** — two patterns:
   - **Worker-level** (recommended): Call `worker.registerTools([myTool])` before or after `worker.start()`. Clients reference it via `toolNames: ["my_tool"]`.
   - **Per-session**: Call `worker.setSessionConfig(sessionId, { tools: [myTool] })` after creating the session. Only works in same-process mode.

3. **Add a test** in `test/sdk.test.js`:
   - Create a test function following the existing pattern (e.g., `testToolCalling`).
   - Track whether the tool handler was called with a boolean flag.
   - Assert the LLM's response reflects the tool's output.
   - Add the test to the `tests` array at the bottom.

## Example

```typescript
import { defineTool } from "durable-copilot-runtime";

const myTool = defineTool("lookup_price", {
    description: "Look up the current price of a product by name",
    parameters: {
        type: "object",
        properties: {
            product: { type: "string", description: "Product name" },
        },
        required: ["product"],
    },
    handler: async ({ product }) => {
        const price = await fetchPrice(product);
        return { product, price };
    },
});

// Worker-level registration
worker.registerTools([myTool]);

// Client references by name
const session = await client.createSession({
    toolNames: ["lookup_price"],
    systemMessage: "You can look up product prices.",
});
```

## How tools flow to the Copilot SDK

```
worker.registerTools() → Map<string, Tool>
  ↓
SessionManager.getOrCreate() resolves toolNames → Tool[]
  ↓
ManagedSession.runTurn() merges user tools + system tools (wait, ask_user)
  ↓
copilotSession.registerTools(allTools)  ← Copilot SDK method
  ↓
copilotSession.send({ prompt })         ← LLM sees registered tools
```

## Key files
- [src/managed-session.ts](../../../src/managed-session.ts) — where tools are merged and registered on `CopilotSession`
- [src/session-manager.ts](../../../src/session-manager.ts) — where `toolNames` are resolved from the worker registry
- [src/worker.ts](../../../src/worker.ts) — where `registerTools()` stores tools in the registry
- [test/sdk.test.js](../../../test/sdk.test.js) — integration tests
