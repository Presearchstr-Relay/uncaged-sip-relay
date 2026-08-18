/**
 * RelayWebSocket Durable Object — the Nostr protocol endpoint.
 *
 * Holds the long-lived WebSocket connections (with hibernation), enforces
 * relay policy (rate limits, allow/block lists, payment, NIP-42), drives
 * SIP-01 validation/indexing through the worker module, and implements:
 *
 *   NIP-01  EVENT / REQ / CLOSE / OK / EOSE / CLOSED / NOTICE
 *   NIP-42  AUTH (optional, config-gated)
 *   NIP-45  COUNT
 *   NIP-50  search filters (SIP-01-aware operators for kind 39697)
 *   NIP-77  NEG-OPEN / NEG-MSG / NEG-CLOSE / NEG-ERR (negentropy sync)
 *
 * Forked from Nosflare's Durable Object (MIT) — see UPSTREAM.md.
 *
 * @module src/durable-object
 */

import { NostrEvent, NostrFilter, RateLimiter, WebSocketSession, Env, DOBroadcastRequest, QueryResult, NegSession } from './types';
import {
  PUBKEY_RATE_LIMIT,
  REQ_RATE_LIMIT,
  SIP01_INDEXER_RATE_LIMIT,
  PAY_TO_RELAY_ENABLED,
  AUTH_REQUIRED,
  AUTH_TIMEOUT_MS,
  NIP50_ENABLED,
  NIP45_ENABLED,
  NIP77_ENABLED,
  NEG_FRAME_SIZE_LIMIT,
  NEG_SESSION_TIMEOUT_MS,
  SIP01_ENABLED,
  isPubkeyAllowed,
  isEventKindAllowed,
  containsBlockedContent,
  isTagAllowed,
  excludedRateLimitKinds,
  relayInfo,
} from './config';
import { verifyEventSignature, hasPaidForRelay, processEvent, queryEvents, countEvents, executeSearch, querySyncItems, calculateQueryComplexity, ensureDatabase, NEG_MAX_ITEMS } from './relay-worker';
import { Negentropy, NegentropyStorageVector, hexToBytes as negHexToBytes, bytesToHex as negBytesToHex } from '../shared/negentropy.js';
import { SIP01_KIND, extractSip01Fields } from '../shared/sip01.js';
import { parseSearchQuery, matchSip01Search } from '../shared/search-query.js';
import { bumpMetric } from './sip01/ingest';

// Session attachment data structure (minimal - auth state stored in session)
interface SessionAttachment {
  sessionId: string;
  bookmark: string;
  host: string;
  doName: string;
  hasPaid?: boolean;
  // NIP-42: Persist auth state across hibernation
  authenticatedPubkeys?: string[];
  challenge?: string;
}

// Cache entry interface with access tracking
interface CacheEntry {
  result: QueryResult;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
}

// Payment cache entry
interface PaymentCacheEntry {
  hasPaid: boolean;
  timestamp: number;
}

export class RelayWebSocket implements DurableObject {
  private sessions: Map<string, WebSocketSession>;
  private env: Env;
  private state: DurableObjectState;
  private region: string;
  private doId: string;
  private doName: string;
  private processedEvents: Map<string, number> = new Map(); // eventId -> timestamp

  // Query cache for REQ messages
  private queryCache: Map<string, CacheEntry> = new Map();
  private readonly QUERY_CACHE_TTL = 60000;
  private readonly MAX_CACHE_SIZE = 100;

  // Query cache index for efficient invalidation (kind:X, author:Y, etc.)
  private queryCacheIndex: Map<string, Set<string>> = new Map();

  // Active queries for deduplication (prevent duplicate work)
  private activeQueries: Map<string, Promise<QueryResult>> = new Map();

  // Payment status cache
  private paymentCache: Map<string, PaymentCacheEntry> = new Map();
  private readonly PAYMENT_CACHE_TTL = 60000;

  // NIP-77 negentropy sessions: `${sessionId}:${subId}` → state (in-memory;
  // reclaimed on hibernation/timeout with NEG-ERR closed:)
  private negSessions: Map<string, NegSession> = new Map();

  // Parsed NIP-50 queries cached per filter object (live delivery matching)
  private parsedSearchCache: WeakMap<NostrFilter, ReturnType<typeof parseSearchQuery>> = new WeakMap();

  // Alarm and cleanup configuration
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private lastActivityTime: number = Date.now();

  // Define allowed endpoints
  private static readonly ALLOWED_ENDPOINTS = [
    'relay-WNAM-primary',  // Western North America
    'relay-ENAM-primary',  // Eastern North America
    'relay-WEUR-primary',  // Western Europe
    'relay-EEUR-primary',  // Eastern Europe
    'relay-APAC-primary',  // Asia-Pacific
    'relay-OC-primary',    // Oceania
    'relay-SAM-primary',   // South America (redirects to enam)
    'relay-AFR-primary',   // Africa (redirects to weur)
    'relay-ME-primary'     // Middle East (redirects to eeur)
  ];

  // Map endpoints to their proper location hints
  private static readonly ENDPOINT_HINTS: Record<string, string> = {
    'relay-WNAM-primary': 'wnam',
    'relay-ENAM-primary': 'enam',
    'relay-WEUR-primary': 'weur',
    'relay-EEUR-primary': 'eeur',
    'relay-APAC-primary': 'apac',
    'relay-OC-primary': 'oc',
    'relay-SAM-primary': 'enam',
    'relay-AFR-primary': 'weur',
    'relay-ME-primary': 'eeur'
  };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.sessions = new Map();
    this.env = env;
    this.doId = crypto.randomUUID();
    this.region = 'unknown';
    this.doName = 'unknown';
    this.processedEvents = new Map();
    this.queryCache = new Map();
    this.queryCacheIndex = new Map();
    this.activeQueries = new Map();
    this.paymentCache = new Map();
    this.negSessions = new Map();
    this.lastActivityTime = Date.now();
  }

  // Alarm handler - called when scheduled alarm fires
  async alarm(): Promise<void> {
    console.log(`Alarm triggered for DO ${this.doName}`);

    const now = Date.now();
    const idleTime = now - this.lastActivityTime;

    const activeWebSockets = this.state.getWebSockets();
    const activeCount = activeWebSockets.length;

    console.log(`DO ${this.doName} - Active WebSockets: ${activeCount}, Idle time: ${idleTime}ms`);

    // Reclaim idle NEG sessions
    this.reclaimIdleNegSessions();

    if (activeCount === 0) {
      console.log(`Cleaning up DO ${this.doName} - no active connections`);
      await this.cleanup();
      return;
    }

    const nextAlarm = now + this.IDLE_TIMEOUT;
    await this.state.storage.setAlarm(nextAlarm);
    console.log(`Next alarm scheduled for DO ${this.doName} in ${this.IDLE_TIMEOUT}ms`);
  }

  private async cleanup(): Promise<void> {
    console.log(`Running cleanup for DO ${this.doName}`);

    this.queryCache.clear();
    this.queryCacheIndex.clear();
    this.activeQueries.clear();
    this.paymentCache.clear();
    this.processedEvents.clear();
    this.negSessions.clear();
    this.sessions.clear();

    await this.cleanupOrphanedSubscriptions();

    console.log(`Cleanup complete for DO ${this.doName}`);
  }

  private async cleanupOrphanedSubscriptions(): Promise<void> {
    try {
      const allKeys = await this.state.storage.list();
      const activeWebSockets = this.state.getWebSockets();
      const activeSessionIds = new Set<string>();

      for (const ws of activeWebSockets) {
        const attachment = ws.deserializeAttachment() as SessionAttachment | null;
        if (attachment) {
          activeSessionIds.add(attachment.sessionId);
        }
      }

      const keysToDelete: string[] = [];
      for (const [key] of allKeys) {
        if (key.startsWith('subs:')) {
          const sessionId = key.substring(5);
          if (!activeSessionIds.has(sessionId)) {
            keysToDelete.push(key);
          }
        }
      }

      if (keysToDelete.length > 0) {
        await this.state.storage.delete(keysToDelete);
        console.log(`Cleaned up ${keysToDelete.length} orphaned subscription entries`);
      }
    } catch (error) {
      console.error('Error cleaning up orphaned subscriptions:', error);
    }
  }

  private async scheduleAlarmIfNeeded(): Promise<void> {
    const existingAlarm = await this.state.storage.getAlarm();

    if (existingAlarm === null) {
      const alarmTime = Date.now() + this.IDLE_TIMEOUT;
      await this.state.storage.setAlarm(alarmTime);
      console.log(`Scheduled first alarm for DO ${this.doName}`);
    }
  }

  // Storage helper methods for subscriptions
  private async saveSubscriptions(sessionId: string, subscriptions: Map<string, NostrFilter[]>): Promise<void> {
    const key = `subs:${sessionId}`;
    const data = Array.from(subscriptions.entries());
    await this.state.storage.put(key, data);
  }

  private async loadSubscriptions(sessionId: string): Promise<Map<string, NostrFilter[]>> {
    const key = `subs:${sessionId}`;
    const data = await this.state.storage.get<[string, NostrFilter[]][]>(key);
    return new Map(data || []);
  }

  private async deleteSubscriptions(sessionId: string): Promise<void> {
    const key = `subs:${sessionId}`;
    await this.state.storage.delete(key);
  }

  // Payment cache methods
  private async getCachedPaymentStatus(pubkey: string): Promise<boolean | null> {
    const cached = this.paymentCache.get(pubkey);
    if (cached && Date.now() - cached.timestamp < this.PAYMENT_CACHE_TTL) {
      return cached.hasPaid;
    }
    if (cached) {
      this.paymentCache.delete(pubkey);
    }
    return null;
  }

  private setCachedPaymentStatus(pubkey: string, hasPaid: boolean): void {
    this.paymentCache.set(pubkey, {
      hasPaid,
      timestamp: Date.now()
    });

    if (this.paymentCache.size > 1000) {
      const sortedEntries = Array.from(this.paymentCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toRemove = Math.floor(this.paymentCache.size * 0.2);
      for (let i = 0; i < toRemove; i++) {
        this.paymentCache.delete(sortedEntries[i][0]);
      }
    }
  }

  // Helper to generate global cache key
  private async generateGlobalCacheKey(filters: NostrFilter[], bookmark: string): Promise<string> {
    const cacheData = JSON.stringify({ filters, bookmark });
    const buffer = new TextEncoder().encode(cacheData);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `https://siprelay-query-cache/${hashHex}`;
  }

  // Query cache methods with deduplication and global caching
  private async getCachedOrQuery(filters: NostrFilter[], bookmark: string): Promise<QueryResult> {
    const cacheKey = JSON.stringify({ filters, bookmark });

    if (this.activeQueries.has(cacheKey)) {
      console.log('Returning in-flight query result (deduplication)');
      return await this.activeQueries.get(cacheKey)!;
    }

    // Check Cloudflare global cache first
    try {
      const globalCache = caches.default;
      const globalCacheKey = await this.generateGlobalCacheKey(filters, bookmark);
      const globalCached = await globalCache.match(globalCacheKey);

      if (globalCached) {
        const cachedDate = globalCached.headers.get('X-Cache-Time');
        if (cachedDate && Date.now() - parseInt(cachedDate) > 300000) {
          console.log('Global cache entry expired, deleting');
          await globalCache.delete(globalCacheKey);
        } else {
          console.log('Returning globally cached query result');
          const result = await globalCached.json() as QueryResult;

          this.queryCache.set(cacheKey, {
            result,
            timestamp: Date.now(),
            accessCount: 1,
            lastAccessed: Date.now()
          });
          this.addToCacheIndex(cacheKey, filters);

          return result;
        }
      }
    } catch (error) {
      console.error('Error checking global cache:', error);
    }

    // Check local cache
    const cached = this.queryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.QUERY_CACHE_TTL) {
      cached.accessCount++;
      cached.lastAccessed = Date.now();
      return cached.result;
    }

    const queryPromise = queryEvents(filters, bookmark, this.env);
    this.activeQueries.set(cacheKey, queryPromise);

    try {
      const result = await queryPromise;

      this.queryCache.set(cacheKey, {
        result,
        timestamp: Date.now(),
        accessCount: 1,
        lastAccessed: Date.now()
      });

      this.addToCacheIndex(cacheKey, filters);

      if (this.queryCache.size > this.MAX_CACHE_SIZE) {
        this.cleanupQueryCache();
      }

      try {
        const globalCache = caches.default;
        const globalCacheKey = await this.generateGlobalCacheKey(filters, bookmark);
        const response = new Response(JSON.stringify(result), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300',
            'X-Cache-Time': Date.now().toString()
          }
        });
        await globalCache.put(globalCacheKey, response);
      } catch (error) {
        console.error('Error storing in global cache:', error);
      }

      return result;
    } finally {
      this.activeQueries.delete(cacheKey);
    }
  }

  private cleanupQueryCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.queryCache.entries()) {
      if (now - entry.timestamp > this.QUERY_CACHE_TTL) {
        this.queryCache.delete(key);
        this.removeFromCacheIndex(key);
      }
    }

    if (this.queryCache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.queryCache.entries());
      const scoredEntries = entries.map(([key, entry]) => {
        const recencyScore = (now - entry.lastAccessed) / 1000;
        const frequencyScore = entry.accessCount * 10;
        const evictionScore = frequencyScore - (recencyScore / 60);

        return { key, score: evictionScore };
      });

      scoredEntries.sort((a, b) => a.score - b.score);

      const toRemove = Math.floor(this.MAX_CACHE_SIZE * 0.2);
      for (let i = 0; i < toRemove; i++) {
        const key = scoredEntries[i].key;
        this.queryCache.delete(key);
        this.removeFromCacheIndex(key);
      }

      console.log(`Evicted ${toRemove} low-scoring cache entries (LFU)`);
    }
  }

  private addToCacheIndex(cacheKey: string, filters: NostrFilter[]): void {
    for (const filter of filters) {
      if (filter.kinds) {
        for (const kind of filter.kinds) {
          const indexKey = `kind:${kind}`;
          if (!this.queryCacheIndex.has(indexKey)) {
            this.queryCacheIndex.set(indexKey, new Set());
          }
          this.queryCacheIndex.get(indexKey)!.add(cacheKey);
        }
      }

      if (filter.authors) {
        for (const author of filter.authors) {
          const indexKey = `author:${author}`;
          if (!this.queryCacheIndex.has(indexKey)) {
            this.queryCacheIndex.set(indexKey, new Set());
          }
          this.queryCacheIndex.get(indexKey)!.add(cacheKey);
        }
      }

      for (const [key, values] of Object.entries(filter)) {
        if (key.startsWith('#') && Array.isArray(values)) {
          const tagName = key.substring(1);
          for (const value of values) {
            const indexKey = `tag:${tagName}:${value}`;
            if (!this.queryCacheIndex.has(indexKey)) {
              this.queryCacheIndex.set(indexKey, new Set());
            }
            this.queryCacheIndex.get(indexKey)!.add(cacheKey);
          }
        }
      }
    }
  }

  private removeFromCacheIndex(cacheKey: string): void {
    for (const [indexKey, cacheKeys] of this.queryCacheIndex.entries()) {
      cacheKeys.delete(cacheKey);
      if (cacheKeys.size === 0) {
        this.queryCacheIndex.delete(indexKey);
      }
    }
  }

  private invalidateRelevantCaches(event: NostrEvent): void {
    const keysToInvalidate = new Set<string>();

    const kindKey = `kind:${event.kind}`;
    if (this.queryCacheIndex.has(kindKey)) {
      for (const cacheKey of this.queryCacheIndex.get(kindKey)!) {
        keysToInvalidate.add(cacheKey);
      }
    }

    const authorKey = `author:${event.pubkey}`;
    if (this.queryCacheIndex.has(authorKey)) {
      for (const cacheKey of this.queryCacheIndex.get(authorKey)!) {
        keysToInvalidate.add(cacheKey);
      }
    }

    for (const tag of event.tags) {
      if (tag.length >= 2) {
        const tagKey = `tag:${tag[0]}:${tag[1]}`;
        if (this.queryCacheIndex.has(tagKey)) {
          for (const cacheKey of this.queryCacheIndex.get(tagKey)!) {
            keysToInvalidate.add(cacheKey);
          }
        }
      }
    }

    for (const key of keysToInvalidate) {
      this.queryCache.delete(key);
      this.removeFromCacheIndex(key);
    }

    if (keysToInvalidate.size > 0) {
      console.log(`Invalidated ${keysToInvalidate.size} local cache entries for event ${event.id} (kind:${event.kind}, author:${event.pubkey.substring(0, 8)}...)`);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const urlDoName = url.searchParams.get('doName');
    if (urlDoName && urlDoName !== 'unknown' && RelayWebSocket.ALLOWED_ENDPOINTS.includes(urlDoName)) {
      this.doName = urlDoName;
    }

    // DO-to-DO broadcast endpoint
    if (url.pathname === '/do-broadcast') {
      return await this.handleDOBroadcast(request);
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    this.region = url.searchParams.get('region') || this.region || 'unknown';
    const colo = url.searchParams.get('colo') || 'default';

    console.log(`WebSocket connection to DO: ${this.doName} (region: ${this.region}, colo: ${colo})`);

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    const sessionId = crypto.randomUUID();
    const host = request.headers.get('host') || url.host;

    const session = this.createSession(sessionId, server, 'first-unconstrained', host, []);
    this.sessions.set(sessionId, session);

    const attachment: SessionAttachment = {
      sessionId,
      bookmark: session.bookmark,
      host,
      doName: this.doName,
      authenticatedPubkeys: [],
      challenge: session.challenge
    };
    server.serializeAttachment(attachment);

    this.state.acceptWebSocket(server);

    if (AUTH_REQUIRED && session.challenge) {
      this.sendAuth(server, session.challenge);
    }

    this.lastActivityTime = Date.now();
    await this.scheduleAlarmIfNeeded();

    console.log(`New WebSocket session: ${sessionId} on DO ${this.doName}`);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /** Construct a session object with fresh rate limiters and auth state. */
  private createSession(
    sessionId: string,
    ws: WebSocket,
    bookmark: string,
    host: string,
    authenticatedPubkeys: string[],
    challenge?: string,
    hasPaid?: boolean,
    subscriptions?: Map<string, NostrFilter[]>,
  ): WebSocketSession {
    return {
      id: sessionId,
      webSocket: ws,
      subscriptions: subscriptions ?? new Map(),
      pubkeyRateLimiter: new RateLimiter(PUBKEY_RATE_LIMIT.rate, PUBKEY_RATE_LIMIT.capacity),
      // SIP-01 indexers get their own, roomier bucket (crawlers burst).
      sipRateLimiter: new RateLimiter(SIP01_INDEXER_RATE_LIMIT.rate, SIP01_INDEXER_RATE_LIMIT.capacity),
      reqRateLimiter: new RateLimiter(REQ_RATE_LIMIT.rate, REQ_RATE_LIMIT.capacity),
      bookmark,
      host,
      challenge: challenge ?? (AUTH_REQUIRED ? this.generateAuthChallenge() : undefined),
      authenticatedPubkeys: new Set(authenticatedPubkeys),
      hasPaid
    };
  }

  // WebSocket Hibernation API handler methods
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    this.lastActivityTime = Date.now();

    const attachment = ws.deserializeAttachment() as SessionAttachment | null;
    if (!attachment) {
      console.error('No session attachment found');
      ws.close(1011, 'Session not found');
      return;
    }

    // Get or recreate session
    let session = this.sessions.get(attachment.sessionId);
    if (!session) {
      if (attachment.doName && this.doName === 'unknown') {
        this.doName = attachment.doName;
      }
      const subscriptions = await this.loadSubscriptions(attachment.sessionId);
      const restoredPubkeys = attachment.authenticatedPubkeys || [];

      session = this.createSession(
        attachment.sessionId,
        ws,
        attachment.bookmark,
        attachment.host,
        restoredPubkeys,
        attachment.challenge || (AUTH_REQUIRED ? this.generateAuthChallenge() : undefined),
        attachment.hasPaid,
        subscriptions,
      );
      this.sessions.set(attachment.sessionId, session);

      if (AUTH_REQUIRED && restoredPubkeys.length === 0 && session.challenge) {
        this.sendAuth(ws, session.challenge);
      }
    }

    try {
      // Hard message size cap before any parsing (advertised in NIP-11).
      const maxMessageLength = relayInfo.limitation?.max_message_length ?? 262144;
      const messageLength = typeof message === 'string' ? message.length : message.byteLength;
      if (messageLength > maxMessageLength) {
        this.sendError(ws, `error: message exceeds ${maxMessageLength} bytes`);
        ws.close(1009, 'message too large');
        return;
      }

      let parsedMessage: any;

      if (typeof message === 'string') {
        parsedMessage = JSON.parse(message);
      } else {
        const decoder = new TextDecoder();
        const text = decoder.decode(message);
        parsedMessage = JSON.parse(text);
      }

      await this.handleMessage(session, parsedMessage);

      const updatedAttachment: SessionAttachment = {
        sessionId: session.id,
        bookmark: session.bookmark,
        host: session.host,
        doName: this.doName,
        hasPaid: session.hasPaid,
        authenticatedPubkeys: Array.from(session.authenticatedPubkeys),
        challenge: session.challenge
      };
      ws.serializeAttachment(updatedAttachment);

    } catch (error) {
      console.error('Error handling message:', error);
      if (error instanceof SyntaxError) {
        this.sendError(ws, 'Invalid JSON format');
      } else {
        this.sendError(ws, 'Failed to process message');
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const attachment = ws.deserializeAttachment() as SessionAttachment | null;
    if (attachment) {
      console.log(`WebSocket closed: ${attachment.sessionId} on DO ${this.doName}`);
      this.sessions.delete(attachment.sessionId);

      // Reclaim this connection's NEG sessions
      for (const key of [...this.negSessions.keys()]) {
        if (key.startsWith(`${attachment.sessionId}:`)) {
          this.negSessions.delete(key);
        }
      }

      await this.deleteSubscriptions(attachment.sessionId);

      const activeWebSockets = this.state.getWebSockets();
      if (activeWebSockets.length === 0) {
        await this.state.storage.deleteAlarm();
        console.log(`Deleted alarm for DO ${this.doName} - no active connections remaining`);
      }
    }
  }

  async webSocketError(ws: WebSocket, error: any): Promise<void> {
    const attachment = ws.deserializeAttachment() as SessionAttachment | null;
    if (attachment) {
      console.error(`WebSocket error for session ${attachment.sessionId}:`, error);
      this.sessions.delete(attachment.sessionId);
    }
  }

  private async handleDOBroadcast(request: Request): Promise<Response> {
    try {
      const data: DOBroadcastRequest = await request.json();
      const { event, sourceDoId } = data;

      if (this.processedEvents.has(event.id)) {
        return new Response(JSON.stringify({ success: true, duplicate: true }));
      }

      this.processedEvents.set(event.id, Date.now());

      console.log(`DO ${this.doName} received event ${event.id} from ${sourceDoId}`);

      this.invalidateRelevantCaches(event);
      await this.broadcastToLocalSessions(event);

      const fiveMinutesAgo = Date.now() - 300000;
      for (const [eventId, timestamp] of this.processedEvents) {
        if (timestamp < fiveMinutesAgo) {
          this.processedEvents.delete(eventId);
        }
      }

      return new Response(JSON.stringify({ success: true }));
    } catch (error) {
      console.error('Error handling DO broadcast:', error);
      // @ts-ignore
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleMessage(session: WebSocketSession, message: any[]): Promise<void> {
    if (!Array.isArray(message)) {
      this.sendError(session.webSocket, 'Invalid message format: expected JSON array');
      return;
    }

    const [type, ...args] = message;

    try {
      switch (type) {
        case 'EVENT':
          await this.handleEvent(session, args[0]);
          break;
        case 'REQ':
          await this.handleReq(session, message);
          break;
        case 'CLOSE':
          await this.handleCloseSubscription(session, args[0]);
          break;
        case 'AUTH':
          await this.handleAuth(session, args[0]);
          break;
        case 'COUNT':
          await this.handleCount(session, message);
          break;
        case 'NEG-OPEN':
          await this.handleNegOpen(session, message);
          break;
        case 'NEG-MSG':
          await this.handleNegMsg(session, message);
          break;
        case 'NEG-CLOSE':
          await this.handleNegClose(session, message);
          break;
        default:
          this.sendError(session.webSocket, `Unknown message type: ${type}`);
      }
    } catch (error) {
      console.error(`Error handling ${type} message:`, error);
      this.sendError(session.webSocket, `Failed to process ${type} message`);
    }
  }

  private async handleEvent(session: WebSocketSession, event: NostrEvent): Promise<void> {
    try {
      // Validate event object
      if (!event || typeof event !== 'object') {
        this.sendOK(session.webSocket, '', false, 'invalid: event object required');
        return;
      }

      // Check required fields (content can be empty string but not null/undefined)
      if (!event.id || !event.pubkey || !event.sig || !event.created_at ||
        event.kind === undefined || !Array.isArray(event.tags) ||
        event.content === undefined || event.content === null) {
        this.sendOK(session.webSocket, event.id || '', false, 'invalid: missing required fields');
        return;
      }

      // Field shape checks (cheap, before any crypto)
      if (!/^[0-9a-f]{64}$/.test(event.id) || !/^[0-9a-f]{64}$/.test(event.pubkey) || !/^[0-9a-f]{128}$/.test(event.sig)) {
        this.sendOK(session.webSocket, event.id || '', false, 'invalid: id, pubkey and sig must be lowercase hex');
        return;
      }
      if (!Number.isInteger(event.kind) || event.kind < 0 || event.kind > 65535) {
        this.sendOK(session.webSocket, event.id, false, 'invalid: kind must be an integer in range [0, 65535]');
        return;
      }
      if (!Number.isInteger(event.created_at)) {
        this.sendOK(session.webSocket, event.id, false, 'invalid: created_at must be an integer');
        return;
      }
      const maxTags = relayInfo.limitation?.max_event_tags ?? 2000;
      if (event.tags.length > maxTags) {
        this.sendOK(session.webSocket, event.id, false, `invalid: event has more than ${maxTags} tags`);
        return;
      }
      const maxContent = relayInfo.limitation?.max_content_length ?? 70000;
      if (typeof event.content !== 'string' || event.content.length > maxContent) {
        this.sendOK(session.webSocket, event.id, false, `invalid: content exceeds ${maxContent} characters`);
        return;
      }

      // NIP-42: Reject kind 22242 events - they are for authentication only, not publishing
      if (event.kind === 22242) {
        this.sendOK(session.webSocket, event.id, false, 'invalid: kind 22242 events are for authentication only');
        return;
      }

      // NIP-42: Check authentication
      if (AUTH_REQUIRED) {
        if (session.authenticatedPubkeys.size === 0) {
          this.sendOK(session.webSocket, event.id, false, 'auth-required: authenticate to publish events');
          return;
        }
        if (event.kind !== 1059 && !session.authenticatedPubkeys.has(event.pubkey)) {
          this.sendOK(session.webSocket, event.id, false, 'restricted: event pubkey does not match authenticated pubkey');
          return;
        }
      }

      // Rate limiting (kind 39697 indexers get their own bucket; excluded
      // kinds skip EVENT rate limiting entirely)
      if (!excludedRateLimitKinds.has(event.kind)) {
        const limiter = (event.kind === SIP01_KIND && SIP01_ENABLED)
          ? session.sipRateLimiter
          : session.pubkeyRateLimiter;
        if (!limiter.removeToken()) {
          console.log(`Rate limit exceeded for pubkey ${event.pubkey} (kind ${event.kind})`);
          this.sendOK(session.webSocket, event.id, false, 'rate-limited: slow down there chief');
          return;
        }
      }

      // Verify signature
      const isValidSignature = await verifyEventSignature(event);
      if (!isValidSignature) {
        console.error(`Signature verification failed for event ${event.id}`);
        this.sendOK(session.webSocket, event.id, false, 'invalid: signature verification failed');
        return;
      }

      // Check if pay to relay is enabled
      if (PAY_TO_RELAY_ENABLED && event.kind !== 1059) {
        let hasPaid = await this.getCachedPaymentStatus(event.pubkey);

        if (hasPaid === null) {
          hasPaid = await hasPaidForRelay(event.pubkey, this.env);
          if (hasPaid !== null) {
            this.setCachedPaymentStatus(event.pubkey, hasPaid);
          }
        }

        // Block unless we know for certain they've paid.
        if (hasPaid !== true) {
          const relayUrl = `https://${session.host}`;
          console.error(`Event denied. Pubkey ${event.pubkey} has not paid for relay access.`);
          this.sendOK(session.webSocket, event.id, false, `blocked: payment required. Visit ${relayUrl} to pay for relay access.`);
          return;
        }
      }

      // Check if pubkey is allowed (bypassed for kind 1059)
      if (event.kind !== 1059 && !isPubkeyAllowed(event.pubkey)) {
        console.error(`Event denied. Pubkey ${event.pubkey} is not allowed.`);
        this.sendOK(session.webSocket, event.id, false, 'blocked: pubkey not allowed');
        return;
      }

      // Check if event kind is allowed (RELAY_MODE gating happens in config)
      if (!isEventKindAllowed(event.kind)) {
        console.error(`Event denied. Event kind ${event.kind} is not allowed.`);
        this.sendOK(session.webSocket, event.id, false, `blocked: event kind ${event.kind} not allowed on this relay`);
        return;
      }

      // Check for blocked content
      if (containsBlockedContent(event)) {
        console.error('Event denied. Content contains blocked phrases.');
        this.sendOK(session.webSocket, event.id, false, 'blocked: content contains blocked phrases');
        return;
      }

      // Check tags
      for (const tag of event.tags) {
        if (!isTagAllowed(tag[0])) {
          console.error(`Event denied. Tag '${tag[0]}' is not allowed.`);
          this.sendOK(session.webSocket, event.id, false, `blocked: tag '${tag[0]}' not allowed`);
          return;
        }
      }

      // Process the event (SIP-01 validation + storage)
      const result = await processEvent(event, session.id, this.env);

      if (result.bookmark) {
        session.bookmark = result.bookmark;
      }

      if (result.success) {
        this.sendOK(session.webSocket, event.id, true, result.message);

        this.processedEvents.set(event.id, Date.now());
        this.invalidateRelevantCaches(event);

        console.log(`DO ${this.doName} broadcasting event ${event.id}`);
        await this.broadcastEvent(event);
      } else {
        this.sendOK(session.webSocket, event.id, false, result.message);
      }

    } catch (error: any) {
      console.error('Error handling event:', error);
      this.sendOK(session.webSocket, event?.id || '', false, `error: ${error.message}`);
    }
  }

  private async handleReq(session: WebSocketSession, message: any[]): Promise<void> {
    const [_, subscriptionId, ...filters] = message;

    if (!subscriptionId || typeof subscriptionId !== 'string' || subscriptionId === '' || subscriptionId.length > 64) {
      this.sendError(session.webSocket, 'Invalid subscription ID: must be non-empty string of max 64 chars');
      return;
    }

    if (AUTH_REQUIRED && session.authenticatedPubkeys.size === 0) {
      this.sendClosed(session.webSocket, subscriptionId, 'auth-required: authentication required to subscribe');
      return;
    }

    if (!session.reqRateLimiter.removeToken()) {
      console.error(`REQ rate limit exceeded for subscription: ${subscriptionId}`);
      this.sendClosed(session.webSocket, subscriptionId, 'rate-limited: slow down there chief');
      return;
    }

    if (filters.length === 0) {
      this.sendClosed(session.webSocket, subscriptionId, 'error: at least one filter required');
      return;
    }

    if (filters.length > 20) {
      this.sendClosed(session.webSocket, subscriptionId, 'error: too many filters (max 20)');
      return;
    }

    const maxSubscriptions = relayInfo.limitation?.max_subscriptions ?? 100;
    if (session.subscriptions.size >= maxSubscriptions && !session.subscriptions.has(subscriptionId)) {
      this.sendClosed(session.webSocket, subscriptionId, `error: max subscriptions (${maxSubscriptions}) reached`);
      return;
    }

    for (const filter of filters) {
      if (typeof filter !== 'object' || filter === null) {
        this.sendClosed(session.webSocket, subscriptionId, 'invalid: filter must be an object');
        return;
      }

      if (filter.ids) {
        for (const id of filter.ids) {
          if (!/^[a-f0-9]{64}$/.test(id)) {
            this.sendClosed(session.webSocket, subscriptionId, `invalid: Invalid event ID format: ${id}`);
            return;
          }
        }
      }

      if (filter.authors) {
        for (const author of filter.authors) {
          if (!/^[a-f0-9]{64}$/.test(author)) {
            this.sendClosed(session.webSocket, subscriptionId, `invalid: Invalid author pubkey format: ${author}`);
            return;
          }
        }
      }

      if (filter.kinds) {
        const blockedKinds = filter.kinds.filter((kind: number) => !isEventKindAllowed(kind));
        if (blockedKinds.length > 0) {
          console.error(`Blocked kinds in subscription: ${blockedKinds.join(', ')}`);
          this.sendClosed(session.webSocket, subscriptionId, `blocked: kinds ${blockedKinds.join(', ')} not allowed`);
          return;
        }
      }

      if (filter.ids && filter.ids.length > 5000) {
        this.sendClosed(session.webSocket, subscriptionId, 'invalid: too many event IDs (max 5000)');
        return;
      }

      // NIP-50 search field validation
      if (filter.search !== undefined) {
        if (!NIP50_ENABLED) {
          this.sendClosed(session.webSocket, subscriptionId, 'blocked: search is not supported by this relay');
          return;
        }
        if (typeof filter.search !== 'string' || filter.search.length > 500) {
          this.sendClosed(session.webSocket, subscriptionId, 'invalid: search must be a string of max 500 chars');
          return;
        }
      }

      if (filter.limit && filter.limit > 500) {
        filter.limit = 500;
      } else if (!filter.limit) {
        filter.limit = 500;
      }
    }

    session.subscriptions.set(subscriptionId, filters);
    await this.saveSubscriptions(session.id, session.subscriptions);

    console.log(`New subscription ${subscriptionId} for session ${session.id} on DO ${this.doName}`);

    try {
      await ensureDatabase(this.env.RELAY_DATABASE);

      // Partition search filters from plain filters (NIP-50 results are
      // rank-ordered and never served from the query cache).
      const searchFilters = filters.filter((f: NostrFilter) => typeof f.search === 'string' && f.search.trim() !== '');
      const plainFilters = filters.filter((f: NostrFilter) => !(typeof f.search === 'string' && f.search.trim() !== ''));

      const seenIds = new Set<string>();

      if (plainFilters.length > 0) {
        const result = await this.getCachedOrQuery(plainFilters, session.bookmark);
        if (result.bookmark) {
          session.bookmark = result.bookmark;
        }
        for (const event of result.events) {
          if (seenIds.has(event.id)) continue;
          seenIds.add(event.id);
          this.sendEvent(session.webSocket, subscriptionId, event);
        }
      }

      for (const filter of searchFilters) {
        const events = await executeSearch(this.env.RELAY_DATABASE.withSession(session.bookmark), filter);
        for (const event of events) {
          if (seenIds.has(event.id)) continue;
          seenIds.add(event.id);
          this.sendEvent(session.webSocket, subscriptionId, event);
        }
        bumpMetric(this.env.RELAY_DATABASE.withSession('first-primary'), 'search_queries_ws').catch(() => undefined);
      }

      this.sendEOSE(session.webSocket, subscriptionId);

    } catch (error: any) {
      console.error(`Error processing REQ for subscription ${subscriptionId}:`, error);
      this.sendClosed(session.webSocket, subscriptionId, 'error: could not connect to the database');
    }
  }

  private async handleCloseSubscription(session: WebSocketSession, subscriptionId: string): Promise<void> {
    if (!subscriptionId) {
      this.sendError(session.webSocket, 'Invalid subscription ID for CLOSE');
      return;
    }

    const deleted = session.subscriptions.delete(subscriptionId);
    if (deleted) {
      await this.saveSubscriptions(session.id, session.subscriptions);
      console.log(`Closed subscription ${subscriptionId} for session ${session.id} on DO ${this.doName}`);
      this.sendClosed(session.webSocket, subscriptionId, 'Subscription closed');
    } else {
      this.sendClosed(session.webSocket, subscriptionId, 'Subscription not found');
    }
  }

  // -------------------------------------------------------------------------
  // NIP-45 COUNT
  // -------------------------------------------------------------------------

  private async handleCount(session: WebSocketSession, message: any[]): Promise<void> {
    const [_, queryId, ...filters] = message;

    if (!queryId || typeof queryId !== 'string' || queryId === '' || queryId.length > 64) {
      this.sendError(session.webSocket, 'Invalid query ID for COUNT');
      return;
    }

    if (!NIP45_ENABLED) {
      this.sendClosed(session.webSocket, queryId, 'blocked: COUNT is not supported by this relay');
      return;
    }

    if (AUTH_REQUIRED && session.authenticatedPubkeys.size === 0) {
      this.sendClosed(session.webSocket, queryId, 'auth-required: authentication required');
      return;
    }

    if (!session.reqRateLimiter.removeToken()) {
      this.sendClosed(session.webSocket, queryId, 'rate-limited: slow down there chief');
      return;
    }

    if (filters.length === 0 || filters.length > 10) {
      this.sendClosed(session.webSocket, queryId, 'error: COUNT requires 1-10 filters');
      return;
    }

    for (const filter of filters) {
      if (typeof filter !== 'object' || filter === null) {
        this.sendClosed(session.webSocket, queryId, 'invalid: filter must be an object');
        return;
      }
      if (calculateQueryComplexity(filter) > 500) {
        this.sendClosed(session.webSocket, queryId, 'blocked: filter too complex to count');
        return;
      }
    }

    try {
      const count = await countEvents(filters, session.bookmark, this.env);
      this.sendCount(session.webSocket, queryId, count);
      bumpMetric(this.env.RELAY_DATABASE.withSession('first-primary'), 'count_queries').catch(() => undefined);
    } catch (error) {
      console.error('COUNT failed:', error);
      this.sendClosed(session.webSocket, queryId, 'error: could not compute count');
    }
  }

  // -------------------------------------------------------------------------
  // NIP-77 negentropy sync
  // -------------------------------------------------------------------------

  private negKey(sessionId: string, subId: string): string {
    return `${sessionId}:${subId}`;
  }

  private reclaimIdleNegSessions(): void {
    const now = Date.now();
    for (const [key, neg] of this.negSessions) {
      if (now - neg.createdAt > NEG_SESSION_TIMEOUT_MS) {
        this.negSessions.delete(key);
        console.log(`Reclaimed idle NEG session ${key}`);
      }
    }
  }

  private async handleNegOpen(session: WebSocketSession, message: any[]): Promise<void> {
    const [_, subId, filter, initialMessage] = message;

    if (!subId || typeof subId !== 'string' || subId === '' || subId.length > 64) {
      this.sendError(session.webSocket, 'Invalid NEG subscription ID');
      return;
    }

    if (!NIP77_ENABLED) {
      this.sendNegErr(session.webSocket, subId, 'disabled: negentropy sync is not enabled on this relay');
      return;
    }

    if (AUTH_REQUIRED && session.authenticatedPubkeys.size === 0) {
      this.sendNegErr(session.webSocket, subId, 'auth-required: authentication required to sync');
      return;
    }

    if (!session.reqRateLimiter.removeToken()) {
      this.sendNegErr(session.webSocket, subId, 'rate-limited: slow down there chief');
      return;
    }

    if (typeof filter !== 'object' || filter === null) {
      this.sendNegErr(session.webSocket, subId, 'invalid: filter must be an object');
      return;
    }

    if (typeof initialMessage !== 'string' || !/^[0-9a-fA-F]*$/.test(initialMessage)) {
      this.sendNegErr(session.webSocket, subId, 'invalid: initial message must be hex-encoded');
      return;
    }

    try {
      // Re-opening an existing id replaces the old session (NIP-77).
      this.negSessions.delete(this.negKey(session.id, subId));
      this.reclaimIdleNegSessions();

      // Load our side's record set for the filter.
      const { items, truncated } = await querySyncItems(filter, this.env);
      if (truncated) {
        this.sendNegErr(session.webSocket, subId, 'blocked: this query is too big', String(NEG_MAX_ITEMS));
        return;
      }

      const storage = new NegentropyStorageVector();
      for (const item of items) {
        storage.insertHex(item.created_at, item.id);
      }
      storage.seal();

      const neg = new Negentropy(storage, NEG_FRAME_SIZE_LIMIT);
      const result = neg.reconcile(negHexToBytes(initialMessage));

      this.negSessions.set(this.negKey(session.id, subId), {
        neg,
        filter,
        createdAt: Date.now(),
        itemCount: items.length,
      });

      bumpMetric(this.env.RELAY_DATABASE.withSession('first-primary'), 'neg_sessions').catch(() => undefined);

      console.log(`NEG-OPEN ${subId}: reconciling ${items.length} items for session ${session.id}`);
      this.sendNegMsg(session.webSocket, subId, negBytesToHex(result.message!));
    } catch (error: any) {
      console.error('NEG-OPEN failed:', error);
      this.sendNegErr(session.webSocket, subId, `invalid: ${error.message || 'bad negentropy message'}`);
    }
  }

  private async handleNegMsg(session: WebSocketSession, message: any[]): Promise<void> {
    const [_, subId, theirMessage] = message;

    if (!subId || typeof subId !== 'string') {
      this.sendError(session.webSocket, 'Invalid NEG subscription ID');
      return;
    }

    const negSession = this.negSessions.get(this.negKey(session.id, subId));
    if (!negSession) {
      this.sendNegErr(session.webSocket, subId, 'closed: no such NEG session (expired or never opened)');
      return;
    }

    if (typeof theirMessage !== 'string' || !/^[0-9a-fA-F]*$/.test(theirMessage)) {
      this.sendNegErr(session.webSocket, subId, 'invalid: message must be hex-encoded');
      this.negSessions.delete(this.negKey(session.id, subId));
      return;
    }

    try {
      negSession.createdAt = Date.now();
      const result = negSession.neg.reconcile(negHexToBytes(theirMessage));
      this.sendNegMsg(session.webSocket, subId, negBytesToHex(result.message!));
    } catch (error: any) {
      console.error('NEG-MSG failed:', error);
      this.sendNegErr(session.webSocket, subId, `invalid: ${error.message || 'bad negentropy message'}`);
      this.negSessions.delete(this.negKey(session.id, subId));
    }
  }

  private async handleNegClose(session: WebSocketSession, message: any[]): Promise<void> {
    const [_, subId] = message;
    if (typeof subId === 'string') {
      this.negSessions.delete(this.negKey(session.id, subId));
    }
  }

  // NIP-42: Handle AUTH message from client
  private async handleAuth(session: WebSocketSession, authEvent: NostrEvent): Promise<void> {
    try {
      if (!authEvent || typeof authEvent !== 'object') {
        this.sendOK(session.webSocket, '', false, 'invalid: auth event object required');
        return;
      }

      if (!authEvent.id || !authEvent.pubkey || !authEvent.sig || !authEvent.created_at ||
        authEvent.kind === undefined || !Array.isArray(authEvent.tags) ||
        authEvent.content === undefined) {
        this.sendOK(session.webSocket, authEvent.id || '', false, 'invalid: missing required fields');
        return;
      }

      if (authEvent.kind !== 22242) {
        this.sendOK(session.webSocket, authEvent.id, false, 'invalid: auth event must be kind 22242');
        return;
      }

      const isValidSignature = await verifyEventSignature(authEvent);
      if (!isValidSignature) {
        this.sendOK(session.webSocket, authEvent.id, false, 'invalid: signature verification failed');
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const timeDiff = Math.abs(now - authEvent.created_at);
      const timeoutSeconds = AUTH_TIMEOUT_MS / 1000;
      if (timeDiff > timeoutSeconds) {
        this.sendOK(session.webSocket, authEvent.id, false, 'invalid: auth event created_at is too far from current time');
        return;
      }

      const challengeTag = authEvent.tags.find(tag => tag[0] === 'challenge');
      if (!challengeTag || !challengeTag[1]) {
        this.sendOK(session.webSocket, authEvent.id, false, 'invalid: missing challenge tag');
        return;
      }

      if (!session.challenge) {
        this.sendOK(session.webSocket, authEvent.id, false, 'invalid: no challenge was issued');
        return;
      }

      if (challengeTag[1] !== session.challenge) {
        this.sendOK(session.webSocket, authEvent.id, false, 'invalid: challenge mismatch');
        return;
      }

      const relayTag = authEvent.tags.find(tag => tag[0] === 'relay');
      if (!relayTag || !relayTag[1]) {
        this.sendOK(session.webSocket, authEvent.id, false, 'invalid: missing relay tag');
        return;
      }

      try {
        const authRelayUrl = new URL(relayTag[1]);
        const sessionHost = session.host.toLowerCase().replace(/:\d+$/, '');
        const authHost = authRelayUrl.host.toLowerCase().replace(/:\d+$/, '');

        if (authHost !== sessionHost) {
          this.sendOK(session.webSocket, authEvent.id, false, `invalid: relay URL mismatch (expected ${sessionHost})`);
          return;
        }
      } catch {
        this.sendOK(session.webSocket, authEvent.id, false, 'invalid: malformed relay URL');
        return;
      }

      session.authenticatedPubkeys.add(authEvent.pubkey);

      if (PAY_TO_RELAY_ENABLED) {
        const paid = await hasPaidForRelay(authEvent.pubkey, this.env);
        if (paid !== null) {
          session.hasPaid = paid;
          this.setCachedPaymentStatus(authEvent.pubkey, paid);
        }
      }

      this.sendOK(session.webSocket, authEvent.id, true, '');

    } catch (error: any) {
      console.error('Error handling AUTH:', error);
      this.sendOK(session.webSocket, authEvent?.id || '', false, `error: ${error.message}`);
    }
  }

  private async broadcastEvent(event: NostrEvent): Promise<void> {
    await this.broadcastToLocalSessions(event);
    await this.broadcastToOtherDOs(event);
  }

  private async broadcastToLocalSessions(event: NostrEvent): Promise<void> {
    let broadcastCount = 0;

    const activeWebSockets = this.state.getWebSockets();

    for (const ws of activeWebSockets) {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (!attachment) continue;

      let session = this.sessions.get(attachment.sessionId);
      if (!session) {
        const subscriptions = await this.loadSubscriptions(attachment.sessionId);

        session = this.createSession(
          attachment.sessionId,
          ws,
          attachment.bookmark,
          attachment.host,
          attachment.authenticatedPubkeys || [],
          attachment.challenge,
          attachment.hasPaid,
          subscriptions,
        );
        this.sessions.set(attachment.sessionId, session);
      }

      for (const [subscriptionId, filters] of session.subscriptions) {
        if (this.matchesFilters(event, filters)) {
          try {
            this.sendEvent(ws, subscriptionId, event);
            broadcastCount++;
          } catch (error) {
            console.error(`Error broadcasting to subscription ${subscriptionId}:`, error);
          }
        }
      }
    }

    if (broadcastCount > 0) {
      console.log(`Event ${event.id} broadcast to ${broadcastCount} local subscriptions on DO ${this.doName}`);
    }
  }

  private async broadcastToOtherDOs(event: NostrEvent): Promise<void> {
    const broadcasts: Promise<Response>[] = [];

    for (const endpoint of RelayWebSocket.ALLOWED_ENDPOINTS) {
      if (endpoint === this.doName) continue;
      broadcasts.push(this.sendToSpecificDO(endpoint, event));
    }

    const results = await Promise.allSettled(
      broadcasts.map(p => Promise.race([
        p,
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error('Broadcast timeout')), 3000)
        )
      ]))
    );

    const successful = results.filter(r => r.status === 'fulfilled').length;
    console.log(`Event ${event.id} broadcast from DO ${this.doName} to ${successful}/${broadcasts.length} remote DOs`);
  }

  private async sendToSpecificDO(doName: string, event: NostrEvent): Promise<Response> {
    try {
      if (!RelayWebSocket.ALLOWED_ENDPOINTS.includes(doName)) {
        throw new Error(`Invalid DO name: ${doName}`);
      }

      const id = this.env.RELAY_WEBSOCKET.idFromName(doName);
      const locationHint = RelayWebSocket.ENDPOINT_HINTS[doName] || 'auto';
      const stub = this.env.RELAY_WEBSOCKET.get(id, { locationHint });

      const url = new URL('https://internal/do-broadcast');
      url.searchParams.set('doName', doName);

      return await stub.fetch(new Request(url.toString(), {
        method: 'POST',
        body: JSON.stringify({
          event,
          sourceDoId: this.doId
        } as DOBroadcastRequest)
      }));
    } catch (error) {
      console.error(`Failed to broadcast to ${doName}:`, error);
      throw error;
    }
  }

  private matchesFilters(event: NostrEvent, filters: NostrFilter[]): boolean {
    return filters.some(filter => this.matchesFilter(event, filter));
  }

  private matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
    if (filter.ids && filter.ids.length > 0 && !filter.ids.includes(event.id)) {
      return false;
    }

    if (filter.authors && filter.authors.length > 0 && !filter.authors.includes(event.pubkey)) {
      return false;
    }

    if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) {
      return false;
    }

    if (filter.since && event.created_at < filter.since) {
      return false;
    }
    if (filter.until && event.created_at > filter.until) {
      return false;
    }

    for (const [key, values] of Object.entries(filter)) {
      if (key.startsWith('#') && Array.isArray(values) && values.length > 0) {
        const tagName = key.substring(1);
        const eventTagValues = event.tags
          .filter(tag => tag[0] === tagName)
          .map(tag => tag[1]);

        const hasMatch = values.some(v => eventTagValues.includes(v));
        if (!hasMatch) {
          return false;
        }
      }
    }

    // NIP-50 live matching (same semantics as the SQL path).
    if (typeof filter.search === 'string' && filter.search.trim() !== '') {
      let parsed = this.parsedSearchCache.get(filter);
      if (!parsed) {
        parsed = parseSearchQuery(filter.search);
        this.parsedSearchCache.set(filter, parsed);
      }

      if (event.kind === SIP01_KIND && SIP01_ENABLED) {
        const fields = extractSip01Fields(event as any);
        if (!fields) return false;
        if (!matchSip01Search(parsed, { ...fields, indexer: event.pubkey } as any)) {
          return false;
        }
      } else {
        // Generic content matching for non-SIP kinds; operators ignored.
        const content = (event.content || '').toLowerCase();
        for (const kw of parsed.keywords) {
          if (!content.includes(kw)) return false;
        }
        for (const ph of parsed.phrases) {
          if (!content.includes(ph.toLowerCase())) return false;
        }
      }
    }

    return true;
  }

  // -------------------------------------------------------------------------
  // Wire senders
  // -------------------------------------------------------------------------

  private sendAuth(ws: WebSocket, challenge: string): void {
    try {
      const authMessage = ['AUTH', challenge];
      ws.send(JSON.stringify(authMessage));
    } catch (error) {
      console.error('Error sending AUTH:', error);
    }
  }

  private generateAuthChallenge(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  private sendOK(ws: WebSocket, eventId: string, status: boolean, message: string): void {
    try {
      const okMessage = ['OK', eventId, status, message || ''];
      ws.send(JSON.stringify(okMessage));
    } catch (error) {
      console.error('Error sending OK:', error);
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    try {
      const noticeMessage = ['NOTICE', message];
      ws.send(JSON.stringify(noticeMessage));
    } catch (error) {
      console.error('Error sending NOTICE:', error);
    }
  }

  private sendEOSE(ws: WebSocket, subscriptionId: string): void {
    try {
      const eoseMessage = ['EOSE', subscriptionId];
      ws.send(JSON.stringify(eoseMessage));
    } catch (error) {
      console.error('Error sending EOSE:', error);
    }
  }

  private sendClosed(ws: WebSocket, subscriptionId: string, message: string): void {
    try {
      const closedMessage = ['CLOSED', subscriptionId, message];
      ws.send(JSON.stringify(closedMessage));
    } catch (error) {
      console.error('Error sending CLOSED:', error);
    }
  }

  private sendEvent(ws: WebSocket, subscriptionId: string, event: NostrEvent): void {
    try {
      const eventMessage = ['EVENT', subscriptionId, event];
      ws.send(JSON.stringify(eventMessage));
    } catch (error) {
      console.error('Error sending EVENT:', error);
    }
  }

  private sendCount(ws: WebSocket, queryId: string, count: number): void {
    try {
      const countMessage = ['COUNT', queryId, { count, approximate: false }];
      ws.send(JSON.stringify(countMessage));
    } catch (error) {
      console.error('Error sending COUNT:', error);
    }
  }

  private sendNegMsg(ws: WebSocket, subId: string, hexMessage: string): void {
    try {
      ws.send(JSON.stringify(['NEG-MSG', subId, hexMessage]));
    } catch (error) {
      console.error('Error sending NEG-MSG:', error);
    }
  }

  private sendNegErr(ws: WebSocket, subId: string, reason: string, maxRecords?: string): void {
    try {
      const msg: any[] = ['NEG-ERR', subId, reason];
      if (maxRecords !== undefined) msg.push(maxRecords);
      ws.send(JSON.stringify(msg));
    } catch (error) {
      console.error('Error sending NEG-ERR:', error);
    }
  }
}
