# UPSTREAM — Nosflare lineage

UNCAGED SIP Relay is a fork of **[Nosflare](https://github.com/Spl0itable/nosflare)**
(MIT license, © Spl0itable). Upstream state at fork time: `main` branch,
version **7.9.45**. The MIT license text is preserved in [LICENSE](LICENSE).

This document records exactly what was inherited, what was modified, and what
was added — so upstream improvements can be ported across, and so nobody
mistakes inherited code for original work (or vice versa).

## Inherited (kept substantially intact)

- **Worker ↔ Durable Object topology.** The Worker routes WebSocket upgrades
  to a multi-regional Durable Object mesh (9 endpoints with location hints);
  DOs hold sessions and broadcast new events to each other over
  `/do-broadcast`.
- **WebSocket Hibernation API** session model: minimal serialized
  attachments, session rehydration from storage, subscription persistence in
  DO storage, idle alarms for eviction.
- **D1 event store layout**: `events` table with first-value tag columns,
  generic `tags` table, `event_tags_cache_multi` multi-value cache,
  `paid_pubkeys`, `content_hashes`, `system_config`.
- **NIP-01 filter → SQL compiler** (`buildQuery`/`buildCountQuery`), chunked
  query execution for oversized filter arrays, query complexity scoring, and
  the COUNT precheck that rejects runaway tag queries.
- **Query result caching** with kind/author/tag invalidation indexes and the
  Cloudflare global cache tier.
- **D1 Session API** (`withSession`, bookmarks) for global read replication
  with read-after-write consistency.
- **Rate limiting** (token bucket), pubkey/kind/tag allow & block lists,
  blocked-content phrases, optional NIP-05 anti-spam gate, anti-spam content
  hashing.
- **NIP-42 authentication** flow with hibernation-safe challenge persistence.
- **NIP-05 endpoint** (`/.well-known/nostr.json`).
- **Replaceable + addressable event semantics** (NIP-16/NIP-33 folded into
  NIP-01), kind-5 deletions, ephemeral kinds.
- **Scheduled maintenance**: size-based pruning, `PRAGMA optimize`, ANALYZE.
- **Pay-to-relay concept**: operator npub + sat price + zap button UX
  (`nostr-zap.js`).

## Modified

- **`src/config.ts`** — reorganized around relay modes
  (`general`/`hybrid`/`sip01`), SIP-01 settings, payment **modes**
  (free/donation/pay-to-relay), NIP-45/50/77 toggles, indexer policy.
- **Event ingestion** — addressable replacement now also repairs the derived
  SIP-01 tables; deletion supports `a` (address) tags per NIP-09; event id is
  verified against its serialized hash; far-future `created_at` rejected per
  NIP-01; field-shape checks before crypto.
- **`event_tags_cache_multi`** — the tag CHECK constraint was replaced so the
  SIP-01 filterable single-letter tags `l` and `x` are cached too
  (schema v7 migration rebuilds the table; new first-value columns
  `tag_l`/`tag_x` on `events`).
- **Payment endpoint** — `POST /?notify-zap` now requires a **valid kind 9735
  zap receipt** (signature + recipient + amount + invoice freshness verified)
  instead of marking any caller-supplied `?npub=` paid. This closes an
  upstream authorization hole. See docs/SECURITY.md.
- **NIP-05 validation path** — no longer falls back to opening an outbound
  WebSocket to `wss://relay.primal.net`; it queries the local store only
  (outbound connections from the relay are an SSRF-shaped surface; the
  feature is off by default either way).
- **Landing page** — upstream's single inline HTML page became the full
  operator UI (static assets binding), with `src/mini-landing.ts` as the
  no-assets fallback.
- **NIP-11 document** — `supported_nips` is computed from what is actually
  enabled, `Accept` header matching uses `includes`, and the SIP-01
  `uncaged_index` block is added (SIP-01 §15).

## Added (new in this fork)

- **`shared/sip01.js`** — byte-compatible SIP-01 v1 implementation (§7
  normalization, `d`/`x` identities, relay-profile validator), shared
  verbatim between Worker, browser UI, and Node tests.
- **`shared/negentropy.js`** — Negentropy Protocol V1 (NIP-77), dependency-free
  port aligned with the UNCAGED-Index-Relay Node implementation.
- **`shared/search-query.js`** — NIP-50 SIP-01 operator parser, in-memory
  matcher (live delivery), and SQL compiler (document index).
- **`shared/sha256.js`** — pure-JS synchronous SHA-256 (WebCrypto fallback
  semantics), needed for synchronous negentropy fingerprints and non-secure
  browsing contexts.
- **`shared/vectors.js` + `shared/selftest.js`** — the canonical §13/§19 test
  vectors and the conformance suite (browser `/tests` + `npm test`).
- **SIP-01 storage layer** (`src/sip01/`): `sip01_documents`,
  `sip01_observations`, `sip01_indexers`, `relay_metrics`; ingestion with
  aggregate repair on replacement/deletion; read API.
- **NIP-45 `COUNT`** and **NIP-77 `NEG-OPEN`/`NEG-MSG`/`NEG-CLOSE`/`NEG-ERR`**
  in the Durable Object.
- **Operator JSON API** (`/api/stats`, `/api/indexers`, `/api/documents`,
  `/api/document`, `/api/observations`, `/api/search`, `/api/relay-info`,
  `/api/health`).
- **Operator UI** (`index.html`, `ui/`): dashboard, search console, explorer
  with client-side validator, indexer/document browsers with provenance,
  NIP-11 viewer, docs viewer, conformance test page, deployment wizard.
- **Docs set** under `docs/`.
