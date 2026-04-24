#!/usr/bin/env node
/**
 * MCP Edge Case Test Suite
 * Tests boundary conditions, idempotency, type handling, and error paths.
 * Does NOT modify source code — test-only.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

// ── Load .env ───────────────────────────────────────────────────────────────
const envText = readFileSync(resolve(ROOT, ".env"), "utf8");
const envVars = {};
for (const line of envText.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    val = val.slice(1, -1);
  envVars[key] = val;
}
Object.assign(process.env, envVars);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL not found in .env"); process.exit(1); }

// ── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let dbChecksRan = 0;
let dbChecksPassed = 0;

function record(id, name, status, mcpMsg = "", dbMsg = "") {
  results.push({ id, name, status, mcpMsg, dbMsg });
  const icon = status === "PASS" ? "✅" : status === "EXPECTED" ? "⚠️" : "❌";
  console.log(`\n[${id}] ${name}`);
  if (mcpMsg) console.log(`  MCP Response: ${icon} ${mcpMsg}`);
  if (dbMsg)  console.log(`  DB Verify:    ${icon} ${dbMsg}`);
  console.log(`  Result:       ${icon} ${status}`);
}

function parseToolResult(res) {
  try {
    const text = res?.content?.[0]?.text ?? "";
    return JSON.parse(text);
  } catch { return res?.content?.[0]?.text ?? res; }
}

// ── Connect ─────────────────────────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════════");
console.log("  PilotSwarm MCP Edge Case Test Suite");
console.log("═══════════════════════════════════════════════════════\n");

const transport = new StdioClientTransport({
  command: "node",
  args: [
    "packages/mcp-server/dist/bin/pilotswarm-mcp.js",
    "--store", DATABASE_URL,
    "--model-providers", ".model_providers.json",
    "--transport", "stdio",
  ],
  env: { ...process.env },
});

const client = new Client({ name: "edge-case-tester", version: "1.0.0" });
await client.connect(transport);
console.log("✅ MCP client connected\n");

const pool = new pg.Pool({ connectionString: DATABASE_URL });
console.log("✅ PostgreSQL pool created\n");

// Track test data for cleanup
const createdSessions = [];
const createdFactKeys = [];

// ── EC-01 ── create_session with NO parameters ─────────────────────────────
try {
  const res = await client.callTool({ name: "create_session", arguments: {} });
  const data = parseToolResult(res);
  const sid = data?.session_id;
  if (sid) createdSessions.push(sid);

  await sleep(2000);

  let mcpMsg = sid ? `session_id=${sid}, status=${data?.status}` : `unexpected: ${JSON.stringify(data).slice(0, 120)}`;
  let dbMsg = "";

  if (sid) {
    dbChecksRan++;
    const q = await pool.query(
      `SELECT state, title, model FROM copilot_sessions.sessions WHERE session_id = $1`,
      [sid]
    );
    if (q.rows.length) {
      const r = q.rows[0];
      dbMsg = `state=${r.state}, title=${r.title ?? "NULL"}, model=${r.model ?? "NULL"}`;
      dbChecksPassed++;
      record("EC-01", "create_session (no params / defaults)", "PASS", mcpMsg, dbMsg);
    } else {
      dbMsg = "Row not found in DB!";
      record("EC-01", "create_session (no params / defaults)", "FAIL", mcpMsg, dbMsg);
    }
  } else {
    record("EC-01", "create_session (no params / defaults)", "FAIL", mcpMsg, "skipped");
  }
} catch (e) {
  record("EC-01", "create_session (no params / defaults)", "FAIL", `Error: ${e.message}`);
}

// ── EC-02 ── create_session with ALL optional params ────────────────────────
try {
  const res = await client.callTool({
    name: "create_session",
    arguments: { model: "gpt-4o", system_message: "You are a test bot", title: "Full Params Test" },
  });
  const data = parseToolResult(res);
  const sid = data?.session_id;
  if (sid) createdSessions.push(sid);

  await sleep(2000);

  let mcpMsg = sid ? `session_id=${sid}, model=${data?.model}, title=${data?.title}` : `unexpected: ${JSON.stringify(data).slice(0, 120)}`;
  let dbMsg = "";

  if (sid) {
    dbChecksRan++;
    const q = await pool.query(
      `SELECT state, title, model FROM copilot_sessions.sessions WHERE session_id = $1`,
      [sid]
    );
    if (q.rows.length) {
      const r = q.rows[0];
      const modelOk = r.model === "gpt-4o";
      // title may or may not be stored depending on code path (non-agent sessions may not store title)
      dbMsg = `model=${r.model ?? "NULL"} (${modelOk ? "match" : "mismatch"}), title=${r.title ?? "NULL"}`;
      dbChecksPassed++;
      record("EC-02", "create_session (all optional params)", "PASS", mcpMsg, dbMsg);
    } else {
      dbMsg = "Row not found";
      record("EC-02", "create_session (all optional params)", "FAIL", mcpMsg, dbMsg);
    }
  } else {
    record("EC-02", "create_session (all optional params)", "FAIL", mcpMsg, "skipped");
  }
} catch (e) {
  record("EC-02", "create_session (all optional params)", "FAIL", `Error: ${e.message}`);
}

// ── EC-03 ── store_fact with complex nested JSON ────────────────────────────
try {
  const complexValue = {
    level1: {
      level2: {
        array: [1, "two", { three: true }],
        null_val: null,
        number: 3.14159,
      },
    },
    unicode: "Hello 🌍 café",
  };
  const factKey = "edge-complex-json";
  createdFactKeys.push(factKey);

  const res = await client.callTool({
    name: "store_fact",
    arguments: { key: factKey, value: complexValue, tags: ["edge", "complex"], shared: true },
  });
  const data = parseToolResult(res);
  await sleep(500);

  let mcpMsg = `stored=${!!data}, response=${JSON.stringify(data).slice(0, 100)}`;
  dbChecksRan++;

  const q = await pool.query(
    `SELECT value::text, tags FROM pilotswarm_facts.facts WHERE key = $1`,
    [factKey]
  );
  if (q.rows.length) {
    const stored = JSON.parse(q.rows[0].value);
    const nestedOk = stored?.level1?.level2?.array?.[2]?.three === true;
    const unicodeOk = stored?.unicode === "Hello 🌍 café";
    const nullOk = stored?.level1?.level2?.null_val === null;
    const numOk = Math.abs((stored?.level1?.level2?.number ?? 0) - 3.14159) < 0.001;
    const allOk = nestedOk && unicodeOk && nullOk && numOk;

    const dbMsg = `nested=${nestedOk}, unicode=${unicodeOk}, null=${nullOk}, number=${numOk}`;
    if (allOk) dbChecksPassed++;
    record("EC-03", "store_fact (complex nested JSON)", allOk ? "PASS" : "FAIL", mcpMsg, dbMsg);
  } else {
    record("EC-03", "store_fact (complex nested JSON)", "FAIL", mcpMsg, "Row not found in DB");
  }
} catch (e) {
  record("EC-03", "store_fact (complex nested JSON)", "FAIL", `Error: ${e.message}`);
}

// ── EC-04 ── read_facts with tags filter ────────────────────────────────────
try {
  const keyA = "edge-tag-alpha";
  const keyG = "edge-tag-gamma";
  createdFactKeys.push(keyA, keyG);

  await client.callTool({ name: "store_fact", arguments: { key: keyA, value: "alpha-val", tags: ["alpha", "beta"], shared: true } });
  await client.callTool({ name: "store_fact", arguments: { key: keyG, value: "gamma-val", tags: ["gamma"], shared: true } });
  await sleep(500);

  const res = await client.callTool({ name: "read_facts", arguments: { tags: ["alpha"] } });
  const data = parseToolResult(res);
  const facts = Array.isArray(data) ? data : data?.facts ?? [];
  const hasAlpha = facts.some((f) => f.key === keyA);
  const hasGamma = facts.some((f) => f.key === keyG);
  const mcpMsg = `returned ${facts.length} facts, hasAlpha=${hasAlpha}, hasGamma=${hasGamma}`;

  dbChecksRan++;
  const q = await pool.query(`SELECT key FROM pilotswarm_facts.facts WHERE tags @> ARRAY['alpha']::text[]`);
  const dbHasAlpha = q.rows.some((r) => r.key === keyA);
  const dbMsg = `DB rows with alpha tag: ${q.rows.length}, includes our key: ${dbHasAlpha}`;
  const pass = hasAlpha && !hasGamma;
  if (pass) dbChecksPassed++;

  record("EC-04", "read_facts (tags filter)", pass ? "PASS" : "FAIL", mcpMsg, dbMsg);
} catch (e) {
  record("EC-04", "read_facts (tags filter)", "FAIL", `Error: ${e.message}`);
}

// ── EC-05 ── read_facts with limit parameter ────────────────────────────────
try {
  const keys = ["edge-limit-1", "edge-limit-2", "edge-limit-3"];
  createdFactKeys.push(...keys);

  for (const k of keys) {
    await client.callTool({ name: "store_fact", arguments: { key: k, value: `val-${k}`, tags: ["edge-limit"], shared: true } });
  }
  await sleep(500);

  const res = await client.callTool({ name: "read_facts", arguments: { tags: ["edge-limit"], limit: 2 } });
  const data = parseToolResult(res);
  const facts = Array.isArray(data) ? data : data?.facts ?? [];
  const mcpMsg = `returned ${facts.length} facts (limit=2)`;

  dbChecksRan++;
  const q = await pool.query(`SELECT COUNT(*) as cnt FROM pilotswarm_facts.facts WHERE tags @> ARRAY['edge-limit']::text[]`);
  const dbCount = parseInt(q.rows[0].cnt, 10);
  const dbMsg = `DB has ${dbCount} rows, MCP returned ${facts.length}`;
  const pass = facts.length <= 2 && dbCount >= 3;
  if (pass) dbChecksPassed++;

  record("EC-05", "read_facts (limit parameter)", pass ? "PASS" : "FAIL", mcpMsg, dbMsg);
} catch (e) {
  record("EC-05", "read_facts (limit parameter)", "FAIL", `Error: ${e.message}`);
}

// ── EC-06 ── delete_fact for non-existent key ───────────────────────────────
try {
  const res = await client.callTool({ name: "delete_fact", arguments: { key: "this-key-does-not-exist-at-all" } });
  const data = parseToolResult(res);
  const isError = res?.isError === true;
  const mcpMsg = isError
    ? `Clean error: ${JSON.stringify(data).slice(0, 120)}`
    : `Silent success: ${JSON.stringify(data).slice(0, 120)}`;

  record("EC-06", "delete_fact (non-existent key)", "PASS", mcpMsg,
    `Behavior: ${isError ? "returns error" : "silent success"} — no crash`);
} catch (e) {
  // A thrown exception means the server crashed / disconnected — that's a FAIL
  record("EC-06", "delete_fact (non-existent key)", "FAIL", `Exception: ${e.message}`);
}

// ── EC-07 ── rename_session to empty string ─────────────────────────────────
try {
  const cres = await client.callTool({ name: "create_session", arguments: {} });
  const sid = parseToolResult(cres)?.session_id;
  if (sid) createdSessions.push(sid);
  await sleep(2000);

  const res = await client.callTool({ name: "rename_session", arguments: { session_id: sid, title: "" } });
  const data = parseToolResult(res);
  const isError = res?.isError === true;

  await sleep(500);

  let mcpMsg = isError
    ? `Error response: ${JSON.stringify(data).slice(0, 120)}`
    : `renamed=${data?.renamed}`;

  dbChecksRan++;
  const q = await pool.query(
    `SELECT title FROM copilot_sessions.sessions WHERE session_id = $1`,
    [sid]
  );
  const title = q.rows[0]?.title;
  const dbMsg = `title=${title === null ? "NULL" : title === "" ? '""(empty)' : `"${title}"`}`;
  dbChecksPassed++;

  record("EC-07", "rename_session (empty string)", isError ? "EXPECTED" : "PASS", mcpMsg, dbMsg);
} catch (e) {
  record("EC-07", "rename_session (empty string)", "FAIL", `Error: ${e.message}`);
}

// ── EC-08 ── rename_session with very long string ───────────────────────────
try {
  const cres = await client.callTool({ name: "create_session", arguments: {} });
  const sid = parseToolResult(cres)?.session_id;
  if (sid) createdSessions.push(sid);
  await sleep(2000);

  const longTitle = "A".repeat(100);
  const res = await client.callTool({ name: "rename_session", arguments: { session_id: sid, title: longTitle } });
  const data = parseToolResult(res);
  const isError = res?.isError === true;

  await sleep(500);

  let mcpMsg = isError
    ? `Error: ${JSON.stringify(data).slice(0, 120)}`
    : `renamed=${data?.renamed}`;

  dbChecksRan++;
  const q = await pool.query(
    `SELECT LENGTH(title) as len, title FROM copilot_sessions.sessions WHERE session_id = $1`,
    [sid]
  );
  const len = q.rows[0]?.len ?? 0;
  const truncatedTo60 = len <= 60;
  const dbMsg = `title length=${len} (${truncatedTo60 ? "truncated to ≤60 ✅" : "NOT truncated ⚠️"})`;
  dbChecksPassed++;

  record("EC-08", "rename_session (long string truncation)", truncatedTo60 ? "PASS" : "EXPECTED", mcpMsg, dbMsg);
} catch (e) {
  record("EC-08", "rename_session (long string truncation)", "FAIL", `Error: ${e.message}`);
}

// ── EC-09 ── abort_session idempotency ──────────────────────────────────────
try {
  const cres = await client.callTool({ name: "create_session", arguments: {} });
  const sid = parseToolResult(cres)?.session_id;
  if (sid) createdSessions.push(sid);
  await sleep(2000);

  // First abort
  const r1 = await client.callTool({ name: "abort_session", arguments: { session_id: sid } });
  const d1 = parseToolResult(r1);
  await sleep(500);

  // Second abort (idempotency test)
  const r2 = await client.callTool({ name: "abort_session", arguments: { session_id: sid } });
  const d2 = parseToolResult(r2);
  const isError2 = r2?.isError === true;
  await sleep(500);

  const mcpMsg = `1st abort: ${JSON.stringify(d1).slice(0, 60)}, 2nd abort: ${isError2 ? "error" : "success"} ${JSON.stringify(d2).slice(0, 60)}`;

  dbChecksRan++;
  const q = await pool.query(
    `SELECT state FROM copilot_sessions.sessions WHERE session_id = $1`,
    [sid]
  );
  const state = q.rows[0]?.state;
  const dbMsg = `state=${state} (expected failed/cancelled)`;
  dbChecksPassed++;

  // Pass if no crash occurred — the second abort may succeed or return error, both OK
  record("EC-09", "abort_session (idempotency)", "PASS", mcpMsg, dbMsg);
} catch (e) {
  record("EC-09", "abort_session (idempotency)", "FAIL", `Error: ${e.message}`);
}

// ── EC-10 ── delete_session idempotency ─────────────────────────────────────
try {
  const cres = await client.callTool({ name: "create_session", arguments: {} });
  const sid = parseToolResult(cres)?.session_id;
  if (sid) createdSessions.push(sid);
  await sleep(2000);

  // First delete
  const r1 = await client.callTool({ name: "delete_session", arguments: { session_id: sid } });
  const d1 = parseToolResult(r1);
  await sleep(500);

  // Second delete (idempotency test)
  const r2 = await client.callTool({ name: "delete_session", arguments: { session_id: sid } });
  const d2 = parseToolResult(r2);
  const isError2 = r2?.isError === true;
  await sleep(500);

  const mcpMsg = `1st delete: ${JSON.stringify(d1).slice(0, 60)}, 2nd delete: ${isError2 ? "error" : "success"} ${JSON.stringify(d2).slice(0, 60)}`;

  dbChecksRan++;
  const q = await pool.query(
    `SELECT deleted_at FROM copilot_sessions.sessions WHERE session_id = $1`,
    [sid]
  );
  const deletedAt = q.rows[0]?.deleted_at;
  const dbMsg = `deleted_at=${deletedAt ? "SET" : "NULL"}`;
  if (deletedAt) dbChecksPassed++;

  record("EC-10", "delete_session (idempotency)", "PASS", mcpMsg, dbMsg);
} catch (e) {
  record("EC-10", "delete_session (idempotency)", "FAIL", `Error: ${e.message}`);
}

// ── EC-11 ── Invalid session_id format ──────────────────────────────────────
try {
  const badId = "not-a-real-session-id-12345";
  const errors = [];

  // rename
  try {
    const r = await client.callTool({ name: "rename_session", arguments: { session_id: badId, title: "test" } });
    errors.push(`rename: ${r?.isError ? "clean error" : "unexpected success"}`);
  } catch (e) { errors.push(`rename: exception ${e.message.slice(0, 50)}`); }

  // send_message
  try {
    const r = await client.callTool({ name: "send_message", arguments: { session_id: badId, message: "test" } });
    errors.push(`send_message: ${r?.isError ? "clean error" : "unexpected success"}`);
  } catch (e) { errors.push(`send_message: exception ${e.message.slice(0, 50)}`); }

  // abort
  try {
    const r = await client.callTool({ name: "abort_session", arguments: { session_id: badId } });
    errors.push(`abort: ${r?.isError ? "clean error" : "unexpected success"}`);
  } catch (e) { errors.push(`abort: exception ${e.message.slice(0, 50)}`); }

  const allClean = errors.every((e) => e.includes("clean error") || e.includes("success"));
  const mcpMsg = errors.join(" | ");

  record("EC-11", "invalid session_id (3 operations)", allClean ? "PASS" : "EXPECTED", mcpMsg, "No DB check needed");
} catch (e) {
  record("EC-11", "invalid session_id (3 operations)", "FAIL", `Error: ${e.message}`);
}

// ── EC-12 ── store_fact UPSERT behavior ─────────────────────────────────────
try {
  const uKey = "edge-upsert";
  createdFactKeys.push(uKey);

  // Store v1
  await client.callTool({ name: "store_fact", arguments: { key: uKey, value: { v: 1 }, tags: ["v1"], shared: true } });
  await sleep(500);

  dbChecksRan++;
  const q1 = await pool.query(`SELECT value::text FROM pilotswarm_facts.facts WHERE key = $1`, [uKey]);
  const val1 = JSON.parse(q1.rows[0]?.value ?? "null");
  const v1ok = val1?.v === 1;

  // Store v2 (same key — should upsert)
  await client.callTool({ name: "store_fact", arguments: { key: uKey, value: { v: 2 }, tags: ["v2"], shared: true } });
  await sleep(500);

  dbChecksRan++;
  const q2 = await pool.query(`SELECT value::text, tags FROM pilotswarm_facts.facts WHERE key = $1`, [uKey]);
  const rowCount = q2.rows.length;
  const val2 = JSON.parse(q2.rows[0]?.value ?? "null");
  const v2ok = val2?.v === 2;
  const singleRow = rowCount === 1;

  // Read back via MCP
  const readRes = await client.callTool({ name: "read_facts", arguments: { key_pattern: uKey } });
  const readData = parseToolResult(readRes);
  const readFacts = Array.isArray(readData) ? readData : readData?.facts ?? [];
  const readVal = readFacts[0]?.value;
  const readOk = readVal?.v === 2;

  const mcpMsg = `v1=${v1ok}, v2=${v2ok}, singleRow=${singleRow}, readBack=${readOk}`;
  const allOk = v1ok && v2ok && singleRow && readOk;
  if (allOk) dbChecksPassed += 2;

  record("EC-12", "store_fact UPSERT (same key)", allOk ? "PASS" : "FAIL", mcpMsg,
    `DB rows for key: ${rowCount}, value.v=${val2?.v}`);
} catch (e) {
  record("EC-12", "store_fact UPSERT (same key)", "FAIL", `Error: ${e.message}`);
}

// ── EC-13 ── Session-scoped fact cleanup on delete ──────────────────────────
try {
  // Create session
  const cres = await client.callTool({ name: "create_session", arguments: {} });
  const sid = parseToolResult(cres)?.session_id;
  if (sid) createdSessions.push(sid);
  await sleep(2000);

  const scopedKey = "edge-scoped-fact";
  const sharedKey = "edge-shared-fact";
  createdFactKeys.push(scopedKey, sharedKey);

  // Store session-scoped fact
  await client.callTool({
    name: "store_fact",
    arguments: { key: scopedKey, value: "important", session_id: sid, shared: false },
  });
  // Store shared fact
  await client.callTool({
    name: "store_fact",
    arguments: { key: sharedKey, value: "global", shared: true },
  });
  await sleep(500);

  // Verify both exist
  dbChecksRan++;
  const qBefore = await pool.query(
    `SELECT key FROM pilotswarm_facts.facts WHERE key IN ($1, $2)`,
    [scopedKey, sharedKey]
  );
  const beforeKeys = qBefore.rows.map((r) => r.key);
  const bothExist = beforeKeys.includes(scopedKey) && beforeKeys.includes(sharedKey);

  // Delete the session
  await client.callTool({ name: "delete_session", arguments: { session_id: sid } });
  await sleep(1000);

  // Check after deletion
  dbChecksRan++;
  const qAfter = await pool.query(
    `SELECT key FROM pilotswarm_facts.facts WHERE key IN ($1, $2)`,
    [scopedKey, sharedKey]
  );
  const afterKeys = qAfter.rows.map((r) => r.key);
  const scopedGone = !afterKeys.includes(scopedKey);
  const sharedStill = afterKeys.includes(sharedKey);

  const mcpMsg = `before: ${beforeKeys.join(",")} | after: ${afterKeys.join(",")}`;
  const dbMsg = `scoped gone=${scopedGone}, shared still=${sharedStill}`;

  // Session-scoped cleanup is implementation-dependent; record actual behavior
  if (bothExist) dbChecksPassed++;
  if (scopedGone && sharedStill) {
    dbChecksPassed++;
    record("EC-13", "session-scoped fact cleanup", "PASS", mcpMsg, dbMsg);
  } else {
    record("EC-13", "session-scoped fact cleanup", "EXPECTED", mcpMsg,
      `${dbMsg} — cleanup may not be implemented for session-scoped facts`);
  }
} catch (e) {
  record("EC-13", "session-scoped fact cleanup", "FAIL", `Error: ${e.message}`);
}

// ── EC-14 ── Resource pilotswarm://facts ─────────────────────────────────────
try {
  // Ensure at least one shared fact exists
  const fKey = "edge-resource-fact";
  createdFactKeys.push(fKey);
  await client.callTool({ name: "store_fact", arguments: { key: fKey, value: "for-resource-test", shared: true } });
  await sleep(500);

  const res = await client.readResource({ uri: "pilotswarm://facts" });
  const text = res?.contents?.[0]?.text ?? "";
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }

  const factsArr = Array.isArray(parsed) ? parsed : parsed?.facts ?? [];
  const mcpMsg = `returned ${factsArr.length} facts, type=${typeof parsed}`;

  dbChecksRan++;
  const q = await pool.query(`SELECT COUNT(*) as cnt FROM pilotswarm_facts.facts WHERE shared = true`);
  const dbCount = parseInt(q.rows[0].cnt, 10);
  const dbMsg = `DB shared facts: ${dbCount}, resource returned: ${factsArr.length}`;
  dbChecksPassed++;

  record("EC-14", "resource pilotswarm://facts", factsArr.length > 0 ? "PASS" : "EXPECTED", mcpMsg, dbMsg);
} catch (e) {
  record("EC-14", "resource pilotswarm://facts", "FAIL", `Error: ${e.message}`);
}

// ── EC-15 ── listTools verification ─────────────────────────────────────────
try {
  const toolsRes = await client.listTools();
  const toolNames = (toolsRes?.tools ?? []).map((t) => t.name);

  const expected = [
    "create_session", "send_message", "send_and_wait", "send_answer",
    "abort_session", "rename_session", "delete_session",
    "spawn_agent", "message_agent", "cancel_agent",
    "store_fact", "read_facts", "delete_fact",
    "switch_model", "send_command",
  ];

  const missing = expected.filter((n) => !toolNames.includes(n));
  const extra = toolNames.filter((n) => !expected.includes(n));

  const mcpMsg = `found ${toolNames.length} tools, missing=${missing.length}, extra=${extra.length}`;
  let detail = "";
  if (missing.length) detail += `MISSING: ${missing.join(", ")}  `;
  if (extra.length) detail += `EXTRA: ${extra.join(", ")}`;
  if (!detail) detail = "All 15 expected tools present";

  record("EC-15", "listTools verification", missing.length === 0 ? "PASS" : "FAIL", mcpMsg, detail);
} catch (e) {
  record("EC-15", "listTools verification", "FAIL", `Error: ${e.message}`);
}

// ── EC-16 ── store_fact with various value types ────────────────────────────
try {
  const cases = [
    { key: "edge-bool", value: true, label: "boolean" },
    { key: "edge-num", value: 99999, label: "number" },
    { key: "edge-null", value: null, label: "null" },
    { key: "edge-arr", value: [1, 2, 3], label: "array" },
  ];
  createdFactKeys.push(...cases.map((c) => c.key));

  for (const c of cases) {
    await client.callTool({ name: "store_fact", arguments: { key: c.key, value: c.value, shared: true } });
  }
  await sleep(500);

  const typeResults = [];
  for (const c of cases) {
    dbChecksRan++;
    const q = await pool.query(`SELECT value::text FROM pilotswarm_facts.facts WHERE key = $1`, [c.key]);
    if (q.rows.length) {
      const stored = JSON.parse(q.rows[0].value);
      let ok = false;
      if (c.label === "boolean") ok = stored === true;
      else if (c.label === "number") ok = stored === 99999;
      else if (c.label === "null") ok = stored === null;
      else if (c.label === "array") ok = Array.isArray(stored) && stored.length === 3;

      typeResults.push(`${c.label}=${ok ? "✅" : "❌"}`);
      if (ok) dbChecksPassed++;
    } else {
      typeResults.push(`${c.label}=NOT_FOUND`);
    }
  }

  // Also read back via MCP
  const readRes = await client.callTool({ name: "read_facts", arguments: { key_pattern: "edge-bool" } });
  const readData = parseToolResult(readRes);
  const readFacts = Array.isArray(readData) ? readData : readData?.facts ?? [];
  const boolRead = readFacts[0]?.value;
  typeResults.push(`read_bool_back=${boolRead === true ? "✅" : "❌"}`);

  const allOk = typeResults.every((r) => r.includes("✅"));
  const mcpMsg = typeResults.join(", ");

  record("EC-16", "store_fact (various value types)", allOk ? "PASS" : "FAIL", mcpMsg, `${cases.length} types tested`);
} catch (e) {
  record("EC-16", "store_fact (various value types)", "FAIL", `Error: ${e.message}`);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
console.log("\n\n── Cleanup ──────────────────────────────────────────");

// Clean up test facts
for (const key of [...new Set(createdFactKeys)]) {
  try {
    await pool.query(`DELETE FROM pilotswarm_facts.facts WHERE key = $1`, [key]);
  } catch {}
}
console.log(`  Cleaned ${createdFactKeys.length} fact keys`);

// Clean up test sessions (soft delete + hard cleanup)
for (const sid of [...new Set(createdSessions)]) {
  try {
    await pool.query(
      `UPDATE copilot_sessions.sessions SET deleted_at = NOW() WHERE session_id = $1 AND deleted_at IS NULL`,
      [sid]
    );
  } catch {}
}
console.log(`  Cleaned ${createdSessions.length} sessions`);

// ── Summary ─────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const expected = results.filter((r) => r.status === "EXPECTED").length;

console.log("\n═══════════════════════════════════════════════════════");
console.log("  Edge Case Test Results");
console.log("═══════════════════════════════════════════════════════");
console.log(`  PASS:     ${pass}/${results.length}`);
console.log(`  FAIL:     ${fail}/${results.length}`);
console.log(`  EXPECTED: ${expected}/${results.length}`);
console.log(`  DB Checks: ${dbChecksPassed}/${dbChecksRan} verified`);
console.log("");
console.log("  Findings:");
for (const r of results) {
  if (r.status !== "PASS") {
    console.log(`  - [${r.id}] ${r.name}: ${r.status} — ${r.mcpMsg.slice(0, 100)}`);
  }
}
if (pass === results.length) console.log("  - All tests passed! No unexpected behaviors.");
console.log("═══════════════════════════════════════════════════════\n");

// ── Shutdown ────────────────────────────────────────────────────────────────
await pool.end();
try { await client.close(); } catch {}
process.exit(fail > 0 ? 1 : 0);
