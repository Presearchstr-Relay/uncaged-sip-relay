/**
 * UNCAGED SIP Relay — main Cloudflare Worker.
 *
 * A serverless SIP-01 search index relay: Nostr kind 39697 web-index
 * observations (https://github.com/NostrDanish/SIP-01) on Cloudflare Workers
 * + D1 + Durable Objects.
 *
 * Forked from Nosflare (https://github.com/Spl0itable/nosflare, MIT) — see
 * UPSTREAM.md for the inherited/modified component list.
 *
 * Request routing:
 *   GET /            + Upgrade: websocket            → Durable Object (Nostr protocol)
 *   GET /            + Accept: application/nostr+json → NIP-11 relay information
 *   GET /.well-known/nostr.json                      → NIP-05
 *   GET /api/*                                       → operator/dashboard JSON API
 *   POST /?notify-zap                                → zap receipt payment notification
 *   GET <anything else>                              → static operator UI (assets binding)
 *
 * @module src/relay-worker
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { Env, NostrEvent, NostrFilter, QueryResult, Nip05Response } from './types';
import * as config from './config';
import { RelayWebSocket } from './durable-object';
import { SIP01_KIND, validateSip01Event } from '../shared/sip01.js';
import { SUPPORTED_NIP50_OPERATORS } from '../shared/search-query.js';
import { SIP01_SCHEMA_STATEMENTS, SCHEMA_VERSION, migrationV7Statements, CACHED_TAG_NAMES } from './sip01/schema';
import { ingestSip01Observation, removeSip01Observations, bumpMetric } from './sip01/ingest';
import * as sipApi from './sip01/api';
import { executeSearch } from './sip01/search';
import { verifyZapReceipt, hasPaidForRelay, savePaidPubkey } from './pay';
import { serveMiniLanding } from './mini-landing';

// Import config values
const {
  relayInfo,
  RELAY_MODE,
  SIP01_ENABLED,
  SIP01_VALIDATION,
  SIP01_INDEXING,
  PAYMENT_MODE,
  PAY_TO_RELAY_ENABLED,
  RELAY_ACCESS_PRICE_SATS,
  relayNpub,
  nip05Users,
  enableAntiSpam,
  enableGlobalDuplicateCheck,
  antiSpamKinds,
  checkValidNip05,
  blockedNip05Domains,
  allowedNip05Domains,
  isIndexerAllowed,
  SIP01_MAX_EVENT_BYTES,
  NIP50_ENABLED,
  NIP45_ENABLED,
  NIP77_ENABLED,
  NEG_MAX_ITEMS,
  COUNT_MAX_ESTIMATE,
  DB_PRUNING_ENABLED,
  DB_SIZE_THRESHOLD_GB,
  DB_PRUNE_BATCH_SIZE,
  DB_PRUNE_TARGET_GB,
  pruneProtectedKinds,
  SIP01_PRUNE_ALLOWED,
} = config;

// Query optimization constants
const GLOBAL_MAX_EVENTS = 500;
const MAX_QUERY_COMPLEXITY = 1000;
const CHUNK_SIZE = 500;

// Re-export for the Durable Object
export { NEG_MAX_ITEMS };

/**
 * Per-isolate, idempotent database initialization. The Durable Object's first
 * EVENT/REQ/COUNT/NEG may arrive before any browser hit the landing page, so
 * the storage path guarantees the schema exists on its own.
 */
let dbInitPromise: Promise<void> | null = null;

export function ensureDatabase(db: D1Database): Promise<void> {
  if (!dbInitPromise) {
    dbInitPromise = initializeDatabase(db).catch((error) => {
      console.error('DB init error:', error);
      dbInitPromise = null; // allow retry on next request
    });
  }
  return dbInitPromise;
}

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

async function initializeDatabase(db: D1Database): Promise<void> {
  const dropSession = db.withSession('first-primary');

  try {
    await dropSession.prepare(`
      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `).run();
  } catch (_) {}

  const cleanupDone = await dropSession.prepare(
    "SELECT value FROM system_config WHERE key = 'cleanup_v1' LIMIT 1"
  ).first().catch(() => null);

  if (!cleanupDone || cleanupDone.value !== '1') {
    const dropIndexes = [
      'idx_events_pubkey',
      'idx_events_kind',
      'idx_events_created_at_kind',
      'idx_events_authors_kinds',
      'idx_events_tag_p_created_at',
      'idx_events_tag_e_created_at',
      'idx_events_tag_a_created_at',
      'idx_events_tag_t_created_at',
      'idx_events_tag_d_created_at',
      'idx_events_tag_r_created_at',
      'idx_events_tag_L_created_at',
      'idx_events_tag_s_created_at',
      'idx_events_tag_u_created_at',
      'idx_events_kind_tag_p',
      'idx_events_kind_tag_e',
      'idx_events_kind_tag_a',
      'idx_events_kind_tag_t',
      'idx_events_kind_tag_L',
      'idx_events_kind_tag_s',
      'idx_events_reply_to',
      'idx_events_root_thread',
      'idx_events_kind_created_at_covering',
      'idx_events_pubkey_kind_created_at_covering',
      'idx_events_created_at_covering',
      'idx_events_kind_pubkey_created_at_covering',
      'idx_tags_name_value',
      'idx_tags_value',
      'idx_tags_name_value_event_created',
    ];
    for (const idx of dropIndexes) {
      await dropSession.prepare(`DROP INDEX IF EXISTS ${idx}`).run();
    }

    const dropTables = ['event_tags_cache', 'mv_follow_graph', 'mv_recent_notes', 'mv_timeline_cache'];
    for (const tbl of dropTables) {
      await dropSession.prepare(`DROP TABLE IF EXISTS ${tbl}`).run();
    }

    await dropSession.prepare(
      "INSERT OR REPLACE INTO system_config (key, value) VALUES ('cleanup_v1', '1')"
    ).run();
  }

  const session = db.withSession('first-primary');

  try {
    const statements = [
      `CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        kind INTEGER NOT NULL,
        tags TEXT NOT NULL,
        content TEXT NOT NULL,
        sig TEXT NOT NULL,
        created_timestamp INTEGER DEFAULT (strftime('%s', 'now')),
        tag_p TEXT,
        tag_e TEXT,
        tag_a TEXT,
        tag_t TEXT,
        tag_d TEXT,
        tag_r TEXT,
        tag_L TEXT,
        tag_s TEXT,
        tag_u TEXT,
        tag_l TEXT,
        tag_x TEXT,
        reply_to_event_id TEXT,
        root_event_id TEXT,
        content_preview TEXT
      )`,

      `CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_events_kind_created_at ON events(kind, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_events_pubkey_created_at ON events(pubkey, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind_created_at ON events(pubkey, kind, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_events_kind_pubkey_created_at ON events(kind, pubkey, created_at DESC)`,

      `CREATE TABLE IF NOT EXISTS tags (
        event_id TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        tag_value TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tags_name_value_event ON tags(tag_name, tag_value, event_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tags_event_id ON tags(event_id)`,

      `CREATE TABLE IF NOT EXISTS event_tags_cache_multi (
        event_id TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        kind INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        tag_type TEXT NOT NULL,
        tag_value TEXT NOT NULL,
        PRIMARY KEY (event_id, tag_type, tag_value)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_cache_multi_type_value_time ON event_tags_cache_multi(tag_type, tag_value, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_cache_multi_type_value_event ON event_tags_cache_multi(tag_type, tag_value, event_id)`,
      `CREATE INDEX IF NOT EXISTS idx_cache_multi_kind_type_value ON event_tags_cache_multi(kind, tag_type, tag_value, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_cache_multi_event_id ON event_tags_cache_multi(event_id)`,

      `CREATE TABLE IF NOT EXISTS paid_pubkeys (
        pubkey TEXT PRIMARY KEY,
        paid_at INTEGER NOT NULL,
        amount_sats INTEGER,
        created_timestamp INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      `CREATE TABLE IF NOT EXISTS content_hashes (
        hash TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_content_hashes_pubkey ON content_hashes(pubkey)`,
      `CREATE INDEX IF NOT EXISTS idx_content_hashes_created_at ON content_hashes(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_content_hashes_pubkey_created ON content_hashes(pubkey, created_at DESC)`,

      // SIP-01 tables (documents / observations / indexers / metrics)
      ...SIP01_SCHEMA_STATEMENTS,
    ];

    for (const statement of statements) {
      await session.prepare(statement).run();
    }

    await session.prepare("PRAGMA foreign_keys = ON").run();

    // Schema migrations (idempotent). Older databases created by upstream
    // versions carry the restrictive tag CHECK constraint — rebuilt in v7.
    const versionResult = await session.prepare(
      "SELECT value FROM system_config WHERE key = 'schema_version'"
    ).first() as { value: string } | null;
    const currentVersion = versionResult ? parseInt(versionResult.value) : 0;

    if (currentVersion < SCHEMA_VERSION) {
      console.log(`Migrating schema ${currentVersion} → ${SCHEMA_VERSION} (SIP-01 tag cache rebuild)...`);
      for (const statement of migrationV7Statements()) {
        try {
          await session.prepare(statement).run();
        } catch (error: any) {
          // "duplicate column" on ALTER ADD COLUMN is fine on re-runs.
          if (!error?.message?.includes('duplicate column')) throw error;
        }
      }
      await session.prepare(
        "INSERT OR REPLACE INTO system_config (key, value) VALUES ('schema_version', ?)"
      ).bind(String(SCHEMA_VERSION)).run();
      console.log('Schema migration completed');
    }

    await session.prepare(
      "INSERT OR REPLACE INTO system_config (key, value) VALUES ('db_initialized', '1')"
    ).run();

    // Populate multi-value cache from any pre-existing events
    await session.prepare(`
      INSERT OR IGNORE INTO event_tags_cache_multi (event_id, pubkey, kind, created_at, tag_type, tag_value)
      SELECT
        e.id,
        e.pubkey,
        e.kind,
        e.created_at,
        t.tag_name,
        t.tag_value
      FROM events e
      INNER JOIN tags t ON e.id = t.event_id
      WHERE t.tag_name IN (${CACHED_TAG_NAMES.map((t) => `'${t}'`).join(', ')})
    `).run();

    console.log("Database initialization completed!");
  } catch (error) {
    console.error("Failed to initialize database:", error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Event verification
// ---------------------------------------------------------------------------

async function verifyEventSignature(event: NostrEvent): Promise<boolean> {
  try {
    const signatureBytes = hexToBytes(event.sig);
    const serializedEventData = serializeEventForSigning(event);
    const messageHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serializedEventData)
    );
    const messageHash = new Uint8Array(messageHashBuffer);
    const publicKeyBytes = hexToBytes(event.pubkey);
    return schnorr.verify(signatureBytes, messageHash, publicKeyBytes);
  } catch (error) {
    console.error("Error verifying event signature:", error);
    return false;
  }
}

/** Verify the event id matches its serialized hash (NIP-01). */
async function verifyEventId(event: NostrEvent): Promise<boolean> {
  try {
    const serializedEventData = serializeEventForSigning(event);
    const messageHashBuffer = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(serializedEventData)
    );
    return bytesToHex(new Uint8Array(messageHashBuffer)) === event.id;
  } catch {
    return false;
  }
}

function serializeEventForSigning(event: NostrEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

function hexToBytes(hexString: string): Uint8Array {
  if (hexString.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexString.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Content hashing for anti-spam
async function hashContent(event: NostrEvent): Promise<string> {
  const contentToHash = enableGlobalDuplicateCheck
    ? JSON.stringify({ kind: event.kind, tags: event.tags, content: event.content })
    : JSON.stringify({ pubkey: event.pubkey, kind: event.kind, tags: event.tags, content: event.content });

  const buffer = new TextEncoder().encode(contentToHash);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(hashBuffer));
}

function shouldCheckForDuplicates(kind: number): boolean {
  return enableAntiSpam && antiSpamKinds.has(kind);
}

// ---------------------------------------------------------------------------
// NIP-05 validation (optional anti-spam, disabled by default)
// ---------------------------------------------------------------------------

async function validateNIP05FromKind0(pubkey: string, env: Env): Promise<boolean> {
  try {
    const filters = [{ kinds: [0], authors: [pubkey], limit: 1 }];
    const result = await queryEvents(filters, 'first-unconstrained', env);
    const metadataEvent = result.events?.[0] ?? null;

    if (!metadataEvent) {
      console.error(`No kind 0 metadata event found for pubkey: ${pubkey}`);
      return false;
    }

    const metadata = JSON.parse(metadataEvent.content);
    const nip05Address = metadata.nip05;

    if (!nip05Address) {
      console.error(`No NIP-05 address found in kind 0 for pubkey: ${pubkey}`);
      return false;
    }

    return await validateNIP05(nip05Address, pubkey);
  } catch (error) {
    console.error(`Error validating NIP-05 for pubkey ${pubkey}: ${error}`);
    return false;
  }
}

async function validateNIP05(nip05Address: string, pubkey: string): Promise<boolean> {
  try {
    const [name, domain] = nip05Address.split('@');

    if (!domain) {
      throw new Error(`Invalid NIP-05 address format: ${nip05Address}`);
    }

    // Check blocked/allowed domains
    if (blockedNip05Domains.has(domain)) {
      console.error(`NIP-05 domain is blocked: ${domain}`);
      return false;
    }

    if (allowedNip05Domains.size > 0 && !allowedNip05Domains.has(domain)) {
      console.error(`NIP-05 domain is not allowed: ${domain}`);
      return false;
    }

    // Fetch the NIP-05 data
    const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`Failed to fetch NIP-05 data from ${url}: ${response.statusText}`);
      return false;
    }

    const nip05Data = await response.json() as Nip05Response;

    if (!nip05Data.names || !nip05Data.names[name]) {
      console.error(`NIP-05 data does not contain a matching public key for ${name}`);
      return false;
    }

    const nip05Pubkey = nip05Data.names[name];
    return nip05Pubkey === pubkey;

  } catch (error) {
    console.error(`Error validating NIP-05 address: ${error}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Query complexity
// ---------------------------------------------------------------------------

function calculateQueryComplexity(filter: NostrFilter): number {
  let complexity = 0;

  complexity += (filter.ids?.length || 0) * 1;
  complexity += (filter.authors?.length || 0) * 2;
  complexity += (filter.kinds?.length || 0) * 5;

  // Tag filters are expensive
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values)) {
      complexity += values.length * 10;
    }
  }

  // No time bounds is very expensive
  if (!filter.since && !filter.until) {
    complexity *= 2;
  }

  // Large limits are expensive
  if ((filter.limit || 0) > 1000) {
    complexity *= 1.5;
  }

  return complexity;
}

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------

async function processEvent(event: NostrEvent, sessionId: string, env: Env): Promise<{ success: boolean; message: string; bookmark?: string }> {
  await ensureDatabase(env.RELAY_DATABASE);
  const session = env.RELAY_DATABASE.withSession('first-primary');
  try {
    // Event id must match the serialized hash (NIP-01)
    if (!(await verifyEventId(event))) {
      await bumpMetric(session, 'events_invalid');
      return { success: false, message: "invalid: event id does not match content" };
    }

    // created_at sanity: reject far-future events (NIP-01 SHOULD)
    const upperLimit = relayInfo.limitation?.created_at_upper_limit;
    if (typeof upperLimit === 'number' && upperLimit > 0) {
      const now = Math.floor(Date.now() / 1000);
      if (event.created_at > now + upperLimit) {
        await bumpMetric(session, 'events_invalid');
        return { success: false, message: "invalid: created_at is too far in the future" };
      }
    }

    // NIP-05 validation if enabled (bypassed for kind 1059)
    if (event.kind !== 1059 && checkValidNip05 && event.kind !== 0) {
      const isValidNIP05 = await validateNIP05FromKind0(event.pubkey, env);
      if (!isValidNIP05) {
        console.error(`Event denied. NIP-05 validation failed for pubkey ${event.pubkey}.`);
        await bumpMetric(session, 'events_invalid');
        return { success: false, message: "invalid: NIP-05 validation failed" };
      }
    }

    // Handle deletion events
    if (event.kind === 5) {
      return await processDeletionEvent(event, env);
    }

    // NIP-16: Ephemeral events (kinds 20000-29999) are broadcast but never stored
    if (event.kind >= 20000 && event.kind < 30000) {
      return { success: true, message: "Ephemeral event broadcast" };
    }

    // SIP-01: validate web index observations at ingestion (§12.4) and apply
    // the operator's indexer policy. An invalid observation never reaches the
    // index — garbage in = garbage index.
    if (event.kind === SIP01_KIND && SIP01_ENABLED) {
      if (!isIndexerAllowed(event.pubkey)) {
        await bumpMetric(session, 'sip01_indexer_blocked');
        return { success: false, message: "blocked: indexer pubkey not allowed on this relay" };
      }

      const eventBytes = JSON.stringify(event).length;
      if (eventBytes > SIP01_MAX_EVENT_BYTES) {
        await bumpMetric(session, 'sip01_validation_failures');
        return { success: false, message: `invalid: event exceeds ${SIP01_MAX_EVENT_BYTES} bytes` };
      }

      if (SIP01_VALIDATION) {
        const validation = await validateSip01Event(event as any);
        if (!validation.valid) {
          await bumpMetric(session, 'sip01_validation_failures');
          console.log(`sip01: rejected observation ${event.id}: ${validation.errors.join('; ')}`);
          return { success: false, message: `invalid: ${validation.errors[0]}` };
        }
      }
    }

    // Save event directly to database (duplicate check happens inside saveEventToDatabase)
    return await saveEventToDatabase(event, env);

  } catch (error: any) {
    console.error(`Error processing event: ${error.message}`);
    return { success: false, message: `error: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// Event storage
// ---------------------------------------------------------------------------

async function saveEventToDatabase(event: NostrEvent, env: Env): Promise<{ success: boolean; message: string; bookmark?: string }> {
  try {
    // Check worker cache for duplicate event ID
    const cache = caches.default;
    const cacheKey = new Request(`https://event-cache/${event.id}`);
    const cached = await cache.match(cacheKey);
    if (cached) {
      return { success: false, message: "duplicate: event already exists" };
    }

    const session = env.RELAY_DATABASE.withSession('first-primary');

    // Check D1 for duplicate event ID
    const existingEvent = await session.prepare("SELECT id FROM events WHERE id = ? LIMIT 1").bind(event.id).first();
    if (existingEvent) {
      if (event.kind === SIP01_KIND) await bumpMetric(session, 'sip01_duplicates');
      return { success: false, message: "duplicate: event already exists", bookmark: session.getBookmark() ?? undefined };
    }

    // NIP-16: Replaceable events (kinds 0, 3, 10000-19999)
    const isReplaceable = event.kind === 0 || event.kind === 3 || (event.kind >= 10000 && event.kind < 20000);
    if (isReplaceable) {
      const existing = await session.prepare(
        "SELECT id, created_at FROM events WHERE kind = ? AND pubkey = ? LIMIT 1"
      ).bind(event.kind, event.pubkey).first();

      if (existing) {
        if (event.created_at <= (existing.created_at as number)) {
          return { success: false, message: "duplicate: a newer or equal replaceable event already exists", bookmark: session.getBookmark() ?? undefined };
        }
        const oldId = existing.id as string;
        await session.batch([
          session.prepare("DELETE FROM tags WHERE event_id = ?").bind(oldId),
          session.prepare("DELETE FROM content_hashes WHERE event_id = ?").bind(oldId),
          session.prepare("DELETE FROM event_tags_cache_multi WHERE event_id = ?").bind(oldId),
          session.prepare("DELETE FROM events WHERE id = ?").bind(oldId),
        ]);
        console.log(`Replaced older event ${oldId} with newer event ${event.id} (kind ${event.kind})`);
      }
    }

    // NIP-01 addressable events (kinds 30000-39999) — the SIP-01 kind 39697
    // slot: one live observation per (pubkey, d). The superseded observation
    // row is removed so document/indexer aggregates stay exact.
    const isParameterizedReplaceable = event.kind >= 30000 && event.kind < 40000;
    if (isParameterizedReplaceable) {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
      const existing = await session.prepare(
        "SELECT id, created_at FROM events WHERE kind = ? AND pubkey = ? AND tag_d = ? LIMIT 1"
      ).bind(event.kind, event.pubkey, dTag).first();

      if (existing) {
        if (event.created_at <= (existing.created_at as number)) {
          return { success: false, message: "duplicate: a newer or equal parameterized replaceable event already exists", bookmark: session.getBookmark() ?? undefined };
        }
        const oldId = existing.id as string;
        await session.batch([
          session.prepare("DELETE FROM tags WHERE event_id = ?").bind(oldId),
          session.prepare("DELETE FROM content_hashes WHERE event_id = ?").bind(oldId),
          session.prepare("DELETE FROM event_tags_cache_multi WHERE event_id = ?").bind(oldId),
          session.prepare("DELETE FROM events WHERE id = ?").bind(oldId),
        ]);
        if (event.kind === SIP01_KIND && SIP01_INDEXING) {
          await removeSip01Observations(session, [oldId]);
        }
        console.log(`Replaced older parameterized event ${oldId} with newer event ${event.id} (kind ${event.kind}, d=${dTag})`);
      }
    }

    // Check for duplicate content (only if anti-spam is enabled)
    let contentHash: string | null = null;
    if (shouldCheckForDuplicates(event.kind)) {
      contentHash = await hashContent(event);

      const duplicateContent = enableGlobalDuplicateCheck
        ? await session.prepare("SELECT event_id FROM content_hashes WHERE hash = ? LIMIT 1").bind(contentHash).first()
        : await session.prepare("SELECT event_id FROM content_hashes WHERE hash = ? AND pubkey = ? LIMIT 1").bind(contentHash, event.pubkey).first();

      if (duplicateContent) {
        return { success: false, message: "duplicate: content already exists", bookmark: session.getBookmark() ?? undefined };
      }
    }

    // Process tags and extract common tag values
    const tagInserts: Array<{ name: string; value: string }> = [];
    const firstValues: Record<string, string | null> = {};
    for (const name of CACHED_TAG_NAMES) firstValues[name] = null;

    for (const tag of event.tags) {
      if (tag[0]) {
        tagInserts.push({ name: tag[0], value: tag[1] || '' });
        if (tag[0] in firstValues && firstValues[tag[0]] === null) {
          firstValues[tag[0]] = tag[1] ?? '';
        }
      }
    }

    // Extract thread metadata
    const eTags = tagInserts.filter(t => t.name === 'e').map(t => t.value);
    const replyToEventId = eTags.length > 0 ? eTags[0] : null;
    const rootEventId = eTags.length > 1 ? eTags[eTags.length - 1] : null;
    const contentPreview = event.content.substring(0, 100);

    // Insert the main event
    const insertResult = await session.prepare(`
      INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, tag_p, tag_e, tag_a, tag_t, tag_d, tag_r, tag_L, tag_s, tag_u, tag_l, tag_x, reply_to_event_id, root_event_id, content_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      event.id,
      event.pubkey,
      event.created_at,
      event.kind,
      JSON.stringify(event.tags),
      event.content,
      event.sig,
      firstValues['p'],
      firstValues['e'],
      firstValues['a'],
      firstValues['t'],
      firstValues['d'],
      firstValues['r'],
      firstValues['L'],
      firstValues['s'],
      firstValues['u'],
      firstValues['l'],
      firstValues['x'],
      replyToEventId,
      rootEventId,
      contentPreview
    ).run();

    // Check if the event was actually inserted (not a duplicate that slipped through)
    if (insertResult.meta.changes === 0) {
      console.log(`Event ${event.id} already exists in database (race condition duplicate)`);
      return { success: false, message: "duplicate: event already exists", bookmark: session.getBookmark() ?? undefined };
    }

    // Consolidate all post-insert writes (tags, caches, content hash) into batches
    const postInsertBatch: D1PreparedStatement[] = [];

    for (const t of tagInserts) {
      postInsertBatch.push(
        session.prepare('INSERT INTO tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)').bind(event.id, t.name, t.value)
      );
    }

    // Multi-value tag cache for relay-filterable single-letter tags
    const cachedSet = new Set<string>(CACHED_TAG_NAMES as readonly string[]);
    const cacheableTags = tagInserts.filter(t => cachedSet.has(t.name));
    for (const t of cacheableTags) {
      postInsertBatch.push(
        session.prepare(`
          INSERT OR IGNORE INTO event_tags_cache_multi (event_id, pubkey, kind, created_at, tag_type, tag_value)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(event.id, event.pubkey, event.kind, event.created_at, t.name, t.value)
      );
    }

    // Content hash
    if (contentHash) {
      postInsertBatch.push(
        session.prepare(`
          INSERT INTO content_hashes (hash, event_id, pubkey, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(hash) DO NOTHING
        `).bind(contentHash, event.id, event.pubkey, event.created_at)
      );
    }

    // Execute all post-insert writes in chunks of 90 (D1 batch limit is 100)
    for (let i = 0; i < postInsertBatch.length; i += 90) {
      await session.batch(postInsertBatch.slice(i, i + 90));
    }

    // SIP-01: maintain the document/observation/indexer index.
    if (event.kind === SIP01_KIND && SIP01_INDEXING) {
      try {
        await ingestSip01Observation(session, event);
        await bumpMetric(session, 'sip01_accepted');
      } catch (error) {
        // Indexing failure must not lose the event itself; the reindex script
        // can repair derived tables from the canonical events table.
        console.error(`sip01: indexing failed for ${event.id}:`, error);
        await bumpMetric(session, 'sip01_index_errors');
      }
    }
    await bumpMetric(session, 'events_accepted');

    // Cache the event ID in worker cache to prevent duplicates
    await cache.put(cacheKey, new Response('cached', {
      headers: { 'Cache-Control': 'max-age=3600' }
    }));

    console.log(`Event ${event.id} saved directly to database`);
    return { success: true, message: "Event saved successfully", bookmark: session.getBookmark() ?? undefined };

  } catch (error: any) {
    console.error(`Error saving event to database: ${error.message}`);
    console.error(`Event details: ID=${event.id}, Kind=${event.kind}, Tags count=${event.tags.length}`);
    return { success: false, message: `error: ${error.message}` };
  }
}

// Helper function for kind 5
async function processDeletionEvent(event: NostrEvent, env: Env): Promise<{ success: boolean; message: string; bookmark?: string }> {
  console.log(`Processing deletion event ${event.id}`);
  const deletedEventIds = event.tags.filter(tag => tag[0] === "e").map(tag => tag[1]);

  const session = env.RELAY_DATABASE.withSession('first-primary');

  // NIP-33-style address deletion (`a` tags) for addressable events
  const addressTags = event.tags.filter(tag => tag[0] === "a").map(tag => tag[1]);

  if (deletedEventIds.length === 0 && addressTags.length === 0) {
    return { success: true, message: "No events to delete", bookmark: session.getBookmark() ?? undefined };
  }

  let deletedCount = 0;
  const errors: string[] = [];
  const idsToDelete: string[] = [];

  if (deletedEventIds.length > 0) {
    try {
      const ownerPlaceholders = deletedEventIds.map(() => '?').join(',');
      const ownerResult = await session.prepare(
        `SELECT id, pubkey FROM events WHERE id IN (${ownerPlaceholders})`
      ).bind(...deletedEventIds).all();

      const eventOwners = new Map<string, string>();
      for (const row of ownerResult.results) {
        eventOwners.set(row.id as string, row.pubkey as string);
      }

      for (const eventId of deletedEventIds) {
        const ownerPubkey = eventOwners.get(eventId);
        if (!ownerPubkey) {
          console.warn(`Event ${eventId} not found in D1. Nothing to delete.`);
          continue;
        }
        if (ownerPubkey !== event.pubkey) {
          console.warn(`Event ${eventId} does not belong to pubkey ${event.pubkey}. Skipping deletion.`);
          errors.push(`unauthorized: cannot delete event ${eventId} - wrong pubkey`);
          continue;
        }
        idsToDelete.push(eventId);
      }
    } catch (error) {
      console.error('Error checking event ownership:', error);
      errors.push('error checking event ownership');
    }
  }

  // Address deletion: `a` tag value is `<kind>:<pubkey>:<d>`. Only the
  // address owner may delete, and only events at or older than the kind-5's
  // created_at (NIP-09 addressable semantics).
  if (addressTags.length > 0) {
    for (const addr of addressTags) {
      const [kindStr, author, d] = addr.split(':');
      const kind = Number.parseInt(kindStr, 10);
      if (!Number.isFinite(kind) || !author || author !== event.pubkey) continue;

      try {
        const existing = await session.prepare(
          "SELECT id, created_at FROM events WHERE kind = ? AND pubkey = ? AND tag_d = ? LIMIT 1"
        ).bind(kind, author, d ?? '').first();

        if (existing && (existing.created_at as number) <= event.created_at) {
          idsToDelete.push(existing.id as string);
        }
      } catch (error) {
        console.error(`Error resolving address ${addr}:`, error);
      }
    }
  }

  if (idsToDelete.length > 0) {
    try {
      // SIP-01: drop derived observation rows first (documents/indexers
      // aggregates are repaired inside removeSip01Observations).
      if (SIP01_INDEXING) {
        await removeSip01Observations(session, idsToDelete);
      }

      const deleteStatements: D1PreparedStatement[] = [];
      for (const eventId of idsToDelete) {
        deleteStatements.push(
          session.prepare("DELETE FROM tags WHERE event_id = ?").bind(eventId),
          session.prepare("DELETE FROM content_hashes WHERE event_id = ?").bind(eventId),
          session.prepare("DELETE FROM event_tags_cache_multi WHERE event_id = ?").bind(eventId),
          session.prepare("DELETE FROM events WHERE id = ?").bind(eventId),
        );
      }

      for (let i = 0; i < deleteStatements.length; i += 90) {
        await session.batch(deleteStatements.slice(i, i + 90));
      }

      deletedCount = idsToDelete.length;
      console.log(`Batch deleted ${deletedCount} events from D1.`);
    } catch (error) {
      console.error('Error batch deleting events:', error);
      errors.push('error batch deleting events');
    }
  }

  // Save the deletion event itself
  const saveResult = await saveEventToDatabase(event, env);

  if (errors.length > 0) {
    return { success: false, message: errors[0], bookmark: saveResult.bookmark ?? (session.getBookmark() ?? undefined) };
  }

  return {
    success: true,
    message: deletedCount > 0 ? `Successfully deleted ${deletedCount} event(s)` : "No matching events found to delete",
    bookmark: saveResult.bookmark ?? (session.getBookmark() ?? undefined)
  };
}

// ---------------------------------------------------------------------------
// Query building (NIP-01 filters)
// ---------------------------------------------------------------------------

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// Only the 7 columns consumed by NostrEvent
const EVENT_COLS = 'e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig';
const EVENT_COLS_BARE = 'id, pubkey, created_at, kind, tags, content, sig';

const CACHED_TAG_SET = new Set<string>(CACHED_TAG_NAMES as readonly string[]);

// Build COUNT query for precheck + NIP-45
function buildCountQuery(filter: NostrFilter): { sql: string; params: any[] } {
  const params: any[] = [];
  const conditions: string[] = [];

  const directTags: Array<{ name: string; values: string[] }> = [];
  const otherTags: Array<{ name: string; values: string[] }> = [];

  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
      const tagName = key.substring(1);
      if (CACHED_TAG_SET.has(tagName)) {
        directTags.push({ name: tagName, values });
      } else {
        otherTags.push({ name: tagName, values });
      }
    }
  }

  if (directTags.length > 0 && otherTags.length === 0) {
    const cacheAlias = directTags.length === 1 ? "m" : "m0";

    if (directTags.length === 1) {
      const tagFilter = directTags[0];
      const hasKinds = filter.kinds && filter.kinds.length > 0;
      const indexHint = hasKinds && filter.kinds!.length <= 10
        ? " INDEXED BY idx_cache_multi_kind_type_value"
        : " INDEXED BY idx_cache_multi_type_value_time";
      let sql = `SELECT COUNT(DISTINCT m.event_id) as count FROM event_tags_cache_multi m${indexHint}
        WHERE m.tag_type = ? AND m.tag_value IN (${tagFilter.values.map(() => '?').join(',')})`;
      params.push(tagFilter.name, ...tagFilter.values);

      if (filter.authors && filter.authors.length > 0) {
        sql += ` AND m.pubkey IN (${filter.authors.map(() => '?').join(',')})`;
        params.push(...filter.authors);
      }
      if (hasKinds) {
        sql += ` AND m.kind IN (${filter.kinds!.map(() => '?').join(',')})`;
        params.push(...filter.kinds!);
      }
      if (filter.since) {
        sql += " AND m.created_at >= ?";
        params.push(filter.since);
      }
      if (filter.until) {
        sql += " AND m.created_at <= ?";
        params.push(filter.until);
      }
      return { sql, params };
    } else {
      const hasKindsMulti = filter.kinds && filter.kinds.length > 0;
      const firstTag = directTags[0];
      const firstHint = hasKindsMulti && filter.kinds!.length <= 10
        ? " INDEXED BY idx_cache_multi_kind_type_value"
        : " INDEXED BY idx_cache_multi_type_value_time";

      const additionalJoins = directTags.slice(1).map((t, i) => {
        const alias = `m${i + 1}`;
        const placeholders = t.values.map(() => '?').join(',');
        return `INNER JOIN event_tags_cache_multi ${alias} ON m0.event_id = ${alias}.event_id AND ${alias}.tag_type = ? AND ${alias}.tag_value IN (${placeholders})`;
      }).join('\n        ');

      let sql = `SELECT COUNT(DISTINCT m0.event_id) as count FROM event_tags_cache_multi m0${firstHint}
        ${additionalJoins}
        WHERE m0.tag_type = ? AND m0.tag_value IN (${firstTag.values.map(() => '?').join(',')})`;

      params.push(firstTag.name, ...firstTag.values);
      for (const tagFilter of directTags.slice(1)) {
        params.push(tagFilter.name, ...tagFilter.values);
      }

      if (filter.authors && filter.authors.length > 0) {
        sql += ` AND m0.pubkey IN (${filter.authors.map(() => '?').join(',')})`;
        params.push(...filter.authors);
      }
      if (hasKindsMulti) {
        sql += ` AND m0.kind IN (${filter.kinds!.map(() => '?').join(',')})`;
        params.push(...filter.kinds!);
      }
      if (filter.since) {
        sql += " AND m0.created_at >= ?";
        params.push(filter.since);
      }
      if (filter.until) {
        sql += " AND m0.created_at <= ?";
        params.push(filter.until);
      }
      return { sql, params };
    }
  }

  // Has non-cacheable tags
  if (directTags.length > 0 || otherTags.length > 0) {
    const allTags = [...directTags, ...otherTags];

    if (allTags.length === 1) {
      const tagFilter = allTags[0];
      let sql = `SELECT COUNT(DISTINCT e.id) as count FROM events e
        INNER JOIN tags t ON e.id = t.event_id
        WHERE t.tag_name = ? AND t.tag_value IN (${tagFilter.values.map(() => '?').join(',')})`;
      params.push(tagFilter.name, ...tagFilter.values);

      if (filter.authors && filter.authors.length > 0) {
        sql += ` AND e.pubkey IN (${filter.authors.map(() => '?').join(',')})`;
        params.push(...filter.authors);
      }
      if (filter.kinds && filter.kinds.length > 0) {
        sql += ` AND e.kind IN (${filter.kinds.map(() => '?').join(',')})`;
        params.push(...filter.kinds);
      }
      if (filter.since) {
        sql += " AND e.created_at >= ?";
        params.push(filter.since);
      }
      if (filter.until) {
        sql += " AND e.created_at <= ?";
        params.push(filter.until);
      }
      return { sql, params };
    } else {
      const tagConditions = allTags.map(t => {
        const placeholders = t.values.map(() => '?').join(',');
        return `(t.tag_name = ? AND t.tag_value IN (${placeholders}))`;
      }).join(' OR ');

      for (const tagFilter of allTags) {
        params.push(tagFilter.name, ...tagFilter.values);
      }

      let sql = `SELECT COUNT(DISTINCT e.id) as count FROM events e
        INNER JOIN tags t ON e.id = t.event_id
        WHERE ${tagConditions}`;

      if (filter.authors && filter.authors.length > 0) {
        sql += ` AND e.pubkey IN (${filter.authors.map(() => '?').join(',')})`;
        params.push(...filter.authors);
      }
      if (filter.kinds && filter.kinds.length > 0) {
        sql += ` AND e.kind IN (${filter.kinds.map(() => '?').join(',')})`;
        params.push(...filter.kinds);
      }
      if (filter.since) {
        sql += " AND e.created_at >= ?";
        params.push(filter.since);
      }
      if (filter.until) {
        sql += " AND e.created_at <= ?";
        params.push(filter.until);
      }

      sql += ` GROUP BY e.id HAVING COUNT(DISTINCT t.tag_name) = ?`;
      params.push(allTags.length);

      sql = `SELECT COUNT(*) as count FROM (${sql})`;
      return { sql, params };
    }
  }

  // No tag filters
  let sql = "SELECT COUNT(*) as count FROM events";

  if (filter.ids && filter.ids.length > 0) {
    conditions.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
    params.push(...filter.ids);
  }
  if (filter.authors && filter.authors.length > 0) {
    conditions.push(`pubkey IN (${filter.authors.map(() => '?').join(',')})`);
    params.push(...filter.authors);
  }
  if (filter.kinds && filter.kinds.length > 0) {
    conditions.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
    params.push(...filter.kinds);
  }
  if (filter.since) {
    conditions.push("created_at >= ?");
    params.push(filter.since);
  }
  if (filter.until) {
    conditions.push("created_at <= ?");
    params.push(filter.until);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  return { sql, params };
}

// Query builder
function buildQuery(filter: NostrFilter): { sql: string; params: any[] } {
  const params: any[] = [];
  const conditions: string[] = [];

  let tagCount = 0;
  const directTags: Array<{ name: string; values: string[] }> = [];
  const otherTags: Array<{ name: string; values: string[] }> = [];

  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
      tagCount += values.length;
      const tagName = key.substring(1);

      if (CACHED_TAG_SET.has(tagName)) {
        directTags.push({ name: tagName, values });
      } else {
        otherTags.push({ name: tagName, values });
      }
    }
  }

  if (directTags.length > 0 && otherTags.length === 0) {
    let sql: string;
    const whereConditions: string[] = [];
    const cacheAlias = directTags.length === 1 ? "m" : "m0";

    if (directTags.length === 1) {
      const tagFilter = directTags[0];
      const hasKinds = filter.kinds && filter.kinds.length > 0;

      let indexHint = "";
      if (hasKinds && filter.kinds!.length <= 10) {
        indexHint = " INDEXED BY idx_cache_multi_kind_type_value";
      } else {
        indexHint = " INDEXED BY idx_cache_multi_type_value_time";
      }

      sql = `SELECT DISTINCT ${EVENT_COLS} FROM events e
        INNER JOIN event_tags_cache_multi m${indexHint} ON e.id = m.event_id
        WHERE m.tag_type = ? AND m.tag_value IN (${tagFilter.values.map(() => '?').join(',')})`;
      params.push(tagFilter.name, ...tagFilter.values);
    } else {
      const hasKindsMulti = filter.kinds && filter.kinds.length > 0;
      const tagConditions = directTags.map((t, i) => {
        const alias = `m${i}`;
        const placeholders = t.values.map(() => '?').join(',');
        const hint = i === 0
          ? (hasKindsMulti && filter.kinds!.length <= 10
            ? " INDEXED BY idx_cache_multi_kind_type_value"
            : " INDEXED BY idx_cache_multi_type_value_time")
          : "";
        return `INNER JOIN event_tags_cache_multi ${alias}${hint} ON e.id = ${alias}.event_id AND ${alias}.tag_type = ? AND ${alias}.tag_value IN (${placeholders})`;
      }).join('\n        ');

      sql = `SELECT DISTINCT ${EVENT_COLS} FROM events e
        ${tagConditions}
        WHERE 1=1`;

      for (const tagFilter of directTags) {
        params.push(tagFilter.name, ...tagFilter.values);
      }
    }

    if (filter.ids && filter.ids.length > 0) {
      whereConditions.push(`e.id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }

    if (filter.authors && filter.authors.length > 0) {
      whereConditions.push(`e.pubkey IN (${filter.authors.map(() => '?').join(',')})`);
      params.push(...filter.authors);
    }

    if (filter.kinds && filter.kinds.length > 0) {
      whereConditions.push(`${cacheAlias}.kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }

    if (filter.since) {
      whereConditions.push(`${cacheAlias}.created_at >= ?`);
      params.push(filter.since);
    }

    if (filter.until) {
      whereConditions.push(`${cacheAlias}.created_at <= ?`);
      params.push(filter.until);
    }

    if (filter.cursor) {
      const [timestamp, lastId] = filter.cursor.split(':');
      whereConditions.push(`(${cacheAlias}.created_at < ? OR (${cacheAlias}.created_at = ? AND e.id > ?))`);
      params.push(parseInt(timestamp), parseInt(timestamp), lastId);
    }

    if (whereConditions.length > 0) {
      sql += " AND " + whereConditions.join(" AND ");
    }

    sql += ` ORDER BY ${cacheAlias}.created_at DESC LIMIT ?`;
    params.push(Math.min(filter.limit || 500, 500));

    return { sql, params };
  }

  // Has any non-cacheable tags
  if (tagCount > 0) {
    const allTags = [...directTags, ...otherTags];

    // Single tag filter
    if (allTags.length === 1) {
      const tagFilter = allTags[0];
      let sql = `SELECT ${EVENT_COLS} FROM events e
        INNER JOIN tags t ON e.id = t.event_id
        WHERE t.tag_name = ? AND t.tag_value IN (${tagFilter.values.map(() => '?').join(',')})`;

      params.push(tagFilter.name, ...tagFilter.values);

      const whereConditions: string[] = [];

      if (filter.ids && filter.ids.length > 0) {
        whereConditions.push(`e.id IN (${filter.ids.map(() => '?').join(',')})`);
        params.push(...filter.ids);
      }

      if (filter.authors && filter.authors.length > 0) {
        whereConditions.push(`e.pubkey IN (${filter.authors.map(() => '?').join(',')})`);
        params.push(...filter.authors);
      }

      if (filter.kinds && filter.kinds.length > 0) {
        whereConditions.push(`e.kind IN (${filter.kinds.map(() => '?').join(',')})`);
        params.push(...filter.kinds);
      }

      if (filter.since) {
        whereConditions.push("e.created_at >= ?");
        params.push(filter.since);
      }

      if (filter.until) {
        whereConditions.push("e.created_at <= ?");
        params.push(filter.until);
      }

      if (filter.cursor) {
        const [timestamp, lastId] = filter.cursor.split(':');
        whereConditions.push("(e.created_at < ? OR (e.created_at = ? AND e.id > ?))");
        params.push(parseInt(timestamp), parseInt(timestamp), lastId);
      }

      if (whereConditions.length > 0) {
        sql += " AND " + whereConditions.join(" AND ");
      }

      sql += " ORDER BY e.created_at DESC";
      sql += " LIMIT ?";
      params.push(Math.min(filter.limit || 500, 500));

      return { sql, params };
    }

    // Multiple tags
    const tagConditions = allTags.map(t => {
      const placeholders = t.values.map(() => '?').join(',');
      return `(t.tag_name = ? AND t.tag_value IN (${placeholders}))`;
    }).join(' OR ');

    for (const tagFilter of allTags) {
      params.push(tagFilter.name, ...tagFilter.values);
    }

    let sql = `SELECT ${EVENT_COLS} FROM events e
      INNER JOIN tags t ON e.id = t.event_id
      WHERE ${tagConditions}`;

    const whereConditions: string[] = [];

    if (filter.ids && filter.ids.length > 0) {
      whereConditions.push(`e.id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }

    if (filter.authors && filter.authors.length > 0) {
      whereConditions.push(`e.pubkey IN (${filter.authors.map(() => '?').join(',')})`);
      params.push(...filter.authors);
    }

    if (filter.kinds && filter.kinds.length > 0) {
      whereConditions.push(`e.kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }

    if (filter.since) {
      whereConditions.push("e.created_at >= ?");
      params.push(filter.since);
    }

    if (filter.until) {
      whereConditions.push("e.created_at <= ?");
      params.push(filter.until);
    }

    if (filter.cursor) {
      const [timestamp, lastId] = filter.cursor.split(':');
      whereConditions.push("(e.created_at < ? OR (e.created_at = ? AND e.id > ?))");
      params.push(parseInt(timestamp), parseInt(timestamp), lastId);
    }

    if (whereConditions.length > 0) {
      sql += " AND " + whereConditions.join(" AND ");
    }

    sql += " GROUP BY e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig";
    sql += ` HAVING COUNT(DISTINCT t.tag_name) = ?`;
    params.push(allTags.length);

    sql += " ORDER BY e.created_at DESC";
    sql += " LIMIT ?";
    params.push(Math.min(filter.limit || 500, 500));

    return { sql, params };
  }

  // No tag filters - standard query with index hints
  let indexHint = "";

  const hasAuthors = filter.authors && filter.authors.length > 0;
  const hasKinds = filter.kinds && filter.kinds.length > 0;
  const hasTimeRange = filter.since || filter.until;
  const authorCount = filter.authors?.length || 0;
  const kindCount = filter.kinds?.length || 0;

  if (hasAuthors && hasKinds && authorCount <= 10 && kindCount <= 10) {
    if (authorCount <= kindCount) {
      indexHint = " INDEXED BY idx_events_pubkey_kind_created_at";
    } else {
      indexHint = " INDEXED BY idx_events_kind_pubkey_created_at";
    }
  } else if (hasAuthors && authorCount <= 5 && !hasKinds) {
    indexHint = " INDEXED BY idx_events_pubkey_created_at";
  } else if (hasKinds && kindCount <= 5 && !hasAuthors) {
    indexHint = " INDEXED BY idx_events_kind_created_at";
  } else if (hasAuthors && hasKinds && authorCount > 10) {
    indexHint = " INDEXED BY idx_events_kind_created_at";
  } else if (!hasAuthors && !hasKinds && hasTimeRange) {
    indexHint = " INDEXED BY idx_events_created_at";
  }

  let sql = `SELECT ${EVENT_COLS_BARE} FROM events${indexHint}`;

  if (filter.ids && filter.ids.length > 0) {
    conditions.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
    params.push(...filter.ids);
  }

  if (filter.authors && filter.authors.length > 0) {
    conditions.push(`pubkey IN (${filter.authors.map(() => '?').join(',')})`);
    params.push(...filter.authors);
  }

  if (filter.kinds && filter.kinds.length > 0) {
    conditions.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
    params.push(...filter.kinds);
  }

  if (filter.since) {
    conditions.push("created_at >= ?");
    params.push(filter.since);
  }

  if (filter.until) {
    conditions.push("created_at <= ?");
    params.push(filter.until);
  }

  if (filter.cursor) {
    const [timestamp, lastId] = filter.cursor.split(':');
    conditions.push("(created_at < ? OR (created_at = ? AND id > ?))");
    params.push(parseInt(timestamp), parseInt(timestamp), lastId);
  }

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " ORDER BY created_at DESC";
  sql += " LIMIT ?";
  params.push(Math.min(filter.limit || 500, 500));

  return { sql, params };
}

// Helper function to handle chunked queries
async function queryDatabaseChunked(filter: NostrFilter, bookmark: string, env: Env): Promise<{ events: NostrEvent[] }> {
  const session = env.RELAY_DATABASE.withSession(bookmark);
  const allRows = new Map<string, any>();

  const baseFilter: NostrFilter = { ...filter };
  const needsChunking = {
    ids: false,
    authors: false,
    kinds: false,
    tags: {} as Record<string, boolean>
  };

  if (filter.ids && filter.ids.length > CHUNK_SIZE) {
    needsChunking.ids = true;
    delete baseFilter.ids;
  }

  if (filter.authors && filter.authors.length > CHUNK_SIZE) {
    needsChunking.authors = true;
    delete baseFilter.authors;
  }

  if (filter.kinds && filter.kinds.length > CHUNK_SIZE) {
    needsChunking.kinds = true;
    delete baseFilter.kinds;
  }

  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values) && values.length > CHUNK_SIZE) {
      needsChunking.tags[key] = true;
      delete baseFilter[key];
    }
  }

  const processStringChunks = async (filterType: 'ids' | 'authors' | string, values: string[]) => {
    const chunks = chunkArray(values, CHUNK_SIZE);

    for (const chunk of chunks) {
      const chunkFilter = { ...baseFilter };

      if (filterType === 'ids') {
        chunkFilter.ids = chunk;
      } else if (filterType === 'authors') {
        chunkFilter.authors = chunk;
      } else if (filterType.startsWith('#')) {
        chunkFilter[filterType] = chunk;
      }

      const query = buildQuery(chunkFilter);

      try {
        const result = await session.prepare(query.sql)
          .bind(...query.params)
          .all();

        for (const row of result.results) {
          allRows.set(row.id as string, row);
        }
      } catch (error) {
        console.error(`Error in chunk query: ${error}`);
      }
    }
  };

  const processNumberChunks = async (filterType: 'kinds', values: number[]) => {
    const chunks = chunkArray(values, CHUNK_SIZE);

    for (const chunk of chunks) {
      const chunkFilter = { ...baseFilter };
      chunkFilter.kinds = chunk;

      const query = buildQuery(chunkFilter);

      try {
        const result = await session.prepare(query.sql)
          .bind(...query.params)
          .all();

        for (const row of result.results) {
          allRows.set(row.id as string, row);
        }
      } catch (error) {
        console.error(`Error in chunk query: ${error}`);
      }
    }
  };

  if (needsChunking.ids && filter.ids) {
    await processStringChunks('ids', filter.ids);
  }

  if (needsChunking.authors && filter.authors) {
    await processStringChunks('authors', filter.authors);
  }

  if (needsChunking.kinds && filter.kinds) {
    await processNumberChunks('kinds', filter.kinds);
  }

  for (const [tagKey, _] of Object.entries(needsChunking.tags)) {
    const tagValues = filter[tagKey];
    if (Array.isArray(tagValues) && tagValues.every((v: any) => typeof v === 'string')) {
      await processStringChunks(tagKey, tagValues as string[]);
    }
  }

  if (!needsChunking.ids && !needsChunking.authors && !needsChunking.kinds && Object.keys(needsChunking.tags).length === 0) {
    const query = buildQuery(filter);

    try {
      const result = await session.prepare(query.sql)
        .bind(...query.params)
        .all();

      for (const row of result.results) {
        allRows.set(row.id as string, row);
      }
    } catch (error) {
      console.error(`Error in query: ${error}`);
    }
  }

  const events = Array.from(allRows.values()).map(row => ({
    id: row.id as string,
    pubkey: row.pubkey as string,
    created_at: row.created_at as number,
    kind: row.kind as number,
    tags: JSON.parse(row.tags as string),
    content: row.content as string,
    sig: row.sig as string
  }));
  console.log(`Found ${events.length} events (chunked)`);

  return { events };
}

// Query handling
async function queryEvents(filters: NostrFilter[], bookmark: string, env: Env): Promise<QueryResult> {
  await ensureDatabase(env.RELAY_DATABASE);
  try {
    console.log(`Processing query with ${filters.length} filters and bookmark: ${bookmark}`);
    const session = env.RELAY_DATABASE.withSession(bookmark);
    const eventSet = new Map<string, NostrEvent>();

    const chunkedFilters: NostrFilter[] = [];
    const batchableFilters: NostrFilter[] = [];

    for (const filter of filters) {
      const complexity = calculateQueryComplexity(filter);
      if (complexity > MAX_QUERY_COMPLEXITY) {
        console.warn(`Query too complex (complexity: ${complexity}), skipping filter`);
        continue;
      }

      const needsChunking = (
        (filter.ids && filter.ids.length > CHUNK_SIZE) ||
        (filter.authors && filter.authors.length > CHUNK_SIZE) ||
        (filter.kinds && filter.kinds.length > CHUNK_SIZE) ||
        Object.entries(filter).some(([key, values]) =>
          key.startsWith('#') && Array.isArray(values) && values.length > CHUNK_SIZE
        )
      );

      if (needsChunking) {
        chunkedFilters.push(filter);
      } else {
        batchableFilters.push(filter);
      }
    }

    let totalEventsRead = 0;
    for (const filter of chunkedFilters) {
      if (totalEventsRead >= GLOBAL_MAX_EVENTS) {
        console.warn(`Global event limit reached (${GLOBAL_MAX_EVENTS}), stopping query`);
        break;
      }

      console.log(`Filter has arrays >${CHUNK_SIZE} items, using chunked query...`);
      const chunkedResult = await queryDatabaseChunked(filter, bookmark, env);
      for (const event of chunkedResult.events) {
        if (totalEventsRead >= GLOBAL_MAX_EVENTS) break;
        eventSet.set(event.id, event);
        totalEventsRead++;
      }
    }

    if (batchableFilters.length > 0 && totalEventsRead < GLOBAL_MAX_EVENTS) {
      const validFilters: NostrFilter[] = [];
      for (const filter of batchableFilters) {
        const hasTagFilters = Object.keys(filter).some(key => key.startsWith('#'));

        if (hasTagFilters) {
          const countQuery = buildCountQuery(filter);
          const countResult = await session.prepare(countQuery.sql).bind(...countQuery.params).first() as { count: number } | null;
          const estimatedRows = (countResult?.count as number) || 0;

          if (estimatedRows > 10000) {
            console.warn(`Query precheck: estimated ${estimatedRows} rows, skipping filter to prevent timeout`);
            continue;
          } else {
            console.log(`Query precheck: estimated ${estimatedRows} rows, proceeding`);
          }
        }

        validFilters.push(filter);
      }

      if (validFilters.length === 0) {
        console.warn('All filters were too expensive after COUNT precheck');
      } else {
        const queries = validFilters.map(filter => {
          const query = buildQuery(filter);
          return session.prepare(query.sql).bind(...query.params);
        });

        try {
          const results = await session.batch(queries);
          const allRows: any[] = [];

          for (let i = 0; i < results.length; i++) {
            const result = results[i];

            if (i === 0 && result.meta) {
              console.log({
                servedByRegion: result.meta.served_by_region ?? "",
                servedByPrimary: result.meta.served_by_primary ?? false,
                batchSize: results.length
              });
            }

            if (result.success && result.results) {
              for (const row of result.results as any[]) {
                if (totalEventsRead >= GLOBAL_MAX_EVENTS) break;
                allRows.push(row);
                totalEventsRead++;
              }
            } else if (!result.success) {
              console.error(`Batch query ${i} failed:`, result.error);
            }
          }

          for (const row of allRows) {
            const event: NostrEvent = {
              id: row.id as string,
              pubkey: row.pubkey as string,
              created_at: row.created_at as number,
              kind: row.kind as number,
              tags: JSON.parse(row.tags as string),
              content: row.content as string,
              sig: row.sig as string
            };
            eventSet.set(event.id, event);
          }
        } catch (error: any) {
          console.error(`Batch query execution error: ${error.message}`);
          throw error;
        }
      }
    }

    const events = Array.from(eventSet.values()).sort((a, b) => {
      if (b.created_at !== a.created_at) {
        return b.created_at - a.created_at;
      }
      return a.id.localeCompare(b.id);
    });

    const newBookmark = session.getBookmark();
    console.log(`Found ${events.length} events. New bookmark: ${newBookmark}`);
    return { events, bookmark: newBookmark };

  } catch (error: any) {
    console.error(`Error querying events: ${error.message}`);
    return { events: [], bookmark: null };
  }
}

// ---------------------------------------------------------------------------
// NIP-45 COUNT
// ---------------------------------------------------------------------------

async function countEvents(filters: NostrFilter[], bookmark: string, env: Env): Promise<number> {
  await ensureDatabase(env.RELAY_DATABASE);
  const session = env.RELAY_DATABASE.withSession(bookmark);
  let total = 0;

  for (const filter of filters) {
    const complexity = calculateQueryComplexity(filter);
    if (complexity > MAX_QUERY_COMPLEXITY) {
      console.warn(`COUNT filter too complex (${complexity}), skipping`);
      continue;
    }
    const { sql, params } = buildCountQuery(filter);
    try {
      const result = await session.prepare(sql).bind(...params).first() as { count: number } | null;
      total += (result?.count as number) || 0;
      if (total > COUNT_MAX_ESTIMATE * 10) {
        // Guard against unbounded aggregate scans.
        break;
      }
    } catch (error) {
      console.error('COUNT query failed:', error);
    }
  }

  return total;
}

// ---------------------------------------------------------------------------
// NIP-77 sync item loading
// ---------------------------------------------------------------------------

/**
 * Load (created_at, id) pairs matching a filter for negentropy
 * reconciliation, sorted ascending per the protocol. Bounded by
 * NEG_MAX_ITEMS; the caller refuses the session when the cap is hit.
 */
async function querySyncItems(filter: NostrFilter, env: Env): Promise<{ items: Array<{ created_at: number; id: string }>; truncated: boolean }> {
  await ensureDatabase(env.RELAY_DATABASE);
  const session = env.RELAY_DATABASE.withSession('first-unconstrained');

  const conditions: string[] = [];
  const params: any[] = [];

  if (filter.ids && filter.ids.length > 0) {
    conditions.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
    params.push(...filter.ids);
  }
  if (filter.authors && filter.authors.length > 0) {
    conditions.push(`pubkey IN (${filter.authors.map(() => '?').join(',')})`);
    params.push(...filter.authors);
  }
  if (filter.kinds && filter.kinds.length > 0) {
    conditions.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
    params.push(...filter.kinds);
  }
  if (filter.since) {
    conditions.push('created_at >= ?');
    params.push(filter.since);
  }
  if (filter.until) {
    conditions.push('created_at <= ?');
    params.push(filter.until);
  }
  for (const [key, values] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
      const tagName = key.substring(1);
      if (tagName.length !== 1) continue;
      conditions.push(
        `EXISTS (SELECT 1 FROM event_tags_cache_multi m WHERE m.event_id = events.id AND m.tag_type = ? AND m.tag_value IN (${values.map(() => '?').join(',')}))`,
      );
      params.push(tagName, ...values);
    }
  }

  const sql = `
    SELECT id, created_at FROM events
    ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `;
  params.push(NEG_MAX_ITEMS + 1);

  const result = await session.prepare(sql).bind(...params).all();
  const rows = (result.results ?? []) as Array<{ id: string; created_at: number }>;
  const truncated = rows.length > NEG_MAX_ITEMS;
  return { items: rows.slice(0, NEG_MAX_ITEMS), truncated };
}

// ---------------------------------------------------------------------------
// NIP-11 relay information document
// ---------------------------------------------------------------------------

function handleRelayInfoRequest(request: Request): Response {
  const responseInfo = { ...relayInfo };

  // Advertise exactly what is enabled — never more.
  const nips = new Set<number>([1, 5, 9, 11, 16, 33, 42]);
  if (NIP45_ENABLED) nips.add(45);
  if (NIP50_ENABLED) nips.add(50);
  if (NIP77_ENABLED) nips.add(77);
  responseInfo.supported_nips = [...nips].sort((a, b) => a - b);

  // SIP-01 capability block (SIP-01 §15).
  if (SIP01_ENABLED) {
    responseInfo.uncaged_index = {
      sip01: true,
      nip50: NIP50_ENABLED,
      nip77: NIP77_ENABLED,
      document_kinds: [SIP01_KIND],
      scope: config.SIP01_SCOPE,
      domains: config.SIP01_SCOPE_DOMAINS,
      languages: config.SIP01_SCOPE_LANGUAGES,
      document_types: config.SIP01_SCOPE_DOCUMENT_TYPES,
      filters: [...SUPPORTED_NIP50_OPERATORS],
      relay_mode: RELAY_MODE,
      validation: config.SIP01_VALIDATION,
      schema_version: '1',
    };
  }

  if (PAYMENT_MODE !== 'free') {
    const url = new URL(request.url);
    responseInfo.payments_url = `${url.protocol}//${url.host}`;
  }
  if (PAY_TO_RELAY_ENABLED) {
    responseInfo.fees = {
      admission: [{ amount: RELAY_ACCESS_PRICE_SATS * 1000, unit: "msats" }]
    };
  }

  return new Response(JSON.stringify(responseInfo), {
    status: 200,
    headers: {
      "Content-Type": "application/nostr+json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
      "Access-Control-Allow-Methods": "GET",
    }
  });
}

// ---------------------------------------------------------------------------
// NIP-05 endpoint
// ---------------------------------------------------------------------------

function handleNIP05Request(url: URL): Response {
  const name = url.searchParams.get("name");
  if (!name) {
    return new Response(JSON.stringify({ error: "Missing 'name' parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const pubkey = nip05Users[name.toLowerCase()];
  if (!pubkey) {
    return new Response(JSON.stringify({ error: "User not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }

  const response = {
    names: { [name]: pubkey },
    relays: { [pubkey]: [] }
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

// ---------------------------------------------------------------------------
// Payment endpoints
// ---------------------------------------------------------------------------

async function handleCheckPayment(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pubkey = url.searchParams.get('pubkey');

  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid pubkey (hex)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const paid = await hasPaidForRelay(pubkey, env);

  if (paid === null) {
    return new Response(JSON.stringify({ error: 'Unable to verify payment status' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  return new Response(JSON.stringify({ paid }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/**
 * Payment notification: the client submits its kind 9735 zap receipt after
 * paying the Lightning invoice; the relay verifies the receipt
 * cryptographically and records the payer. (Replaces upstream's
 * unauthenticated `?npub=` marking — see src/pay.ts.)
 */
async function handlePaymentNotification(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json() as { event?: NostrEvent };
    const receipt = body?.event;
    if (!receipt) {
      return new Response(JSON.stringify({ error: 'Missing zap receipt event' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const verified = await verifyZapReceipt(receipt, relayNpub, verifyEventSignature);
    if (!verified) {
      return new Response(JSON.stringify({ error: 'Invalid zap receipt' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Persist the receipt event itself (best-effort audit trail), then record access.
    await saveEventToDatabase(receipt, env).catch(() => undefined);
    const success = await savePaidPubkey(verified.payer, env, verified.amountSats, verified.receiptId);

    return new Response(JSON.stringify({
      success,
      pubkey: verified.payer,
      message: success ? 'Payment recorded successfully' : 'Failed to save payment'
    }), {
      status: success ? 200 : 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    console.error('Error processing payment notification:', error);
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Operator JSON API (consumed by the static dashboard UI)
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

async function handleApiRequest(url: URL, request: Request, env: Env): Promise<Response> {
  const path = url.pathname;

  // Public relay configuration for the UI (never includes secrets).
  if (path === '/api/relay-info') {
    return jsonResponse({
      name: relayInfo.name,
      description: relayInfo.description,
      version: relayInfo.version,
      software: relayInfo.software,
      icon: relayInfo.icon,
      relay_mode: RELAY_MODE,
      sip01_enabled: SIP01_ENABLED,
      sip01_validation: SIP01_VALIDATION,
      nip50: NIP50_ENABLED,
      nip45: NIP45_ENABLED,
      nip77: NIP77_ENABLED,
      auth_required: config.AUTH_REQUIRED,
      payment_mode: PAYMENT_MODE,
      payment_sats: RELAY_ACCESS_PRICE_SATS,
      payment_npub: relayNpub,
      supported_operators: [...SUPPORTED_NIP50_OPERATORS],
    });
  }

  if (path === '/api/health') {
    const session = env.RELAY_DATABASE.withSession('first-unconstrained');
    let events = 0;
    try {
      const row = await session.prepare('SELECT COUNT(*) AS n FROM events').first();
      events = (row?.n as number) ?? 0;
    } catch { /* initializing */ }
    return jsonResponse({ status: 'ok', events, mode: RELAY_MODE, version: relayInfo.version, time: Math.floor(Date.now() / 1000) });
  }

  // Everything below requires SIP-01 indexing.
  if (!SIP01_INDEXING) {
    return jsonResponse({ error: 'SIP-01 indexing is disabled on this relay' }, 404);
  }

  const session = env.RELAY_DATABASE.withSession('first-unconstrained');

  if (path === '/api/stats') {
    return jsonResponse(await sipApi.getSip01Stats(session));
  }

  if (path === '/api/indexers') {
    return jsonResponse(await sipApi.listIndexers(session, url));
  }

  if (path === '/api/indexer') {
    const pubkey = url.searchParams.get('pubkey');
    if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
      return jsonResponse({ error: 'Missing or invalid pubkey (hex)' }, 400);
    }
    const result = await sipApi.getIndexer(session, pubkey);
    return result ? jsonResponse(result) : jsonResponse({ error: 'Indexer not found' }, 404);
  }

  if (path === '/api/documents') {
    return jsonResponse(await sipApi.listDocuments(session, url));
  }

  if (path === '/api/document') {
    const d = url.searchParams.get('d');
    if (!d || !/^widx:[0-9a-f]{32}$/.test(d)) {
      return jsonResponse({ error: "Missing or invalid d (expected 'widx:' + 32 hex chars)" }, 400);
    }
    const result = await sipApi.getDocument(session, d);
    return result ? jsonResponse(result) : jsonResponse({ error: 'Document not found' }, 404);
  }

  if (path === '/api/observations') {
    return jsonResponse(await sipApi.listObservations(session, url));
  }

  // HTTP convenience mirror of NIP-50 search for the dashboard. The relay
  // protocol itself stays standard Nostr over WebSocket.
  if (path === '/api/search') {
    if (!NIP50_ENABLED) return jsonResponse({ error: 'search disabled' }, 404);
    const q = (url.searchParams.get('q') || '').slice(0, 500);
    if (!q.trim()) return jsonResponse({ error: 'Missing q parameter' }, 400);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 100);
    await bumpMetric(env.RELAY_DATABASE.withSession('first-primary'), 'search_queries_http');
    const events = await executeSearch(session, { kinds: [SIP01_KIND], search: q, limit });
    return jsonResponse({ events, query: q, count: events.length });
  }

  return jsonResponse({ error: 'Unknown API endpoint' }, 404);
}

// ---------------------------------------------------------------------------
// Multi-region DO selection logic with location hints
// ---------------------------------------------------------------------------

async function getOptimalDO(cf: any, env: Env): Promise<{ stub: DurableObjectStub; doName: string }> {
  const country = cf?.country || 'US';
  const region = cf?.region || 'unknown';

  const ALL_ENDPOINTS = [
    { name: 'relay-WNAM-primary', hint: 'wnam' },
    { name: 'relay-ENAM-primary', hint: 'enam' },
    { name: 'relay-WEUR-primary', hint: 'weur' },
    { name: 'relay-EEUR-primary', hint: 'eeur' },
    { name: 'relay-APAC-primary', hint: 'apac' },
    { name: 'relay-OC-primary', hint: 'oc' },
    { name: 'relay-SAM-primary', hint: 'sam' },
    { name: 'relay-AFR-primary', hint: 'afr' },
    { name: 'relay-ME-primary', hint: 'me' }
  ];

  const countryToHint: Record<string, string> = {
    'US': 'enam', 'CA': 'enam', 'MX': 'wnam',
    'GT': 'wnam', 'BZ': 'wnam', 'SV': 'wnam', 'HN': 'wnam', 'NI': 'wnam',
    'CR': 'wnam', 'PA': 'wnam', 'CU': 'wnam', 'DO': 'wnam', 'HT': 'wnam',
    'JM': 'wnam', 'PR': 'wnam', 'TT': 'wnam', 'BB': 'wnam',
    'BR': 'sam', 'AR': 'sam', 'CL': 'sam', 'CO': 'sam', 'PE': 'sam',
    'VE': 'sam', 'EC': 'sam', 'BO': 'sam', 'PY': 'sam', 'UY': 'sam',
    'GY': 'sam', 'SR': 'sam', 'GF': 'sam',
    'GB': 'weur', 'FR': 'weur', 'DE': 'weur', 'ES': 'weur', 'IT': 'weur',
    'NL': 'weur', 'BE': 'weur', 'CH': 'weur', 'AT': 'weur', 'PT': 'weur',
    'IE': 'weur', 'LU': 'weur', 'MC': 'weur', 'AD': 'weur', 'SM': 'weur',
    'VA': 'weur', 'LI': 'weur', 'MT': 'weur',
    'SE': 'weur', 'NO': 'weur', 'DK': 'weur', 'FI': 'weur', 'IS': 'weur',
    'PL': 'eeur', 'RU': 'eeur', 'UA': 'eeur', 'RO': 'eeur', 'CZ': 'eeur',
    'HU': 'eeur', 'GR': 'eeur', 'BG': 'eeur', 'SK': 'eeur', 'HR': 'eeur',
    'RS': 'eeur', 'SI': 'eeur', 'BA': 'eeur', 'AL': 'eeur', 'MK': 'eeur',
    'ME': 'eeur', 'XK': 'eeur', 'BY': 'eeur', 'MD': 'eeur', 'LT': 'eeur',
    'LV': 'eeur', 'EE': 'eeur', 'CY': 'eeur',
    'JP': 'apac', 'CN': 'apac', 'KR': 'apac', 'IN': 'apac', 'SG': 'apac',
    'TH': 'apac', 'ID': 'apac', 'MY': 'apac', 'VN': 'apac', 'PH': 'apac',
    'TW': 'apac', 'HK': 'apac', 'MO': 'apac', 'KH': 'apac', 'LA': 'apac',
    'MM': 'apac', 'BD': 'apac', 'LK': 'apac', 'NP': 'apac', 'BT': 'apac',
    'MV': 'apac', 'PK': 'apac', 'AF': 'apac', 'MN': 'apac', 'KP': 'apac',
    'BN': 'apac', 'TL': 'apac', 'PG': 'apac', 'FJ': 'apac', 'SB': 'apac',
    'VU': 'apac', 'NC': 'apac', 'PF': 'apac', 'WS': 'apac', 'TO': 'apac',
    'KI': 'apac', 'PW': 'apac', 'MH': 'apac', 'FM': 'apac', 'NR': 'apac',
    'TV': 'apac', 'CK': 'apac', 'NU': 'apac', 'TK': 'apac', 'GU': 'apac',
    'MP': 'apac', 'AS': 'apac',
    'AU': 'oc', 'NZ': 'oc',
    'AE': 'me', 'SA': 'me', 'IL': 'me', 'TR': 'me', 'EG': 'me',
    'IQ': 'me', 'IR': 'me', 'SY': 'me', 'JO': 'me', 'LB': 'me',
    'KW': 'me', 'QA': 'me', 'BH': 'me', 'OM': 'me', 'YE': 'me',
    'PS': 'me', 'GE': 'me', 'AM': 'me', 'AZ': 'me',
    'ZA': 'afr', 'NG': 'afr', 'KE': 'afr', 'MA': 'afr', 'TN': 'afr',
    'DZ': 'afr', 'LY': 'afr', 'ET': 'afr', 'GH': 'afr', 'TZ': 'afr',
    'UG': 'afr', 'SD': 'afr', 'AO': 'afr', 'MZ': 'afr', 'MG': 'afr',
    'CM': 'afr', 'CI': 'afr', 'NE': 'afr', 'BF': 'afr', 'ML': 'afr',
    'MW': 'afr', 'ZM': 'afr', 'SN': 'afr', 'SO': 'afr', 'TD': 'afr',
    'ZW': 'afr', 'GN': 'afr', 'RW': 'afr', 'BJ': 'afr', 'BI': 'afr',
    'TG': 'afr', 'SL': 'afr', 'LR': 'afr', 'MR': 'afr', 'CF': 'afr',
    'ER': 'afr', 'GM': 'afr', 'BW': 'afr', 'NA': 'afr', 'GA': 'afr',
    'LS': 'afr', 'GW': 'afr', 'GQ': 'afr', 'MU': 'afr', 'SZ': 'afr',
    'DJ': 'afr', 'KM': 'afr', 'CV': 'afr', 'SC': 'afr', 'ST': 'afr',
    'SS': 'afr', 'EH': 'afr', 'CG': 'afr', 'CD': 'afr',
    'KZ': 'apac', 'UZ': 'apac', 'TM': 'apac', 'TJ': 'apac', 'KG': 'apac',
  };

  const usStateToHint: Record<string, string> = {
    'California': 'wnam', 'Oregon': 'wnam', 'Washington': 'wnam', 'Nevada': 'wnam', 'Arizona': 'wnam',
    'Utah': 'wnam', 'Idaho': 'wnam', 'Montana': 'wnam', 'Wyoming': 'wnam', 'Colorado': 'wnam',
    'New Mexico': 'wnam', 'Alaska': 'wnam', 'Hawaii': 'wnam',
    'New York': 'enam', 'Florida': 'enam', 'Texas': 'enam', 'Illinois': 'enam', 'Georgia': 'enam',
    'Pennsylvania': 'enam', 'Ohio': 'enam', 'Michigan': 'enam', 'North Carolina': 'enam', 'Virginia': 'enam',
    'Massachusetts': 'enam', 'New Jersey': 'enam', 'Maryland': 'enam', 'Connecticut': 'enam', 'Maine': 'enam',
    'New Hampshire': 'enam', 'Vermont': 'enam', 'Rhode Island': 'enam', 'South Carolina': 'enam', 'Tennessee': 'enam',
    'Alabama': 'enam', 'Mississippi': 'enam', 'Louisiana': 'enam', 'Arkansas': 'enam', 'Missouri': 'enam',
    'Iowa': 'enam', 'Minnesota': 'enam', 'Wisconsin': 'enam', 'Indiana': 'enam', 'Kentucky': 'enam',
    'West Virginia': 'enam', 'Delaware': 'enam', 'Oklahoma': 'enam', 'Kansas': 'enam', 'Nebraska': 'enam',
    'South Dakota': 'enam', 'North Dakota': 'enam',
    'District of Columbia': 'enam',
  };

  const continentToHint: Record<string, string> = {
    'NA': 'enam', 'SA': 'sam', 'EU': 'weur', 'AS': 'apac', 'AF': 'afr', 'OC': 'oc'
  };

  let bestHint: string;
  if (country === 'US' && region && region !== 'unknown') {
    bestHint = usStateToHint[region] || 'enam';
  } else {
    bestHint = countryToHint[country] || continentToHint[cf?.continent || 'NA'] || 'enam';
  }

  const primaryEndpoint = ALL_ENDPOINTS.find(ep => ep.hint === bestHint) || ALL_ENDPOINTS[1];
  const orderedEndpoints = [
    primaryEndpoint,
    ...ALL_ENDPOINTS.filter(ep => ep.name !== primaryEndpoint.name)
  ];

  for (const endpoint of orderedEndpoints) {
    try {
      const id = env.RELAY_WEBSOCKET.idFromName(endpoint.name);
      const stub = env.RELAY_WEBSOCKET.get(id, { locationHint: endpoint.hint });
      // @ts-ignore
      return { stub, doName: endpoint.name };
    } catch (error) {
      console.log(`Failed to connect to ${endpoint.name}: ${error}`);
    }
  }

  const fallback = ALL_ENDPOINTS[1];
  const id = env.RELAY_WEBSOCKET.idFromName(fallback.name);
  const stub = env.RELAY_WEBSOCKET.get(id, { locationHint: fallback.hint });
  // @ts-ignore
  return { stub, doName: fallback.name };
}

// ---------------------------------------------------------------------------
// Database pruning (D1 has a 10GB limit)
// ---------------------------------------------------------------------------

async function getDatabaseSizeBytes(session: D1DatabaseSession): Promise<number> {
  try {
    const result = await session.prepare('SELECT 1').run();
    const sizeAfter = (result.meta as { size_after?: number } | undefined)?.size_after;
    if (typeof sizeAfter === 'number' && sizeAfter > 0) {
      return sizeAfter;
    }
    return 0;
  } catch (error) {
    console.error('Error getting database size:', error);
    return 0;
  }
}

async function pruneOldEvents(session: D1DatabaseSession, targetSizeBytes: number): Promise<{ eventsDeleted: number; finalSizeBytes: number }> {
  let totalEventsDeleted = 0;
  let currentSize = await getDatabaseSizeBytes(session);

  console.log(`Starting database pruning. Current size: ${(currentSize / (1024 * 1024 * 1024)).toFixed(2)} GB, Target: ${(targetSizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`);

  const protectedKinds = new Set<number>(pruneProtectedKinds);
  if (SIP01_PRUNE_ALLOWED) protectedKinds.delete(SIP01_KIND);
  const protectedKindsArray = Array.from(protectedKinds);
  const protectedKindsClause = protectedKindsArray.length > 0
    ? `AND kind NOT IN (${protectedKindsArray.join(',')})`
    : '';

  while (currentSize > targetSizeBytes) {
    const oldestEvents = await session.prepare(`
      SELECT id FROM events
      WHERE 1=1 ${protectedKindsClause}
      ORDER BY created_at ASC
      LIMIT ?
    `).bind(DB_PRUNE_BATCH_SIZE).all();

    if (!oldestEvents.results || oldestEvents.results.length === 0) {
      console.log('No more events eligible for pruning');
      break;
    }

    const eventIds = oldestEvents.results.map((row: any) => row.id as string);
    const placeholders = eventIds.map(() => '?').join(',');

    if (SIP01_INDEXING) {
      await removeSip01Observations(session, eventIds);
    }

    const pruneResults = await session.batch([
      session.prepare(`DELETE FROM tags WHERE event_id IN (${placeholders})`).bind(...eventIds),
      session.prepare(`DELETE FROM content_hashes WHERE event_id IN (${placeholders})`).bind(...eventIds),
      session.prepare(`DELETE FROM event_tags_cache_multi WHERE event_id IN (${placeholders})`).bind(...eventIds),
      session.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).bind(...eventIds),
    ]);

    const deletedCount = pruneResults[3]?.meta?.changes || eventIds.length;
    totalEventsDeleted += deletedCount;

    console.log(`Pruned ${deletedCount} events (total: ${totalEventsDeleted})`);

    currentSize = await getDatabaseSizeBytes(session);
    console.log(`Current database size: ${(currentSize / (1024 * 1024 * 1024)).toFixed(2)} GB`);

    if (totalEventsDeleted >= 100000) {
      console.log('Reached maximum pruning limit for this run (100,000 events)');
      break;
    }
  }

  return { eventsDeleted: totalEventsDeleted, finalSizeBytes: currentSize };
}

// ---------------------------------------------------------------------------
// Static UI serving
// ---------------------------------------------------------------------------

const UI_ROUTES = new Set([
  '/', '/dashboard', '/search', '/explorer', '/indexers', '/documents',
  '/relay', '/deploy', '/tests', '/docs',
]);

async function serveUi(request: Request, env: Env, url: URL): Promise<Response> {
  if (env.ASSETS) {
    // SPA routes serve index.html; asset paths serve themselves.
    if (UI_ROUTES.has(url.pathname)) {
      const indexUrl = new URL('/index.html', url);
      return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
    return new Response('Not found', { status: 404 });
  }
  // Single-script deploy fallback.
  return serveMiniLanding(url.host);
}

// ---------------------------------------------------------------------------
// Exports for the Durable Object
// ---------------------------------------------------------------------------

export {
  verifyEventSignature,
  hasPaidForRelay,
  processEvent,
  queryEvents,
  countEvents,
  executeSearch,
  querySyncItems,
  calculateQueryComplexity,
  initializeDatabase,
};

// ---------------------------------------------------------------------------
// Main worker
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      // Payment endpoints
      if (request.method === 'POST' && url.searchParams.has('notify-zap') && PAY_TO_RELAY_ENABLED) {
        return await handlePaymentNotification(request, env);
      }

      if (url.pathname === "/api/check-payment" && PAY_TO_RELAY_ENABLED) {
        return await handleCheckPayment(request, env);
      }

      // Operator JSON API
      if (url.pathname.startsWith('/api/')) {
        await ensureDatabase(env.RELAY_DATABASE);
        return await handleApiRequest(url, request, env);
      }

      // Main endpoint
      if (url.pathname === "/") {
        if (request.headers.get("Upgrade") === "websocket") {
          const cf = (request as any).cf;
          const { stub, doName } = await getOptimalDO(cf, env);

          const newUrl = new URL(request.url);
          newUrl.searchParams.set('region', cf?.region || 'unknown');
          newUrl.searchParams.set('colo', cf?.colo || 'unknown');
          newUrl.searchParams.set('continent', cf?.continent || 'unknown');
          newUrl.searchParams.set('country', cf?.country || 'unknown');
          newUrl.searchParams.set('doName', doName);

          return stub.fetch(new Request(newUrl, request));
        } else if ((request.headers.get("Accept") || "").includes("application/nostr+json")) {
          return handleRelayInfoRequest(request);
        } else {
          ctx.waitUntil(ensureDatabase(env.RELAY_DATABASE));
          return serveUi(request, env, url);
        }
      } else if (url.pathname === "/.well-known/nostr.json") {
        return handleNIP05Request(url);
      } else if (request.method === 'GET') {
        return await serveUi(request, env, url);
      } else {
        return new Response("Invalid request", { status: 400 });
      }
    } catch (error) {
      console.error("Error in fetch handler:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },

  // Scheduled handler for 24hr database maintenance (runs daily at 00:00 UTC)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Running scheduled 24hr database maintenance...');

    try {
      const session = env.RELAY_DATABASE.withSession('first-primary');

      if (DB_PRUNING_ENABLED) {
        const currentSizeBytes = await getDatabaseSizeBytes(session);
        const currentSizeGB = currentSizeBytes / (1024 * 1024 * 1024);
        console.log(`Current database size: ${currentSizeGB.toFixed(2)} GB (threshold: ${DB_SIZE_THRESHOLD_GB} GB)`);

        if (currentSizeGB >= DB_SIZE_THRESHOLD_GB) {
          console.log(`Database size (${currentSizeGB.toFixed(2)} GB) exceeds threshold (${DB_SIZE_THRESHOLD_GB} GB). Starting pruning...`);
          const targetSizeBytes = DB_PRUNE_TARGET_GB * 1024 * 1024 * 1024;
          const pruneResult = await pruneOldEvents(session, targetSizeBytes);
          console.log(`Pruning completed. Deleted ${pruneResult.eventsDeleted} events. Final size: ${(pruneResult.finalSizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`);
        } else {
          console.log('Database size is within limits. No pruning needed.');
        }
      } else {
        console.log('Database pruning is disabled.');
      }

      console.log('Running PRAGMA optimize...');
      await session.prepare('PRAGMA optimize').run();

      console.log('Running ANALYZE on all tables...');
      await session.prepare('ANALYZE events').run();
      await session.prepare('ANALYZE tags').run();
      await session.prepare('ANALYZE event_tags_cache_multi').run();
      await session.prepare('ANALYZE content_hashes').run();
      await session.prepare('ANALYZE sip01_documents').run().catch(() => undefined);
      await session.prepare('ANALYZE sip01_observations').run().catch(() => undefined);
      await session.prepare('ANALYZE sip01_indexers').run().catch(() => undefined);

      console.log('Scheduled 24hr database maintenance completed successfully');
    } catch (error) {
      console.error('Scheduled maintenance failed:', error);
    }
  }
};

// Export the Durable Object class
export { RelayWebSocket };
