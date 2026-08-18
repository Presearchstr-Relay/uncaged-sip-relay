# Architecture

## Overview

```
                         ┌──────────────────────── Cloudflare ────────────────────────┐
                         │                                                            │
   Nostr client          │   Worker (src/relay-worker.ts)                              │
   (crawler/engine)      │    • HTTP routing, NIP-11, NIP-05, /api/*                   │
        │  wss           │    • event verification + SIP-01 validation                 │
        ▼                │    • D1 session management (bookmarks)                      │
   ┌───────────┐         │    • payment (zap receipt verification)                     │
   │  Durable  │◀────────┤    • static operator UI (assets binding)                    │
   │  Object   │ fetch   │                                                             │
   │  (region) │         │   Durable Object mesh (src/durable-object.ts)               │
   └───────────┘         │    • NIP-01 EVENT/REQ/CLOSE, NIP-42 AUTH                    │
        │  broadcast     │    • NIP-45 COUNT, NIP-50 search, NIP-77 NEG-*              │
        ▼  /do-broadcast │    • rate limits, query cache, hibernation                  │
   ┌───────────┐         │                                                             │
   │ other DOs │         │   D1 (SQLite)                                               │
   └───────────┘         │    • events + tags + tag caches (canonical store)           │
                         │    • sip01_documents / sip01_observations /                │
                         │      sip01_indexers (derived search index)                 │
                         │    • relay_metrics, paid_pubkeys, content_hashes           │
                         └─────────────────────────────────────────────────────────────┘
```

## Design principles

1. **The Nostr event store is canonical.** `sip01_*` tables are derived
   acceleration structures. If they ever drift, they can be rebuilt from
   `events` (see `scripts/reindex` note in docs/OPERATIONS.md).
2. **D1 is not the web.** D1 holds compact searchable metadata (titles,
   descriptions, URLs, tags, hashes) — never page bodies. A 10 GB D1
   database holds tens of millions of observations. Larger artifacts belong
   in R2/external storage in future revisions (the schema does not need to
   change for that).
3. **Provenance is never merged.** A document row aggregates; observation
   rows keep one row per live `(pubkey, d)` so "N independent indexers saw
   this page" is a `COUNT(DISTINCT pubkey)` away.
4. **One shared implementation.** `shared/` is plain ES modules imported by
   the Worker bundle, the browser UI, and the Node tests — the conformance
   suite tests the same bytes the relay runs.
5. **Payment is policy, not protocol.** SIP-01 is open. Pay-to-relay is an
   optional operator switch.

## Request flow

### Write path (kind 39697)

1. Client `EVENT` → DO `handleEvent`: field-shape checks → kind policy
   (`RELAY_MODE`) → NIP-42 → per-pubkey rate limit (kind 39697 gets the
   roomier indexer bucket) → Schnorr signature → payment gate →
   content/tag policy.
2. DO → `processEvent` (worker module): event-id hash check → `created_at`
   future limit → SIP-01 schema validation (`validateSip01Event`) →
   indexer policy → storage.
3. Storage (`saveEventToDatabase`): duplicate checks (worker cache + D1) →
   addressable replacement per `(pubkey, d)` (superseded observation row is
   removed and aggregates repaired) → insert event + tags → **SIP-01 ingest**:
   insert observation, upsert document (latest observation supplies
   descriptive fields), recompute `observation_count`/`indexer_count`/
   `first_seen`/`last_seen`, upsert indexer.
4. OK to the writer; event broadcast to matching subscriptions on every DO in
   the mesh; query caches invalidated by kind/author/tag.

### Read path (NIP-01 filter)

`REQ` → filter validation → complexity score → COUNT precheck for tag
queries → SQL via the multi-value tag cache → events sorted
`created_at DESC` → EOSE → live delivery via `matchesFilter` (which also
understands `search` for realtime updates).

### Search path (NIP-50)

`search` string → parser (`shared/search-query.js`) → document-level SQL
conditions + rank expression → optional `distinct:domain` grouping → join
through `sip01_observations` to the canonical `events` → rank-ordered
observation events. Other kinds in the same filter fall back to
case-insensitive content matching.

### Federation path (NIP-77)

`NEG-OPEN` loads the filter's `(created_at, id)` set from D1 into a sealed
negentropy vector (capped by `NEG_MAX_ITEMS`), then the DO runs the
Negentropy V1 server role against the initiator's messages. Sessions are
in-memory per DO and reclaimed on timeout (`NEG_SESSION_TIMEOUT_MS`) or
hibernation (client gets `NEG-ERR closed:` and re-opens).

## The DO mesh

Nine region-pinned Durable Objects (`relay-*-primary`) selected by the
visitor's geography (country → US state → continent hints). Every accepted
event is fanned out to the other eight DOs over `/do-broadcast`, so
subscribers on any region receive it in real time. Hibernation keeps idle
connections cheap.

## Module map

| Path | Role |
|---|---|
| `src/index.ts` | Worker entry (exports handler + DO class) |
| `worker.ts` | Root re-export for Shakespeare/Cloudflare builds |
| `src/relay-worker.ts` | HTTP routing, NIP-11/05, storage, queries, API, pruning |
| `src/durable-object.ts` | WebSocket protocol endpoint (all NIPs) |
| `src/config.ts` | All operator settings |
| `src/sip01/schema.ts` | SIP-01 D1 schema + migrations |
| `src/sip01/ingest.ts` | Observation/document/indexer maintenance |
| `src/sip01/search.ts` | NIP-50 execution (SIP-01 ranked + generic) |
| `src/sip01/api.ts` | Read queries for the JSON API |
| `src/pay.ts` | Zap receipt verification + paid-pubkey store |
| `src/bech32.ts` | npub → hex |
| `shared/sip01.js` | Canonical SIP-01 implementation |
| `shared/negentropy.js` | Negentropy V1 (NIP-77) |
| `shared/search-query.js` | NIP-50 operator parser/SQL/matcher |
| `shared/sha256.js` | Pure-JS SHA-256 (+ WebCrypto wrapper) |
| `shared/vectors.js` | SIP-01 §13/§19 test vectors |
| `shared/selftest.js` | Conformance suite |
| `ui/` | Operator UI (vanilla ES modules, no build step) |
