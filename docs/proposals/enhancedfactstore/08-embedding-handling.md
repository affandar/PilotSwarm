# Embedding Handling

This note is the canonical EnhancedFactStore embedding-state design. It supersedes older proposal text that described `content_hash`, `last_embedded_hash`, `embedded_at`, `last_embed_error_at`, `embed_retry_at`, or `contentHash` crawl receipts.

## Minimal Facts State

The facts table keeps embedding and graph-crawl state intentionally small:

| Column | Owner | Meaning |
|---|---|---|
| `last_crawled_at` | Graph crawler | `NULL` means the fact is pending graph incorporation. Only graph-crawler paths modify it: the write trigger resets it on content change, and `facts_mark_crawled` stamps it. |
| `embedding` | Embedder | Stored vector. `NULL` means no current vector is available. |
| `embedding_model` | Embedder | Model/deployment that produced `embedding`. Rows with another model are pending for the configured model. |
| `last_embed_error` | Embedder | `NULL` = eligible/healthy, `-1` = internal single-row retry marker, `> 0` = terminal row failure. |
| `search_text` | Database | Generated lexical text: `key || E'\n' || value::text`. |

The final enhanced facts schema does not store content hashes or embedding timestamps. Content changes clear derived state instead of comparing hashes later.

## Content Updates

The facts write trigger watches `key` and `value`. When either changes, it resets derived state:

```sql
last_crawled_at = NULL,
embedding = NULL,
embedding_model = NULL,
last_embed_error = NULL
```

This is enough to requeue the fact for both graph crawling and embedding. Metadata-only writes should not reset derived state.

## Crawl Ownership

`last_crawled_at` is graph-crawler state only.

Allowed writers:

- The write trigger resets `last_crawled_at = NULL` on fact content changes.
- `facts_mark_crawled` stamps `last_crawled_at = now()` after the graph crawler incorporates the fact.

The embedder never reads or writes `last_crawled_at`. Embedding failures must not mark facts crawled. A graph harvester can decide whether and how to handle facts whose embedding failed, but that is crawler policy, not embedder policy.

The crawl API uses scope-key receipts only:

```ts
readUncrawledFacts(opts): Promise<{ count: number; facts: FactRecord[] }>
markFactsCrawled(stamps: { scopeKey: string }[]): Promise<{ marked: number; skipped: number }>
```

A skipped mark means the fact is already marked or no longer exists.

## Embedding State

A fact is eligible for normal batch embedding when:

```sql
last_embed_error IS NULL
AND (
  embedding IS NULL
  OR embedding_model IS DISTINCT FROM <configured model>
)
```

`last_embed_error` carries the complete non-vector state:

| Value | Meaning | Visibility |
|---|---|---|
| `NULL` | Healthy/eligible. If `embedding` is missing or model-mismatched, the batch loop may embed it. | Normal state. |
| `-1` | Internal retry marker after a failed batch. | Not shown as an operator failure. |
| `> 0` | Terminal single-row embedding failure. | Reported by `manage_embedder(action="failures")`. |

Terminal error codes:

| Code | Label |
|---:|---|
| `1001` | `input_too_large` |
| `1400` | `provider_bad_request` |
| `1401` | `provider_authentication_failed` |
| `1403` | `provider_authorization_failed` |
| `1429` | `provider_rate_limited` |
| `1500` | `provider_server_error` |
| `1901` | `provider_malformed_response` |
| `9999` | `unknown_embedding_error` |

Failure diagnostics filter on `last_embed_error > 0`; they must exclude the internal `-1` retry marker.

## Durable Embedder Shape

The embedder is two independent pg_durable loops:

1. **Batch loop**: embeds ordinary pending rows in array batches.
2. **Retry loop**: embeds rows marked `last_embed_error = -1` one row at a time.

They can run independently. The batch loop does not wait for or drain retry work; it simply ignores rows whose `last_embed_error` is non-null. The retry loop owns `-1` rows.

### Batch loop

```text
sleep(interval)
select rows where last_embed_error IS NULL and embedding is pending
if no rows: continue
if any selected input is DB-classified oversized (>8000 chars):
  mark selected still-current rows last_embed_error = -1
  continue
POST array embedding request
if response is valid and count matches selected ids:
  write embedding + embedding_model, clear last_embed_error
else:
  mark selected still-current rows last_embed_error = -1
```

### Retry loop

```text
sleep(interval)
select one row where last_embed_error = -1
if no rows: continue
if selected input is DB-classified oversized (>8000 chars):
  set last_embed_error = 1001
  continue
POST single-row embedding request
if response is valid:
  write embedding + embedding_model, clear last_embed_error
else:
  classify response and set last_embed_error = positive code
```

Both loops use `updated_at` only as an in-flight write guard:

```sql
WHERE f.id = selected.id
  AND f.updated_at IS NOT DISTINCT FROM selected.updated_at
```

`updated_at` is not an embedding-state column. It just prevents an old HTTP response from writing onto a row edited after selection.

## Search Text

Lexical search uses the same broad content source as embeddings:

```sql
coalesce(key, '') || E'\n' || coalesce(value::text, '')
```

This matches the public `store_fact` contract: `value` can be any JSON-serializable shape, not only objects with `name`, `description`, `text`, `body`, or `subject` fields.

## Model Rotation

Model rotation is handled by `embedding_model` only. A row whose `embedding_model` differs from the configured model is pending for the batch loop and invisible to semantic search for that model. No retry-model column is needed.

Changing vector dimension still requires a schema migration because the `vector(N)` column type changes.
