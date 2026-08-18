/**
 * NIP-50 `search` filter parsing + SIP-01 operator semantics.
 *
 * NIP-50 defines the `search` filter field and sanctions `key:value`
 * extension pairs (relays SHOULD ignore extensions they don't support).
 * SIP-01 §15 defines the meaning of the web-search operators on aware
 * relays: site:, domain:, url:, inurl:, title:, topic:, type:, platform:,
 * category:, network:, country:, mime:, filetype:, source:, lang:, before:,
 * after:, distinct:domain — each with a negated `-op:` form.
 *
 * This relay additionally supports the relay-profile operators `indexer:`,
 * `x:` and `d:` (documented in docs/API.md). Unknown operators are ignored
 * per NIP-50, so mixed-reality query fan-out stays safe.
 *
 * Plain ES module JavaScript: shared by the Worker (SQL building), the
 * browser UI (query preview), and the Node test suite.
 *
 * @module shared/search-query
 */

import { normalizeIndexUrl, searchHostValue } from './sip01.js';

/** Operators this relay implements (advertised in NIP-11 `uncaged_index.filters`). */
export const SUPPORTED_NIP50_OPERATORS = /** @type {const} */ ([
  'site', 'domain', 'url', 'inurl', 'title', 'topic', 'type', 'platform',
  'category', 'network', 'country', 'mime', 'filetype', 'source', 'lang',
  'before', 'after', 'indexer', 'x', 'd', 'distinct:domain',
]);

/**
 * @typedef {Object} SearchOp
 * @property {string} op       Operator name (lowercased).
 * @property {string} value    Raw operator value.
 * @property {boolean} negated True for the `-op:value` form.
 */

/**
 * @typedef {Object} ParsedSearchQuery
 * @property {string[]} keywords  Plain lowercase terms (AND semantics).
 * @property {string[]} phrases   Exact quoted phrases (AND semantics).
 * @property {SearchOp[]} ops     Recognized operators in order.
 * @property {string[]} ignored   `key:value` pairs that are not supported
 *                                (kept for transparency; ignored per NIP-50).
 * @property {boolean} distinctDomain  `distinct:domain` present.
 * @property {string} raw         Original query string.
 */

const KNOWN_OPS = new Set(SUPPORTED_NIP50_OPERATORS.filter((op) => op !== 'distinct:domain'));

/**
 * Parse a NIP-50 search string. Grammar:
 *
 *   query    := token*
 *   token    := phrase | operator | word
 *   phrase   := '"' ... '"'                (exact substring)
 *   operator := ['-'] name ':' value       (value may be "quoted")
 *   word     := bare whitespace-delimited text (case-insensitive substring)
 *
 * @param {string} input
 * @returns {ParsedSearchQuery}
 */
export function parseSearchQuery(input) {
  const raw = String(input ?? '');
  /** @type {ParsedSearchQuery} */
  const out = { keywords: [], phrases: [], ops: [], ignored: [], distinctDomain: false, raw };

  // Tokenizer: op:"quoted value" stays one token, bare "quoted phrases" stay
  // whole, everything else splits on whitespace.
  const tokens = [];
  const re = /(-?[a-zA-Z][a-zA-Z0-9]*(?::[a-zA-Z]+)?:"[^"]*")|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ text: m[1], quoted: false }); // operator with quoted value
    } else if (m[2] !== undefined) {
      tokens.push({ text: m[2], quoted: true });
    } else {
      tokens.push({ text: m[3], quoted: false });
    }
  }

  for (const token of tokens) {
    const text = token.text;
    if (!text) continue;

    // Operator shape: [-]name:value (value may be "quoted"; `distinct:domain`
    // tokenizes as op `distinct` + value `domain`).
    const opMatch = /^(-?)([a-zA-Z][a-zA-Z0-9]*(?::[a-zA-Z]+)?):(.+)$/.exec(text);
    if (!token.quoted && opMatch) {
      const negated = opMatch[1] === '-';
      const op = opMatch[2].toLowerCase();
      let value = opMatch[3];
      // Strip surrounding quotes from values like site:"github.com".
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      if (op === 'distinct:domain' || op === 'distinct') {
        if (op === 'distinct:domain' || (op === 'distinct' && value === 'domain')) {
          if (!negated) out.distinctDomain = true;
        } else {
          out.ignored.push(`${op}:${value}`);
        }
        continue;
      }
      if (KNOWN_OPS.has(op)) {
        out.ops.push({ op, value, negated });
      } else {
        out.ignored.push(`${op}:${value}`);
      }
      continue;
    }

    // Bare `distinct:domain` without value.
    if (!token.quoted && /^(-?)distinct:domain$/.test(text)) {
      if (!text.startsWith('-')) out.distinctDomain = true;
      continue;
    }

    if (token.quoted) {
      out.phrases.push(text);
    } else {
      out.keywords.push(text.toLowerCase());
    }
  }

  return out;
}

/**
 * Parse a before:/after: value: unix seconds or an ISO date (YYYY-MM-DD,
 * optionally with time). Returns unix seconds or null.
 * @param {string} value
 * @returns {number | null}
 */
export function parseDateValue(value) {
  const v = value.trim();
  if (/^\d{1,16}$/.test(v)) return Number.parseInt(v, 10);
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(v)) {
    const ts = Date.parse(v.includes('T') ? v : v.replace(' ', 'T') + (v.includes(':') ? '' : 'T00:00:00') + 'Z');
    if (Number.isFinite(ts)) return Math.floor(ts / 1000);
  }
  return null;
}

/** Common filetype → MIME aliases (the `filetype:` operator). */
export const FILETYPE_MIME_MAP = /** @type {const} */ ({
  pdf: 'application/pdf',
  html: 'text/html',
  txt: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  md: 'text/markdown',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
});

/** Escape a string for use inside a SQL LIKE ... ESCAPE '\'. */
export function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * In-memory match of a parsed query against extracted SIP-01 fields (the
 * exact same semantics as the SQL builder — used for live subscription
 * delivery in the Durable Object and by tests).
 *
 * @param {ParsedSearchQuery} parsed
 * @param {import('./sip01.js').Sip01Fields & { indexer?: string, observation_count?: number, indexer_count?: number, last_seen?: number }} fields
 *   Document fields. `indexer` (event pubkey) enables the indexer: operator;
 *   `last_seen`/`observed_at` drive before:/after:.
 * @returns {boolean}
 */
export function matchSip01Search(parsed, fields) {
  const title = (fields.title || '').toLowerCase();
  const description = (fields.description || '').toLowerCase();
  const url = (fields.url || '').toLowerCase();
  const host = (fields.url_host || '').toLowerCase();
  const topics = fields.topics || [];
  const observed = fields.last_seen ?? fields.observed_at ?? 0;

  const textHit = (needleRaw) => {
    const needle = needleRaw.toLowerCase();
    return title.includes(needle) || description.includes(needle) || url.includes(needle);
  };

  for (const kw of parsed.keywords) if (!textHit(kw)) return false;
  for (const ph of parsed.phrases) if (!textHit(ph)) return false;

  for (const { op, value, negated } of parsed.ops) {
    let hit = false;
    switch (op) {
      case 'site': {
        const h = searchHostValue(value);
        hit = h !== undefined && (host === h || host.endsWith('.' + h));
        break;
      }
      case 'domain': {
        const h = searchHostValue(value);
        hit = h !== undefined && host === h;
        break;
      }
      case 'url': {
        const n = normalizeIndexUrl(value);
        hit = n !== null && (fields.url === n || url === value.toLowerCase());
        break;
      }
      case 'inurl':
        hit = url.includes(value.toLowerCase());
        break;
      case 'title':
        hit = title.includes(value.toLowerCase());
        break;
      case 'topic':
        hit = topics.includes(value.toLowerCase());
        break;
      case 'type':
        hit = fields.doc_type === value.toLowerCase();
        break;
      case 'platform':
        hit = fields.platform === value.toLowerCase();
        break;
      case 'category':
        hit = fields.category === value.toLowerCase();
        break;
      case 'network':
        hit = fields.network === value.toLowerCase();
        break;
      case 'country':
        hit = fields.country === value.toUpperCase();
        break;
      case 'lang':
        hit = fields.language === value.toLowerCase();
        break;
      case 'mime':
        hit = (fields.content_type || '') === value.toLowerCase();
        break;
      case 'filetype': {
        const ft = value.toLowerCase();
        const mimeAlias = FILETYPE_MIME_MAP[ft];
        hit = fields.file_ext === ft || (mimeAlias !== undefined && fields.content_type === mimeAlias);
        break;
      }
      case 'source':
        hit = fields.source === value || fields.software === value;
        break;
      case 'indexer':
        hit = fields.indexer === value.toLowerCase();
        break;
      case 'x':
        hit = fields.content_hash === value.toLowerCase();
        break;
      case 'd':
        hit = fields.d === value;
        break;
      case 'before': {
        const ts = parseDateValue(value);
        hit = ts !== null && observed > 0 && observed < ts;
        break;
      }
      case 'after': {
        const ts = parseDateValue(value);
        hit = ts !== null && observed >= ts;
        break;
      }
      default:
        hit = true; // unknown ops are ignored per NIP-50
    }
    if (negated ? hit : !hit) return false;
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* SQL building (Worker side; pure string logic, unit-tested in Node)  */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} SqlFragment
 * @property {string} sql
 * @property {any[]} params
 */

/**
 * Build the WHERE conditions over `sip01_documents` (alias `doc`) for a
 * parsed query. Returns conditions + params; the caller assembles the full
 * statement (so it can wrap for distinct:domain, ranking, etc.).
 *
 * `indexer:` and `source:` correlate against the observations table.
 *
 * @param {ParsedSearchQuery} parsed
 * @returns {{ conditions: string[], params: any[] }}
 */
export function buildSip01SearchConditions(parsed) {
  /** @type {string[]} */
  const conditions = [];
  /** @type {any[]} */
  const params = [];

  const pushText = (needleRaw, negated) => {
    const needle = `%${escapeLike(needleRaw.toLowerCase())}%`;
    const clause =
      `(lower(doc.title) LIKE ? ESCAPE '\\' OR lower(doc.description) LIKE ? ESCAPE '\\' OR lower(doc.canonical_url) LIKE ? ESCAPE '\\')`;
    conditions.push(negated ? `NOT ${clause}` : clause);
    params.push(needle, needle, needle);
  };

  for (const kw of parsed.keywords) pushText(kw, false);
  for (const ph of parsed.phrases) pushText(ph, false);

  for (const { op, value, negated } of parsed.ops) {
    /** @param {string} clause @param {any[]} values */
    const push = (clause, values) => {
      conditions.push(negated ? `NOT (${clause})` : `(${clause})`);
      params.push(...values);
    };

    switch (op) {
      case 'site': {
        const h = searchHostValue(value);
        if (h) push(`(doc.url_host = ? OR doc.url_host LIKE '%.' || ?)`, [h, h]);
        break;
      }
      case 'domain': {
        const h = searchHostValue(value);
        if (h) push(`doc.url_host = ?`, [h]);
        break;
      }
      case 'url': {
        const n = normalizeIndexUrl(value);
        push(`doc.canonical_url = ?`, [n ?? value]);
        break;
      }
      case 'inurl':
        push(`lower(doc.canonical_url) LIKE ? ESCAPE '\\'`, [`%${escapeLike(value.toLowerCase())}%`]);
        break;
      case 'title':
        push(`lower(doc.title) LIKE ? ESCAPE '\\'`, [`%${escapeLike(value.toLowerCase())}%`]);
        break;
      case 'topic':
        push(`EXISTS (SELECT 1 FROM json_each(doc.topics) je WHERE je.value = ?)`, [value.toLowerCase()]);
        break;
      case 'type':
        push(`doc.doc_type = ?`, [value.toLowerCase()]);
        break;
      case 'platform':
        push(`doc.platform = ?`, [value.toLowerCase()]);
        break;
      case 'category':
        push(`doc.category = ?`, [value.toLowerCase()]);
        break;
      case 'network':
        push(`doc.network = ?`, [value.toLowerCase()]);
        break;
      case 'country':
        push(`doc.country = ?`, [value.toUpperCase()]);
        break;
      case 'lang':
        push(`doc.language = ?`, [value.toLowerCase()]);
        break;
      case 'mime':
        push(`doc.content_type = ?`, [value.toLowerCase()]);
        break;
      case 'filetype': {
        const ft = value.toLowerCase();
        const mimeAlias = FILETYPE_MIME_MAP[ft];
        if (mimeAlias) {
          push(`(doc.file_ext = ? OR doc.content_type = ?)`, [ft, mimeAlias]);
        } else {
          push(`doc.file_ext = ?`, [ft]);
        }
        break;
      }
      case 'source':
        push(
          `EXISTS (SELECT 1 FROM sip01_observations so WHERE so.d = doc.d AND so.source = ?)`,
          [value],
        );
        break;
      case 'indexer':
        push(
          `EXISTS (SELECT 1 FROM sip01_observations io WHERE io.d = doc.d AND io.pubkey = ?)`,
          [value.toLowerCase()],
        );
        break;
      case 'x':
        push(`doc.content_hash = ?`, [value.toLowerCase()]);
        break;
      case 'd':
        push(`doc.d = ?`, [value]);
        break;
      case 'before': {
        const ts = parseDateValue(value);
        if (ts !== null) push(`doc.last_seen < ?`, [ts]);
        break;
      }
      case 'after': {
        const ts = parseDateValue(value);
        if (ts !== null) push(`doc.last_seen >= ?`, [ts]);
        break;
      }
      default:
        break; // unknown operators ignored per NIP-50
    }
  }

  return { conditions, params };
}

/**
 * Rank expression for SIP-01 search results (higher is better). NIP-50:
 * results are returned in descending order of quality, not created_at.
 *
 * Signals: keyword coverage of the title/description, independent indexer
 * agreement (the core SIP-01 signal), and freshness as a tiebreak. Kept as
 * pure SQL so D1 evaluates it inside the index scan.
 *
 * @param {ParsedSearchQuery} parsed
 * @returns {{ rankSql: string, params: any[] }}
 */
export function buildSip01Rank(parsed) {
  /** @type {any[]} */
  const params = [];
  const parts = [];

  // +4 per keyword/phrase present in the title, +2 in the description.
  for (const termRaw of [...parsed.keywords, ...parsed.phrases]) {
    const term = `%${escapeLike(termRaw.toLowerCase())}%`;
    parts.push(`(CASE WHEN lower(doc.title) LIKE ? ESCAPE '\\' THEN 4 ELSE 0 END)`);
    params.push(term);
    parts.push(`(CASE WHEN lower(doc.description) LIKE ? ESCAPE '\\' THEN 2 ELSE 0 END)`);
    params.push(term);
  }

  // Independent indexer agreement: log-ish bounded boost (capped at +8).
  parts.push(`(CASE WHEN doc.indexer_count >= 8 THEN 8 ELSE doc.indexer_count END)`);

  // Recency tiebreak, small bounded term (newer last_seen → up to +2).
  parts.push(`(CASE WHEN doc.last_seen > 0 THEN 2.0 * (doc.last_seen % 1000000) / 1000000.0 ELSE 0 END)`);

  const rankSql = parts.length > 0 ? parts.join(' + ') : '0';
  return { rankSql, params };
}

/**
 * Assemble the full SIP-01 search statement: ranked matching documents
 * joined through observations to the underlying kind 39697 events, so a
 * search returns real Nostr events (one per indexer observation) in rank
 * order — exactly what search engines need to compute independent agreement.
 *
 * @param {ParsedSearchQuery} parsed
 * @param {number} limit Max events to return (already clamped by the caller).
 * @param {{ extraConditions?: string[], extraParams?: any[] }} [extras]
 *   Additional event-level restrictions (alias `e`): authors, ids,
 *   since/until, `#tag` EXISTS clauses — the NIP-50 "other filter fields".
 * @returns {SqlFragment}
 */
export function buildSip01SearchSql(parsed, limit, extras = {}) {
  const { conditions, params } = buildSip01SearchConditions(parsed);
  const { rankSql, params: rankParams } = buildSip01Rank(parsed);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const docSelect = `
    SELECT doc.d AS d, doc.last_seen AS last_seen, (${rankSql}) AS rank
    FROM sip01_documents doc
    ${where}
  `;

  // distinct:domain — best-ranked row per host (SQLite bare-column + MAX
  // aggregate semantics: bare columns come from a row with the max value).
  const docSet = parsed.distinctDomain
    ? `
    SELECT d, MAX(rank) AS rank, MAX(last_seen) AS last_seen FROM (
      SELECT doc.d AS d, doc.url_host AS url_host, doc.last_seen AS last_seen, (${rankSql}) AS rank
      FROM sip01_documents doc
      ${where}
    ) GROUP BY url_host
  `
    : docSelect;

  const extraWhere = extras.extraConditions && extras.extraConditions.length > 0
    ? `WHERE ${extras.extraConditions.join(' AND ')}`
    : '';

  const sql = `
    SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig, r.rank
    FROM (${docSet}) r
    JOIN sip01_observations o ON o.d = r.d
    JOIN events e ON e.id = o.event_id
    ${extraWhere}
    ORDER BY r.rank DESC, e.created_at DESC
    LIMIT ?
  `;

  // Parameter order follows textual order in the assembled statement:
  // rank expression (SELECT), document WHERE, event-level WHERE, LIMIT.
  const baseParams = [...rankParams, ...params, ...(extras.extraParams ?? []), limit];

  return { sql, params: baseParams };
}
