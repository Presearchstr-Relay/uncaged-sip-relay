# Security model

This relay is public Internet infrastructure. It assumes every client is
hostile until proven otherwise.

## Ingestion hardening

1. **Message size cap** before JSON parsing (256 KB default; close 1009).
2. **Field shape checks** before any cryptography: lowercase-hex `id`,
   `pubkey`, `sig`; integer `kind` (0–65535) and `created_at`; tag count;
   content length.
3. **Event id = sha256(serialization)** verified, then **Schnorr signature**
   verified (`@noble/curves`, constant-time primitives).
4. **`created_at` future limit** (default +900 s; NIP-01 SHOULD).
5. **SIP-01 schema validation** for kind 39697 (spec §12.4): URL allowlist
   (http/https only — `javascript:`, `data:`, `file:` rejected), d↔u and
   x↔content hash consistency, hard length caps, extension tag shapes.
6. **Policy engine**: pubkey/kind/tag allow+block lists, blocked content
   phrases, optional NIP-05 gate, optional anti-spam content hashing.
7. **Rate limits**: per-connection token buckets — writes (10/min), reads
   (50/min), and a roomier kind-39697 indexer bucket (120/min, burst 240).
8. **Query cost controls**: complexity scoring, COUNT precheck against tag
   queries (>10k estimated rows refused), global per-REQ event cap, chunked
   execution of huge filter arrays, search length/result caps, COUNT
   complexity guard, NEG item cap (`NEG-ERR blocked:` beyond).

## Payment verification (pay-to-relay mode)

Upstream's payment endpoint marked any caller-supplied `?npub=` as paid —
anyone could self-grant access. This fork only records payment from a
**cryptographically valid kind 9735 zap receipt**:

- valid Schnorr signature;
- `p` tag = the operator's pubkey (decoded from the configured npub);
- `P` tag = the payer receiving access;
- `amount` (msats) ≥ configured price and a `bolt11` invoice present;
- receipt ≤ 30 days old.

**Trust model:** a zap receipt is issued and signed by the operator's own
LNURL server after invoice settlement, so trusting it reduces to trusting the
operator's Lightning infrastructure — the correct trust root for a relay
policy decision. A receipt can be replayed, but only to grant access to the
same payer it already paid for. Invoice-level double-checks against the
LNURL `verify` endpoint can be layered on later without changing the module
interface (outbound calls are deliberately not made by default — see SSRF).

## Outbound requests (SSRF posture)

The relay never fetches URLs from events or search queries. The only
outbound fetches are:

- `https://<domain>/.well-known/nostr.json` for the optional NIP-05 gate
  (off by default; domains come from publishing clients' kind-0 metadata —
  enable only with allow-listed domains if you turn this on), and
- the favicon proxy to the configured `relayInfo.icon` URL (static config).

Server-side **crawling is out of scope** for the relay itself — crawlers
(Crawlstr/Indexstr) fetch URLs and apply their own SSRF protections; the
relay only stores their signed observations.

## WebSocket abuse protection

- Hibernating Durable Objects with idle eviction alarms.
- Max 100 subscriptions per connection; max 20 filters per REQ; sub-id ≤ 64.
- NEG sessions: in-memory, one per sub-id, 10-minute idle reclamation,
  replaced on repeated NEG-OPEN (per NIP-77).
- DO broadcast mesh validates event ids against a dedupe map before fanout.

## Data safety

- All SQL is parameterized (bound values); LIKE patterns are escaped with
  `ESCAPE '\'`; tag names come from a whitelist for cache-column lookups.
- Deletion requires ownership (`e` tag targets must share the deletion's
  pubkey; `a` tag targets must match kind+pubkey).
- D1 sessions (`withSession` bookmarks) give read-after-write consistency
  without trusting stale replicas.

## Secrets

- Never in source: Cloudflare API tokens, account IDs, Nostr private keys,
  Lightning node keys. Use `wrangler secret` for runtime secrets.
- The relay needs **no private key** at all — it serves and validates; it
  does not sign.

## Reporting

Open a GitHub issue (or contact the operator address in the NIP-11
document). Please include reproduction details; do not include secrets.
