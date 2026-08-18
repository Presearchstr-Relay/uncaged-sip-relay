# UNCAGED SIP Relay

**Deploy your own decentralized search index node.**

A serverless [SIP-01](https://github.com/NostrDanish/SIP-01) search index relay — Nostr **kind 39697** web-index observations on [Cloudflare Workers](https://workers.cloudflare.com/) + [D1](https://developers.cloudflare.com/d1/) + [Durable Objects](https://developers.cloudflare.com/durable-objects/).

> One shared decentralized index. Many independent indexers. Many independent search engines. No single owner.

```
      WEB
       │
 ┌─────▼──────┐   SIP-01 kind 39697    ┌────────────────┐
 │  crawlers  │ ─────────────────────▶ │  SIP-01 RELAYS │  ← this project
 │ (Crawlstr, │  signed observations   │  (Cloudflare)  │
 │  Indexstr) │                        └───────┬────────┘
 └────────────┘                                │  NIP-50 / NIP-77
                          ┌────────────────────┼─────────────────┐
                    ┌─────▼─────┐      ┌───────▼──────┐   ┌──────▼─────┐
                    │  search   │      │ other SIP-01 │   │   search   │
                    │  engines  │      │ relays sync  │   │   nodes    │
                    └───────────┘      └──────────────┘   └────────────┘
```

This is a **fork of [Nosflare](https://github.com/Spl0itable/nosflare) (MIT)** turned into the deployment layer for the SIP-01 ecosystem: anyone can run a validating, searchable, federating index relay with a Cloudflare account and a few clicks. See [UPSTREAM.md](UPSTREAM.md).

## What it does

- **Validates at the door** — every kind 39697 event is checked against the SIP-01 v1 schema: URL normalization (§7), `d` ↔ `u` consistency, `x` ↔ content consistency, signatures, hard size caps. Invalid observations get `OK false invalid: …` and never reach the index.
- **Indexes for search** — a document/observation/indexer model on top of the canonical event store: one document row per `d` (URL identity), one observation row per live `(pubkey, d)`, one indexer row per publishing key. Provenance is never merged.
- **NIP-50 search with web operators** — `site:` `domain:` `url:` `inurl:` `title:` `topic:` `type:` `platform:` `category:` `network:` `country:` `mime:` `filetype:` `source:` `lang:` `before:` `after:` `distinct:domain`, negations, plus relay-profile `indexer:` / `x:` / `d:`.
- **NIP-77 federation** — negentropy set reconciliation so relays sync indexes efficiently: `["NEG-OPEN","sync",{"kinds":[39697]}, …]`.
- **NIP-45 counts** — cheap observation counts for dashboards and engines.
- **NIP-11 capability advertisement** — including the `uncaged_index` SIP-01 block (SIP-01 §15).
- **Optional pay-to-relay** — Bitcoin Lightning via Nostr zaps with **cryptographically verified** kind 9735 receipts. Payment is relay policy, never protocol.
- **Operator UI** — landing page, live dashboard, search console, observation explorer with a client-side validator, indexer/document browsers, NIP-11 viewer, in-browser conformance tests, and a deployment wizard.
- **Three modes** — `sip01` (dedicated index), `hybrid` (general relay + SIP-01), `general` (plain relay).

## Quickstart (operator)

**One click** — Cloudflare clones the repo into your GitHub account, auto-provisions the D1 database + Durable Objects, builds, and deploys:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/NostrDanish/SIP-Booster-Relay)

Or with the wrangler CLI (Node.js ≥ 20, wrangler ≥ 4.45 auto-provisions D1 on first deploy):

```bash
git clone https://github.com/NostrDanish/SIP-Booster-Relay.git
cd SIP-Booster-Relay
npm install
$EDITOR src/config.ts     # relay name, mode, payment, indexer policy…
npx wrangler login
npx wrangler deploy
```

Then verify:

```bash
curl -H "Accept: application/nostr+json" https://your-relay.workers.dev
# → "uncaged_index": { "sip01": true, "nip50": true, "nip77": true, … }
```

Point [Crawlstr](https://github.com/NostrDanish/Crwalstr) or [indexstr](https://github.com/NostrDanish/indexstr) at `wss://your-relay.workers.dev` and watch the dashboard fill with observations.

The full, non-technical walkthrough lives at the relay's own **`/deploy`** page (and in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

## Using the index

**Read** (any Nostr library, any SIP relay):

```js
const events = await pool.query(relays, [{ kinds: [39697], '#t': ['nostr'], limit: 50 }]);
// group by d → count distinct pubkeys = independent indexer agreement
```

**Search** (NIP-50):

```json
["REQ", "search", {
  "kinds": [39697],
  "search": "bitcoin privacy site:github.com lang:en after:2026-01-01",
  "limit": 50
}]
```

**Sync** (NIP-77 federation):

```json
["NEG-OPEN", "sync", {"kinds": [39697]}, "<hex-encoded negentropy message>"]
```

More: [docs/API.md](docs/API.md).

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design: Worker + DO mesh + D1 + SIP-01 tables |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Full deployment guide (wrangler, dashboard, git, button) |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every `src/config.ts` option |
| [docs/SIP01.md](docs/SIP01.md) | The relay's SIP-01 support profile |
| [docs/NIP-COMPATIBILITY.md](docs/NIP-COMPATIBILITY.md) | Honest NIP support matrix |
| [docs/SECURITY.md](docs/SECURITY.md) | Security model, threat surface, hardening |
| [docs/FEDERATION.md](docs/FEDERATION.md) | NIP-77 sync + relay discovery/registry |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Pruning, metrics, monitoring, capacity |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common problems and fixes |
| [docs/API.md](docs/API.md) | WebSocket + HTTP API reference with examples |
| [docs/TESTING.md](docs/TESTING.md) | Conformance suite (browser + Node) |
| [UPSTREAM.md](UPSTREAM.md) | Nosflare lineage: inherited / modified / added |

## Tests

```bash
npm test          # canonical SIP-01 §13 vectors, NIP-50 parser, NIP-77 convergence
```

The same suite runs in the browser at the relay's **`/tests`** page against the exact modules the Worker executes — one shared implementation (`shared/`), no drift.

## Cost

Small community relays typically run inside Cloudflare's free tier; the design (hibernating Durable Objects, D1 read replication, compact index metadata) keeps large relays cheap. D1's 10 GB cap is handled by design: **D1 holds compact searchable metadata, not the web.** See docs/OPERATIONS.md.

## License

MIT (see [LICENSE](LICENSE)). SIP-01 specification text is public domain.

---

[![Edit with Shakespeare](https://shakespeare.diy/badge.svg)](https://shakespeare.diy/clone?url=https%3A%2F%2Fgithub.com%2FNostrDanish%2FSIP-Booster-Relay.git)
