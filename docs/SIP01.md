# SIP-01 support profile

This relay implements the [SIP-01](https://github.com/NostrDanish/SIP-01)
Search Index Protocol (spec v1.2). The canonical implementation is
`shared/sip01.js`, byte-compatible with the specification's §13 test vectors
and with the ecosystem implementations (Crawlstr, Indexstr, UNCAGED-ENGINE,
0xSearchstr, UNCAGED-Index-Relay).

## Ingestion (§12.4 relay-side validation)

Every kind 39697 event passes (in order): JSON/field shape → NIP-01 id hash
and Schnorr signature → relay kind policy → indexer policy → event size cap →
**full SIP-01 v1 schema validation**:

- exactly one `d`, `u`, `v`, `alt` tag each; `v` must be `"1"`
- `u` must be a valid http(s) URL ≤ 2048 chars
- `d` must equal `"widx:" + sha256(normalize(u))[0:32]` (§3/§7)
- content JSON: `title` 1–300 chars; `description` ≤ 1000; `image` https only
- ≤ 8 topic tags matching `^[a-z0-9][a-z0-9-]{0,99}$`
- `l` matches `^[a-z]{2}$` (bare ISO 639-1 form, §12.5)
- `x` must be the correct `sha256(title + "\n" + description)` (§8)
- `published` numeric; `source` ≤ 100 chars
- extension tags (`type`, `platform`, `category`, `network`, `country`,
  `mime`) validated against their registry shapes (§9.2)
- unknown tags are ignored (§9.1 forwards compatibility) and noted in logs

Failures are rejected with `OK false invalid: <reason>` and counted in the
`sip01_validation_failures` metric. They never reach the index.

## Storage model

- Addressable semantics (NIP-01): one live observation per `(pubkey, d)`.
  Recrawls replace the previous observation; aggregates are repaired.
- `sip01_documents`: one row per `d` — normalized URL, host, title,
  description, `x`, language, mime, extension facets, topics, first/last
  seen, observation and indexer counts.
- `sip01_observations`: one row per live `(pubkey, d)` — event id,
  `created_at`, `source`, relay-side `relay_seen_at`.
- `sip01_indexers`: one row per indexer pubkey — software/version (parsed
  from `source`), counts, first/last seen.

Exact duplicates (same event id) → `duplicate:`. Same URL from a different
indexer → a new, legitimate observation. Same `(pubkey, d)` re-crawled →
replacement. These three cases are distinct on purpose (SIP-01 §2).

## Querying

Baseline NIP-01 filters work everywhere: `kinds: [39697]`, `#d`, `#u`, `#t`,
`#l`, `#x`, `authors`, `since`/`until`, `limit`. Single-letter tags are
indexed in the multi-value tag cache.

NIP-50 acceleration with the SIP-01 operator set (§15) plus relay-profile
operators `indexer:`, `x:`, `d:` — see docs/API.md for the full reference
and ranking rules.

NIP-45 `COUNT` for cheap counts (e.g. observations per `#d`).

## NIP-11 advertisement (§15)

```json
{
  "uncaged_index": {
    "sip01": true,
    "nip50": true,
    "nip77": true,
    "document_kinds": [39697],
    "scope": "global",
    "domains": ["*"],
    "languages": [],
    "document_types": [],
    "filters": ["site", "domain", "url", "inurl", "title", "topic", "type",
                "platform", "category", "network", "country", "mime",
                "filetype", "source", "lang", "before", "after", "indexer",
                "x", "d", "distinct:domain"],
    "relay_mode": "sip01",
    "validation": true,
    "schema_version": "1"
  }
}
```

`filters` lists every operator this relay implements — clients SHOULD check
this before relying on operator semantics (§15 precision note).

## Federation

NIP-77 negentropy sync over any filter: `["NEG-OPEN","sync",{"kinds":[39697]},…]`.
See docs/FEDERATION.md.

## Conformance

`npm test`, or the relay's `/tests` page, runs the §13/§19 vectors, negative
validation cases, NIP-50 parser/matcher tests, and NIP-77 convergence tests
against the same modules the Worker executes.
