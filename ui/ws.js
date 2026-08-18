/**
 * Minimal Nostr WebSocket client for the UI — real NIP-01 REQ/EVENT and
 * NIP-50 search against the selected relay. No dependencies.
 *
 * @module ui/ws
 */

/**
 * Run a REQ and collect events until EOSE.
 *
 * @param {string} wsUrl  wss:// relay URL
 * @param {object[]} filters
 * @param {{ timeoutMs?: number, maxEvents?: number }} [opts]
 * @returns {Promise<{ events: object[], eose: boolean, closed?: string, error?: string }>}
 */
export function reqEvents(wsUrl, filters, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const maxEvents = opts.maxEvents ?? 500;

  return new Promise((resolve) => {
    const events = [];
    const seen = new Set();
    let settled = false;
    let ws;

    const done = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch { /* noop */ }
      resolve({ events, eose: !!extra?.eose, ...extra });
    };

    let timer;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      resolve({ events: [], eose: false, error: `could not open WebSocket: ${error.message || error}` });
      return;
    }

    timer = setTimeout(() => done({ eose: false, error: 'timeout waiting for EOSE' }), timeoutMs);

    ws.onopen = () => {
      const subId = `ui-${Math.random().toString(36).slice(2, 10)}`;
      ws.send(JSON.stringify(['REQ', subId, ...filters]));
      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (!Array.isArray(data)) return;
          if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
            const ev = data[2];
            if (!seen.has(ev.id)) {
              seen.add(ev.id);
              events.push(ev);
              if (events.length >= maxEvents) done({ eose: true });
            }
          } else if (data[0] === 'EOSE' && data[1] === subId) {
            done({ eose: true });
          } else if (data[0] === 'CLOSED' && data[1] === subId) {
            done({ eose: false, closed: data[2] || 'closed by relay' });
          } else if (data[0] === 'AUTH') {
            done({ eose: false, error: 'relay requires NIP-42 authentication (not supported by this UI)' });
          }
        } catch { /* ignore malformed frames */ }
      };
    };

    ws.onerror = () => done({ eose: false, error: 'WebSocket error (is this a Nostr relay?)' });
    ws.onclose = (e) => {
      if (!settled && events.length === 0) {
        done({ eose: false, error: `connection closed (${e.code || 'no code'})` });
      } else {
        done({ eose: true });
      }
    };
  });
}

/**
 * NIP-50 search against a relay.
 * @param {string} wsUrl
 * @param {string} query
 * @param {number} [limit]
 */
export function nip50Search(wsUrl, query, limit = 50) {
  return reqEvents(wsUrl, [{ kinds: [39697], search: query, limit }], { maxEvents: limit, timeoutMs: 15000 });
}

/**
 * NIP-45 count against a relay (null when unsupported/error).
 * @param {string} wsUrl
 * @param {object} filter
 */
export function nip45Count(wsUrl, filter) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch { /* noop */ }
      resolve(v);
    };
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => done(null), 8000);
    ws.onopen = () => {
      const id = `cnt-${Math.random().toString(36).slice(2, 10)}`;
      ws.send(JSON.stringify(['COUNT', id, filter]));
      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data[0] === 'COUNT' && data[1] === id) done(data[2]?.count ?? null);
          if (data[0] === 'CLOSED' && data[1] === id) done(null);
        } catch { /* noop */ }
      };
    };
    ws.onerror = () => done(null);
    ws.onclose = () => done(null);
  });
}
