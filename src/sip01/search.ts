/**
 * NIP-50 search execution for the relay.
 *
 * Two paths:
 *
 *  - SIP-01 path (kind 39697): the query is parsed for web-search operators
 *    (SIP-01 §15 + relay-profile `indexer:`/`x:`/`d:`), matched against the
 *    `sip01_documents` index, ranked, then joined back to the underlying
 *    observation events — one event per indexer observation, in rank order,
 *    so consumers can compute independent indexer agreement directly.
 *
 *  - Generic path (other kinds): plain case-insensitive substring matching
 *    over `events.content` — NIP-50's baseline ("relays SHOULD perform
 *    matching against content").
 *
 * Unknown `key:value` extensions are ignored per NIP-50.
 *
 * @module src/sip01/search
 */

import {
  parseSearchQuery,
  buildSip01SearchSql,
  escapeLike,
} from '../../shared/search-query.js';
import { SIP01_KIND } from '../../shared/sip01.js';
import { SIP01_INDEXING, SEARCH_MAX_RESULTS } from '../config';
import type { NostrEvent, NostrFilter } from '../types';

type Session = D1DatabaseSession;

/** Clamp a search result limit. */
export function clampSearchLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return Math.min(50, SEARCH_MAX_RESULTS);
  return Math.min(limit, SEARCH_MAX_RESULTS);
}

/** Build event-level WHERE fragments shared by both search paths. */
function eventFilterExtras(filter: NostrFilter): { conditions: string[]; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter.ids && filter.ids.length > 0) {
    conditions.push(`e.id IN (${filter.ids.map(() => '?').join(',')})`);
    params.push(...filter.ids);
  }
  if (filter.authors && filter.authors.length > 0) {
    conditions.push(`e.pubkey IN (${filter.authors.map(() => '?').join(',')})`);
    params.push(...filter.authors);
  }
  if (filter.since) {
    conditions.push('e.created_at >= ?');
    params.push(filter.since);
  }
  if (filter.until) {
    conditions.push('e.created_at <= ?');
    params.push(filter.until);
  }

  // Single-letter `#tag` filters as EXISTS against the multi-value tag cache.
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
      const tagName = key.substring(1);
      if (tagName.length !== 1) continue; // NIP-01: only single-letter tags are indexed
      conditions.push(
        `EXISTS (SELECT 1 FROM event_tags_cache_multi em WHERE em.event_id = e.id AND em.tag_type = ? AND em.tag_value IN (${values.map(() => '?').join(',')}))`,
      );
      params.push(tagName, ...values);
    }
  }

  return { conditions, params };
}

/**
 * Execute a NIP-50 search filter and return matching events.
 *
 * Result ordering: SIP-01-ranked kind 39697 observations first (NIP-50:
 * descending quality), then generically matched events of other requested
 * kinds by created_at. The caller applies subscription limits.
 */
export async function executeSearch(session: Session, filter: NostrFilter): Promise<NostrEvent[]> {
  const limit = clampSearchLimit(filter.limit);
  const parsed = parseSearchQuery(String(filter.search ?? '').slice(0, 500));

  const kinds = Array.isArray(filter.kinds) ? filter.kinds : undefined;
  const wantSip01 = SIP01_INDEXING && (!kinds || kinds.includes(SIP01_KIND));
  const otherKinds = kinds ? kinds.filter((k) => k !== SIP01_KIND) : undefined;

  const extras = eventFilterExtras(filter);
  const events: NostrEvent[] = [];
  const seen = new Set<string>();

  // --- SIP-01 ranked path over the document index.
  if (wantSip01) {
    const { sql, params } = buildSip01SearchSql(parsed, limit, {
      extraConditions: extras.conditions,
      extraParams: extras.params,
    });
    try {
      const result = await session.prepare(sql).bind(...params).all();
      for (const row of result.results ?? []) {
        if (seen.has(row.id as string)) continue;
        seen.add(row.id as string);
        events.push({
          id: row.id as string,
          pubkey: row.pubkey as string,
          created_at: row.created_at as number,
          kind: row.kind as number,
          tags: JSON.parse(row.tags as string),
          content: row.content as string,
          sig: row.sig as string,
        });
      }
    } catch (error) {
      console.error('sip01 search query failed:', error, sql);
    }
  }

  // --- Generic content path for other kinds.
  const genericKinds = kinds === undefined ? undefined : otherKinds;
  const wantGeneric = kinds === undefined || (genericKinds !== undefined && genericKinds.length > 0);
  if (wantGeneric && (parsed.keywords.length > 0 || parsed.phrases.length > 0)) {
    const conditions: string[] = [];
    const params: any[] = [];

    for (const termRaw of [...parsed.keywords, ...parsed.phrases]) {
      conditions.push(`lower(e.content) LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(termRaw.toLowerCase())}%`);
    }
    if (genericKinds && genericKinds.length > 0) {
      conditions.push(`e.kind IN (${genericKinds.map(() => '?').join(',')})`);
      params.push(...genericKinds);
    }
    if (filter.ids && filter.ids.length > 0) {
      conditions.push(`e.id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }
    if (filter.authors && filter.authors.length > 0) {
      conditions.push(`e.pubkey IN (${filter.authors.map(() => '?').join(',')})`);
      params.push(...filter.authors);
    }
    if (filter.since) {
      conditions.push('e.created_at >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      conditions.push('e.created_at <= ?');
      params.push(filter.until);
    }

    const sql = `
      SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig
      FROM events e
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY e.created_at DESC
      LIMIT ?
    `;
    params.push(limit);

    try {
      const result = await session.prepare(sql).bind(...params).all();
      for (const row of result.results ?? []) {
        if (seen.has(row.id as string)) continue;
        seen.add(row.id as string);
        events.push({
          id: row.id as string,
          pubkey: row.pubkey as string,
          created_at: row.created_at as number,
          kind: row.kind as number,
          tags: JSON.parse(row.tags as string),
          content: row.content as string,
          sig: row.sig as string,
        });
      }
    } catch (error) {
      console.error('generic search query failed:', error);
    }
  }

  return events.slice(0, limit);
}
