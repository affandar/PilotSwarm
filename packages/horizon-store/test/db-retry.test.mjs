import { test } from "vitest";
import assert from "node:assert/strict";

import { isTransientDbError } from "../dist/src/db-retry.js";

test("ECONNABORTED is classified as a transient connection setup failure", () => {
    assert.equal(isTransientDbError({ code: "ECONNABORTED", message: "connect ECONNABORTED 57.154.11.47:5432" }), true);
});

test("ordinary SQL errors are not transient", () => {
    assert.equal(isTransientDbError({ code: "23505", message: "duplicate key value violates unique constraint" }), false);
});
