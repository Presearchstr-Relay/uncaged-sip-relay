# Testing

One conformance suite, three runners — the modules under test are the exact
bytes the relay executes (`shared/` is plain ES modules imported by the
Worker, the browser UI, and Node).

## Run it

```bash
npm test          # Node ≥ 20, zero extra dependencies
```

or open the relay's **`/tests`** page in a browser — the suite auto-runs and
renders results (and logs `[TEST]` lines to the console). In static preview
mode the suite also runs automatically in the background.

## What's covered

### SIP-01 (spec conformance)

- §13.1 URL normalization vectors — byte-identical `normalizeIndexUrl`
  output for the spec's four canonical URLs;
- §13.1 `d` tag derivation (`widx:` + sha256(normalized)[0:32]);
- §13.2 `x` content-hash vectors (`sha256(title + "\n" + description)`);
- §19 example events (minimal / full / self-consistent) validate clean;
- 14 negative cases: wrong kind, missing/multiple tags, bad `d`, non-http
  `u`, wrong `x`, bad version, missing `alt`, empty title, non-JSON content,
  bad topic/language/published/mime shapes;
- forwards compatibility: unknown extension tags produce notices, not
  rejections;
- `buildIndexEventTemplate` round-trip (built events pass validation);
- field extraction: domain hierarchy, extension parsing, `source` split.

### SHA-256

- Known answers (`""`, `"abc"`, quick-brown-fox);
- pure-JS vs WebCrypto agreement across padding boundary lengths
  (54–129 bytes) and a 100 KB input.

### NIP-50

- Parser: keywords, phrases, operators, `-` negation, `distinct:domain`,
  quoted values, unsupported operators ignored;
- date values (unix + ISO dates);
- in-memory matcher semantics (`site:`/`lang:`/`indexer:`/negation/dates);
- SQL assembly shape (joins, grouping, parameter order).

### NIP-77 (negentropy)

- varint round-trips (incl. 32/53-bit edges);
- fingerprint determinism and sensitivity;
- identical sets → zero diffs;
- disjoint sets → full exchange;
- overlapping sets → exactly the set difference, both directions;
- frame-size-limited (4 KB) sync over 800 records still converges;
- empty-vs-nonempty sets;
- protocol version byte `0x61`.

## Adding tests

Add cases to `shared/selftest.js` (and vectors to `shared/vectors.js` when
the spec grows them). The browser page and Node runner pick them up
automatically.

## Integration testing against the live ecosystem

1. Deploy a test relay (see docs/DEPLOYMENT.md).
2. Point a Crawlstr instance at `wss://<your-relay>` and crawl a known page.
3. Confirm:
   - the observation validates (`/explorer` shows ✓);
   - `COUNT` for its `#d` is 1;
   - a second indexer publishing the same URL raises the document's
     indexer count to 2 (`/documents?d=…` provenance view);
   - `search` finds it (`/search`);
   - a NEG-OPEN sync against another SIP-01 relay transfers it.
