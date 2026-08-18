# Troubleshooting

## "blocked: event kind X not allowed on this relay"

You are in `sip01` mode (default): only kind 39697 (+5, +9735) are stored.
Switch `RELAY_MODE` to `'hybrid'` in `src/config.ts` for a general relay with
SIP-01 indexing.

## Crawler gets `invalid: …` OKs

The message tells you exactly what failed. Common causes:

- `d tag does not match the normalized u tag` — the crawler is not
  normalizing per SIP-01 §7 (tracker params, www, trailing slash, query
  sort). Use the ecosystem libraries (`buildIndexEvent` in Crawlstr) or the
  `/explorer` calculator on the relay UI to compare.
- `x tag does not match sha256(title + \n + description)` — hash computed
  over truncated/different strings, or JSON field order confusion (hash the
  raw strings, not the JSON).
- `unsupported web document schema version` — only `v = "1"` exists.
- `title must be 1-300 characters` — empty or oversized title.

The relay UI's `/explorer` page validates any event client-side with the
same code the relay runs.

## `NEG-ERR blocked: this query is too big`

The sync filter matches more than `NEG_MAX_ITEMS` (default 100k) events.
Narrow with `since`/`until` windows or raise the limit in config.

## `NEG-ERR closed: no such NEG session`

The Durable Object hibernated or the session idled out (>10 min). Re-open
with `NEG-OPEN`; sync is stateless-safe to restart.

## Search returns nothing

- Is there data? Check `/api/stats` (or the dashboard).
- Operator values are exact (`lang:en`, not `lang:EN`; `mime:` is
  lowercase). `site:`/`domain:` normalize hosts for you; `topic:` is
  lowercase.
- `domain:` is exact host; use `site:` for host-or-subdomain.
- Search only covers kind 39697 in `sip01` mode.

## Dashboard shows zeros right after deploy

Nothing is indexed yet — publish your first observation (Crawlstr), then
reload. The first HTTP hit initializes the schema automatically.

## WebSocket connects but REQ gets `CLOSED auth-required:`

`AUTH_REQUIRED` is on. Authenticate with NIP-42 (kind 22242 signed with the
issued challenge), or disable it.

## `rate-limited: slow down there chief`

Per-connection buckets: 10 writes/min (general) or 120/min for kind 39697,
50 REQs/min. Crawlers publishing faster should batch/connect with backoff or
ask the operator to raise `SIP01_INDEXER_RATE_LIMIT`.

## D1 "database is locked" / slow queries under load

Enable D1 read replication (D1 → Settings) — the relay uses the Session API
and falls back cleanly if replication is off. Check the Cloudflare status
page for D1 incidents.

## Payment not recognized after zapping

The relay records payment from the **zap receipt** (kind 9735) — a zap from a
wallet that doesn't produce receipts (or to the wrong npub) cannot be
verified. Check the operator npub in `/api/relay-info`, and that the receipt
reached the relay (`POST /?notify-zap`). Donation mode never gates access.

## The landing page is minimal (no dashboard)

You deployed by pasting `worker.js` into the dashboard — that path has no
static assets binding. Redeploy with wrangler or git (docs/DEPLOYMENT.md)
for the full operator UI.
