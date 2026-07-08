#!/usr/bin/env node
// Unit test — session_id validation accepts UUID-SHAPED ids, not just RFC4122.
//
// System sessions use deterministic ids whose version/variant nibbles are
// free (e.g. the waldemortchk agent-tuner id below: third group `a1a4`).
// z.string().uuid() rejected those, locking system sessions out of every
// session_id-taking MCP tool (get_session_events, get_session_detail, …).
import assert from "node:assert/strict";
import { SESSION_ID_SHAPE, sessionIdShape } from "../../dist/src/session-id.js";

const ACCEPT = [
    "a7f23cda-5cfd-4f0e-aff1-d6b0400b8da5", // RFC4122 v4 (regular session)
    "22013ffb-08cb-a1a4-de5b-3039b4fb7826", // system session (non-RFC version nibble)
    "1e41c4b3-f635-cfb8-15a2-9bea997c8ce4", // system session (repo-cache-manager)
    "00000000-0000-0000-0000-000000000000",
    "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", // case-insensitive hex
];
const REJECT = [
    "",
    "not-a-uuid",
    "a7f23cda5cfd4f0eaff1d6b0400b8da5",       // no dashes
    "a7f23cda-5cfd-4f0e-aff1-d6b0400b8da",    // short
    "a7f23cda-5cfd-4f0e-aff1-d6b0400b8da5x",  // trailing junk
    "g7f23cda-5cfd-4f0e-aff1-d6b0400b8da5",   // non-hex
    "a7f23cda-5cfd-4f0e-aff1-d6b0400b8da5 ",  // whitespace
];

for (const id of ACCEPT) {
    assert.equal(SESSION_ID_SHAPE.test(id), true, `pattern should accept ${id}`);
    assert.equal(sessionIdShape().safeParse(id).success, true, `schema should accept ${id}`);
}
for (const id of REJECT) {
    assert.equal(SESSION_ID_SHAPE.test(id), false, `pattern should reject ${JSON.stringify(id)}`);
    assert.equal(sessionIdShape().safeParse(id).success, false, `schema should reject ${JSON.stringify(id)}`);
}

console.log(`session-id.unit: ${ACCEPT.length} accepted, ${REJECT.length} rejected — OK`);
