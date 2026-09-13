import { writeFileSync } from "node:fs";

it("runs from the caller-owned suite", () => {
    expect(2 + 2).toBe(4);
    // Explicit execution evidence independent of reporter formatting/silence.
    if (process.env.EXTERNAL_CONSUMER_PROOF) writeFileSync(process.env.EXTERNAL_CONSUMER_PROOF, "consumer-smoke executed");
});
