/**
 * UI ↔ relay wiring.
 *
 * The operator UI normally runs on the relay's own origin (served by the
 * Worker's assets binding), so API + WebSocket calls default to same-origin.
 * When opened as a static preview (or to inspect ANOTHER SIP-01 relay), the
 * relay URL can be overridden and is persisted in localStorage.
 *
 * @module ui/api
 */

const RELAY_OVERRIDE_KEY = 'sip-relay-url-override';

let localRelayInfo = null;
let localDetected = false;

/** Fetch the same-origin /api/relay-info; null when this origin isn't a relay. */
export async function detectLocalRelay() {
  if (localDetected) return localRelayInfo;
  localDetected = true;
  try {
    const res = await fetch('./api/relay-info', { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) return null;
    localRelayInfo = await res.json();
    return localRelayInfo;
  } catch {
    return null;
  }
}

/** The currently selected relay: same-origin when live, else the override. */
export function getRelayHttpBase() {
  const override = localStorage.getItem(RELAY_OVERRIDE_KEY);
  if (override) return override.replace(/\/+$/, '');
  return location.origin;
}

export function getRelayWsUrl() {
  const base = getRelayHttpBase();
  return base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

export function setRelayOverride(url) {
  if (url) {
    localStorage.setItem(RELAY_OVERRIDE_KEY, url.replace(/\/+$/, ''));
  } else {
    localStorage.removeItem(RELAY_OVERRIDE_KEY);
  }
}

export function getRelayOverride() {
  return localStorage.getItem(RELAY_OVERRIDE_KEY) || '';
}

/** GET a JSON API path from the selected relay. Throws on non-JSON/404. */
export async function apiGet(path) {
  const base = getRelayHttpBase();
  const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** POST JSON to the selected relay. */
export async function apiPost(path, body) {
  const base = getRelayHttpBase();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** NIP-11 relay information document of the selected relay. */
export async function fetchRelayInfoDoc() {
  const base = getRelayHttpBase();
  const res = await fetch(`${base}/`, { headers: { Accept: 'application/nostr+json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---------- small format helpers ---------- */

export function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}

export function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export function timeAgo(ts) {
  if (!ts) return '—';
  const delta = Math.floor(Date.now() / 1000) - ts;
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function shortHex(hex, head = 8, tail = 6) {
  if (!hex || hex.length <= head + tail + 3) return hex || '';
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

let toastTimer = null;
export function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText =
      'position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);background:#f0b45a;color:#15100a;' +
      'padding:.6rem 1.2rem;border-radius:8px;font-weight:600;z-index:999;box-shadow:0 4px 24px rgba(0,0,0,.5);' +
      'transition:opacity .25s;opacity:0;font-family:system-ui;font-size:.9rem;';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}
