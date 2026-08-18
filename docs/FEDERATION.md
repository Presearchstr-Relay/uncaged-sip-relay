# Federation (NIP-77) & relay discovery

## Why federation matters

No relay is the permanent global index. SIP-01 stays decentralized because
observations live on many independently operated relays, and relays
**synchronize** with each other. If one disappears, the index lives on.

This relay implements **Negentropy Protocol V1** as specified in the NIP-77
appendix (server role; initiator role included for relay-to-relay tooling and
tests). Implementation: `shared/negentropy.js` — aligned byte-for-byte on the
wire with the UNCAGED-Index-Relay Node implementation.

## Syncing two relays

Any Nostr client (including another relay's operator script) can reconcile:

```jsonc
// client → relay
["NEG-OPEN", "sync", {"kinds": [39697]}, "<hex negentropy message>"]
// relay → client
["NEG-MSG", "sync", "<hex negentropy response>"]
// … alternate NEG-MSG until the initiator's reconcile returns null …
["NEG-CLOSE", "sync"]
```

After reconciliation the initiator knows:

- `haveIds` — events it has that this relay lacks → upload with `EVENT`;
- `needIds` — events this relay has that it lacks → download with `REQ` by `ids`.

Only the differences move — syncing a million-record index usually takes a
few round trips of a few KB.

Notes:

- Works with any filter: sync everything, only `{"kinds":[39697]}`, a time
  range (`since`/`until`), one domain (`{"#d": […]}` won't help; use
  `kinds`+time windows), etc.
- Sessions are in-memory per Durable Object and expire after 10 idle minutes
  (`NEG-ERR closed:` — just re-open). Hibernation can also drop a session;
  re-opening is cheap and idempotent.
- Sets larger than `NEG_MAX_ITEMS` (default 100,000 events) are refused with
  `NEG-ERR blocked: this query is too big` (+ the cap as a 4th element).
  Narrow the filter (e.g. by `since`) and sync in windows.
- Wire messages are capped at 256 KB; larger diffs split into more rounds
  automatically.

### Minimal sync client (Node)

```js
import { Negentropy, NegentropyStorageVector } from './shared/negentropy.js';

const storage = new NegentropyStorageVector();
for (const e of myLocalEvents) storage.insertHex(e.created_at, e.id);
storage.seal();

const neg = new Negentropy(storage);
const ws = new WebSocket('wss://your-relay.workers.dev');
ws.on('open', () => ws.send(JSON.stringify(['NEG-OPEN', 'sync', { kinds: [39697] }, Buffer.from(neg.initiate()).toString('hex')])));
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg[0] !== 'NEG-MSG') return;
  const res = neg.reconcile(Buffer.from(msg[2], 'hex'));
  if (res.message === null) {
    console.log('have:', res.haveIds, 'need:', res.needIds);
    ws.close();
  } else {
    ws.send(JSON.stringify(['NEG-MSG', 'sync', Buffer.from(res.message).toString('hex')]));
  }
});
```

## Relay discovery

A SIP-01 relay advertises itself through its NIP-11 document — look for:

```json
{ "uncaged_index": { "sip01": true, "nip50": true, "nip77": true, … } }
```

Crawlers and engines SHOULD probe candidate relays with:

```bash
curl -H "Accept: application/nostr+json" <relay-url>
```

and keep a pool of relays whose `uncaged_index.sip01` is `true`.

### The registry convention

Operators who want their relay publicly listed SHOULD announce it as ordinary
Nostr data so discovery itself stays decentralized:

- **Relay list metadata (kind 10002)** on the operator's pubkey including the
  relay URL, and
- a kind 31990-style handler or a note tagging the relay with `#sip01` —
  clients that already know a bootstrap relay can find others.

This project deliberately does **not** run a central registry service. A
curated community list can live in the SIP-01 repository (`relays.json`) as a
bootstrap hint only; treat it as untrusted input and always verify the
NIP-11 `uncaged_index` block yourself.

## Consistency model

- Negentropy reconciles the canonical `events` store. The SIP-01 derived
  tables on the receiving side are maintained by the normal ingestion path
  as missing events arrive via `EVENT` (validation applies identically to
  federated events — a bad observation is rejected no matter who relays it).
- Addressable replacement means syncing is monotonic in practice: newer
  observations replace older ones on both sides.
