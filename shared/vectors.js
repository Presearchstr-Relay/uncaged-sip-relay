/**
 * SIP-01 §13 canonical test vectors + §19 example events.
 *
 * Every value here is copied verbatim from the specification. Implementations
 * MUST produce byte-identical results — a single character of drift in
 * normalization or hashing breaks deduplication against every other
 * implementation in the ecosystem.
 *
 * @module shared/vectors
 */

/** §13.1 URL identity vectors: [input URL, normalized URL, expected d tag]. */
export const URL_VECTORS = /** @type {const} */ ([
  [
    'https://example.com/',
    'https://example.com/',
    'widx:0f115db062b7c0dd030b16878c99dea5',
  ],
  [
    'HTTPS://WWW.Example.Com:443/page/?b=2&utm_source=x&a=1#top',
    'https://example.com/page?a=1&b=2',
    'widx:f68176b3eb966bd682c3c6eadcc5fe44',
  ],
  [
    'https://example.com/page',
    'https://example.com/page',
    'widx:3641c5f2274c5471278ab5bf1df6d185',
  ],
  [
    'https://github.com/NostrDanish/Crwalstr',
    'https://github.com/NostrDanish/Crwalstr',
    'widx:cdfd4df8c01d609fc9cdf943afa80197',
  ],
]);

/** §13.2 content identity vectors: [title, description|undefined, expected x]. */
export const CONTENT_VECTORS = /** @type {const} */ ([
  [
    'Example',
    undefined,
    'e1762f14d9924e37b32f1c81dfd256410af462f5136415c96877efa8c80345d0',
  ],
  [
    'Example Page',
    'A page about examples.',
    '2a5cbdf44513f552fb571d6c6de2ddf16c5452b235cc887980b52898fb38e7c1',
  ],
  [
    'Crwalstr — a browser-based web crawler for Nostr',
    'A browser-based web crawler that publishes SIP-01 web index observations.',
    'babd08c579e107b98a360a7f713d5d822bbd9f24087b86d98404db214f0e5500',
  ],
]);

/** §19 minimal valid event (structure only — id/pubkey/sig are placeholders). */
export const EXAMPLE_EVENT_MINIMAL = {
  kind: 39697,
  content: '{"title":"Example"}',
  tags: [
    ['d', 'widx:0f115db062b7c0dd030b16878c99dea5'],
    ['u', 'https://example.com/'],
    ['v', '1'],
    ['alt', 'Web index observation: Example'],
  ],
};

/** §19 full event with extension tags (structure only). */
export const EXAMPLE_EVENT_FULL = {
  kind: 39697,
  content:
    '{"title":"Crwalstr — a browser-based web crawler for Nostr","description":"A browser-based web crawler that publishes SIP-01 web index observations."}',
  tags: [
    ['d', 'widx:cdfd4df8c01d609fc9cdf943afa80197'],
    ['u', 'https://github.com/NostrDanish/Crwalstr'],
    ['t', 'nostr'],
    ['t', 'crawler'],
    ['t', 'search'],
    ['l', 'en'],
    ['x', 'babd08c579e107b98a360a7f713d5d822bbd9f24087b86d98404db214f0e5500'],
    ['v', '1'],
    ['type', 'repository'],
    ['platform', 'github'],
    ['network', 'clearnet'],
    ['source', 'crawlstr/1'],
    ['alt', 'Web index observation: Crwalstr — a browser-based web crawler for Nostr'],
  ],
};

/** §4 self-consistent event (d matches u, x matches content). */
export const EXAMPLE_EVENT_SELF_CONSISTENT = {
  kind: 39697,
  content: '{"title":"Example Page","description":"A page about examples.","image":"https://example.com/og.jpg"}',
  tags: [
    ['d', 'widx:3641c5f2274c5471278ab5bf1df6d185'],
    ['u', 'https://example.com/page'],
    ['t', 'nostr'],
    ['t', 'privacy'],
    ['l', 'en'],
    ['x', '2a5cbdf44513f552fb571d6c6de2ddf16c5452b235cc887980b52898fb38e7c1'],
    ['v', '1'],
    ['published', '1786200000'],
    ['source', 'crawlstr/1'],
    ['alt', 'Web index observation: Example Page'],
  ],
};

/**
 * Negative cases: [label, mutator-description, event-with-defect,
 * substring expected in one of the validator errors].
 * Built from the self-consistent §4 event so each case isolates one defect.
 */
export const INVALID_CASES = /** @type {const} */ ([
  [
    'wrong kind',
    {
      kind: 1,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags,
    },
    'wrong kind',
  ],
  [
    'missing d',
    {
      kind: 39697,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags.filter(([n]) => n !== 'd'),
    },
    'missing d tag',
  ],
  [
    'bad d (does not match u)',
    {
      kind: 39697,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags.map(([n, v]) =>
        n === 'd' ? ['d', 'widx:00000000000000000000000000000000'] : [n, v]),
    },
    'd tag does not match',
  ],
  [
    'missing u',
    {
      kind: 39697,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags.filter(([n]) => n !== 'u'),
    },
    'missing u tag',
  ],
  [
    'non-http u',
    {
      kind: 39697,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags.map(([n, v]) =>
        n === 'u' ? ['u', 'ftp://example.com/page'] : [n, v]),
    },
    'not a valid http(s) URL',
  ],
  [
    'bad x',
    {
      kind: 39697,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags.map(([n, v]) =>
        n === 'x' ? ['x', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'] : [n, v]),
    },
    'x tag does not match',
  ],
  [
    'wrong version',
    {
      kind: 39697,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags.map(([n, v]) =>
        n === 'v' ? ['v', '2'] : [n, v]),
    },
    'unsupported web document schema version',
  ],
  [
    'missing alt',
    {
      kind: 39697,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags.filter(([n]) => n !== 'alt'),
    },
    'missing alt tag',
  ],
  [
    'empty title',
    {
      kind: 39697,
      content: '{"title":""}',
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags.filter(([n]) => n !== 'x'),
    },
    'title must be 1-300 characters',
  ],
  [
    'non-JSON content',
    {
      kind: 39697,
      content: 'not json',
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags.filter(([n]) => n !== 'x'),
    },
    'not valid JSON with a title',
  ],
  [
    'bad topic shape',
    {
      kind: 39697,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: [...EXAMPLE_EVENT_SELF_CONSISTENT.tags.filter(([n]) => n !== 'x' && n !== 't'), ['t', 'Not A Topic']],
    },
    'topic (t) tags must be lowercase alphanumeric words',
  ],
  [
    'bad language code',
    {
      kind: 39697,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags.map(([n, v]) =>
        n === 'l' ? ['l', 'english'] : [n, v]),
    },
    'l tag is not a valid ISO 639-1 language code',
  ],
  [
    'bad published',
    {
      kind: 39697,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: EXAMPLE_EVENT_SELF_CONSISTENT.tags.map(([n, v]) =>
        n === 'published' ? ['published', 'tomorrow'] : [n, v]),
    },
    'published tag must be a unix timestamp',
  ],
  [
    'bad mime',
    {
      kind: 39697,
      content: EXAMPLE_EVENT_SELF_CONSISTENT.content,
      tags: [...EXAMPLE_EVENT_SELF_CONSISTENT.tags, ['mime', 'not a mime']],
    },
    'mime tag is not a valid MIME type',
  ],
]);
