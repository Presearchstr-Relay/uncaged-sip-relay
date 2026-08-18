import { RelayInfo } from './types';

// ***************************** //
// ** BEGIN EDITABLE SETTINGS ** //
// ***************************** //

// Settings below can be configured to your preferences. Everything here is
// static compile-time configuration — the same values are baked into the
// NIP-11 relay information document, so keep them truthful.

// ---------------------------------------------------------------------------
// Relay operating mode
// ---------------------------------------------------------------------------

/**
 * RELAY_MODE controls what this relay accepts:
 *
 *  - "sip01"   — SIP-01 optimized index relay. Only kind 39697 observations
 *                (plus kind 5 deletions and kind 9735 zap receipts when
 *                payment is enabled) are accepted for storage. Reads stay
 *                fully NIP-01 compatible. This is the recommended mode for
 *                a dedicated search-index node.
 *  - "hybrid"  — General Nostr relay + first-class SIP-01 indexing. All
 *                kinds are accepted (subject to the allow/block lists
 *                below); kind 39697 additionally gets validated and indexed.
 *  - "general" — Plain Nostr relay (upstream Nosflare behavior). SIP-01
 *                validation is off; kind 39697 events are stored like any
 *                other addressable event. SIP-01 search/index APIs disable
 *                themselves.
 */
export const RELAY_MODE: 'general' | 'hybrid' | 'sip01' = 'sip01';

// ---------------------------------------------------------------------------
// SIP-01 (Search Index Protocol) settings
// ---------------------------------------------------------------------------

export const SIP01_ENABLED = RELAY_MODE !== 'general';

/** Validate kind 39697 events at ingestion (SIP-01 §12.4) and reject
 *  malformed observations with `OK false invalid: ...`. */
export const SIP01_VALIDATION = true;

/** Maintain the SIP-01 document/observation/indexer tables and serve the
 *  document-aware NIP-50 search operators. */
export const SIP01_INDEXING = SIP01_ENABLED;

/** Kinds accepted for storage in "sip01" mode (kind 5 = deletions, kind
 *  9735 = zap receipts for payment verification). NIP-42 auth events
 *  (kind 22242) are never stored by any mode. */
export const SIP01_MODE_ALLOWED_KINDS = new Set<number>([39697, 5, 9735]);

/** Per-indexer write rate limit for kind 39697 (token bucket: sustained
 *  rate per ms + burst capacity). Crawlers publish bursts of observations;
 *  the default allows ~120 observations/minute with a burst of 240. */
export const SIP01_INDEXER_RATE_LIMIT = { rate: 120 / 60000, capacity: 240 };

/** Maximum accepted byte size of a single kind 39697 event message. The
 *  spec's field caps make legit events far smaller than this. */
export const SIP01_MAX_EVENT_BYTES = 64 * 1024; // 64 KB

/** Indexer allow/block policy for kind 39697 publishers.
 *  - "open"      — any valid signed observation is accepted (default)
 *  - "allowlist" — only pubkeys in sip01AllowedIndexers may publish
 *  - "blocklist" — pubkeys in sip01BlockedIndexers are rejected
 */
export const SIP01_INDEXER_POLICY: 'open' | 'allowlist' | 'blocklist' = 'open';

export const sip01AllowedIndexers = new Set<string>([
  // ... hex pubkeys of explicitly allowed indexers (allowlist policy)
]);

export const sip01BlockedIndexers = new Set<string>([
  // ... hex pubkeys of blocked indexers (blocklist policy)
]);

// ---------------------------------------------------------------------------
// Search (NIP-50)
// ---------------------------------------------------------------------------

export const NIP50_ENABLED = true;

/** Hard cap on search results per query (also clamps `limit`). */
export const SEARCH_MAX_RESULTS = 100;

/** Maximum parsed length of a `search` string. */
export const SEARCH_MAX_QUERY_LENGTH = 500;

// ---------------------------------------------------------------------------
// Federation (NIP-77 negentropy)
// ---------------------------------------------------------------------------

export const NIP77_ENABLED = true;

/** Maximum events loaded into a single NEG-OPEN reconciliation session.
 *  Larger requests are refused with `NEG-ERR blocked:` (clients can narrow
 *  the filter, e.g. by time range). */
export const NEG_MAX_ITEMS = 100000;

/** Maximum size of a single negentropy wire message (bytes, pre-hex). */
export const NEG_FRAME_SIZE_LIMIT = 256 * 1024; // 256 KB

/** Idle timeout after which a NEG session is reclaimed (NEG-ERR closed:). */
export const NEG_SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Event counts (NIP-45)
// ---------------------------------------------------------------------------

export const NIP45_ENABLED = true;

/** Upper bound of rows a single COUNT may scan before being refused. */
export const COUNT_MAX_ESTIMATE = 50000;

// ---------------------------------------------------------------------------
// Payment (OPTIONAL — SIP-01 itself is open; payment is relay policy)
// ---------------------------------------------------------------------------

/**
 * PAYMENT_MODE:
 *  - "free"         — no payment required; no payment UI (default)
 *  - "donation"     — payment optional; the landing page shows a zap button
 *  - "pay-to-relay" — publishing requires a paid pubkey (Nostr zap to
 *                     relayNpub of RELAY_ACCESS_PRICE_SATS; verified from
 *                     kind 9735 zap receipts)
 */
export const PAYMENT_MODE: 'free' | 'donation' | 'pay-to-relay' = 'free';

// Derived for upstream-compatible checks.
export const PAY_TO_RELAY_ENABLED = PAYMENT_MODE === 'pay-to-relay';

export const relayNpub = "npub16jdfqgazrkapk0yrqm9rdxlnys7ck39c7zmdzxtxqlmmpxg04r0sd733sv"; // Use your own npub
export const RELAY_ACCESS_PRICE_SATS = 212121; // Price in SATS for relay access

/** Hex pubkey of the relay operator (payment recipient). Derived from
 *  relayNpub at startup in relay-worker.ts. */

// NIP-42 Authentication
export const AUTH_REQUIRED = false; // Set to true to require NIP-42 auth for reads+writes
export const AUTH_TIMEOUT_MS = 600000; // 10 minutes - how long the challenge is valid

// ---------------------------------------------------------------------------
// Relay info (NIP-11)
// ---------------------------------------------------------------------------

export const relayInfo: RelayInfo = {
  name: "UNCAGED SIP Relay",
  description: "A serverless SIP-01 search index relay — decentralized web-index observations (Nostr kind 39697) on Cloudflare Workers + D1. One shared decentralized index. Many independent indexers. No single owner.",
  pubkey: "d49a9023a21dba1b3c8306ca369bf3243d8b44b8f0b6d1196607f7b0990fa8df",
  contact: "lux@fed.wtf",
  supported_nips: [1, 5, 9, 11, 16, 33, 42, 45, 50, 77],
  software: "https://github.com/NostrDanish/SIP-Booster-Relay",
  version: "1.0.0",
  icon: "https://raw.githubusercontent.com/NostrDanish/SIP-Booster-Relay/main/images/icon.png",

  // Optional fields (uncomment as needed):
  // banner: "https://example.com/banner.jpg",
  // privacy_policy: "https://example.com/privacy-policy.html",
  // terms_of_service: "https://example.com/terms.html",

  // Relay limitations
  limitation: {
    max_message_length: 262144, // 256KB
    max_subscriptions: 100,
    max_limit: 500,
    max_subid_length: 64,
    max_event_tags: 2000,
    max_content_length: 70000,
    // min_pow_difficulty: 0,
    auth_required: AUTH_REQUIRED,
    payment_required: PAY_TO_RELAY_ENABLED,
    restricted_writes: PAY_TO_RELAY_ENABLED || SIP01_INDEXER_POLICY === 'allowlist',
    // created_at_lower_limit: 0,
    created_at_upper_limit: 900, // reject events more than 15 min in the future
    default_limit: 100,
  },

  // Event retention policies (uncomment and configure as needed):
  // retention: [
  //   { kinds: [[30000, 39999]], count: 100000 },
  // ],

  // Content limitations by country (uncomment as needed):
  // relay_countries: ["*"],

  // Payment configuration (added dynamically in handleRelayInfoRequest when enabled):
  // payments_url / fees
};

/** SIP-01 capability block advertised in the NIP-11 document under the
 *  `uncaged_index` custom field (SIP-01 §15). Values are assembled
 *  dynamically from this configuration in relay-worker.ts. */
export const SIP01_SCOPE: 'global' | 'regional' | 'community' | 'private' = 'global';
export const SIP01_SCOPE_DOMAINS: string[] = ["*"];      // e.g. ["docs.example.com"] to specialize
export const SIP01_SCOPE_LANGUAGES: string[] = [];        // e.g. ["en", "de"]; empty = all
export const SIP01_SCOPE_DOCUMENT_TYPES: string[] = [];   // e.g. ["page", "repository"]; empty = all

// Nostr address NIP-05 verified users (for verified checkmark like username@your-relay.com)
export const nip05Users: Record<string, string> = {
  // "name": "hexpubkey",
  // ... more NIP-05 verified users
};

// ---------------------------------------------------------------------------
// Anti-spam / filtering (upstream Nosflare policy engine, preserved)
// ---------------------------------------------------------------------------

// Anti-spam settings
export const enableAntiSpam = false; // Set to true to enable hashing and duplicate content checking
export const enableGlobalDuplicateCheck = false; // When anti-spam is enabled, set to true for global hash (across all pubkeys and not individually)

// Kinds subjected to duplicate checks (only when anti-spam is enabled)
export const antiSpamKinds = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 40, 41, 42, 43, 44, 64, 818, 1021, 1022, 1040, 1059, 1063, 1311, 1617, 1621, 1622, 1630, 1633, 1971, 1984, 1985, 1986, 1987, 2003, 2004, 2022, 4550, 5000, 5999, 6000, 6999, 7000, 9000, 9030, 9041, 9467, 9734, 9735, 9802, 10000, 10001, 10002, 10003, 10004, 10005, 10006, 10007, 10009, 10015, 10030, 10050, 10063, 10096, 13194, 21000, 22242, 23194, 23195, 24133, 24242, 27235, 30000, 30001, 30002, 30003, 30004, 30005, 30007, 30008, 30009, 30015, 30017, 30018, 30019, 30020, 30023, 30024, 30030, 30040, 30041, 30063, 30078, 30311, 30315, 30402, 30403, 30617, 30618, 30818, 30819, 31890, 31922, 31923, 31924, 31925, 31989, 31990, 34235, 34236, 34237, 34550, 39000, 39001, 39002, 39003, 39004, 39005, 39006, 39007, 39008, 39009
  // Add other kinds you want to check for duplicates
]);

// Blocked pubkeys
// Add pubkeys in hex format to block write access
export const blockedPubkeys = new Set([
  // ... pubkeys that are explicitly blocked
]);

// Allowed pubkeys
// Add pubkeys in hex format to allow write access
export const allowedPubkeys = new Set<string>([
  // ... pubkeys that are explicitly allowed
]);

// Blocked event kinds
// Add comma-separated kinds Ex: 1064, 4, 22242
export const blockedEventKinds = new Set<number>([
  1064
]);

// Allowed event kinds
// Add comma-separated kinds Ex: 1, 2, 3
export const allowedEventKinds = new Set<number>([
  // ... kinds that are explicitly allowed
]);

// Blocked words or phrases (case-insensitive)
export const blockedContent = new Set([
  "~~ hello world! ~~"
  // ... more blocked content
]);

// NIP-05 validation
export const checkValidNip05 = false; // Set to true to enable NIP-05 validation (this requires users to have a valid NIP-05 in order to publish events to the relay as part of anti-spam)

// Blocked NIP-05 domains
// This prevents users with NIP-05's from specified domains from publishing events to the relay
export const blockedNip05Domains = new Set<string>([
  // Add domains that are explicitly blocked
  // "primal.net"
]);

// Allowed NIP-05 domains
export const allowedNip05Domains = new Set<string>([
  // Add domains that are explicitly allowed
  // Leave empty to allow all domains (unless blocked)
]);

// Blocked tags
// Add comma-separated tags Ex: t, e, p
export const blockedTags = new Set<string>([
  // ... tags that are explicitly blocked
]);

// Allowed tags
// Add comma-separated tags Ex: p, e, t
export const allowedTags = new Set<string>([
  // "p", "e", "t"
  // ... tags that are explicitly allowed
]);

// Rate limit thresholds
export const PUBKEY_RATE_LIMIT = { rate: 10 / 60000, capacity: 10 }; // 10 EVENT messages per min
export const REQ_RATE_LIMIT = { rate: 50 / 60000, capacity: 50 }; // 50 REQ messages per min
export const excludedRateLimitKinds = new Set<number>([
  1059
  // ... kinds to exclude from EVENT rate limiting Ex: 1, 2, 3
]);

// ---------------------------------------------------------------------------
// Database pruning (D1 has a 10GB limit)
// ---------------------------------------------------------------------------

export const DB_PRUNING_ENABLED = true; // Set to false to disable automatic pruning
export const DB_SIZE_THRESHOLD_GB = 9; // Start pruning when database exceeds this size (in GB)
export const DB_PRUNE_BATCH_SIZE = 1000; // Number of events to delete per batch
export const DB_PRUNE_TARGET_GB = 8; // Target size to prune down to (in GB)

// Event kinds to preserve during pruning. In sip01/hybrid mode kind 39697
// observations are protected by default: an addressable index record's value
// is its latest state, not its age, and age-based eviction silently shrinks
// the searchable index. Set SIP01_PRUNE_ALLOWED to true to let pruning
// reclaim old observations anyway.
export const SIP01_PRUNE_ALLOWED = false;
export const pruneProtectedKinds = new Set<number>([
  0,      // Profile metadata
  3,      // Contact list / follows
  10002,  // Relay list metadata
  39697,  // SIP-01 web index observations (see SIP01_PRUNE_ALLOWED)
]);

// *************************** //
// ** END EDITABLE SETTINGS ** //
// *************************** //

// Helper validation functions
import { NostrEvent } from './types';

export function isPubkeyAllowed(pubkey: string): boolean {
  if (allowedPubkeys.size > 0 && !allowedPubkeys.has(pubkey)) {
    return false;
  }
  return !blockedPubkeys.has(pubkey);
}

export function isEventKindAllowed(kind: number): boolean {
  if (RELAY_MODE === 'sip01' && !SIP01_MODE_ALLOWED_KINDS.has(kind)) {
    return false;
  }
  if (allowedEventKinds.size > 0 && !allowedEventKinds.has(kind)) {
    return false;
  }
  return !blockedEventKinds.has(kind);
}

export function isIndexerAllowed(pubkey: string): boolean {
  if (SIP01_INDEXER_POLICY === 'allowlist') {
    return sip01AllowedIndexers.has(pubkey);
  }
  if (SIP01_INDEXER_POLICY === 'blocklist') {
    return !sip01BlockedIndexers.has(pubkey);
  }
  return true;
}

export function containsBlockedContent(event: NostrEvent): boolean {
  const lowercaseContent = (event.content || "").toLowerCase();
  const lowercaseTags = event.tags.map(tag => tag.join("").toLowerCase());

  for (const blocked of blockedContent) {
    const blockedLower = blocked.toLowerCase(); // Checks case-insensitively
    if (
      lowercaseContent.includes(blockedLower) ||
      lowercaseTags.some(tag => tag.includes(blockedLower))
    ) {
      return true;
    }
  }
  return false;
}

export function isTagAllowed(tag: string): boolean {
  if (allowedTags.size > 0 && !allowedTags.has(tag)) {
    return false;
  }
  return !blockedTags.has(tag);
}
