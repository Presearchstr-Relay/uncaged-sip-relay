/**
 * SIP-01 relay self-test suite — runs identically in the browser (the /tests
 * page), in Node (tests/run-tests.mjs), and against the production modules
 * themselves (shared/*.js). No test framework; a tiny harness with clear
 * pass/fail output.
 *
 * Coverage:
 *   - SHA-256 known answers (the pure-JS fallback path)
 *   - SIP-01 §13.1 URL normalization + d-tag vectors
 *   - SIP-01 §13.2 content-hash vectors
 *   - §19 example events validate clean
 *   - negative validation cases (each defect isolated)
 *   - buildIndexEventTemplate round-trip
 *   - NIP-50 search query parser + in-memory matcher
 *   - NIP-77 negentropy: varint, fingerprints, full reconciliation
 *     convergence incl. frame-size-limited splits
 *
 * @module shared/selftest
 */

import { sha256HexSync, sha256Hex, bytesToHex, hexToBytes } from './sha256.js';
import {
  SIP01_KIND,
  normalizeIndexUrl,
  documentId,
  documentIdSync,
  contentHash,
  contentHashSync,
  validateSip01Event,
  buildIndexEventTemplate,
  extractSip01Fields,
  domainHierarchy,
  searchHostValue,
} from './sip01.js';
import {
  URL_VECTORS,
  CONTENT_VECTORS,
  EXAMPLE_EVENT_MINIMAL,
  EXAMPLE_EVENT_FULL,
  EXAMPLE_EVENT_SELF_CONSISTENT,
  INVALID_CASES,
} from './vectors.js';
import {
  parseSearchQuery,
  matchSip01Search,
  parseDateValue,
  buildSip01SearchSql,
} from './search-query.js';
import {
  Negentropy,
  NegentropyStorageVector,
  encodeVarInt,
  PROTOCOL_VERSION,
} from './negentropy.js';

/**
 * Run the whole suite.
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ name: string, pass: boolean, error?: string }[]>}
 */
export async function runAllTests(log = () => {}) {
  /** @type {{ name: string, pass: boolean, error?: string }[]} */
  const results = [];

  /**
   * @param {string} name
   * @param {() => void | Promise<void>} fn
   */
  const test = async (name, fn) => {
    try {
      await fn();
      results.push({ name, pass: true });
      log(`[TEST] PASS ${name}`);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      results.push({ name, pass: false, error: message });
      log(`[TEST] FAIL ${name}: ${message}`);
    }
  };

  /** @param {boolean} cond @param {string} msg */
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const eq = (a, b, msg) => assert(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

  // ---------------------------------------------------------------- SHA-256
  await test('sha256: known answers', async () => {
    eq(sha256HexSync(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty string');
    eq(sha256HexSync('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'abc');
    eq(
      sha256HexSync('The quick brown fox jumps over the lazy dog'),
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
      'fox',
    );
    // async path agrees with sync path
    eq(await sha256Hex('abc'), sha256HexSync('abc'), 'subtle vs pure');
  });

  await test('sha256: multi-block streaming correctness', async () => {
    const long = 'a'.repeat(100000);
    eq(
      sha256HexSync(long),
      await sha256Hex(long),
      '100KB input matches WebCrypto',
    );
  });

  await test('sha256: padding boundary lengths match WebCrypto', async () => {
    // The 0x80/length-trailer boundary at byteLen ≡ 55/56 (mod 64) is where
    // hand-rolled padding breaks; sweep across it.
    for (const len of [54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 127, 128, 129]) {
      const input = 'x'.repeat(len);
      eq(sha256HexSync(input), await sha256Hex(input), `length ${len} mismatch`);
    }
  });

  // ------------------------------------------------- SIP-01 §13.1 d vectors
  for (const [input, normalized, d] of URL_VECTORS) {
    await test(`sip01 §13.1: normalize ${input.slice(0, 48)}`, async () => {
      eq(normalizeIndexUrl(input), normalized, 'normalized URL mismatch');
    });
    await test(`sip01 §13.1: d tag for ${normalized}`, async () => {
      eq(await documentId(normalized), d, 'async documentId mismatch');
      eq(documentIdSync(normalized), d, 'sync documentId mismatch');
    });
  }

  await test('sip01 §7: rejects non-http(s)', async () => {
    eq(normalizeIndexUrl('ftp://example.com'), null, 'ftp accepted');
    eq(normalizeIndexUrl('javascript:alert(1)'), null, 'javascript accepted');
    eq(normalizeIndexUrl('not a url'), null, 'garbage accepted');
  });

  // ------------------------------------------------- SIP-01 §13.2 x vectors
  for (const [title, description, x] of CONTENT_VECTORS) {
    await test(`sip01 §13.2: x for "${String(title).slice(0, 32)}"`, async () => {
      eq(await contentHash(title, description ?? ''), x, 'async contentHash mismatch');
      eq(contentHashSync(title, description ?? ''), x, 'sync contentHash mismatch');
    });
  }

  // ----------------------------------------------------- §19 valid examples
  await test('sip01 §19: minimal example validates', async () => {
    const v = await validateSip01Event(EXAMPLE_EVENT_MINIMAL);
    assert(v.valid, `rejected: ${v.errors.join('; ')}`);
  });

  await test('sip01 §19: full example with extensions validates', async () => {
    const v = await validateSip01Event(EXAMPLE_EVENT_FULL);
    assert(v.valid, `rejected: ${v.errors.join('; ')}`);
  });

  await test('sip01 §4: self-consistent example validates', async () => {
    const v = await validateSip01Event(EXAMPLE_EVENT_SELF_CONSISTENT);
    assert(v.valid, `rejected: ${v.errors.join('; ')}`);
  });

  // ------------------------------------------------------- invalid examples
  for (const [label, event, expected] of INVALID_CASES) {
    await test(`sip01 validation rejects: ${label}`, async () => {
      const v = await validateSip01Event(event);
      assert(!v.valid, 'event was accepted');
      assert(
        v.errors.some((e) => e.includes(expected)),
        `expected error containing ${JSON.stringify(expected)}, got: ${v.errors.join('; ')}`,
      );
    });
  }

  await test('sip01: unknown extension tags → notice, not rejection', async () => {
    const event = {
      ...EXAMPLE_EVENT_SELF_CONSISTENT,
      tags: [...EXAMPLE_EVENT_SELF_CONSISTENT.tags, ['x-experimental', 'foo']],
    };
    const v = await validateSip01Event(event);
    assert(v.valid, `rejected: ${v.errors.join('; ')}`);
    assert(v.notices.some((n) => n.includes('x-experimental')), 'no notice recorded');
  });

  // ------------------------------------------------- builder round-trip
  await test('sip01: buildIndexEventTemplate produces a valid self-consistent event', async () => {
    const tpl = buildIndexEventTemplate({
      url: 'https://example.com/page',
      title: 'Example Page',
      description: 'A page about examples.',
      topics: ['nostr'],
      language: 'en',
      source: 'crawlstr/1',
    });
    assert(tpl, 'template not built');
    eq(tpl.kind, SIP01_KIND, 'kind');
    const v = await validateSip01Event({ ...tpl, id: '', pubkey: '', created_at: 0, sig: '' });
    assert(v.valid, `built event invalid: ${v.errors.join('; ')}`);
    const dTag = tpl.tags.find((t) => t[0] === 'd')[1];
    eq(dTag, 'widx:3641c5f2274c5471278ab5bf1df6d185', 'built d tag');
  });

  await test('sip01: extractSip01Fields (domain hierarchy, ext parsing)', async () => {
    const f = extractSip01Fields({ ...EXAMPLE_EVENT_FULL, id: '', pubkey: 'ab'.repeat(32), created_at: 1786250000, sig: '' });
    assert(f, 'no fields extracted');
    eq(f.url_host, 'github.com', 'host');
    eq(f.doc_type, 'repository', 'type ext');
    eq(f.network, 'clearnet', 'network ext');
    eq(f.software, 'crawlstr', 'software parse');
    eq(f.software_version, '1', 'software version parse');
    assert(f.topics.includes('nostr'), 'topics');
  });

  await test('sip01: domainHierarchy / searchHostValue', async () => {
    eq(JSON.stringify(domainHierarchy('docs.github.com')), '["docs.github.com","github.com"]', 'hierarchy');
    eq(JSON.stringify(domainHierarchy('1.2.3.4')), '["1.2.3.4"]', 'ip hierarchy');
    eq(searchHostValue('https://WWW.GitHub.com/torvalds'), 'github.com', 'forgiving host');
    eq(searchHostValue('GitHub.com.'), 'github.com', 'trailing dot');
  });

  // ------------------------------------------------------------ NIP-50 parse
  await test('nip50: parses keywords, phrases, operators, negation', async () => {
    const p = parseSearchQuery('bitcoin privacy site:github.com -lang:de "cold storage" after:2026-01-01');
    eq(JSON.stringify(p.keywords), '["bitcoin","privacy"]', 'keywords');
    eq(JSON.stringify(p.phrases), '["cold storage"]', 'phrases');
    const site = p.ops.find((o) => o.op === 'site');
    assert(site && site.value === 'github.com' && !site.negated, 'site op');
    const lang = p.ops.find((o) => o.op === 'lang');
    assert(lang && lang.value === 'de' && lang.negated, 'negated lang op');
    const after = p.ops.find((o) => o.op === 'after');
    assert(after && parseDateValue(after.value) !== null, 'after op');
  });

  await test('nip50: quoted operator values keep their spaces', async () => {
    const p = parseSearchQuery('title:"white paper" site:docs.example.com');
    const title = p.ops.find((o) => o.op === 'title');
    assert(title && title.value === 'white paper', `title value ${JSON.stringify(title && title.value)}`);
    eq(p.keywords.length, 0, 'no stray keywords');
    const site = p.ops.find((o) => o.op === 'site');
    assert(site && site.value === 'docs.example.com', 'site op intact');
  });

  await test('nip50: distinct:domain + unsupported ops ignored', async () => {
    const p = parseSearchQuery('search distinct:domain sentiment:positive');
    assert(p.distinctDomain, 'distinct:domain not detected');
    eq(JSON.stringify(p.ignored), '["sentiment:positive"]', 'ignored list');
  });

  await test('nip50: date values (unix + ISO)', async () => {
    eq(parseDateValue('1786200000'), 1786200000, 'unix');
    eq(parseDateValue('2026-01-01'), 1767225600, 'ISO date');
    eq(parseDateValue('banana'), null, 'garbage');
  });

  await test('nip50: matchSip01Search in-memory semantics', async () => {
    const fields = {
      d: 'widx:abc', url: 'https://github.com/nostr-protocol/nips', url_host: 'github.com',
      title: 'Nostr NIPs', description: 'Protocol specs', topics: ['nostr', 'protocol'],
      language: 'en', content_type: 'text/html', doc_type: 'repository', platform: 'github',
      observed_at: 1786200000, indexer: 'ab'.repeat(32),
    };
    assert(matchSip01Search(parseSearchQuery('nostr site:github.com'), fields), 'site match');
    assert(matchSip01Search(parseSearchQuery('nostr site:nostr-protocol.github.io'), fields) === false, 'subdomain mismatch');
    assert(matchSip01Search(parseSearchQuery('site:docs.github.com'), fields) === false, 'subdomain of parent');
    assert(matchSip01Search(parseSearchQuery('nostr -lang:de'), fields), 'negation match');
    assert(matchSip01Search(parseSearchQuery('nostr lang:de'), fields) === false, 'lang mismatch');
    assert(matchSip01Search(parseSearchQuery(`indexer:${'ab'.repeat(32)}`), fields), 'indexer match');
    assert(matchSip01Search(parseSearchQuery('type:repository'), fields), 'type match');
    assert(matchSip01Search(parseSearchQuery('before:2026-01-01'), fields) === false, 'before boundary');
    assert(matchSip01Search(parseSearchQuery('after:2026-01-01'), fields), 'after match');
  });

  await test('nip50: buildSip01SearchSql assembles sane SQL', async () => {
    const p = parseSearchQuery('nostr site:github.com lang:en distinct:domain');
    const { sql, params } = buildSip01SearchSql(p, 25);
    assert(sql.includes('sip01_documents'), 'documents table');
    assert(sql.includes('sip01_observations'), 'observations join');
    assert(sql.includes('GROUP BY url_host'), 'distinct grouping');
    assert(sql.includes('LIMIT ?'), 'limit');
    eq(params[params.length - 1], 25, 'limit param last');
    assert(params.includes('github.com'), 'site param bound');
    assert(params.includes('en'), 'lang param bound');
  });

  // ------------------------------------------------------------- NIP-77 neg
  await test('nip77: varint round-trip', async () => {
    for (const n of [0, 1, 127, 128, 300, 16384, 4294967295, Number.MAX_SAFE_INTEGER]) {
      // encode then decode via a full bound-less reader path
      const enc = encodeVarInt(n);
      let result = 0;
      let i = 0;
      while (true) {
        const byte = enc[i++];
        result = result * 128 + (byte & 0x7f);
        if ((byte & 0x80) === 0) break;
      }
      eq(result, n, `varint(${n})`);
    }
  });

  const makeItems = (prefix, count, tsBase = 1700000000) => {
    const v = new NegentropyStorageVector();
    for (let i = 0; i < count; i++) {
      v.insertHex(tsBase + (i % 97), sha256HexSync(`${prefix}:${i}`));
    }
    v.seal();
    return v;
  };

  await test('nip77: fingerprint determinism + sensitivity', async () => {
    const a = makeItems('fp', 10);
    const b = makeItems('fp', 10);
    const c = makeItems('fp-different', 10);
    const fa = bytesToHex(a.fingerprint(0, 10));
    const fb = bytesToHex(b.fingerprint(0, 10));
    const fc = bytesToHex(c.fingerprint(0, 10));
    eq(fa, fb, 'same set, same fingerprint');
    assert(fa !== fc, 'different set, same fingerprint');
    // empty range fingerprint
    const e = bytesToHex(a.fingerprint(0, 0));
    assert(e.length === 32, 'empty fingerprint size (16 bytes hex = 32)');
  });

  const syncSets = (aItems, bItems, frameLimit = 0) => {
    const client = new Negentropy(aItems, frameLimit);
    const server = new Negentropy(bItems, frameLimit);

    let msg = client.initiate();
    let rounds = 0;
    while (msg && rounds < 50) {
      const serverResult = server.reconcile(msg);
      assert(serverResult.message, 'server returned no message');
      const clientResult = client.reconcile(serverResult.message);
      msg = clientResult.message;
      rounds++;
    }
    assert(rounds < 50, 'did not converge');
    return {
      haveIds: [...client.haveIds].sort(),
      needIds: [...client.needIds].sort(),
      rounds,
    };
  };

  await test('nip77: identical sets converge with zero diffs', async () => {
    const a = makeItems('same', 64);
    const b = makeItems('same', 64);
    const { haveIds, needIds } = syncSets(a, b);
    eq(haveIds.length, 0, 'have');
    eq(needIds.length, 0, 'need');
  });

  await test('nip77: disjoint small sets reconcile fully', async () => {
    const a = makeItems('client-set', 20);
    const b = makeItems('server-set', 20);
    const { haveIds, needIds } = syncSets(a, b);
    eq(haveIds.length, 20, 'client should have 20 to upload');
    eq(needIds.length, 20, 'client should need 20');
    // sanity: ids actually belong to the right set
    const aIds = new Set(Array.from({ length: 20 }, (_, i) => sha256HexSync(`client-set:${i}`)));
    assert(haveIds.every((id) => aIds.has(id)), 'haveIds mismatch');
  });

  await test('nip77: overlapping sets reconcile only the difference', async () => {
    // shared: indices 0..79; client-only: 80..99; server-only: 80..119 of "b"
    const client = new NegentropyStorageVector();
    const server = new NegentropyStorageVector();
    for (let i = 0; i < 80; i++) {
      const id = sha256HexSync(`shared:${i}`);
      client.insertHex(1700000000 + (i % 31), id);
      server.insertHex(1700000000 + (i % 31), id);
    }
    for (let i = 80; i < 100; i++) client.insertHex(1700000000 + (i % 31), sha256HexSync(`client:${i}`));
    for (let i = 80; i < 120; i++) server.insertHex(1700000000 + (i % 31), sha256HexSync(`server:${i}`));
    client.seal();
    server.seal();

    const { haveIds, needIds } = syncSets(client, server);
    eq(haveIds.length, 20, 'client-only count');
    eq(needIds.length, 40, 'server-only count');
    const clientOnly = new Set(Array.from({ length: 20 }, (_, i) => sha256HexSync(`client:${i + 80}`)));
    const serverOnly = new Set(Array.from({ length: 40 }, (_, i) => sha256HexSync(`server:${i + 80}`)));
    eq(JSON.stringify(haveIds), JSON.stringify([...clientOnly].sort()), 'haveIds exact');
    eq(JSON.stringify(needIds), JSON.stringify([...serverOnly].sort()), 'needIds exact');
  });

  await test('nip77: frame-size-limited sync converges', async () => {
    const a = makeItems('big-a', 400);
    const b = makeItems('big-b', 400);
    const { haveIds, needIds, rounds } = syncSets(a, b, 4096);
    eq(haveIds.length, 400, 'all client items offered');
    eq(needIds.length, 400, 'all server items learned');
    assert(rounds > 1, 'expected multiple rounds under frame limit');
  });

  await test('nip77: protocol version byte is emitted', async () => {
    const v = makeItems('v', 3);
    const n = new Negentropy(v);
    const msg = n.initiate();
    eq(msg[0], PROTOCOL_VERSION, 'version byte 0x61');
  });

  await test('nip77: empty vs non-empty set', async () => {
    const empty = new NegentropyStorageVector();
    empty.seal();
    const b = makeItems('nonempty', 5);
    const { haveIds, needIds } = syncSets(empty, b);
    eq(haveIds.length, 0, 'nothing to upload');
    eq(needIds.length, 5, 'needs all five');
  });

  return results;
}

/** Pretty summary line for consoles. */
export function summarize(results) {
  const passed = results.filter((r) => r.pass).length;
  return `${passed}/${results.length} tests passed`;
}
