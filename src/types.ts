// Nostr protocol types
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  cursor?: string;
  search?: string; // NIP-50
  [key: string]: any;
}

/** NIP-11 relay information document (custom fields allowed — clients MUST
 *  ignore fields they do not understand). */
export interface RelayInfo {
  name: string;
  description: string;
  pubkey: string;
  contact: string;
  supported_nips: number[];
  software: string;
  version: string;
  icon: string;
  banner?: string;
  privacy_policy?: string;
  terms_of_service?: string;
  limitation?: {
    payment_required?: boolean;
    restricted_writes?: boolean;
    auth_required?: boolean;
    [key: string]: any;
  };
  retention?: Array<{ kinds?: Array<number | [number, number]>; time?: number; count?: number }>;
  relay_countries?: string[];
  language_tags?: string[];
  tags?: string[];
  posting_policy?: string;
  payments_url?: string;
  fees?: {
    admission?: Array<{ amount: number; unit: string }>;
    subscription?: Array<{ amount: number; unit: string; period: number }>;
    publication?: Array<{ kinds: number[]; amount: number; unit: string }>;
  };
  /** SIP-01 §15 capability block (custom field). */
  uncaged_index?: {
    sip01: boolean;
    nip50: boolean;
    nip77: boolean;
    document_kinds: number[];
    scope: string;
    domains: string[];
    languages: string[];
    document_types: string[];
    filters: string[];
    relay_mode: 'general' | 'hybrid' | 'sip01';
    validation: boolean;
    schema_version: string;
  };
  [key: string]: any;
}

export interface Subscription {
  id: string;
  filters: NostrFilter[];
}

export interface QueryResult {
  events: NostrEvent[];
  bookmark: string | null;
}

// Worker environment type
export interface Env {
  RELAY_DATABASE: D1Database;
  RELAY_WEBSOCKET: DurableObjectNamespace;
  /** Static assets binding (wrangler [assets]); optional — a minimal inline
   *  landing page is served when absent (single-script paste deploys). */
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

// Durable Object types
export interface RateLimiterConfig {
  rate: number;
  capacity: number;
}

export interface WebSocketSession {
  id: string;
  webSocket: WebSocket;
  subscriptions: Map<string, NostrFilter[]>;
  pubkeyRateLimiter: RateLimiter;
  /** Roomier token bucket for kind 39697 indexer bursts (SIP-01). */
  sipRateLimiter: RateLimiter;
  reqRateLimiter: RateLimiter;
  bookmark: string;
  host: string;
  // NIP-42 Authentication
  challenge?: string;
  authenticatedPubkeys: Set<string>;
  // Pay-to-relay: cached per-session, checked at AUTH time
  hasPaid?: boolean;
}

/** NIP-77 negentropy session state (per NEG subscription id, in-memory). */
export interface NegSession {
  /** The negentropy server instance (holds the sealed storage vector). */
  neg: import('../shared/negentropy.js').Negentropy;
  filter: NostrFilter;
  createdAt: number;
  itemCount: number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefillTime: number;
  private capacity: number;
  private fillRate: number;

  constructor(rate: number, capacity: number) {
    this.tokens = capacity;
    this.lastRefillTime = Date.now();
    this.capacity = capacity;
    this.fillRate = rate;
  }

  removeToken(): boolean {
    this.refill();
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedTime = now - this.lastRefillTime;
    const tokensToAdd = Math.floor(elapsedTime * this.fillRate);
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }
}

// NIP-05 response type
export interface Nip05Response {
  names: Record<string, string>;
  relays?: Record<string, string[]>;
}

// WebSocket message types for the Nostr protocol (client → relay and
// relay → client variants share the array shape)
export type NostrMessage =
  | ["EVENT", string, NostrEvent]
  | ["EOSE", string]
  | ["OK", string, boolean, string]
  | ["NOTICE", string]
  | ["REQ", string, ...NostrFilter[]]
  | ["CLOSE", string]
  | ["CLOSED", string, string]
  | ["COUNT", string, ...any[]]              // NIP-45
  | ["AUTH", string]           // Relay sends challenge string
  | ["AUTH", NostrEvent]       // Client sends signed auth event (kind 22242)
  | ["NEG-OPEN", string, NostrFilter, string] // NIP-77
  | ["NEG-MSG", string, string]               // NIP-77
  | ["NEG-ERR", string, string]               // NIP-77
  | ["NEG-CLOSE", string];                    // NIP-77

// WebSocket event types for Cloudflare Workers
export interface WebSocketEventMap {
  "close": CloseEvent;
  "error": Event;
  "message": MessageEvent;
  "open": Event;
}

// Request body types for internal RPC calls
export interface BroadcastEventRequest {
  event: NostrEvent;
}

// Simplified DO-to-DO broadcast request
export interface DOBroadcastRequest {
  event: NostrEvent;
  sourceDoId: string;
}

// Health check response
export interface HealthCheckResponse {
  status: string;
  doName: string;
  sessions: number;
  activeWebSockets: number;
}

// Durable Object interface with hibernation support
export interface DurableObject {
  fetch(request: Request): Promise<Response>;
  // WebSocket hibernation handlers (optional)
  webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
  webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
  webSocketError?(ws: WebSocket, error: any): void | Promise<void>;
}

// Durable Object stub with location hint support
export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

// Extended Durable Object namespace with location hints
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId, options?: { locationHint?: string }): DurableObjectStub;
}

export interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
}

// Extended DurableObjectState with hibernation support
export interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  // WebSocket hibernation methods
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
}

export interface DurableObjectStorage {
  get<T = any>(key: string): Promise<T | undefined>;
  get<T = any>(keys: string[]): Promise<Map<string, T>>;
  put<T = any>(key: string, value: T): Promise<void>;
  put(entries: Record<string, any>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list(options?: { prefix?: string }): Promise<Map<string, any>>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

// Extended WebSocket interface with hibernation attachment methods
declare global {
  interface WebSocket {
    serializeAttachment(value: any): void;
    deserializeAttachment(): any;
  }
}
