import { z } from "zod";
import { registerCheckType, registerTool } from "pilotswarm-eval-harness";

registerTool({
  name: "incident_lookup",
  description: "Look up an incident by id.",
  schema: z.object({ id: z.string().min(1) }),
  handler: async (args) => ({ id: args.id, service: "checkout", severity: "sev2" })
});

registerCheckType("incident-owner-present", {
  schema: z.object({ type: z.literal("incident-owner-present") }),
  evaluate: ({ observed }) => ({
    pass: /owner/i.test(observed.finalResponse),
    message: "final response should mention an owner"
  })
});
