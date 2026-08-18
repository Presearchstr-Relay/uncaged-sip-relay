# API reference

The relay protocol is **standard Nostr over WebSocket** (`wss://<host>`) —
no proprietary APIs. Optional HTTP endpoints exist for health, operator
metrics, and the dashboard; they are conveniences, not the protocol.

## WebSocket (Nostr)

### NIP-01

```jsonc
// publish
["EVENT", { "id": "…", "pubkey": "…", "created_at": 1786250000, "kind": 39697, "tags": […], "content": "…", "sig": "…" }]
// → ["OK", "<id>", true, ""]  or  ["OK", "<id>", false, "invalid: …"]

// subscribe
["REQ", "sub1", { "kinds": [39697], "#t": ["nostr"], "limit": 50 }]
// → ["EVENT", "sub1", {…}] × N, then ["EOSE", "sub1"], then live events

["CLOSE", "sub1"]   // → ["CLOSED", "sub1", "…"]
```

Filterable single-letter tags on this relay: `p e a t d r L s u l x`
(SIP-01: `#d` document id, `#u` canonical URL, `#t` topics, `#l` language,
`#x` content hash).

### NIP-50 search

```jsonc
["REQ", "s1", { "kinds": [39697], "search": "bitcoin privacy site:github.com lang:en", "limit": 50 }]
```

Results are rank-ordered (NIP-50 quality ordering) observation events.
Because a document may have several observations (one per indexer), group
results by `d` and count distinct `pubkey`s for the independent-agreement
signal.

**Operators** (SIP-01 §15 set + relay-profile extras):

| Operator | Matches | Example |
|---|---|---|
| `site:` | host or subdomain of | `site:github.com` |
| `domain:` | exact host only | `domain:docs.github.com` |
| `url:` | exact normalized URL | `url:https://example.com/page` |
| `inurl:` | URL substring | `inurl:spec` |
| `title:` | title substring | `title:"white paper"` |
| `topic:` | topic tag (`t`) | `topic:nostr` |
| `type:` / `platform:` / `category:` / `network:` | extension tags | `type:repository` |
| `country:` | ISO alpha-2 | `country:DE` |
| `mime:` | exact MIME | `mime:application/pdf` |
| `filetype:` | file extension (with common MIME aliases) | `filetype:pdf` |
| `source:` | crawler software (`source` tag) | `source:crawlstr/1` |
| `lang:` | `l` tag | `lang:en` |
| `before:` / `after:` | latest-observation time; unix or `YYYY-MM-DD` | `after:2026-01-01` |
| `indexer:` *(profile)* | observed by pubkey | `indexer:<hex>` |
| `x:` / `d:` *(profile)* | exact content hash / document id | `d:widx:…` |
| `distinct:domain` | one best-ranked document per host | `nostr distinct:domain` |
| `-op:` | negation | `-site:x.com` |

Plain words and `"quoted phrases"` match title/description/URL
(case-insensitive, AND semantics). Unknown operators are ignored (NIP-50).

**Ranking**: +4 per term in title, +2 in description, +min(indexer_count, 8)
independent-agreement boost, small recency tiebreak. `limit` applies after
ranking.

### NIP-45 count

```jsonc
["COUNT", "c1", { "kinds": [39697], "#d": ["widx:3641c5f2274c5471278ab5bf1df6d185"] }]
// → ["COUNT", "c1", { "count": 3, "approximate": false }]
```

### NIP-77 sync

See docs/FEDERATION.md for the full flow (`NEG-OPEN` / `NEG-MSG` /
`NEG-CLOSE` / `NEG-ERR`).

### NIP-42 auth

When `AUTH_REQUIRED` is on, the relay sends `["AUTH", "<challenge>"]` on
connect; answer with a signed kind 22242 event carrying `relay` and
`challenge` tags.

## HTTP

All endpoints return JSON with CORS enabled.

| Endpoint | Description |
|---|---|
| `GET /` + `Accept: application/nostr+json` | NIP-11 relay information (incl. `uncaged_index`) |
| `GET /.well-known/nostr.json?name=…` | NIP-05 |
| `GET /api/health` | `{ status, events, mode, version, time }` |
| `GET /api/relay-info` | Public relay configuration for UIs |
| `GET /api/stats` | Index statistics + metrics + DB size |
| `GET /api/indexers?limit=&offset=` | Paginated indexer list |
| `GET /api/indexer?pubkey=<hex>` | One indexer + top hosts/languages |
| `GET /api/documents?limit=&offset=&host=&lang=&q=` | Document index browse |
| `GET /api/document?d=widx:…` | Document + all observations (provenance) |
| `GET /api/observations?limit=&offset=&pubkey=&d=` | Recent observation events |
| `GET /api/search?q=…&limit=` | HTTP mirror of NIP-50 (dashboard convenience) |
| `GET /api/check-payment?pubkey=<hex>` | Payment status (pay-to-relay mode) |
| `POST /?notify-zap` | Submit kind 9735 zap receipt → grants access |

## Client examples

### JavaScript / TypeScript

```js
const ws = new WebSocket('wss://your-relay.workers.dev');
ws.onopen = () => {
  ws.send(JSON.stringify(['REQ', 's1', {
    kinds: [39697],
    search: 'bitcoin privacy site:github.com lang:en',
    limit: 50,
  }]));
};
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg[0] === 'EVENT') console.log('observation', msg[2]);
  if (msg[0] === 'EOSE') ws.close();
};
```

### Python (websockets)

```python
import asyncio, json, websockets

async def main():
    async with websockets.connect('wss://your-relay.workers.dev') as ws:
        await ws.send(json.dumps(['REQ', 's1', {'kinds': [39697], '#t': ['nostr'], 'limit': 10}]))
        while True:
            msg = json.loads(await ws.recv())
            if msg[0] == 'EVENT': print(msg[2])
            if msg[0] == 'EOSE': break

asyncio.run(main())
```

### curl (NIP-11 + stats)

```bash
curl -H "Accept: application/nostr+json" https://your-relay.workers.dev
curl https://your-relay.workers.dev/api/stats | jq .documents
curl "https://your-relay.workers.dev/api/search?q=lang%3Aen+nostr&limit=5" | jq .count
```
