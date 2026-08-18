/**
 * Search — a real NIP-50 client against the selected relay, demonstrating
 * the SIP-01 operators. Results are grouped by `d` so independent indexer
 * agreement is visible at a glance.
 *
 * @module ui/pages/search
 */

import { relayBannerHtml, bindRelayBanner, pageHeader, routeParams } from '../app.js';
import { escapeHtml, getRelayWsUrl, fmtNum, timeAgo, shortHex } from '../api.js';
import { nip50Search } from '../ws.js';
import { parseSearchQuery, SUPPORTED_NIP50_OPERATORS } from '../../shared/search-query.js';
import { parseSip01Event } from '../../shared/sip01.js';

const EXAMPLES = [
  'bitcoin privacy',
  'site:github.com nostr',
  'lang:en type:repository',
  'mime:application/pdf',
  'nostr after:2026-01-01',
  'decentralized search distinct:domain',
];

export async function renderSearch(root, ctx) {
  const q = routeParams().get('q') || '';

  root.innerHTML = pageHeader(
    'Search the index',
    'Real NIP-50 queries against the relay. SIP-01-aware operators map onto the document index.'
  ) + relayBannerHtml() + `
    <div class="searchbar">
      <input type="text" id="q" placeholder='e.g. bitcoin privacy site:github.com lang:en' value="${escapeHtml(q)}">
      <button class="btn" id="go">Search</button>
    </div>
    <p class="small faint mb">
      operators: ${SUPPORTED_NIP50_OPERATORS.map((op) => `<code>${escapeHtml(op.includes(':') ? op : op + ':')}</code>`).join(' ')}
      &nbsp;·&nbsp; prefix any operator with <code>-</code> to negate
    </p>
    <p class="small mb">examples: ${EXAMPLES.map((e) => `<a href="#/search?q=${encodeURIComponent(e)}" class="pill">${escapeHtml(e)}</a>`).join(' ')}</p>
    <div id="results"></div>
  `;

  bindRelayBanner(root);

  const input = /** @type {HTMLInputElement} */ (root.querySelector('#q'));
  const go = () => {
    const value = input.value.trim();
    location.hash = `#/search?q=${encodeURIComponent(value)}`;
    if (value === q) runSearch(root, value); // hash unchanged → manual rerun
  };
  root.querySelector('#go').addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  if (q) runSearch(root, q);
}

async function runSearch(root, query) {
  const results = root.querySelector('#results');
  if (!query) {
    results.innerHTML = '';
    return;
  }

  const parsed = parseSearchQuery(query);
  results.innerHTML = `
    <div class="panel">
      <h2>// parsed query</h2>
      <p class="small mono muted">
        keywords: ${parsed.keywords.map((k) => `<span class="pill amber">${escapeHtml(k)}</span>`).join(' ') || '<span class="faint">none</span>'}
        ${parsed.phrases.length ? `<br>phrases: ${parsed.phrases.map((p) => `<span class="pill amber">"${escapeHtml(p)}"</span>`).join(' ')}` : ''}
        ${parsed.ops.length ? `<br>operators: ${parsed.ops.map((o) => `<span class="pill ${o.negated ? 'red' : 'blue'}">${o.negated ? '-' : ''}${escapeHtml(o.op)}:${escapeHtml(o.value)}</span>`).join(' ')}` : ''}
        ${parsed.distinctDomain ? '<br><span class="pill green">distinct:domain</span>' : ''}
        ${parsed.ignored.length ? `<br><span class="faint">ignored (unsupported): ${escapeHtml(parsed.ignored.join(', '))}</span>` : ''}
      </p>
    </div>
    <p class="muted small">searching <code>${escapeHtml(getRelayWsUrl())}</code> …</p>
  `;

  const { events, error, closed } = await nip50Search(getRelayWsUrl(), query, 50);

  if (error || closed) {
    results.innerHTML += `
      <div class="notice"><strong>Search failed.</strong> ${escapeHtml(error || closed || 'unknown error')}
      <br><span class="small">Is the relay online and NIP-50 enabled?</span></div>`;
    return;
  }

  if (events.length === 0) {
    results.innerHTML += `<div class="notice info"><strong>No results.</strong> The index may not cover this yet — observations arrive as crawlers publish them.</div>`;
    return;
  }

  // Group by d → independent indexer agreement
  /** @type {Map<string, {obs: any[], title: string, url: string, host: string, description: string}>} */
  const byDoc = new Map();
  for (const ev of events) {
    const parsed = parseSip01Event(ev);
    if (!parsed) continue;
    const entry = byDoc.get(parsed.d) || { obs: [], title: parsed.title, url: parsed.url, host: parsed.host, description: parsed.description };
    entry.obs.push(parsed);
    byDoc.set(parsed.d, entry);
  }

  results.innerHTML += `
    <p class="small muted mb">${fmtNum(events.length)} observation(s) across ${fmtNum(byDoc.size)} document(s), ranked by relay score:</p>
    ${[...byDoc.entries()].map(([d, doc]) => {
      const indexers = new Set(doc.obs.map((o) => o.indexer));
      const latest = doc.obs.reduce((a, b) => (a.observedAt > b.observedAt ? a : b));
      return `
        <div class="event-card">
          <div class="title">${escapeHtml(doc.title)}</div>
          <a class="url" href="${escapeHtml(doc.url)}" target="_blank" rel="noopener nofollow">${escapeHtml(doc.url)}</a>
          ${doc.description ? `<div class="desc">${escapeHtml(doc.description)}</div>` : ''}
          <div class="meta">
            <span class="pill ${indexers.size > 1 ? 'green' : ''}">${indexers.size} independent indexer${indexers.size === 1 ? '' : 's'}</span>
            <span class="pill">${doc.obs.length} observation${doc.obs.length === 1 ? '' : 's'}</span>
            ${latest.language ? `<span class="pill blue">${escapeHtml(latest.language)}</span>` : ''}
            ${latest.topics.slice(0, 4).map((t) => `<span class="pill">${escapeHtml(t)}</span>`).join('')}
            <span class="pill faint" title="${escapeHtml(d)}">${escapeHtml(shortHex(d, 12, 4))}</span>
            <span class="pill faint">seen ${timeAgo(latest.observedAt)}</span>
            <a href="#/documents?d=${encodeURIComponent(d)}" class="pill amber">provenance →</a>
          </div>
        </div>
      `;
    }).join('')}
  `;
}
