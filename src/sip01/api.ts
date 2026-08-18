/**
 * SIP-01 read-side queries backing the JSON HTTP API (/api/stats,
 * /api/indexers, /api/documents, /api/document, /api/observations) and the
 * operator dashboard. Read-only; all values are bound parameters.
 *
 * @module src/sip01/api
 */

type Session = D1DatabaseSession;

function clampInt(value: string | null, min: number, max: number, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Database size in bytes as reported by D1's `size_after` meta (0 when unknown). */
export async function getDatabaseSizeBytes(session: Session): Promise<number> {
  try {
    const result = await session.prepare('SELECT 1').run();
    const sizeAfter = (result.meta as { size_after?: number } | undefined)?.size_after;
    return typeof sizeAfter === 'number' && sizeAfter > 0 ? sizeAfter : 0;
  } catch {
    return 0;
  }
}

/** All relay metric counters as a flat object. */
export async function getMetrics(session: Session): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const rows = await session.prepare('SELECT key, value FROM relay_metrics').all();
    for (const row of rows.results ?? []) {
      out[row.key as string] = row.value as number;
    }
  } catch {
    /* metrics table may not exist yet */
  }
  return out;
}

/** Headline statistics for the dashboard/API. */
export async function getSip01Stats(session: Session) {
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const weekAgo = now - 7 * 86400;

  const [
    totals,
    last24h,
    last7d,
    topHosts,
    topLanguages,
    topMimes,
    topTypes,
    topIndexers,
    topSoftware,
    metrics,
    sizeBytes,
  ] = await Promise.all([
    session
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sip01_documents) AS documents,
           (SELECT COUNT(*) FROM sip01_observations) AS observations,
           (SELECT COUNT(*) FROM sip01_indexers) AS indexers`,
      )
      .first(),
    session.prepare('SELECT COUNT(*) AS n FROM sip01_observations WHERE created_at >= ?').bind(dayAgo).first(),
    session.prepare('SELECT COUNT(*) AS n FROM sip01_observations WHERE created_at >= ?').bind(weekAgo).first(),
    session
      .prepare('SELECT url_host, COUNT(*) AS n FROM sip01_documents GROUP BY url_host ORDER BY n DESC LIMIT 10')
      .all(),
    session
      .prepare("SELECT language, COUNT(*) AS n FROM sip01_documents WHERE language IS NOT NULL GROUP BY language ORDER BY n DESC LIMIT 10")
      .all(),
    session
      .prepare("SELECT content_type, COUNT(*) AS n FROM sip01_documents WHERE content_type IS NOT NULL GROUP BY content_type ORDER BY n DESC LIMIT 10")
      .all(),
    session
      .prepare("SELECT doc_type, COUNT(*) AS n FROM sip01_documents WHERE doc_type IS NOT NULL GROUP BY doc_type ORDER BY n DESC LIMIT 10")
      .all(),
    session
      .prepare('SELECT pubkey, software, software_version, observation_count, document_count, last_seen FROM sip01_indexers ORDER BY observation_count DESC LIMIT 10')
      .all(),
    session
      .prepare("SELECT software, COUNT(*) AS n, SUM(observation_count) AS observations FROM sip01_indexers WHERE software IS NOT NULL GROUP BY software ORDER BY observations DESC LIMIT 10")
      .all(),
    getMetrics(session),
    getDatabaseSizeBytes(session),
  ]);

  return {
    documents: (totals?.documents as number) ?? 0,
    observations: (totals?.observations as number) ?? 0,
    indexers: (totals?.indexers as number) ?? 0,
    observations_24h: (last24h?.n as number) ?? 0,
    observations_7d: (last7d?.n as number) ?? 0,
    top_hosts: topHosts.results ?? [],
    top_languages: topLanguages.results ?? [],
    top_mime_types: topMimes.results ?? [],
    top_document_types: topTypes.results ?? [],
    top_indexers: topIndexers.results ?? [],
    indexer_software: topSoftware.results ?? [],
    metrics,
    database_size_bytes: sizeBytes,
    generated_at: now,
  };
}

/** Paginated indexer list. */
export async function listIndexers(session: Session, url: URL) {
  const limit = clampInt(url.searchParams.get('limit'), 1, 500, 50);
  const offset = clampInt(url.searchParams.get('offset'), 0, 1_000_000, 0);
  const rows = await session
    .prepare(
      `SELECT pubkey, software, software_version, first_seen, last_seen, observation_count, document_count
       FROM sip01_indexers ORDER BY observation_count DESC, last_seen DESC LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all();
  const total = await session.prepare('SELECT COUNT(*) AS n FROM sip01_indexers').first();
  return { indexers: rows.results ?? [], total: (total?.n as number) ?? 0, limit, offset };
}

/** Paginated document list with optional host/language/keyword filters. */
export async function listDocuments(session: Session, url: URL) {
  const limit = clampInt(url.searchParams.get('limit'), 1, 500, 50);
  const offset = clampInt(url.searchParams.get('offset'), 0, 1_000_000, 0);
  const host = url.searchParams.get('host');
  const language = url.searchParams.get('lang');
  const q = url.searchParams.get('q');

  const conditions: string[] = [];
  const params: any[] = [];
  if (host) {
    conditions.push('(url_host = ? OR url_host LIKE ?)');
    params.push(host.toLowerCase(), `%.${host.toLowerCase()}`);
  }
  if (language) {
    conditions.push('language = ?');
    params.push(language.toLowerCase());
  }
  if (q) {
    const needle = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    conditions.push(`(lower(title) LIKE ? ESCAPE '\\' OR lower(description) LIKE ? ESCAPE '\\' OR lower(canonical_url) LIKE ? ESCAPE '\\')`);
    params.push(needle, needle, needle);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await session
    .prepare(
      `SELECT d, canonical_url, url_host, title, description, image, content_hash, language,
              content_type, doc_type, platform, category, network, country, file_ext, topics,
              published_at, first_seen, last_seen, observation_count, indexer_count, last_event_id
       FROM sip01_documents ${where}
       ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all();
  const total = await session
    .prepare(`SELECT COUNT(*) AS n FROM sip01_documents ${where}`)
    .bind(...params)
    .first();
  return { documents: rows.results ?? [], total: (total?.n as number) ?? 0, limit, offset };
}

/** One document with its full observation provenance (indexer pubkeys, event ids). */
export async function getDocument(session: Session, d: string) {
  const doc = await session
    .prepare(
      `SELECT d, canonical_url, url_host, title, description, image, content_hash, language,
              content_type, doc_type, platform, category, network, country, file_ext, topics,
              published_at, first_seen, last_seen, observation_count, indexer_count, last_event_id
       FROM sip01_documents WHERE d = ?`,
    )
    .bind(d)
    .first();
  if (!doc) return null;

  const observations = await session
    .prepare(
      `SELECT o.event_id, o.pubkey, o.created_at, o.content_hash, o.source, o.relay_seen_at
       FROM sip01_observations o WHERE o.d = ? ORDER BY o.created_at DESC`,
    )
    .bind(d)
    .all();

  return { document: doc, observations: observations.results ?? [] };
}

/** Recent observations joined with their full events (the explorer feed). */
export async function listObservations(session: Session, url: URL) {
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
  const offset = clampInt(url.searchParams.get('offset'), 0, 1_000_000, 0);
  const pubkey = url.searchParams.get('pubkey');
  const d = url.searchParams.get('d');

  const conditions: string[] = [];
  const params: any[] = [];
  if (pubkey) {
    conditions.push('o.pubkey = ?');
    params.push(pubkey.toLowerCase());
  }
  if (d) {
    conditions.push('o.d = ?');
    params.push(d);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await session
    .prepare(
      `SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig
       FROM sip01_observations o JOIN events e ON e.id = o.event_id
       ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...params, limit, offset)
    .all();

  const events = (rows.results ?? []).map((row) => ({
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: JSON.parse(row.tags as string),
    content: row.content,
    sig: row.sig,
  }));
  return { events, limit, offset };
}

/** Single indexer profile. */
export async function getIndexer(session: Session, pubkey: string) {
  const indexer = await session
    .prepare(
      `SELECT pubkey, software, software_version, first_seen, last_seen, observation_count, document_count
       FROM sip01_indexers WHERE pubkey = ?`,
    )
    .bind(pubkey.toLowerCase())
    .first();
  if (!indexer) return null;

  const topHosts = await session
    .prepare(
      `SELECT doc.url_host, COUNT(*) AS n FROM sip01_observations o
       JOIN sip01_documents doc ON doc.d = o.d
       WHERE o.pubkey = ? GROUP BY doc.url_host ORDER BY n DESC LIMIT 10`,
    )
    .bind(pubkey.toLowerCase())
    .all();
  const languages = await session
    .prepare(
      `SELECT doc.language, COUNT(*) AS n FROM sip01_observations o
       JOIN sip01_documents doc ON doc.d = o.d
       WHERE o.pubkey = ? AND doc.language IS NOT NULL GROUP BY doc.language ORDER BY n DESC LIMIT 10`,
    )
    .bind(pubkey.toLowerCase())
    .all();

  return {
    indexer,
    top_hosts: topHosts.results ?? [],
    languages: languages.results ?? [],
  };
}
