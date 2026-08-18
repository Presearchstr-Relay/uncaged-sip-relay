/**
 * SIP-01 (Search Index Protocol) — canonical implementation for this relay.
 *
 * Byte-compatible with the SIP-01 v1.2 specification
 * (https://github.com/NostrDanish/SIP-01 → public/spec/SIP-01.md) and with
 * every ecosystem implementation:
 *
 *   - SIP-01 site           src/lib/sip01-utils.ts   (explorer validator)
 *   - 0xSearchstr/UNCAGED   src/lib/webIndex.ts     (publisher/reader)
 *   - Crawlstr              src/crawler/webIndex.ts (crawler publisher)
 *   - UNCAGED-Index-Relay   src/web-document.ts     (relay-profile validator)
 *
 * Validation error wording mirrors the UNCAGED Index Relay ingestion profile
 * (SIP-01 §12.4: invalid observations are rejected with `OK false invalid:`).
 *
 * Plain ES module JavaScript on purpose: shared verbatim by the Cloudflare
 * Worker (src/), the browser UI (ui/), and the Node test suite (tests/).
 *
 * @module shared/sip01
 */

import { sha256Hex, sha256HexSync } from './sha256.js';

/** Web Index Observation kind (addressable range 30000–39999). */
export const SIP01_KIND = 39697;

/** Current schema version (the `v` tag). */
export const SIP01_SCHEMA_VERSION = '1';

/** d-tag namespace prefix (SIP-01 §3). */
export const SIP01_D_PREFIX = 'widx:';

/* Hard caps (spec §5/§6) */
export const MAX_URL_LEN = 2048;
export const MAX_TITLE_LEN = 300;
export const MAX_DESCRIPTION_LEN = 1000;
export const MAX_IMAGE_LEN = 2048;
export const MAX_ALT_LEN = 1000;
export const MAX_SOURCE_LEN = 100;
export const MAX_TOPICS = 8;

/** Tracking parameters stripped during normalization (spec §7 step 5). */
export const TRACKING_PARAMS = /** @type {const} */ ([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'dclid', 'mc_cid', 'mc_eid', 'igshid', 'ref_src',
  'spm', 'si',
]);

const TRACKING_SET = new Set(TRACKING_PARAMS);

/** Topic tag shape (spec §6). */
export const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** ISO 639-1 two-letter language code (the `l` tag, spec §6/§12.5). */
export const LANG_RE = /^[a-z]{2}$/;

/** Extension keyword shape (spec §9.1 rule 5). */
export const EXTENSION_VALUE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/;

/** MIME type with optional parameters. */
export const MIME_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}(;\s*[^\s;=]+=[^\s;]+)*$/;

/** Published tag: unix seconds. */
const PUBLISHED_RE = /^\d{1,16}$/;

/** Content hash: lowercase 64-char hex SHA-256. */
const HASH_RE = /^[0-9a-f]{64}$/;

/** Dotted-quad IPv4 host. */
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** Registered core tags (spec §5/§6). */
export const CORE_TAGS = ['d', 'u', 'v', 'alt', 't', 'l', 'x', 'published', 'source'];

/** Registered extension tags (spec §9.2). */
export const EXTENSION_TAGS = ['type', 'platform', 'category', 'network', 'country', 'mime'];

/** All tags this schema revision knows about (forwards-compat notices use it). */
export const KNOWN_TAGS = new Set([...CORE_TAGS, ...EXTENSION_TAGS]);

/**
 * Normalize a URL per SIP-01 §7. Implementations across the ecosystem MUST
 * produce byte-identical output for the same page or `d`-tag deduplication
 * breaks. Returns null for invalid or non-http(s) URLs.
 *
 *   1. Parse; reject anything not http:// or https://.
 *   2. Lowercase scheme/host (WHATWG parser); strip a leading `www.`.
 *   3. Remove default ports (handled by the WHATWG parser).
 *   4. Remove the fragment entirely.
 *   5. Remove known tracking parameters (case-insensitive); keep the rest.
 *   6. Sort remaining query parameters alphabetically by key (stable).
 *   7. Remove a trailing `/` from non-root paths.
 *   8. Re-encode via URL.toString().
 *
 * @param {string} input
 * @returns {string | null}
 */
export function normalizeIndexUrl(input) {
  if (typeof input !== 'string') return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  // 2. Strip a leading www. (scheme/host are lowercased by the parser).
  if (url.hostname.startsWith('www.')) {
    url.hostname = url.hostname.slice(4);
  }

  // 3. Default ports are dropped by the URL parser itself.

  // 4. Fragment never identifies content for indexing purposes.
  url.hash = '';

  // 5–6. Strip tracking params, keep everything else, sort deterministically.
  // Assigning `url.search` unconditionally also normalizes away a bare `?`.
  const entries = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_SET.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted = new URLSearchParams();
  for (const [key, value] of entries) sorted.append(key, value);
  url.search = sorted.toString();

  // 7. Trailing slash on non-root paths.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/**
 * URL identity (spec §3): "widx:" + first 32 hex chars of sha256(normalized).
 * @param {string} normalizedUrl
 * @returns {Promise<string>}
 */
export async function documentId(normalizedUrl) {
  const hex = await sha256Hex(normalizedUrl);
  return `${SIP01_D_PREFIX}${hex.slice(0, 32)}`;
}

/** Synchronous variant of {@link documentId} (pure JS SHA-256). */
export function documentIdSync(normalizedUrl) {
  return `${SIP01_D_PREFIX}${sha256HexSync(normalizedUrl).slice(0, 32)}`;
}

/**
 * Content identity (spec §8): sha256(title + "\n" + description), absent
 * description treated as the empty string.
 * @param {string} title
 * @param {string} [description]
 * @returns {Promise<string>}
 */
export async function contentHash(title, description = '') {
  return sha256Hex(`${title}\n${description}`);
}

/** Synchronous variant of {@link contentHash}. */
export function contentHashSync(title, description = '') {
  return sha256HexSync(`${title}\n${description}`);
}

/** All values of the tags with the given name that carry a value. */
function tagValues(event, name) {
  return event.tags.filter((t) => t[0] === name && t[1]).map((t) => t[1]);
}

/** The single value of a tag expected at most once, or undefined. */
function tagValue(event, name) {
  return tagValues(event, name)[0];
}

/**
 * Parse the content JSON of a web index observation. Returns undefined when
 * the content is not a JSON object or `title` is not a string.
 */
export function parseWebDocumentContent(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const { title, description, image } = /** @type {Record<string, unknown>} */ (parsed);
  if (typeof title !== 'string') return undefined;
  return {
    title,
    ...(typeof description === 'string' && { description }),
    ...(typeof image === 'string' && { image }),
  };
}

/**
 * @typedef {Object} Sip01Validation
 * @property {boolean} valid    True when the event passes every SIP-01 v1 check.
 * @property {string[]} errors  Relay-profile rejection reasons (spec §12.4 wording).
 * @property {string[]} notices Non-fatal observations (e.g. unknown extension tags).
 */

/**
 * Fully validate a kind 39697 event, mirroring the UNCAGED Index Relay's
 * ingestion rules (SIP-01 §12.4 relay-side validation). Async because the
 * `d` ↔ `u` and `x` ↔ content checks require SHA-256.
 *
 * @param {import('./sip01').NostrEventLike} event
 * @returns {Promise<Sip01Validation>}
 */
export async function validateSip01Event(event) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const notices = [];

  if (!event || typeof event !== 'object' || event.kind !== SIP01_KIND) {
    return {
      valid: false,
      errors: [`wrong kind (expected ${SIP01_KIND}, got ${event && event.kind})`],
      notices,
    };
  }

  // --- Required tags: exactly one d, u, v, alt each.

  const dTags = event.tags.filter((t) => t[0] === 'd');
  if (dTags.length === 0 || !dTags[0][1]) errors.push('web document missing d tag');
  if (dTags.length > 1) errors.push('web document has multiple d tags');
  const dTag = dTags[0] && dTags[0][1];

  const uTags = event.tags.filter((t) => t[0] === 'u');
  if (uTags.length === 0 || !uTags[0][1]) errors.push('web document missing u tag');
  if (uTags.length > 1) errors.push('web document has multiple u tags');
  const uTag = uTags[0] && uTags[0][1];

  const vTags = event.tags.filter((t) => t[0] === 'v');
  if (vTags.length === 0 || !vTags[0][1]) errors.push('web document missing v tag');
  else if (vTags.length > 1) errors.push('web document has multiple v tags');
  else if (vTags[0][1] !== SIP01_SCHEMA_VERSION) {
    errors.push(`unsupported web document schema version "${vTags[0][1]}"`);
  }

  const altTags = event.tags.filter((t) => t[0] === 'alt');
  if (altTags.length === 0 || !altTags[0][1] || !altTags[0][1].trim()) {
    errors.push('web document missing alt tag');
  } else if (altTags.length > 1) {
    errors.push('web document has multiple alt tags');
  } else if (altTags[0][1].length > MAX_ALT_LEN) {
    errors.push(`alt tag exceeds ${MAX_ALT_LEN} characters`);
  }

  // --- URL allowlist + d ↔ normalized u consistency (spec §7, §11).

  let normalized = null;
  if (uTag !== undefined && uTag !== null && uTag !== '') {
    if (uTag.length > MAX_URL_LEN) errors.push(`u tag exceeds ${MAX_URL_LEN} characters`);
    normalized = normalizeIndexUrl(uTag);
    if (!normalized) {
      errors.push('u tag is not a valid http(s) URL');
    } else if (dTag) {
      const expected = await documentId(normalized);
      if (dTag !== expected) {
        errors.push('d tag does not match the normalized u tag (widx: + sha256(u)[0:32])');
      }
    }
  }

  // --- Content JSON: title required (1–300 trimmed), description/image capped.

  const content = parseWebDocumentContent(event.content || '');
  if (!content) {
    errors.push('web document content is not valid JSON with a title');
  } else {
    const trimmedTitle = content.title.trim();
    if (trimmedTitle.length === 0 || trimmedTitle.length > MAX_TITLE_LEN) {
      errors.push(`title must be 1-${MAX_TITLE_LEN} characters`);
    }
    if (content.description !== undefined && content.description.length > MAX_DESCRIPTION_LEN) {
      errors.push(`description exceeds ${MAX_DESCRIPTION_LEN} characters`);
    }
    if (content.image !== undefined) {
      let ok = false;
      try {
        ok = new URL(content.image).protocol === 'https:';
      } catch { /* ok stays false */ }
      if (!ok) errors.push('image must be an https URL');
      else if (content.image.length > MAX_IMAGE_LEN) {
        errors.push(`image exceeds ${MAX_IMAGE_LEN} characters`);
      }
    }
  }

  // --- Optional tags, validated when present.

  const topics = event.tags.filter((t) => t[0] === 't');
  if (topics.length > MAX_TOPICS) errors.push(`web document has more than ${MAX_TOPICS} topic tags`);
  for (const topic of topics) {
    if (!topic[1] || !TOPIC_RE.test(topic[1])) {
      errors.push('topic (t) tags must be lowercase alphanumeric words');
      break;
    }
  }

  const lang = tagValue(event, 'l');
  if (lang !== undefined && !LANG_RE.test(lang)) {
    errors.push('l tag is not a valid ISO 639-1 language code');
  }

  // The x tag is the content-agreement signal; an incorrect hash is worse
  // than none, so it is verified against the observed metadata (spec §8).
  const x = tagValue(event, 'x');
  if (x !== undefined) {
    if (!HASH_RE.test(x)) {
      errors.push('x tag must be a lowercase hex sha256 digest');
    } else if (content) {
      const expected = await contentHash(content.title, content.description ?? '');
      if (x !== expected) errors.push('x tag does not match sha256(title + \\n + description)');
    }
  }

  const published = tagValue(event, 'published');
  if (published !== undefined && !PUBLISHED_RE.test(published)) {
    errors.push('published tag must be a unix timestamp in seconds');
  }

  const source = tagValue(event, 'source');
  if (source !== undefined && source.length > MAX_SOURCE_LEN) {
    errors.push(`source tag exceeds ${MAX_SOURCE_LEN} characters`);
  }

  // Registered extension tags (spec §9.2).
  for (const name of ['type', 'platform', 'category', 'network']) {
    const value = tagValue(event, name);
    if (value !== undefined && !EXTENSION_VALUE_RE.test(value)) {
      errors.push(`${name} tag is not a valid keyword`);
    }
  }

  const country = tagValue(event, 'country');
  if (country !== undefined && !/^[a-zA-Z]{2}$/.test(country)) {
    errors.push('country tag must be an ISO 3166-1 alpha-2 code');
  }

  const mime = tagValue(event, 'mime');
  if (mime !== undefined && !MIME_RE.test(mime)) {
    errors.push('mime tag is not a valid MIME type');
  }

  // Unknown tags: forwards-compatibility notice (spec §9.1 rule 3).
  const unknown = [...new Set(event.tags.map((t) => t[0]).filter((n) => n && !KNOWN_TAGS.has(n)))];
  if (unknown.length > 0) {
    notices.push(`unknown extension tag(s) ignored: ${unknown.join(', ')}`);
  }

  return { valid: errors.length === 0, errors, notices };
}

/**
 * Build the domain hierarchy for a host: the host itself plus every dotted
 * parent suffix. `docs.github.com` → `["docs.github.com", "github.com"]`.
 * Bare TLDs and IP hosts yield only the host. Powers the `site:` operator.
 * @param {string} host
 * @returns {string[]}
 */
export function domainHierarchy(host) {
  if (!host || IPV4_RE.test(host) || host.includes(':')) return [host];
  const parts = host.split('.');
  const out = [host];
  for (let i = 1; i < parts.length - 1; i++) {
    out.push(parts.slice(i).join('.'));
  }
  return out;
}

/**
 * Lowercased file extension of a URL path's last segment when it looks like
 * a real extension (`/a/file.tar.gz` → `gz`); undefined otherwise.
 * @param {string} pathname
 * @returns {string | undefined}
 */
export function fileExtension(pathname) {
  const lastSegment = pathname.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const ext = lastSegment.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : undefined;
}

/**
 * Normalize a `site:`/`domain:` operator value to a bare host, forgiving
 * common input forms (`https://github.com/x` → `github.com`,
 * `GitHub.com.` → `github.com`, `www.github.com` → `github.com`).
 * Returns undefined when unusable.
 * @param {string} value
 * @returns {string | undefined}
 */
export function searchHostValue(value) {
  let v = String(value).trim().toLowerCase();
  if (!v) return undefined;
  if (v.includes('://')) {
    const normalized = normalizeIndexUrl(v);
    if (!normalized) return undefined;
    v = new URL(normalized).hostname;
  }
  if (v.startsWith('www.')) v = v.slice(4);
  if (v.endsWith('.')) v = v.slice(0, -1);
  if (v.includes('/')) v = v.split('/')[0];
  if (v.length > 253 || !/^[a-z0-9.\-:[\]]+$/.test(v)) return undefined;
  return v;
}

/**
 * @typedef {Object} Sip01Fields
 * Structured index fields extracted from a valid observation.
 * @property {string} d
 * @property {string} url                Normalized canonical URL.
 * @property {string} url_host           Lowercased hostname.
 * @property {string[]} url_domain_hierarchy  Host + dotted parent suffixes.
 * @property {string} [file_ext]         Lowercased path extension.
 * @property {string} title
 * @property {string} [description]
 * @property {string} [image]
 * @property {string} [content_hash]     The `x` tag.
 * @property {number} [published_at]     The `published` tag (page's claim).
 * @property {number} observed_at        Event `created_at` (crawler's claim).
 * @property {string} [source]           The `source` tag, e.g. `crawlstr/1`.
 * @property {string} [software]         Parsed from `source` before `/`.
 * @property {string} [software_version] Parsed from `source` after `/`.
 * @property {string[]} topics           Lowercased `t` tags.
 * @property {string} [language]         The `l` tag.
 * @property {string} [doc_type]         The `type` extension tag (lowercased).
 * @property {string} [platform]         The `platform` extension tag (lowercased).
 * @property {string} [category]         The `category` extension tag (lowercased).
 * @property {string} [network]          The `network` extension tag (lowercased).
 * @property {string} [country]          The `country` extension tag (UPPERCASED).
 * @property {string} [content_type]     The `mime` extension tag (lowercased).
 */

/**
 * Extract structured index fields from an observation event. Returns null
 * when the event is not a usable web document. Callers on the ingest path
 * run {@link validateSip01Event} first, so this stays cheap and pure.
 *
 * @param {import('./sip01').NostrEventLike} event
 * @returns {Sip01Fields | null}
 */
export function extractSip01Fields(event) {
  if (!event || event.kind !== SIP01_KIND) return null;

  const d = tagValue(event, 'd');
  const rawUrl = tagValue(event, 'u');
  if (!d || !rawUrl) return null;
  const url = normalizeIndexUrl(rawUrl);
  if (!url) return null;

  const content = parseWebDocumentContent(event.content || '');
  if (!content) return null;

  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  /** @type {Sip01Fields} */
  const fields = {
    d,
    url,
    url_host: host,
    url_domain_hierarchy: domainHierarchy(host),
    title: content.title,
    observed_at: event.created_at,
    topics: event.tags
      .filter((t) => t[0] === 't' && t[1] && TOPIC_RE.test(t[1]))
      .map((t) => t[1])
      .slice(0, MAX_TOPICS),
  };

  const ext = fileExtension(new URL(url).pathname);
  if (ext) fields.file_ext = ext;
  if (content.description) fields.description = content.description;
  if (content.image) fields.image = content.image;

  const x = tagValue(event, 'x');
  if (x && HASH_RE.test(x)) fields.content_hash = x;

  const published = tagValue(event, 'published');
  if (published && PUBLISHED_RE.test(published)) {
    fields.published_at = Number.parseInt(published, 10);
  }

  const source = tagValue(event, 'source');
  if (source) {
    fields.source = source;
    const slash = source.indexOf('/');
    if (slash > 0) {
      fields.software = source.slice(0, slash);
      fields.software_version = source.slice(slash + 1) || undefined;
    } else {
      fields.software = source;
    }
  }

  const lang = tagValue(event, 'l');
  if (lang && LANG_RE.test(lang)) fields.language = lang;

  for (const [tag, key] of [['type', 'doc_type'], ['platform', 'platform'], ['category', 'category'], ['network', 'network']]) {
    const value = tagValue(event, tag);
    if (value && EXTENSION_VALUE_RE.test(value)) fields[key] = value.toLowerCase();
  }

  const country = tagValue(event, 'country');
  if (country && /^[a-zA-Z]{2}$/.test(country)) fields.country = country.toUpperCase();

  const mime = tagValue(event, 'mime');
  if (mime && MIME_RE.test(mime)) fields.content_type = mime.toLowerCase();

  return fields;
}

/**
 * Cheap synchronous parse for display (browser explorer). Full validation is
 * {@link validateSip01Event}; this returns null for structurally unusable
 * events only.
 */
export function parseSip01Event(event) {
  const fields = extractSip01Fields(event);
  if (!fields) return null;
  return {
    ...fields,
    indexer: event.pubkey,
    event,
  };
}

/**
 * The `alt` tag convention string for an observation (spec §12.3).
 * @param {string} title
 * @returns {string}
 */
export function observationAlt(title) {
  return `Web index observation: ${title}`.slice(0, MAX_ALT_LEN);
}

/**
 * Build the tags+content of a minimal valid observation (used by tests and
 * the UI's d-tag calculator). Signing is the caller's job.
 */
export function buildIndexEventTemplate({ url, title, description, image, topics, language, source, published, extensions }) {
  const normalized = normalizeIndexUrl(url);
  if (!normalized) return null;
  const d = documentIdSync(normalized);
  /** @type {Record<string, string>} */
  const content = { title };
  if (description) content.description = description;
  if (image) content.image = image;

  const tags = [
    ['d', d],
    ['u', normalized],
    ['x', contentHashSync(title, description ?? '')],
    ['v', SIP01_SCHEMA_VERSION],
  ];
  for (const t of (topics || []).slice(0, MAX_TOPICS)) tags.push(['t', t]);
  if (language) tags.push(['l', language]);
  if (published) tags.push(['published', String(published)]);
  if (source) tags.push(['source', source]);
  if (extensions) {
    for (const [k, v] of Object.entries(extensions)) tags.push([k, v]);
  }
  tags.push(['alt', observationAlt(title)]);

  return { kind: SIP01_KIND, content: JSON.stringify(content), tags };
}

/**
 * @typedef {Object} NostrEventLike
 * @property {string} id
 * @property {string} pubkey
 * @property {number} created_at
 * @property {number} kind
 * @property {string[][]} tags
 * @property {string} content
 * @property {string} sig
 */
