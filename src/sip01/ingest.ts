/**
 * SIP-01 ingestion pipeline — maintains the document/observation/indexer
 * tables as kind 39697 events flow through the relay.
 *
 * Invariants:
 *  - The canonical `events` table remains the source of truth; these tables
 *    are derived acceleration structures and are rebuilt from it by
 *    scripts/reindex if they ever drift.
 *  - One observation row per live (pubkey, d) — addressable replacement in
 *    the main event path removes the superseded row first.
 *  - A document row exists exactly while ≥1 observation of its `d` exists.
 *  - Independent observations are never merged into one fake event: the
 *    document row aggregates, the observation rows keep provenance.
 *
 * @module src/sip01/ingest
 */

import { extractSip01Fields } from '../../shared/sip01.js';
import type { NostrEvent } from '../types';

type Session = D1DatabaseSession;

/** Increment a relay metric counter (best-effort, never throws). */
export async function bumpMetric(session: Session, key: string, delta = 1): Promise<void> {
  try {
    await session
      .prepare(
        `INSERT INTO relay_metrics (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
      )
      .bind(key, delta)
      .run();
  } catch (error) {
    console.error(`metric bump failed for ${key}:`, error);
  }
}

/**
 * Ingest one validated kind 39697 event after it was stored in `events`.
 * Assumes any superseded (pubkey, d) observation was already removed.
 */
export async function ingestSip01Observation(session: Session, event: NostrEvent): Promise<void> {
  const fields = extractSip01Fields(event as any);
  if (!fields) {
    console.error(`sip01: could not extract fields from event ${event.id}`);
    return;
  }

  const topics = JSON.stringify(fields.topics ?? []);
  const statements: D1PreparedStatement[] = [];

  // 1. The observation itself.
  statements.push(
    session
      .prepare(
        `INSERT INTO sip01_observations (event_id, d, pubkey, created_at, content_hash, source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(
        event.id,
        fields.d,
        event.pubkey,
        event.created_at,
        fields.content_hash ?? null,
        fields.source ?? null,
      ),
  );

  // 2. Document upsert — the latest observation (by created_at) provides the
  //    descriptive fields; aggregates are recomputed in step 3.
  const docValues = [
    fields.d,
    fields.url,
    fields.url_host,
    fields.title,
    fields.description ?? null,
    fields.image ?? null,
    fields.content_hash ?? null,
    fields.language ?? null,
    fields.content_type ?? null,
    fields.doc_type ?? null,
    fields.platform ?? null,
    fields.category ?? null,
    fields.network ?? null,
    fields.country ?? null,
    fields.file_ext ?? null,
    topics,
    fields.published_at ?? null,
    event.created_at, // first_seen (initial)
    event.created_at, // last_seen (initial)
    event.id,
  ];
  statements.push(
    session
      .prepare(
        `INSERT INTO sip01_documents (
           d, canonical_url, url_host, title, description, image, content_hash,
           language, content_type, doc_type, platform, category, network, country,
           file_ext, topics, published_at, first_seen, last_seen, last_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(d) DO UPDATE SET
           canonical_url = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.canonical_url ELSE sip01_documents.canonical_url END,
           url_host      = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.url_host      ELSE sip01_documents.url_host      END,
           title         = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.title         ELSE sip01_documents.title         END,
           description   = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.description   ELSE sip01_documents.description   END,
           image         = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.image         ELSE sip01_documents.image         END,
           content_hash  = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.content_hash  ELSE sip01_documents.content_hash  END,
           language      = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.language      ELSE sip01_documents.language      END,
           content_type  = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.content_type  ELSE sip01_documents.content_type  END,
           doc_type      = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.doc_type      ELSE sip01_documents.doc_type      END,
           platform      = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.platform      ELSE sip01_documents.platform      END,
           category      = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.category      ELSE sip01_documents.category      END,
           network       = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.network       ELSE sip01_documents.network       END,
           country       = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.country       ELSE sip01_documents.country       END,
           file_ext      = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.file_ext      ELSE sip01_documents.file_ext      END,
           topics        = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.topics        ELSE sip01_documents.topics        END,
           published_at  = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.published_at  ELSE sip01_documents.published_at  END,
           last_event_id = CASE WHEN excluded.last_seen >= sip01_documents.last_seen THEN excluded.last_event_id ELSE sip01_documents.last_event_id END`,
      )
      .bind(...docValues),
  );

  // 3. Document aggregates from the observation set (provenance-preserving).
  statements.push(
    session
      .prepare(
        `UPDATE sip01_documents SET
           observation_count = (SELECT COUNT(*) FROM sip01_observations WHERE d = ?),
           indexer_count     = (SELECT COUNT(DISTINCT pubkey) FROM sip01_observations WHERE d = ?),
           first_seen        = (SELECT MIN(created_at) FROM sip01_observations WHERE d = ?),
           last_seen         = (SELECT MAX(created_at) FROM sip01_observations WHERE d = ?)
         WHERE d = ?`,
      )
      .bind(fields.d, fields.d, fields.d, fields.d, fields.d),
  );

  // 4. Indexer upsert + aggregates.
  statements.push(
    session
      .prepare(
        `INSERT INTO sip01_indexers (pubkey, software, software_version, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pubkey) DO UPDATE SET
           software         = COALESCE(excluded.software, sip01_indexers.software),
           software_version = COALESCE(excluded.software_version, sip01_indexers.software_version),
           last_seen        = MAX(sip01_indexers.last_seen, excluded.last_seen),
           first_seen       = MIN(sip01_indexers.first_seen, excluded.first_seen)`,
      )
      .bind(event.pubkey, fields.software ?? null, fields.software_version ?? null, event.created_at, event.created_at),
  );
  statements.push(
    session
      .prepare(
        `UPDATE sip01_indexers SET
           observation_count = (SELECT COUNT(*) FROM sip01_observations WHERE pubkey = ?),
           document_count    = (SELECT COUNT(DISTINCT d) FROM sip01_observations WHERE pubkey = ?)
         WHERE pubkey = ?`,
      )
      .bind(event.pubkey, event.pubkey, event.pubkey),
  );

  // D1 batches cap at 100 statements; this is 6.
  await session.batch(statements);
}

/**
 * Remove observations by event id (addressable replacement, kind-5 deletion,
 * pruning) and repair the derived document/indexer rows. Documents and
 * indexers left with zero observations are removed.
 */
export async function removeSip01Observations(session: Session, eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;

  const placeholders = eventIds.map(() => '?').join(',');
  const affected = await session
    .prepare(`SELECT event_id, d, pubkey FROM sip01_observations WHERE event_id IN (${placeholders})`)
    .bind(...eventIds)
    .all();

  if (!affected.results || affected.results.length === 0) return;

  const ds = new Set<string>();
  const pubkeys = new Set<string>();
  for (const row of affected.results) {
    ds.add(row.d as string);
    pubkeys.add(row.pubkey as string);
  }

  const statements: D1PreparedStatement[] = [];
  statements.push(
    session.prepare(`DELETE FROM sip01_observations WHERE event_id IN (${placeholders})`).bind(...eventIds),
  );

  for (const d of ds) {
    statements.push(
      session
        .prepare(
          `UPDATE sip01_documents SET
             observation_count = (SELECT COUNT(*) FROM sip01_observations WHERE d = ?),
             indexer_count     = (SELECT COUNT(DISTINCT pubkey) FROM sip01_observations WHERE d = ?),
             first_seen        = COALESCE((SELECT MIN(created_at) FROM sip01_observations WHERE d = ?), first_seen),
             last_seen         = COALESCE((SELECT MAX(created_at) FROM sip01_observations WHERE d = ?), last_seen)
           WHERE d = ?`,
        )
        .bind(d, d, d, d, d),
    );
    statements.push(
      session
        .prepare(`DELETE FROM sip01_documents WHERE d = ? AND NOT EXISTS (SELECT 1 FROM sip01_observations WHERE d = ?)`)
        .bind(d, d),
    );
  }

  for (const pubkey of pubkeys) {
    statements.push(
      session
        .prepare(
          `UPDATE sip01_indexers SET
             observation_count = (SELECT COUNT(*) FROM sip01_observations WHERE pubkey = ?),
             document_count    = (SELECT COUNT(DISTINCT d) FROM sip01_observations WHERE pubkey = ?)
           WHERE pubkey = ?`,
        )
        .bind(pubkey, pubkey, pubkey),
    );
    statements.push(
      session
        .prepare(`DELETE FROM sip01_indexers WHERE pubkey = ? AND NOT EXISTS (SELECT 1 FROM sip01_observations WHERE pubkey = ?)`)
        .bind(pubkey, pubkey),
    );
  }

  for (let i = 0; i < statements.length; i += 90) {
    await session.batch(statements.slice(i, i + 90));
  }
}

/** Whether an event id currently has a SIP-01 observation row. */
export async function hasSip01Observation(session: Session, eventId: string): Promise<boolean> {
  const row = await session
    .prepare('SELECT event_id FROM sip01_observations WHERE event_id = ? LIMIT 1')
    .bind(eventId)
    .first();
  return row !== null;
}
