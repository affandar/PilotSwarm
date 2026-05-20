import { registerCheckType, registerTool } from "../../../src/index.js";

registerTool({
  name: "incident_lookup",
  description: "Example downstream incident lookup tool.",
  handler: ({ id }) => ({ id, severity: "sev2" })
});

registerCheckType("incident-owner-present", {
  evaluate: ({ observed }) => ({
    pass: /owner/i.test(observed.finalResponse),
    message: "final response should mention an owner"
  })
});
