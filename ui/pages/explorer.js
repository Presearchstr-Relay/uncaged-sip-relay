/**
 * Explorer — live kind 39697 feed with the client-side SIP-01 validator
 * (§18 reader guidance), plus the URL → d-tag calculator (§7/§8).
 *
 * @module ui/pages/explorer
 */

import { relayBannerHtml, bindRelayBanner, pageHeader } from '../app.js';
import { apiGet, escapeHtml, getRelayWsUrl, timeAgo, shortHex } from '../api.js';
import { reqEvents } from '../ws.js';
import {
  validateSip01Event,
  parseSip01Event,
  normalizeIndexUrl,
  documentId,
  contentHash,
} from '../../shared/sip01.js';

export async function renderExplorer(root, ctx) {
  root.innerHTML = pageHeader(
    'Observation explorer',
    'Live kind 39697 events, validated client-side against the SIP-01 v1 schema.'
  ) + relayBannerHtml() + `
    <div class="panel">
      <h2>// url → document identity calculator</h2>
      <div class="field-row">
        <div><label>URL</label><input type="text" id="calc-url" placeholder="https://WWW.Example.com/page/?utm_source=x&a=1"></div>
        <div><label>title (for x)</label><input type="text" id="calc-title" placeholder="Example Page"></div>
        <div><label>description (for x)</label><input type="text" id="calc-desc" placeholder="A page about examples."></div>
      </div>
      <button class="btn small mt" id="calc-go">Compute</button>
      <div id="calc-out" class="mt"></div>
    </div>

    <h2 class="mono" style="color:var(--amber);margin-bottom:.8rem">// latest observations</h2>
    <div id="feed"><p class="muted">loading…</p></div>
  `;

  bindRelayBanner(root);

  // --- calculator
  root.querySelector('#calc-go').addEventListener('click', async () => {
    const url = /** @type {HTMLInputElement} */ (root.querySelector('#calc-url')).value;
    const title = /** @type {HTMLInputElement} */ (root.querySelector('#calc-title')).value;
    const desc = /** @type {HTMLInputElement} */ (root.querySelector('#calc-desc')).value;
    const out = root.querySelector('#calc-out');

    const normalized = normalizeIndexUrl(url);
    if (!normalized) {
      out.innerHTML = `<p class="badge-fail mono small">not a valid http(s) URL</p>`;
      return;
    }
    const d = await documentId(normalized);
    const x = title ? await contentHash(title, desc) : null;
    out.innerHTML = `
      <div class="codeblock">normalized:  ${escapeHtml(normalized)}
d tag:       ${escapeHtml(d)}${x ? `\nx tag:       ${escapeHtml(x)}` : ''}</div>`;
  });

  // --- live feed: same-origin API when available, else plain NIP-01 REQ
  const feed = root.querySelector('#feed');
  let events = [];
  let sourceNote = '';

  try {
    const data = await apiGet('/api/observations?limit=30');
    events = data.events || [];
    sourceNote = 'via relay index API';
  } catch {
    const res = await reqEvents(getRelayWsUrl(), [{ kinds: [39697], limit: 30 }], { timeoutMs: 10000 });
    if (res.error) {
      feed.innerHTML = `<div class="notice"><strong>Could not load observations.</strong> ${escapeHtml(res.error)}</div>`;
      return;
    }
    events = res.events;
    sourceNote = 'via NIP-01 filter (live WebSocket)';
  }

  if (events.length === 0) {
    feed.innerHTML = `<div class="notice info"><strong>No observations yet.</strong> Point a SIP-01 crawler (e.g. Crawlstr) at this relay and the feed will fill up.</div>`;
    return;
  }

  feed.innerHTML = `<p class="faint small mb">${events.length} most recent observations, ${escapeHtml(sourceNote)}. Each is validated in your browser right now:</p>`;

  for (const ev of events) {
    const parsed = parseSip01Event(ev);
    const validation = await validateSip01Event(ev);

    const card = document.createElement('div');
    card.className = 'event-card';
    card.innerHTML = parsed
      ? `
      <div class="title">${escapeHtml(parsed.title)}</div>
      <a class="url" href="${escapeHtml(parsed.url)}" target="_blank" rel="noopener nofollow">${escapeHtml(parsed.url)}</a>
      ${parsed.description ? `<div class="desc">${escapeHtml(parsed.description)}</div>` : ''}
      <div class="meta">
        <span class="pill" title="indexer pubkey">${escapeHtml(shortHex(parsed.indexer))}</span>
        ${parsed.source ? `<span class="pill blue">${escapeHtml(parsed.source)}</span>` : ''}
        ${parsed.language ? `<span class="pill">${escapeHtml(parsed.language)}</span>` : ''}
        ${parsed.topics.map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join('')}
        <span class="pill faint">${timeAgo(parsed.observedAt)}</span>
        <a href="#/documents?d=${encodeURIComponent(parsed.d)}" class="pill amber">document →</a>
      </div>
      <div class="validation ${validation.valid ? 'badge-ok' : 'badge-fail'}">
        ${validation.valid ? '✓ valid SIP-01 v1 observation' : `✗ ${escapeHtml(validation.errors.join('; '))}`}
        ${validation.notices.length ? `<br><span class="faint">${escapeHtml(validation.notices.join('; '))}</span>` : ''}
      </div>
    `
      : `<div class="title badge-fail">unparseable observation</div>
         <div class="mono small faint">${escapeHtml(ev.id)}</div>`;
    feed.appendChild(card);
  }
}
