# Operations

## Capacity model

D1's practical ceiling is 10 GB. This relay stores **compact metadata**, not
web pages:

- one `events` row per live observation (~0.5–2 KB typical), plus tag rows;
- one `sip01_observations` row per live `(pubkey, d)` (~100 bytes);
- one `sip01_documents` row per distinct URL (~200–600 bytes).

A rough rule of thumb: **1 GB ≈ 1–2 million live observations** with tags and
indexes. The default 10 GB ceiling therefore holds on the order of **10–20M**
live observations. Because kind 39697 is addressable, recrawls replace old
rows — the index grows with the number of *distinct documents*, not with the
number of *crawls*.

When you outgrow that: run a specialized relay (scope domains/languages in
config), enable pruning of old unreferenced content, or run several relays —
federation keeps them consistent. The design goal is many medium relays, not
one giant one.

## Pruning

Daily cron (00:00 UTC): if the database exceeds `DB_SIZE_THRESHOLD_GB`
(9 GB), the oldest non-protected events are deleted in batches until
`DB_PRUNE_TARGET_GB` (8 GB). Protected by default: kinds `0`, `3`, `10002`,
and **`39697`** — in an index relay, addressable observations are the product;
deleting them by age silently shrinks the searchable index. Set
`SIP01_PRUNE_ALLOWED = true` if you prefer bounded freshness over
completeness.

The cron also runs `PRAGMA optimize` + `ANALYZE` for the query planner.

## Metrics

`relay_metrics` counters (surfaced via `/api/stats` and the dashboard):

| Key | Meaning |
|---|---|
| `events_accepted` | All stored events |
| `events_invalid` | Rejected at id/shape checks |
| `sip01_accepted` | Validated + indexed observations |
| `sip01_validation_failures` | Observations rejected by SIP-01 validation |
| `sip01_duplicates` | Duplicate observation submissions |
| `sip01_indexer_blocked` | Writes rejected by the indexer policy |
| `sip01_index_errors` | Index maintenance errors (event still stored) |
| `search_queries_ws` / `search_queries_http` | NIP-50 usage |
| `count_queries` | NIP-45 usage |
| `neg_sessions` | NIP-77 sync sessions opened |

## Monitoring

- `/api/health` — `{ status, events, mode, version, time }` — cheap liveness
  probe for uptime monitors.
- `/api/stats` — full statistics document (counts, top facets, metrics,
  database size).
- Cloudflare dashboard: Workers analytics, D1 size/reads/writes, DO request
  counts. Recommended alert: D1 size > 8 GB.

## Tuning

- Free Workers plan: lower `cpu_ms` to 10000 in wrangler.toml and keep
  `NEG_MAX_ITEMS` modest.
- Busy public relays: paid plan + 30000 ms CPU + D1 read replication ON.
- Crawler-heavy relays: raise `SIP01_INDEXER_RATE_LIMIT` if legitimate
  crawlers report `rate-limited:` OKs; lower it if abused.

## Rebuilding the SIP-01 tables

The derived tables are exactly that — derived. To rebuild them from the
canonical event store (e.g. after restoring a database copy):

```sql
DELETE FROM sip01_observations; DELETE FROM sip01_documents; DELETE FROM sip01_indexers;
```

then re-ingest every kind 39697 event (a small script paging `SELECT * FROM
events WHERE kind = 39697 ORDER BY created_at ASC` and calling
`ingestSip01Observation` is sufficient; see `scripts/` for utilities).

## Backups

D1 is replicated by Cloudflare; for point-in-time recovery enable D1 Time
Travel (paid) or periodically export:

```bash
npx wrangler d1 export sip01-relay --remote --output backup.sql
```

## Upgrading

Pull the new version, re-check `src/config.ts` diffs, `npx wrangler deploy`.
Schema migrations run idempotently on first request (`schema_version` in
`system_config`). Downgrading is safe as long as newer migrations are
additive (v7 is: it rebuilds the tag cache and adds columns).
